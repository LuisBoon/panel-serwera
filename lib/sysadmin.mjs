// System: wydajność (historia zasobów, co zjada pamięć, prognoza dysku), aktualizacje i restart serwera
// o wybranej godzinie (z kontrolą po restarcie), harmonogram zadań do edycji i własne alarmy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, spawnCollect, readText, exists, sleep } from './util.mjs';
import * as S from './system.mjs';
import * as J from './journal.mjs';
import { C as CFG, publicUrl } from './config.mjs';

let db, DATA_DIR, notify = async () => {}, event = () => {};
const CRON_FILE = '/etc/cron.d/panel-serwera';
const RUNNER = '/usr/local/sbin/panel-harmonogram';
let JOBS_DIR = '/var/lib/panel-serwera/harmonogram';
const LOG_DIR = '/var/log/panel-harmonogram';

export function init(database, dataDir, opts = {}) {
  db = database; DATA_DIR = dataDir; JOBS_DIR = path.join(dataDir, 'harmonogram');
  notify = opts.notify || notify; event = opts.event || event;
  db.exec(`CREATE TABLE IF NOT EXISTS zasoby(ts INTEGER PRIMARY KEY, cpu REAL, mem REAL, disk INTEGER, load REAL, rx INTEGER, tx INTEGER);
           CREATE TABLE IF NOT EXISTS harmonogram(id TEXT PRIMARY KEY, name TEXT, kind TEXT, target TEXT, sched TEXT, enabled INTEGER, created INTEGER, by TEXT);
           CREATE TABLE IF NOT EXISTS alarmy(id TEXT PRIMARY KEY, metric TEXT, target TEXT, op TEXT, value REAL, minutes INTEGER, enabled INTEGER, created INTEGER, by TEXT, since INTEGER, fired INTEGER, last TEXT);`);
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  ensureRunner();
  J.afterRestore('cron', async () => { writeCron(); });
}
function kv(k, v) {
  if (v === undefined) { const r = db.prepare('SELECT v FROM ustawienia WHERE k=?').get(k); try { return r ? JSON.parse(r.v) : null; } catch { return null; } }
  db.prepare('INSERT OR REPLACE INTO ustawienia(k,v) VALUES(?,?)').run(k, JSON.stringify(v));
}

/* ---------------------------------------------------------------- zasoby */

