// „Coś nie działa?” — panel sprawdza po kolei to, co zwykle psuje strony i usługi (DNS, zapora, certyfikat,
// Apache, aplikacja, PHP, baza, dysk, pamięć), mówi po polsku, co jest nie tak, i daje przycisk naprawy.
// Naprawy to zamknięta lista bezpiecznych czynności (fix()).
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import { run, readText } from './util.mjs';
import * as S from './system.mjs';
import * as AP from './autopilot.mjs';
import * as T from './sitetools.mjs';
import * as F from './firewall.mjs';
import * as G from './games.mjs';
import { C as CFG } from './config.mjs';

let ctx = { panelHosts: [], fails: () => 0, clearFails: () => {}, ovh: null };
export function init(c) { ctx = { ...ctx, ...c }; }

export const PROBLEMS = [
  { id: 'strona', title: 'Strona się nie otwiera albo pokazuje błąd', target: 'site' },
  { id: 'wolno', title: 'Strona działa wolno', target: 'site' },
  { id: 'logowanie', title: 'Nie mogę się zalogować', target: 'login' },
  { id: 'gra', title: 'Serwer gry nie startuje albo nie da się wejść', target: 'game' },
  { id: 'usluga', title: 'Aplikacja albo usługa nie działa', target: 'service' },
  { id: 'poczta', title: 'Nie dochodzą maile', target: null },
  { id: 'serwer', title: 'Cały serwer jest wolny', target: null },
];

const ok = (title, text = '') => ({ status: 'ok', title, text });
const bad = (title, text = '', fix = null, link = null) => ({ status: 'bad', title, text, fix, link });
const warn = (title, text = '', fix = null, link = null) => ({ status: 'warn', title, text, fix, link });
const info = (title, text = '', fix = null, link = null) => ({ status: 'info', title, text, fix, link });
const skip = (title, text = '') => ({ status: 'skip', title, text });
const gb = (n) => (n / 1073741824).toFixed(1).replace('.', ',') + ' GB';

/** Lista celów do wyboru w kroku 2. */
export async function targets() {
  const sites = (await S.sites()).map((s) => ({ id: s.name, label: s.name, status: s.status }));
  const services = (await S.services()).filter((s) => s.group !== 'other' || s.failed).map((s) => ({ id: s.unit, label: s.name, status: s.failed ? 'down' : s.active ? 'ok' : 'off' }));
  let games = [];
  try { if (G.ready()) games = (await G.list()).map((g) => ({ id: g.id, label: g.name, status: g.state === 'running' ? 'ok' : 'off' })); } catch {}
  const adr = CFG().adres;
  return { sites, services, games, login: [{ id: 'panel', label: `Panel serwera${adr ? ' (' + adr + ')' : ''}` }, ...sites.filter((s) => s.id !== adr).map((s) => ({ ...s, label: `strona ${s.label}` }))] };
}

/* ------------------------------------------------------------ pomocnicze */

async function curl(host, { https = true, ip = '127.0.0.1', path = '/' } = {}) {
  const port = https ? 443 : 80;
  const r = await run('curl', ['-sk', '-o', '/dev/null', '-w', '%{http_code} %{time_starttransfer} %{time_total}', '--max-time', '15', '--resolve', `${host}:${port}:${ip}`, `${https ? 'https' : 'http'}://${host}${path}`], { timeout: 20000 });
  const [code, ttfb, total] = r.out.trim().split(' ');
  return { code: Number(code) || 0, ttfb: Number(ttfb) || 0, total: Number(total) || 0, err: r.ok ? '' : r.err.trim() };
}
/** Kto słucha na porcie (usługa systemd). */
async function unitOnPort(port) {
  const r = await run('ss', ['-Hltnp', `sport = :${port}`]);
  const pid = Number((r.out.match(/pid=(\d+)/) || [])[1]);
  if (!pid) return null;
  const cg = readText(`/proc/${pid}/cgroup`);
  return (cg.match(/\/([^/]+)\.service/) || [])[1] || null;
}
function portOf(proxy) { const m = String(proxy).match(/:(\d+)/); return m ? Number(m[1]) : null; }
async function apacheTest() { const r = await run('apache2ctl', ['configtest']); return { ok: r.ok, text: (r.err + r.out).split('\n').filter((l) => l && !/Syntax OK/.test(l)).slice(0, 4).join('\n') }; }
function tailFile(p, maxBytes = 200000) {
  try {
    const fd = fs.openSync(p, 'r'); const st = fs.fstatSync(fd);
    const len = Math.min(st.size, maxBytes); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    return { text: buf.toString('utf8'), mtime: st.mtimeMs };
  } catch { return { text: '', mtime: 0 }; }
}
/** Ostatnie błędy PHP/Apache w logu strony — z wyjaśnieniem znanych przypadków. */
const KNOWN = [
  [/could not find driver|Call to undefined function (mysqli_|mysql_)|Class "?PDO"? not found/i, 'PHP nie ma modułu bazy danych. Zwykle po aktualizacji PHP Apache trzyma w pamięci stare biblioteki — pomaga ponowne uruchomienie Apache i PHP.', 'stale'],
  [/Allowed memory size of \d+ bytes exhausted/i, 'Skryptowi PHP zabrakło pamięci. Podnieś limit pamięci PHP w ustawieniach strony albo popraw skrypt.', null],
  [/SQLSTATE\[HY000\] \[2002\]|Can't connect to local MySQL server|Connection refused.*3306/i, 'Strona nie może połączyć się z bazą — baza MariaDB nie działa albo nie przyjmuje połączeń.', 'mariadb'],
  [/SQLSTATE\[HY000\] \[1045\]|Access denied for user/i, 'Baza odrzuca login albo hasło zapisane w konfiguracji strony. Sprawdź hasło konta bazy (Bazy danych → Konta) i plik konfiguracyjny strony.', null],
  [/SQLSTATE\[HY000\] \[1049\]|Unknown database/i, 'Baza, której szuka strona, nie istnieje — mogła zostać usunięta albo ma inną nazwę.', null],
  [/Permission denied/i, 'Serwer nie ma prawa do jakiegoś pliku lub katalogu (uprawnienia). Pliki strony powinny należeć do www-data.', null],
  [/No such file or directory|failed to open stream/i, 'Strona szuka pliku, którego nie ma — może coś zostało usunięte albo źle wgrane.', null],
  [/Maximum execution time/i, 'Skrypt PHP działał za długo i został przerwany.', null],
  [/syntax error|Parse error/i, 'W kodzie PHP jest błąd składni — ostatnio zmieniany plik ma literówkę. Możesz przywrócić poprzednią wersję w karcie strony → Wersje.', null],
  [/proxy: error reading status line|AH01102|AH00957|Connection refused: AH/i, 'Apache nie dostaje odpowiedzi od aplikacji — aplikacja nie działa albo nie słucha na swoim porcie.', 'app'],
  [/server reached pm.max_children/i, 'PHP ma za mało procesów na ruch — strona odpowiada wolno w szczytach.', null],
];
function recentErrors(logs, sinceMs = 2 * 3600e3) {
  const out = [];
  for (const p of logs.filter((l) => /error/.test(l))) {
    const { text, mtime } = tailFile(p);
    if (!text || Date.now() - mtime > 7 * 864e5) continue;
    const lines = text.split('\n').filter((l) => /error|fatal|crit|alert|emerg/i.test(l)).slice(-60);
    for (const l of lines.reverse()) {
      const m = l.match(/^\[(\w{3} \w{3} \d+ [\d:.]+ \d{4})\]/);
      const ts = m ? Date.parse(m[1].replace(/\.\d+/, '')) : mtime;
      if (Date.now() - ts > sinceMs) continue;
      out.push({ ts, line: l.replace(/\[client [^\]]+\] /, '').slice(0, 300) });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}
function explain(errs) {
  for (const [re, text, fix] of KNOWN) { const e = errs.find((x) => re.test(x.line)); if (e) return { text, fix, line: e.line }; }
  return errs[0] ? { text: 'W logu są świeże błędy:', fix: null, line: errs[0].line } : null;
}

/* ---------------------------------------------------------------- strona */

async function checkSite(name) {
  const out = [];
  const s = S.siteConfigs().find((x) => x.name === name || x.aliases.includes(name));
  if (!s) return [bad('Panel nie zna tej strony', 'Nie ma jej w konfiguracji Apache.')];
  const ip = S.metrics().ip;
  // 1. włączona?
  if (!s.enabled) { out.push(bad('Strona jest wyłączona w Apache', 'Ktoś ją wyłączył (Strony → wyłącz).', { id: 'wlacz-strone', args: { name: s.name }, label: 'Włącz stronę' })); return out; }
  out.push(ok('Strona jest włączona'));
  // 2. DNS
  let ips = [];
  try { ips = await dns.resolve4(name); } catch {}
  if (!ips.length) out.push(bad('Adres nie istnieje w DNS', `Nikt w internecie nie znajdzie ${name}. Dodaj w OVH rekord A: ${name} → ${ip}.`, ctx.ovh?.manages(name) ? { id: 'dns-ovh', args: { name }, label: 'Dodaj w OVH' } : null));
  else if (!ips.includes(ip)) out.push(bad('Adres wskazuje na inny serwer', `${name} → ${ips.join(', ')}, a ten serwer to ${ip}. Popraw rekord A w OVH.`, ctx.ovh?.manages(name) ? { id: 'dns-ovh', args: { name }, label: 'Popraw w OVH' } : null));
  else out.push(ok('Adres w DNS wskazuje na ten serwer', `${name} → ${ip}`));
  // 3. zapora
  try { const fw = await F.status(); out.push(fw.active ? ok('Zapora przepuszcza strony (porty 80 i 443)') : info('Zapora jest wyłączona', 'Strony są dostępne, ale serwer jest mniej chroniony.', null, '#/zapora')); } catch {}
  // 4. Apache
  const ap = (await S.services()).find((x) => x.unit === 'apache2');
  if (!ap?.active) { out.push(bad('Apache nie działa', 'Bez niego nie działa żadna strona.', { id: 'restart', args: { unit: 'apache2' }, label: 'Uruchom Apache' })); return out; }
  const t = await apacheTest();
  out.push(t.ok ? ok('Apache działa, konfiguracja bez błędów') : bad('W konfiguracji Apache jest błąd', t.text + '\nApache działa na starej konfiguracji, ale nie przyjmie zmian, dopóki błąd zostanie.'));
  // 5. certyfikat
  if (s.https) {
    const st = (await S.sites()).find((x) => x.name === s.name);
    const c = st?.cert;
    if (!c?.validTo) out.push(warn('Nie udało się odczytać certyfikatu'));
    else {
      const days = Math.floor((c.validTo - Date.now()) / 864e5);
      const certName = (await S.certs()).find((k) => k.domains?.includes(s.name) || k.name === s.name)?.name;
      if (days < 0) out.push(bad('Certyfikat wygasł', `Przeglądarki pokazują ostrzeżenie zamiast strony (wygasł ${-days} dni temu).`, certName ? { id: 'ssl', args: { name: certName }, label: 'Odnów certyfikat' } : null));
      else if (c.matches === false) out.push(bad('Certyfikat nie pasuje do adresu', 'Przeglądarka pokaże ostrzeżenie.', certName ? { id: 'ssl', args: { name: certName }, label: 'Odnów certyfikat' } : null));
      else if (days < 10) out.push(warn(`Certyfikat wygasa za ${days} dni`, 'Powinien odnowić się sam — możesz to zrobić teraz.', certName ? { id: 'ssl', args: { name: certName }, label: 'Odnów teraz' } : null));
      else out.push(ok(`Certyfikat ważny jeszcze ${days} dni`));
    }
  }
  // 6. odpowiedź strony
  const r = await curl(s.name, { https: s.https });
  let extras = null; try { extras = T.extrasInfo(s.name); } catch {}
  if (r.code === 0) out.push(bad('Strona nie odpowiada', r.err || 'Brak odpowiedzi w 15 sekund.'));
  else if (r.code === 503 && extras?.maintenance?.on) out.push(warn('Trwa przerwa techniczna', 'Strona pokazuje komunikat o przerwie (włączony w karcie strony → Ochrona).', { id: 'przerwa-off', args: { name: s.name }, label: 'Wyłącz przerwę' }));
  else if (r.code === 401 && extras?.password?.on) out.push(info('Strona jest chroniona hasłem', `Login: ${extras.password.user}. Hasło zmienisz w karcie strony → Ochrona.`, null, `#/strona/${encodeURIComponent(s.name)}/ochrona`));
  else if (r.code >= 500) out.push(bad(`Strona zwraca błąd ${r.code}`, r.code === 502 || r.code === 503 ? 'Apache nie może dogadać się z aplikacją za stroną.' : 'Błąd po stronie aplikacji albo PHP — szczegóły niżej.'));
  else if (r.code === 404) out.push(warn('Strona główna zwraca 404', 'Serwer działa, ale nie ma strony głównej (np. brak index.html / index.php).', null, `#/strona/${encodeURIComponent(s.name)}/pliki`));
  else if (r.code === 403) out.push(warn('Strona zwraca 403 (brak dostępu)', 'Często brak pliku index albo złe uprawnienia katalogu.', null, `#/strona/${encodeURIComponent(s.name)}/pliki`));
  else out.push(ok(`Strona odpowiada (kod ${r.code}, ${Math.round(r.total * 1000)} ms)`));
  // 7. aplikacja za stroną (proxy)
  for (const port of [...new Set(s.proxies.map(portOf).filter(Boolean))].slice(0, 2)) {
    const unit = await unitOnPort(port);
    if (!unit) {
      const guess = (await S.services()).find((x) => x.unit === T.siteInfo(s.name).unit);
      out.push(bad(`Nic nie słucha na porcie ${port}`, 'Aplikacja, do której Apache przekazuje ruch, nie działa.', guess ? { id: 'restart', args: { unit: guess.unit }, label: `Uruchom ${guess.name}` } : null, '#/uslugi'));
    } else {
      const sv = (await S.services()).find((x) => x.unit === unit);
      out.push(ok(`Aplikacja działa (${sv?.name || unit}, port ${port})`));
      if (r.code >= 500 && sv) out.push(info('Aplikacja odpowiada błędem', 'Spróbuj ją uruchomić ponownie — logi zobaczysz w Usługach.', { id: 'restart', args: { unit }, label: 'Uruchom ponownie' }, '#/logi'));
    }
  }
  // 8. PHP i biblioteki po aktualizacji
  const stale = await AP.staleUnits().catch(() => []);
  const st2 = stale.filter((x) => ['apache2', 'php8.3-fpm', 'php8.2-fpm', 'php8.4-fpm', 'pteroq', 'mariadb'].includes(x.unit) || x.unit.startsWith('php'));
  if (st2.length) out.push(warn('Usługi mają w pamięci stare biblioteki po aktualizacji', `${st2.map((x) => x.name).join(', ')} — tak padł panel gier 16.11. Ponowne uruchomienie to naprawia.`, { id: 'stale', args: {}, label: 'Odśwież usługi' }));
  // 9. błędy w logu strony
  const errs = recentErrors(s.logs);
  const ex = explain(errs);
  if (ex) out.push((r.code >= 500 ? bad : warn)('Błędy w logu strony (ostatnie 2 godziny)', `${ex.text}\n${ex.line}`, ex.fix === 'stale' ? { id: 'stale', args: {}, label: 'Uruchom ponownie Apache i PHP' } : ex.fix === 'mariadb' ? { id: 'restart', args: { unit: 'mariadb' }, label: 'Uruchom ponownie bazę' } : null, s.logs[0] ? `#/logi?z=${encodeURIComponent('f:' + s.logs.find((l) => /error/.test(l)) || s.logs[0])}` : null));
  else if (s.logs.some((l) => /error/.test(l))) out.push(ok('Brak świeżych błędów w logu strony'));
  // 10. baza
  const maria = (await S.services()).find((x) => x.unit === 'mariadb');
  if (maria && !maria.active) out.push(bad('Baza MariaDB nie działa', 'Strony w PHP nie mogą odczytać danych.', { id: 'restart', args: { unit: 'mariadb' }, label: 'Uruchom bazę' }));
  else if (maria) out.push(ok('Baza MariaDB działa'));
  out.push(...resources());
  return out;
}
function resources() {
  const m = S.metrics();
  const out = [];
  const diskPct = m.disk.used / m.disk.total * 100;
  if (m.disk.free < 1024 ** 3) out.push(bad('Kończy się miejsce na dysku', `Zostało ${gb(m.disk.free)} — strony i bazy mogą przestać zapisywać dane.`, { id: 'sprzataj', args: {}, label: 'Posprzątaj dysk' }, '#/dysk'));
  else if (diskPct > 90) out.push(warn(`Dysk zajęty w ${Math.round(diskPct)}%`, `Wolne ${gb(m.disk.free)}.`, { id: 'sprzataj', args: {}, label: 'Posprzątaj dysk' }, '#/dysk'));
  else out.push(ok(`Dysk: wolne ${gb(m.disk.free)}`));
  const memPct = (1 - m.mem.available / m.mem.total) * 100;
  if (memPct > 92) out.push(bad(`Brakuje pamięci (${Math.round(memPct)}% zajęte)`, 'Serwer może zabijać procesy. Zobacz, co zjada pamięć.', null, '#/wydajnosc'));
  else out.push(ok(`Pamięć: ${Math.round(memPct)}% zajęte`));
  return out;
}

/* ------------------------------------------------------------ wolna strona */

async function checkSlow(name) {
  const s = S.siteConfigs().find((x) => x.name === name);
  if (!s) return [bad('Panel nie zna tej strony')];
  const out = [];
  const times = [];
  for (let i = 0; i < 3; i++) times.push(await curl(s.name, { https: s.https }));
  const ttfb = Math.min(...times.map((t) => t.ttfb)) * 1000;
  const total = Math.min(...times.map((t) => t.total)) * 1000;
  if (ttfb > 1500) out.push(bad(`Serwer odpowiada wolno: ${Math.round(ttfb)} ms do pierwszego bajtu`, 'To czas, w którym serwer przygotowuje stronę (PHP, baza, aplikacja).'));
  else if (ttfb > 600) out.push(warn(`Odpowiedź w ${Math.round(ttfb)} ms`, 'Trochę wolno, ale bez dramatu.'));
  else out.push(ok(`Serwer odpowiada szybko: ${Math.round(ttfb)} ms`, total > ttfb * 3 && total > 1500 ? `Całość pobiera się ${Math.round(total)} ms — strona jest ciężka (duże obrazki/pliki).` : ''));
  out.push(...(await serverLoad()));
  const errs = recentErrors(s.logs, 6 * 3600e3).filter((e) => /max_children|Maximum execution|timed out|timeout/i.test(e.line));
  if (errs.length) out.push(warn('Strona dobija do limitów PHP', errs[0].line));
  return out;
}
async function serverLoad() {
  const out = [];
  const cores = (await import('node:os')).cpus().length;
  const load = Number(readText('/proc/loadavg').split(' ')[0]);
  if (load > cores * 1.5) out.push(bad(`Serwer jest przeciążony (obciążenie ${load.toFixed(2)} przy ${cores} rdzeniach)`, 'Zobacz, co zajmuje procesor.', null, '#/wydajnosc'));
  else if (load > cores) out.push(warn(`Serwer jest mocno zajęty (obciążenie ${load.toFixed(2)})`, '', null, '#/wydajnosc'));
  else out.push(ok(`Procesor ma zapas (obciążenie ${load.toFixed(2)} przy ${cores} rdzeniach)`));
  const top = (await busyProcs()).filter((p) => p.cpu > 25).slice(0, 3);
  if (top.length) out.push(warn('Najbardziej zajęte procesy (teraz)', top.map((p) => `${p.name} — ${Math.round(p.cpu)}% procesora, ${Math.round(p.rss / 1024)} MB`).join('\n'), null, '#/wydajnosc'));
  const tp = await S.testProcs().catch(() => []);
  if (tp.length) out.push(warn(`${tp.length} procesów testowych zajmuje ${Math.round(tp.reduce((a, p) => a + p.rss, 0) / 1048576)} MB`, 'To pozostałości po pracy Claude — można je zatrzymać.', { id: 'testowe', args: {}, label: 'Zatrzymaj je' }));
  out.push(...resources());
  return out;
}

/** Zużycie procesora w tej chwili (pomiar 1 s), bez samego pomiaru. */
export async function busyProcs() {
  const snap = () => {
    const m = new Map();
    for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      try {
        const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const name = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')'));
        const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
        m.set(pid, { name, t: Number(f[11]) + Number(f[12]), rss: Number(f[21]) * 4 });
      } catch {}
    }
    return m;
  };
  const a = snap(); const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 1000));
  const b = snap(); const dt = (Date.now() - t0) / 1000;
  const out = [];
  for (const [pid, x] of b) { const y = a.get(pid); if (!y || pid === String(process.pid)) continue; const cpu = (x.t - y.t) / 100 / dt * 100; if (cpu > 0.5) out.push({ pid: Number(pid), name: x.name, cpu, rss: x.rss }); }
  return out.sort((p, q) => q.cpu - p.cpu);
}