function cpuTimes() { const f = readText('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number); return { idle: f[3] + (f[4] || 0), total: f.reduce((a, b) => a + b, 0) }; }
function netBytes() { let rx = 0, tx = 0; for (const l of readText('/proc/net/dev').split('\n').slice(2)) { const [n, rest] = l.split(':'); if (!rest || n.trim() === 'lo') continue; const f = rest.trim().split(/\s+/).map(Number); rx += f[0]; tx += f[8]; } return { rx, tx }; }
let prev = null;
/** Co 5 minut: zapis próbki do historii (35 dni). */
export function sample() {
  const c = cpuTimes(), n = netBytes(), now = Date.now();
  if (prev) {
    const m = S.metrics();
    const cpu = c.total > prev.c.total ? (1 - (c.idle - prev.c.idle) / (c.total - prev.c.total)) * 100 : 0;
    db.prepare('INSERT OR REPLACE INTO zasoby(ts,cpu,mem,disk,load,rx,tx) VALUES(?,?,?,?,?,?,?)').run(now, Math.round(cpu * 10) / 10,
      Math.round((1 - m.mem.available / m.mem.total) * 1000) / 10, m.disk.used, Number(readText('/proc/loadavg').split(' ')[0]) || 0, Math.max(0, n.rx - prev.n.rx), Math.max(0, n.tx - prev.n.tx));
    db.prepare('DELETE FROM zasoby WHERE ts<?').run(now - 35 * 864e5);
  }
  prev = { c, n };
}
export function history(days = 30) {
  const since = Date.now() - days * 864e5;
  const rows = db.prepare('SELECT * FROM zasoby WHERE ts>=? ORDER BY ts').all(since);
  // do wykresu: średnie godzinowe (30 dni = 720 punktów)
  const bucket = days > 2 ? 3600e3 : 300e3;
  const out = new Map();
  for (const r of rows) {
    const k = Math.floor(r.ts / bucket) * bucket;
    let x = out.get(k); if (!x) out.set(k, x = { ts: k, n: 0, cpu: 0, mem: 0, disk: 0, load: 0, rx: 0, tx: 0, cpuMax: 0 });
    x.n++; x.cpu += r.cpu; x.mem += r.mem; x.disk = Math.max(x.disk, r.disk); x.load += r.load; x.rx += r.rx; x.tx += r.tx; x.cpuMax = Math.max(x.cpuMax, r.cpu);
  }
  return [...out.values()].map((x) => ({ ts: x.ts, cpu: x.cpu / x.n, cpuMax: x.cpuMax, mem: x.mem / x.n, disk: x.disk, load: x.load / x.n, rx: x.rx, tx: x.tx }));
}

const FRIENDLY0 = { apache2: 'Apache + PHP', mariadb: 'Baza MariaDB', 'redis-server': 'Redis', spamd: 'Filtr spamu (poczta)', exim4: 'Poczta (exim)', 'panel-serwera': 'Panel serwera', pteroq: 'Kolejka panelu gier', fail2ban: 'Ochrona logowania', tailscaled: 'Tailscale', coturn: 'Rozmowy (TURN)', 'php8.3-fpm': 'PHP (osobne procesy)', 'snapd': 'snapd', ssh: 'SSH', postgresql: 'PostgreSQL', mongod: 'MongoDB' };
const friendly = (u) => CFG().aplikacje?.[u]?.[0] || FRIENDLY0[u];
function groupOf(pid, comm, cmd) {
  const cg = readText(`/proc/${pid}/cgroup`);
  if (/claude/i.test(comm) || /\/claude(\s|$)|claude-code|@anthropic/.test(cmd)) return ['claude', 'Sesje Claude'];
  if (/chrom|headless_shell/i.test(comm)) return ['przegladarki', 'Przeglądarki testowe'];
  let m = cg.match(/system\.slice\/([^/\n]+)\.service/);
  if (m) { const u = m[1].replace(/@.*$/, ''); const base = u.startsWith('postgresql') ? 'postgresql' : u; return [base, friendly(base) || base]; }
  if (/user\.slice|session-\d+\.scope/.test(cg)) return ['sesje', 'Sesje terminala i SSH'];
  return ['inne', 'Inne procesy systemu'];
}
/** Pamięć i procesor w grupach (usługi, sesje). cpu z pomiaru 1 s. */
export async function usage() {
  const read = () => {
    const m = new Map();
    for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      try {
        const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const comm = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')'));
        const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
        m.set(pid, { comm, t: Number(f[11]) + Number(f[12]), rss: Number(f[21]) * 4096 });
      } catch {}
    }
    return m;
  };
  const a = read(); await sleep(1000); const b = read();
  const groups = new Map();
  for (const [pid, x] of b) {
    if (!x.rss) continue;
    let cmd = ''; try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').slice(0, 200); } catch {}
    const [id, name] = groupOf(pid, x.comm, cmd);
    let g = groups.get(id); if (!g) groups.set(id, g = { id, name, mem: 0, cpu: 0, procs: 0 });
    g.mem += x.rss; g.procs++;
    const y = a.get(pid); if (y) g.cpu += Math.max(0, (x.t - y.t)) / os.cpus().length;
  }
  const m = S.metrics();
  return { total: m.mem.total, used: m.mem.total - m.mem.available, available: m.mem.available, cores: os.cpus().length, groups: [...groups.values()].sort((p, q) => q.mem - p.mem) };
}
export function diskForecast() {
  const rows = db.prepare('SELECT ts, disk FROM zasoby WHERE ts>=? ORDER BY ts').all(Date.now() - 30 * 864e5);
  const m = S.metrics();
  if (rows.length < 12 * 24 * 2) return { free: m.disk.free, total: m.disk.total, days: null, perDay: null, note: 'Zbieram dane — prognoza pojawi się po 2 dniach.' };
  // regresja liniowa zajętości (bajty/dzień) z dziennych maksimów
  const daily = new Map(); for (const r of rows) { const d = Math.floor(r.ts / 864e5); daily.set(d, Math.max(daily.get(d) || 0, r.disk)); }
  const pts = [...daily.entries()];
  const n = pts.length, sx = pts.reduce((a, [x]) => a + x, 0), sy = pts.reduce((a, [, y]) => a + y, 0), sxx = pts.reduce((a, [x]) => a + x * x, 0), sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const slope = n > 1 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
  return { free: m.disk.free, total: m.disk.total, perDay: slope, days: slope > 1e6 ? Math.round(m.disk.free / slope) : null };
}
export async function tips(u) {
  const out = [];
  const g = (id) => u.groups.find((x) => x.id === id);
  const claude = g('claude'); if (claude && claude.mem > 400 * 1048576) out.push({ level: 'info', text: `Sesje Claude zajmują ${Math.round(claude.mem / 1048576)} MB. Zwolnią się same, gdy zakończysz rozmowę z Claude.` });
  const br = g('przegladarki'); if (br) out.push({ level: 'warn', text: `Przeglądarki testowe zajmują ${Math.round(br.mem / 1048576)} MB — to pozostałości po zrzutach ekranu.`, fix: 'testowe' });
  const spam = g('spamd'); if (spam && spam.mem > 250 * 1048576) out.push({ level: 'info', text: `Filtr spamu zajmuje ${Math.round(spam.mem / 1048576)} MB. Jest potrzebny, jeśli serwer odbiera pocztę (sprawdza ją pod kątem spamu).` });
  const swap = Number((readText('/proc/meminfo').match(/SwapTotal:\s+(\d+)/) || [])[1] || 0);
  if (!swap && u.available / u.total < 0.15) out.push({ level: 'warn', text: 'Serwer nie ma pliku wymiany (swap), a wolnej pamięci jest mało. Przy skoku zużycia system może zabić któryś proces.' });
  return out;
}