/* ----------------------------------------------------------- logowanie */

async function checkLogin(target, clientIp) {
  const out = [];
  if (clientIp) {
    const jails = await AP.fail2ban().catch(() => []);
    const hit = jails.filter((j) => j.ips.includes(clientIp));
    if (hit.length) out.push(bad(`Twój adres ${clientIp} jest zablokowany`, `Ochrona logowania (fail2ban, ${hit.map((j) => j.jail).join(', ')}) zablokowała go po kilku nieudanych próbach.`, { id: 'odbanuj', args: { ip: clientIp, jails: hit.map((j) => j.jail) }, label: 'Odblokuj mój adres' }));
    else out.push(ok(`Twój adres ${clientIp} nie jest zablokowany`));
  }
  if (target === 'panel') {
    const n = ctx.fails(clientIp);
    if (n >= 5) out.push(bad('Panel wstrzymał logowanie z Twojego adresu', `${n} nieudanych prób w ostatnich 15 minutach.`, { id: 'panel-proby', args: { ip: clientIp }, label: 'Wyczyść nieudane próby' }));
    else out.push(ok('Panel nie blokuje Twojego adresu'));
    out.push(info('Nie pamiętasz hasła albo zgubiłeś telefon z kodami?', 'Właściciel może nadać nowe hasło innym kontom (Konto → Osoby z dostępem). Dla swojego konta: w terminalu serwera uruchom /opt/panel-serwera/reset-2fa.sh.'));
    return out;
  }
  const s = S.siteConfigs().find((x) => x.name === target);
  if (s) {
    let extras = null; try { extras = T.extrasInfo(s.name); } catch {}
    if (extras?.password?.on) out.push(info('Strona ma dodatkowe hasło (okienko przeglądarki)', `Login: ${extras.password.user}. Nowe hasło ustawisz w karcie strony → Ochrona.`, null, `#/strona/${encodeURIComponent(s.name)}/ochrona`));
    const r = await curl(s.name, { https: s.https });
    out.push(r.code && r.code < 500 ? ok(`Strona odpowiada (kod ${r.code})`) : bad(`Strona nie działa (kod ${r.code || 'brak'})`, 'Problem nie jest w haśle — sprawdź „Strona się nie otwiera”.'));
    const gc = CFG().gibcord;
    if (gc?.usluga && gc.domena === s.name) {
      const sv = (await S.services()).find((x) => x.unit === gc.usluga);
      out.push(sv?.active ? ok('GibCord działa') : bad('GibCord nie działa', '', { id: 'restart', args: { unit: gc.usluga }, label: 'Uruchom GibCorda' }));
      out.push(info('Zapomniane hasło do GibCorda', 'Administrator GibCorda może zresetować hasło w panelu admina GibCorda (Osoby → konto → Nowe hasło).'));
    }
  }
  return out;
}