/* ------------------------------------------------------- aktualizacje i restart */

export async function updates() {
  const r = await run('apt', ['list', '--upgradable'], { timeout: 60000, env: { ...process.env, LANG: 'C' } });
  const pk = r.out.split('\n').map((l) => l.match(/^([^/]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/)).filter(Boolean)
    .map((m) => ({ name: m[1], to: m[3], from: m[4], security: /security/.test(m[2]) }));
  const reboot = exists('/var/run/reboot-required');
  const rpk = readText('/var/run/reboot-required.pkgs').split('\n').filter(Boolean);
  const log = readText('/var/log/unattended-upgrades/unattended-upgrades.log').split('\n').filter((l) => /Packages that will be upgraded|All upgrades installed|No packages found/.test(l)).slice(-1)[0] || '';
  const lastAuto = log ? Date.parse(log.slice(0, 19).replace(' ', 'T')) : null;
  const plan = kv('restart-plan');
  const boot = Date.now() - os.uptime() * 1000;
  return { packages: pk.sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name)), reboot, rebootPkgs: rpk, lastAuto, plan: plan?.at > Date.now() ? plan : null, boot, kernel: os.release(), lastCheck: kv('po-restarcie') };
}
export async function installUpdates(say) {
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'a' };
  say('▸ odświeżam listę pakietów\n');
  let r = await spawnCollect('apt-get', ['update'], { env });
  if (!r.ok) throw new Error('apt-get update nie wyszedł.');
  say('▸ instaluję aktualizacje\n');
  r = await spawnCollect('apt-get', ['-y', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'upgrade', '--with-new-pkgs'], { env, onData: say });
  if (!r.ok) throw new Error('Instalacja aktualizacji nie wyszła — szczegóły wyżej.');
  say(exists('/var/run/reboot-required') ? '▸ część zmian zadziała dopiero po restarcie serwera\n' : '');
  return true;
}
export function planRestart(at, who) {
  if (at == null) { kv('restart-plan', null); J.add(who, 'system', 'Anulowano zaplanowany restart serwera'); return null; }
  const t = Number(at);
  if (!Number.isFinite(t) || t < Date.now() + 60e3 || t > Date.now() + 14 * 864e5) throw new Error('Wybierz godzinę w ciągu najbliższych 14 dni (najwcześniej za minutę).');
  const plan = { at: t, by: who?.login || '' };
  kv('restart-plan', plan);
  J.add(who, 'system', `Zaplanowano restart serwera na ${new Date(t).toLocaleString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`, { type: 'restart-anuluj', data: {} });
  return plan;
}
J.handler?.('restart-anuluj', async () => { kv('restart-plan', null); });
/** Co minutę (z autopilota): czy pora na zaplanowany restart. */
export async function restartTick() {
  const p = kv('restart-plan');
  if (!p?.at || Date.now() < p.at) return;
  kv('restart-plan', null);
  kv('przed-restartem', { at: Date.now(), boot: Date.now() - os.uptime() * 1000 });
  event('aktualizacje', 'info', 'Restartuję serwer (zaplanowany restart)', { auto: true });
  await notify('Restart serwera', 'Serwer uruchamia się ponownie zgodnie z planem. Po starcie sprawdzę strony i usługi.', 'info');
  setTimeout(() => run('systemctl', ['reboot']), 8000);
}
/** Po starcie panelu: jeśli to pierwszy start po restarcie serwera — po 3 min sprawdź wszystko i daj znać. */
export function afterBoot() {
  const boot = Date.now() - os.uptime() * 1000;
  const last = kv('ostatni-boot');
  kv('ostatni-boot', boot);
  if (!last || Math.abs(last - boot) < 120e3) return;
  setTimeout(async () => {
    try {
      S.sites.reset(); S.services.reset();
      const sites = (await S.sites()).filter((s) => s.enabled && s.status !== 'nodns' && s.status !== 'off');
      const bad = sites.filter((s) => s.status === 'down');
      const svc = (await S.services(true)).filter((s) => s.group !== 'other' && s.enabled && !s.active);
      const ok = !bad.length && !svc.length;
      const text = ok ? `Serwer wstał po restarcie (${Math.round(os.uptime() / 60)} min temu). Wszystkie strony (${sites.length}) i usługi działają.` : `Serwer wstał po restarcie, ale: ${[...bad.map((s) => `strona ${s.name} nie działa`), ...svc.map((s) => `usługa ${s.name} nie działa`)].join(', ')}.`;
      kv('po-restarcie', { at: Date.now(), ok, text });
      event('aktualizacje', ok ? 'info' : 'error', text, { auto: true });
      const svcAll = (await S.services()).filter((s) => s.group !== 'other' && s.enabled);
      await notify('Serwer wstał po restarcie', text, ok ? 'ok' : 'error', { link: '#/pulpit', card: {
        level: ok ? 'ok' : 'error', title: 'Serwer wstał po restarcie', subtitle: `${new Date(Date.now() - os.uptime() * 1000).toLocaleString('pl-PL', { weekday: 'long', hour: '2-digit', minute: '2-digit' })} · jądro ${os.release()}`,
        badge: { text: ok ? 'Wszystko działa' : 'Coś nie wstało', level: ok ? 'ok' : 'error' },
        stats: [{ label: 'Strony', value: `${sites.length - bad.length} z ${sites.length}`, note: bad.length ? 'nie wszystkie działają' : 'działają', level: bad.length ? 'error' : 'ok' }, { label: 'Usługi', value: `${svcAll.length - svc.length} z ${svcAll.length}`, note: svc.length ? 'nie wszystkie wstały' : 'działają', level: svc.length ? 'error' : 'ok' }],
        sections: ok ? [] : [{ title: 'Do sprawdzenia', todo: true, items: [...bad.map((s) => ({ text: `Strona ${s.name} nie działa`, level: 'error', url: `${PANEL()}#/napraw?p=strona&t=${encodeURIComponent(s.name)}`, cta: 'Sprawdź' })), ...svc.map((s) => ({ text: `Usługa ${s.name} nie działa`, level: 'error', url: `${PANEL()}#/napraw?p=usluga&t=${encodeURIComponent(s.unit)}`, cta: 'Sprawdź' }))] }],
        buttons: [{ label: 'Otwórz panel', url: PANEL() + '#/pulpit' }],
      } });
    } catch (e) { console.error('panel: kontrola po restarcie', e.message); }
  }, 3 * 60e3).unref();
}