/* ---------------------------------------------------------- serwer gry */

function tcp(host, port, ms = 4000) {
  return new Promise((resolve) => { const s = net.connect({ host, port, timeout: ms }); const done = (v) => { s.destroy(); resolve(v); }; s.on('connect', () => done(true)); s.on('timeout', () => done(false)); s.on('error', () => done(false)); });
}
async function checkGame(id) {
  const out = [];
  const gHost = (CFG().gry?.panel || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!gHost) return [info('Panel gier nie jest ustawiony', 'Dodaj adres panelu Pterodactyl w konfiguracji (moduł „Serwery gier”).')];
  const panel = await curl(gHost);
  out.push(panel.code && panel.code < 500 ? ok(`Panel gier (${gHost}) działa`) : bad(`Panel gier nie działa (kod ${panel.code || 'brak'})`, 'Bez niego serwery w domu nie dostają poleceń.', { id: 'stale', args: {}, label: 'Uruchom ponownie Apache i PHP' }));
  const q = (await S.services()).find((x) => x.unit === 'pteroq');
  if (q) out.push(q.active ? ok('Kolejka panelu gier działa') : bad('Kolejka panelu gier nie działa', 'Start/stop serwerów nie dochodzi do skutku.', { id: 'restart', args: { unit: 'pteroq' }, label: 'Uruchom kolejkę' }));
  let nodes = CFG().dom?.host ? [{ fqdn: CFG().dom.host, port: 8080 }] : [];
  try { const r = await run('mysql', ['-N', '-B', '-e', `SELECT fqdn, daemonListen FROM \`${(CFG().gry?.baza || 'panel').replace(/[^A-Za-z0-9_]/g, '')}\`.nodes LIMIT 5`]); const l = r.out.trim().split('\n').filter(Boolean).map((x) => x.split('\t')); if (l.length) nodes = l.map(([fqdn, port]) => ({ fqdn, port: Number(port) || 8080 })); } catch {}
  for (const n of nodes) {
    let home = '';
    try { home = (await dns.resolve4(n.fqdn))[0]; } catch {}
    if (!home) { out.push(bad(`Nie znam adresu ${n.fqdn}`, 'Rekord DNS zniknął albo dynamiczny DNS przestał się aktualizować.')); continue; }
    const wings = await tcp(home, n.port);
    out.push(wings ? ok(`Serwer gier w domu odpowiada (${n.fqdn}, ${home})`) : bad(`Serwer gier w domu nie odpowiada (${n.fqdn}, ${home}:${n.port})`, 'Komputer w domu jest wyłączony, nie ma internetu albo router nie przekierowuje portów. Tego nie naprawię z tego serwera — sprawdź komputer w domu.'));
  }
  if (G.ready()) {
    try {
      const g = (await G.list()).find((x) => x.id === id);
      if (!g) out.push(warn('Nie widzę tego serwera gry w panelu gier'));
      else if (g.suspended) out.push(bad('Serwer gry jest zawieszony w panelu gier'));
      else if (g.installing) out.push(warn('Serwer gry właśnie się instaluje'));
      else if (g.state === 'running') out.push(ok(`${g.name} działa${g.players ? ` — gracze: ${g.players.online}${g.players.max ? '/' + g.players.max : ''}` : ''}`, g.address ? `Adres: ${g.address}` : ''));
      else out.push(bad(`${g.name} jest wyłączony (${g.state})`, '', { id: 'gra-start', args: { id: g.id }, label: 'Uruchom serwer gry' }, '#/gry'));
    } catch (e) { out.push(warn('Nie udało się zapytać panelu gier', e.message, null, '#/gry')); }
  } else out.push(info('Panel nie jest połączony z panelem gier', 'Wklej klucz w „Serwery gier”, a sprawdzę też stan samego serwera.', null, '#/gry'));
  return out;
}