/* ----------------------------------------------------------- harmonogram */

const DAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
function ensureRunner() {
  const body = `#!/bin/bash
# Uruchamia zadanie z harmonogramu panelu serwera i zapisuje wynik do logu. Użycie: panel-harmonogram <id>
set -u
ID="$1"
[[ "$ID" =~ ^[a-z0-9]{6,16}$ ]] || exit 2
SCRIPT="${JOBS_DIR}/$ID.sh"
LOG="${LOG_DIR}/$ID.log"
mkdir -p "${LOG_DIR}"
[ -f "$SCRIPT" ] || { echo "brak zadania $ID" >&2; exit 2; }
{ echo "=== start $(date '+%Y-%m-%d %H:%M:%S')"; timeout 6h bash "$SCRIPT" 2>&1; rc=$?; echo "=== koniec $(date '+%Y-%m-%d %H:%M:%S') kod $rc"; } >> "$LOG" 2>&1
tail -c 200000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
`;
  if (readText(RUNNER) !== body) fs.writeFileSync(RUNNER, body, { mode: 0o755 });
}
/** Harmonogram z formularza → wyrażenie cron. */
export function toCron(s) {
  const n = (v, lo, hi, what) => { const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`Nieprawidłow${what}.`); return x; };
  const at = () => { const m = String(s.at || '').match(/^(\d{1,2}):(\d{2})$/); if (!m) throw new Error('Wpisz godzinę, np. 03:30.'); return [n(m[2], 0, 59, 'a minuta'), n(m[1], 0, 23, 'a godzina')]; };
  switch (s.every) {
    case 'minuta': return '* * * * *';
    case 'minuty': { const k = n(s.n, 2, 30, 'a liczba minut'); return `*/${k} * * * *`; }
    case 'godzina': return `${n(s.minute ?? 0, 0, 59, 'a minuta')} * * * *`;
    case 'dzien': { const [mi, h] = at(); return `${mi} ${h} * * *`; }
    case 'tydzien': { const [mi, h] = at(); return `${mi} ${h} * * ${n(s.dow, 0, 6, 'y dzień tygodnia')}`; }
    case 'miesiac': { const [mi, h] = at(); return `${mi} ${h} ${n(s.dom, 1, 28, 'y dzień miesiąca')} * *`; }
    case 'start': return '@reboot';
    case 'wlasne': { const e = String(s.cron || '').trim(); if (!/^(@(reboot|hourly|daily|weekly|monthly)|([\d*/,-]+\s+){4}[\d*/,-]+)$/.test(e)) throw new Error('Nieprawidłowe wyrażenie cron (5 pól, np. 30 3 * * *).'); return e; }
    default: throw new Error('Wybierz, kiedy uruchamiać.');
  }
}
export function cronHuman(e) {
  const [mi, h, dom, , dow] = e.split(/\s+/);
  const p = (x) => String(x).padStart(2, '0');
  if (e === '@reboot') return 'przy starcie serwera';
  if (e === '* * * * *') return 'co minutę';
  let m;
  if ((m = mi.match(/^\*\/(\d+)$/)) && h === '*') return `co ${m[1]} min`;
  if (/^\d+$/.test(mi) && h === '*') return `co godzinę (o :${p(mi)})`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(h)) {
    const t = `${p(h)}:${p(mi)}`;
    if (dom === '*' && dow === '*') return `codziennie o ${t}`;
    if (dom === '*' && /^\d$/.test(dow)) return `w każdy ${DAYS[Number(dow)]} o ${t}`.replace('w każdy środa', 'w każdą środę').replace('w każdy sobota', 'w każdą sobotę').replace('w każdy niedziela', 'w każdą niedzielę');
    if (/^\d+$/.test(dom)) return `co miesiąc ${dom}. dnia o ${t}`;
  }
  return e;
}
/** Najbliższe uruchomienie (prosto: minuta po minucie do 32 dni). */
export function nextRun(e) {
  if (e.startsWith('@')) return null;
  const [mi, h, dom, mon, dow] = e.split(/\s+/);
  const match = (f, v) => f === '*' || f.split(',').some((part) => { const [r, st] = part.split('/'); const step = Number(st || 1); if (r === '*') return v % step === 0; const [a, b] = r.split('-').map(Number); return v >= a && v <= (b ?? a) && (v - a) % step === 0; });
  const d = new Date(); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 32 * 1440; i++) {
    if (match(mi, d.getMinutes()) && match(h, d.getHours()) && match(dom, d.getDate()) && match(mon, d.getMonth() + 1) && match(dow, d.getDay())) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
const KINDS = { polecenie: 'polecenie', adres: 'otwarcie adresu', usluga: 'restart usługi' };
function scriptFor(kind, target) {
  if (kind === 'polecenie') { const c = String(target || '').trim(); if (!c || c.length > 4000) throw new Error('Wpisz polecenie.'); return `#!/bin/bash\n${c}\n`; }
  if (kind === 'adres') { const u = String(target || '').trim(); if (!/^https?:\/\/[^\s'"]+$/.test(u)) throw new Error('Wpisz adres, np. https://strona.example.pl/cron.php'); return `#!/bin/bash\ncurl -fsS -m 300 -A 'panel-serwera (harmonogram)' '${u}' -o /dev/null -w 'HTTP %{http_code}, %{time_total} s\\n'\n`; }
  if (kind === 'usluga') { const u = String(target || '').trim(); if (!/^[a-z0-9@._-]+$/i.test(u)) throw new Error('Wybierz usługę.'); return `#!/bin/bash\nsystemctl restart '${u}' && echo "uruchomiono ponownie ${u}"\n`; }
  throw new Error('Wybierz, co zadanie ma robić.');
}
function writeCron() {
  const rows = db.prepare('SELECT * FROM harmonogram ORDER BY created').all();
  const lines = [`# Zadania z harmonogramu panelu serwera (${CFG().adres || 'panel'} → Harmonogram). Nie edytuj ręcznie — panel nadpisze plik.`, 'SHELL=/bin/bash', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ''];
  for (const r of rows) lines.push(`# ${r.id} ${r.name.replace(/\n/g, ' ')}`, `${r.enabled ? '' : '# (wyłączone) '}${r.sched} root ${RUNNER} ${r.id}`);
  fs.writeFileSync(CRON_FILE, lines.join('\n') + '\n', { mode: 0o644 });
}
function lastRun(id) {
  const t = readText(path.join(LOG_DIR, id + '.log'));
  const i = t.lastIndexOf('=== start ');
  if (i < 0) return null;
  const part = t.slice(i);
  const start = Date.parse(part.slice(10, 29).replace(' ', 'T'));
  const end = part.match(/=== koniec (\S+ \S+) kod (\d+)/);
  return { start, end: end ? Date.parse(end[1].replace(' ', 'T')) : null, code: end ? Number(end[2]) : null, out: part.replace(/^=== start [^\n]*\n/, '').replace(/=== koniec[^\n]*\n?$/, '').slice(-4000) };
}
export function cronJobs() {
  return db.prepare('SELECT * FROM harmonogram ORDER BY created').all().map((r) => ({ ...r, enabled: !!r.enabled, human: cronHuman(r.sched), next: r.enabled ? nextRun(r.sched) : null, kindName: KINDS[r.kind], last: lastRun(r.id) }));
}
export function cronSave(b, who) {
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) throw new Error('Nazwij zadanie, np. „Czyszczenie starych plików”.');
  const sched = toCron(b.when || {});
  const script = scriptFor(b.kind, b.target);
  const id = b.id && /^[a-z0-9]{6,16}$/.test(b.id) ? b.id : crypto.randomBytes(5).toString('hex');
  const old = db.prepare('SELECT * FROM harmonogram WHERE id=?').get(id);
  const undo = [J.fileBefore(CRON_FILE, ['cron']), J.fileBefore(path.join(JOBS_DIR, id + '.sh'))];
  fs.writeFileSync(path.join(JOBS_DIR, id + '.sh'), script, { mode: 0o700 });
  db.prepare('INSERT OR REPLACE INTO harmonogram(id,name,kind,target,sched,enabled,created,by) VALUES(?,?,?,?,?,?,?,?)').run(id, name, b.kind, String(b.target || ''), sched, b.enabled === false ? 0 : 1, old?.created || Date.now(), who?.login || '');
  writeCron();
  J.add(who, 'harmonogram', `${old ? 'Zmieniono' : 'Nowe'} zadanie „${name}” (${cronHuman(sched)})`, { type: 'harmonogram-stan', data: { files: undo, row: old || null, id } }, '#/cron');
  return cronJobs().find((x) => x.id === id);
}
J.handler?.('harmonogram-stan', async (d) => {
  for (const f of d.files) { if (f.content == null) fs.rmSync(f.path, { force: true }); else fs.writeFileSync(f.path, Buffer.from(f.content, 'base64'), { mode: f.mode || 0o644 }); }
  if (d.row) db.prepare('INSERT OR REPLACE INTO harmonogram(id,name,kind,target,sched,enabled,created,by) VALUES(?,?,?,?,?,?,?,?)').run(d.row.id, d.row.name, d.row.kind, d.row.target, d.row.sched, d.row.enabled, d.row.created, d.row.by);
  else db.prepare('DELETE FROM harmonogram WHERE id=?').run(d.id);
  writeCron();
});
export function cronDelete(id, who) {
  const r = db.prepare('SELECT * FROM harmonogram WHERE id=?').get(String(id));
  if (!r) throw new Error('Nie ma takiego zadania.');
  const undo = [J.fileBefore(CRON_FILE, ['cron']), J.fileBefore(path.join(JOBS_DIR, r.id + '.sh'))];
  db.prepare('DELETE FROM harmonogram WHERE id=?').run(r.id);
  fs.rmSync(path.join(JOBS_DIR, r.id + '.sh'), { force: true });
  writeCron();
  J.add(who, 'harmonogram', `Usunięto zadanie „${r.name}”`, { type: 'harmonogram-stan', data: { files: undo, row: r, id: r.id } }, '#/cron');
}
export function cronToggle(id, on, who) {
  const r = db.prepare('SELECT * FROM harmonogram WHERE id=?').get(String(id));
  if (!r) throw new Error('Nie ma takiego zadania.');
  db.prepare('UPDATE harmonogram SET enabled=? WHERE id=?').run(on ? 1 : 0, r.id);
  writeCron();
  J.add(who, 'harmonogram', `${on ? 'Włączono' : 'Wyłączono'} zadanie „${r.name}”`, null, '#/cron');
}
export async function cronRunNow(id, say) {
  const r = db.prepare('SELECT * FROM harmonogram WHERE id=?').get(String(id));
  if (!r) throw new Error('Nie ma takiego zadania.');
  say(`▸ uruchamiam „${r.name}”\n`);
  const res = await spawnCollect(RUNNER, [r.id]);
  const l = lastRun(r.id);
  say((l?.out || '').trim() + '\n');
  say(l?.code === 0 ? '✓ zakończone bez błędu\n' : `✗ zakończone z kodem ${l?.code ?? res.code}\n`);
  return l?.code === 0;
}

/* -------------------------------------------------------------- alarmy */

export const METRICS = {
  pamiec: { name: 'pamięć', unit: '%', needs: null },
  procesor: { name: 'procesor', unit: '%', needs: null },
  dysk: { name: 'zajętość dysku', unit: '%', needs: null },
  obciazenie: { name: 'obciążenie serwera', unit: '', needs: null },
  strona: { name: 'strona nie działa', unit: '', needs: 'site', bool: true },
  wolna: { name: 'strona odpowiada wolniej niż', unit: 'ms', needs: 'site' },
  usluga: { name: 'usługa nie działa', unit: '', needs: 'service', bool: true },
  gra: { name: 'serwer gry wyłączony', unit: '', needs: 'game', bool: true },
};
export function alarms() { return db.prepare('SELECT * FROM alarmy ORDER BY created').all().map((a) => ({ ...a, enabled: !!a.enabled, fired: !!a.fired })); }
export function alarmSave(b, who) {
  const m = METRICS[b.metric];
  if (!m) throw new Error('Wybierz, czego pilnować.');
  const target = m.needs ? String(b.target || '').trim() : '';
  if (m.needs && !target) throw new Error('Wybierz, której strony / usługi / gry to dotyczy.');
  const value = m.bool ? 0 : Number(b.value);
  if (!m.bool && (!Number.isFinite(value) || value <= 0)) throw new Error('Wpisz próg, np. 90.');
  const minutes = Math.max(1, Math.min(240, Math.round(Number(b.minutes) || 5)));
  const id = b.id && /^[a-z0-9]{6,16}$/.test(b.id) ? b.id : crypto.randomBytes(5).toString('hex');
  db.prepare('INSERT OR REPLACE INTO alarmy(id,metric,target,op,value,minutes,enabled,created,by,since,fired,last) VALUES(?,?,?,?,?,?,?,COALESCE((SELECT created FROM alarmy WHERE id=?),?),?,NULL,0,NULL)')
    .run(id, b.metric, target, '>', value, minutes, b.enabled === false ? 0 : 1, id, Date.now(), who?.login || '');
  J.add(who, 'system', `Alarm: ${alarmText({ metric: b.metric, target, value, minutes })}`, null, '#/autopilot');
  return alarms();
}
export function alarmDelete(id, who) { const a = db.prepare('SELECT * FROM alarmy WHERE id=?').get(String(id)); if (!a) throw new Error('Nie ma takiego alarmu.'); db.prepare('DELETE FROM alarmy WHERE id=?').run(a.id); J.add(who, 'system', `Usunięto alarm: ${alarmText(a)}`, null, '#/autopilot'); return alarms(); }
export function alarmText(a) {
  const m = METRICS[a.metric];
  if (!m) return a.metric;
  if (m.bool) return `${a.target ? a.target + ': ' : ''}${m.name} przez ${a.minutes} min`;
  return `${a.target ? a.target + ': ' : ''}${m.name} ${a.metric === 'wolna' ? '' : 'powyżej '}${a.value}${m.unit === '%' ? '%' : m.unit ? ' ' + m.unit : ''} przez ${a.minutes} min`;
}
const PANEL = () => publicUrl();
/** Karta alarmu do GibCorda (wariant A). */
async function alarmCard(a, now, firing) {
  const m = METRICS[a.metric];
  const link = a.metric === 'strona' || a.metric === 'wolna' ? `#/strona/${encodeURIComponent(a.target)}` : a.metric === 'usluga' ? '#/uslugi' : a.metric === 'gra' ? '#/gry' : '#/wydajnosc';
  const sections = [];
  if (firing && (a.metric === 'pamiec' || a.metric === 'procesor')) {
    try {
      const u = await usage();
      const top = [...u.groups].sort((x, y) => (a.metric === 'pamiec' ? y.mem - x.mem : y.cpu - x.cpu)).slice(0, 3);
      sections.push({ title: 'Najwięcej zajmuje', items: top.map((g) => ({ text: a.metric === 'pamiec' ? `${g.name} — ${Math.round(g.mem / 1048576)} MB` : `${g.name} — ${Math.round(g.cpu)}% procesora` })) });
    } catch {}
  }
  return {
    link,
    card: {
      level: firing ? 'error' : 'ok',
      title: `${firing ? 'Alarm' : 'Alarm minął'}: ${m?.name || a.metric}${a.target ? ' — ' + a.target : ''}`,
      subtitle: firing ? `Jeśli ${alarmText(a)}` : 'wróciło do normy',
      badge: { text: firing ? `teraz ${now}` : `w normie (${now})`, level: firing ? 'error' : 'ok' },
      sections,
      buttons: [{ label: link === '#/wydajnosc' ? 'Wydajność' : 'Otwórz w panelu', url: PANEL() + link }, ...(firing ? [{ label: 'Coś nie działa?', url: PANEL() + '#/napraw' }] : [])],
    },
  };
}
/** Co minutę: ocena alarmów; powiadomienie po przekroczeniu czasu i po powrocie do normy. */
export async function alarmTick(ctx) {
  const list = alarms().filter((a) => a.enabled);
  if (!list.length) return;
  const m = S.metrics();
  const values = { pamiec: (1 - m.mem.available / m.mem.total) * 100, procesor: m.cpu?.pct ?? null, dysk: m.disk.used / m.disk.total * 100, obciazenie: Number(readText('/proc/loadavg').split(' ')[0]) };
  let sites = null, services = null, games = null;
  for (const a of list) {
    let hit = false, now = '';
    try {
      if (a.metric in values) { const v = values[a.metric]; if (v == null) continue; hit = v > a.value; now = `${String(Math.round(v * 10) / 10).replace('.', ',')}${METRICS[a.metric].unit}`; }
      else if (a.metric === 'strona' || a.metric === 'wolna') {
        sites ??= await S.sites();
        const s = sites.find((x) => x.name === a.target); if (!s) continue;
        if (a.metric === 'strona') { hit = s.status === 'down'; now = s.http?.code ? `kod ${s.http.code}` : 'brak odpowiedzi'; }
        else { hit = (s.http?.ms || 0) > a.value; now = `${s.http?.ms || 0} ms`; }
      } else if (a.metric === 'usluga') {
        services ??= await S.services(); const s = services.find((x) => x.unit === a.target); if (!s) continue;
        hit = !s.active; now = s.state;
      } else if (a.metric === 'gra' && ctx.games) {
        games ??= await ctx.games().catch(() => null); if (!games) continue;
        const g = games.find((x) => x.id === a.target || x.name === a.target); if (!g) continue;
        hit = g.state !== 'running'; now = g.state;
      }
    } catch { continue; }
    if (hit) {
      const since = a.since || Date.now();
      if (!a.since) db.prepare('UPDATE alarmy SET since=?, last=? WHERE id=?').run(since, now, a.id);
      if (!a.fired && Date.now() - since >= a.minutes * 60e3) {
        db.prepare('UPDATE alarmy SET fired=1, last=? WHERE id=?').run(now, a.id);
        await notify('Alarm', `${alarmText(a)} — teraz: ${now}`, 'error', await alarmCard(a, now, true));
        event('alarm', 'error', `Alarm: ${alarmText(a)} (teraz ${now})`, { auto: true });
      }
    } else if (a.since) {
      db.prepare('UPDATE alarmy SET since=NULL, fired=0, last=? WHERE id=?').run(now, a.id);
      if (a.fired) { await notify('Alarm minął', `${alarmText(a)} — wróciło do normy (${now})`, 'ok', await alarmCard(a, now, false)); event('alarm', 'info', `Alarm minął: ${alarmText(a)}`, { auto: true }); }
    }
  }
}