/* ----------------------------------------------------------- usługa */

async function checkService(unit) {
  const sv = (await S.services(true)).find((x) => x.unit === unit);
  if (!sv) return [bad('Nie ma takiej usługi')];
  const out = [];
  if (sv.failed) out.push(bad(`${sv.name} padła`, `Ostatni wynik: ${sv.result || 'błąd'}. Fragment logu niżej.`, { id: 'restart', args: { unit }, label: 'Uruchom ponownie' }));
  else if (!sv.active) out.push(bad(`${sv.name} jest zatrzymana`, '', { id: 'restart', args: { unit }, label: 'Uruchom' }));
  else out.push(ok(`${sv.name} działa${sv.since ? ' od ' + new Date(sv.since).toLocaleString('pl-PL') : ''}`, sv.mem ? `zajmuje ${Math.round(sv.mem / 1048576)} MB pamięci` : ''));
  if (sv.restarts > 3) out.push(warn(`Usługa restartowała się ${sv.restarts} razy`, 'Coś ją co jakiś czas wywraca — zajrzyj do logu.'));
  const j = await run('journalctl', ['-u', unit, '-n', '60', '--no-pager', '-o', 'short-iso', '--since', '-6h']);
  const errs = j.out.split('\n').filter((l) => /error|fatal|exception|failed|unhandled|EADDRINUSE|ENOENT|EACCES/i.test(l)).slice(-4);
  if (errs.length) out.push(warn('Błędy w logu z ostatnich 6 godzin', errs.map((l) => l.replace(/^\S+ \S+ /, '').slice(0, 220)).join('\n'), null, `#/logi?z=${encodeURIComponent('j:' + unit)}`));
  else out.push(ok('Brak błędów w logu z ostatnich 6 godzin'));
  const stale = (await AP.staleUnits().catch(() => [])).find((x) => x.unit === unit);
  if (stale) out.push(warn('Usługa ma w pamięci stare biblioteki po aktualizacji', stale.libs.join(', '), { id: 'restart', args: { unit }, label: 'Uruchom ponownie' }));
  out.push(...resources());
  return out;
}

/* ------------------------------------------------------------- poczta */

async function checkMail() {
  const out = [];
  const p25 = await run('ss', ['-Hltnp', 'sport = :25']);
  const proc = (p25.out.match(/users:\(\("([^"]+)"/) || [])[1];
  out.push(proc ? ok(`Poczta przychodząca działa (port 25: ${proc})`) : warn('Nic nie odbiera poczty na porcie 25', 'Maile na adresy na tym serwerze nie dojdą.'));
  try { const fw = F.settings(); if ((await F.status()).active && !fw.services.poczta) out.push(bad('Zapora blokuje pocztę przychodzącą (port 25)', '', null, '#/zapora')); } catch {}
  for (const d of [CFG().gibcord?.domena, CFG().domena].filter(Boolean)) {
    try { const mx = await dns.resolveMx(d); out.push(mx.length ? ok(`Rekord MX dla ${d}: ${mx.map((x) => x.exchange).join(', ')}`) : warn(`Brak rekordu MX dla ${d}`)); } catch { out.push(info(`Brak rekordu MX dla ${d}`, 'Jeśli nie odbierasz poczty na tej domenie, to w porządku.')); }
  }
  const gcu = CFG().gibcord?.usluga;
  const dc = gcu ? (await S.services()).find((x) => x.unit === gcu) : null;
  if (dc) out.push(dc.active ? ok('GibCord (wysyłka maili) działa') : bad('GibCord nie działa — nie wysyła maili', '', { id: 'restart', args: { unit: gcu }, label: 'Uruchom GibCorda' }));
  const j = gcu ? await run('journalctl', ['-u', gcu, '--since', '-24h', '--no-pager', '-o', 'cat']) : { out: '' };
  const mailErr = j.out.split('\n').filter((l) => /(mail|smtp|resend)/i.test(l) && /(error|fail|błąd|rejected|invalid)/i.test(l)).slice(-3);
  if (mailErr.length) out.push(warn('Błędy wysyłki w logu GibCorda (24 h)', mailErr.join('\n').slice(0, 600)));
  else if (dc) out.push(ok('Brak błędów wysyłki w logu GibCorda (24 h)'));
  const ap = AP.settings();
  out.push(ap.notify?.email ? ok('Powiadomienia panelu mają ustawiony adres e-mail') : info('Panel nie ma ustawionego adresu e-mail do powiadomień', 'Ustawisz go na stronie Autopilot.', null, '#/autopilot'));
  return out;
}

/* ---------------------------------------------------------- wejście */

export async function check(problem, target, { clientIp } = {}) {
  const t0 = Date.now();
  let checks;
  switch (problem) {
    case 'strona': checks = await checkSite(String(target || '')); break;
    case 'wolno': checks = await checkSlow(String(target || '')); break;
    case 'logowanie': checks = await checkLogin(String(target || 'panel'), clientIp); break;
    case 'gra': checks = await checkGame(String(target || '')); break;
    case 'usluga': checks = await checkService(String(target || '')); break;
    case 'poczta': checks = await checkMail(); break;
    case 'serwer': checks = await serverLoad(); break;
    default: throw new Error('Nieznany problem.');
  }
  const worst = checks.some((c) => c.status === 'bad') ? 'bad' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { checks, worst, ms: Date.now() - t0 };
}

/** Naprawy — tylko z tej listy. Zwraca opis tego, co zrobiono. */
export async function fix(id, args = {}, who = {}) {
  switch (id) {
    case 'restart': {
      const unit = String(args.unit || '');
      const sv = (await S.services(true)).find((x) => x.unit === unit);
      if (!sv) throw new Error('Nie ma takiej usługi.');
      await S.serviceAction(unit, sv.active ? 'restart' : 'start');
      return `${sv.name}: ${sv.active ? 'uruchomiono ponownie' : 'uruchomiono'}.`;
    }
    case 'stale': { const done = await AP.restartStale('naprawa z panelu'); return done.length ? `Odświeżono: ${done.join(', ')}.` : 'Nic nie wymagało odświeżenia — uruchamiam ponownie Apache.' + (await S.serviceAction('apache2', 'restart'), ''); }
    case 'wlacz-strone': await S.setSiteEnabled(String(args.name), true, ctx.panelHosts); return 'Strona włączona.';
    case 'ssl': { const [cmd, a] = await S.renewCert(String(args.name)); const r = await run(cmd, a, { timeout: 180000 }); S.certs.reset(); S.sites.reset(); if (!r.ok) throw new Error('Nie udało się odnowić: ' + (r.err || r.out).trim().split('\n').slice(-2).join(' ')); return 'Certyfikat odnowiony.'; }
    case 'przerwa-off': await T.setMaintenance(String(args.name), { on: false }); return 'Przerwa techniczna wyłączona.';
    case 'sprzataj': { const done = []; for (const c of await S.cleanupCandidates()) if (['przegladarka', 'apt', 'dziennik', 'cache'].includes(c.id) && c.size > 0) { try { await S.cleanup(c.id); done.push(c.name.toLowerCase()); } catch {} } return done.length ? `Posprzątano: ${done.join(', ')}.` : 'Nie było czego bezpiecznie usunąć — zobacz stronę Dysk.'; }
    case 'testowe': { const k = await S.killTestProcs((await S.testProcs()).map((x) => x.pid)); return `Zatrzymano ${k.length} procesów.`; }
    case 'odbanuj': { const ip = String(args.ip || ''); for (const j of [].concat(args.jails || [])) await AP.unban(String(j), ip); return `Odblokowano ${ip}.`; }
    case 'panel-proby': ctx.clearFails(String(args.ip || '')); return 'Wyczyszczono nieudane próby logowania.';
    case 'gra-start': await G.power(String(args.id), 'start'); return 'Wysłano polecenie startu — serwer wstaje zwykle w minutę.';
    case 'dns-ovh': { if (!ctx.ovh) throw new Error('OVH nie jest podłączone.'); await ctx.ovh.ensure(String(args.name)); return 'Rekord w OVH ustawiony — zacznie działać w ciągu kilku minut.'; }
    default: throw new Error('Nieznana naprawa.');
  }
}
