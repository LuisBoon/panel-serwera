// Bezpieczeństwo (wariant A · Ocena i lista): wynik 0–100 i lista spraw z przyciskiem „Napraw”.
// Sprawdza logowanie do SSH, zaporę i porty widoczne z internetu, restart po aktualizacjach jądra,
// automatyczne aktualizacje, fail2ban, LLMNR, certyfikaty i logowanie do panelu.
import fs from 'node:fs';
import { run, readText, exists } from './util.mjs';
import * as AC from './access.mjs';
import * as FW from './firewall.mjs';
import * as SA from './sysadmin.mjs';
import * as S from './system.mjs';
import * as J from './journal.mjs';

let ctx = { users: () => 0, startJob: null };
J.afterRestore?.('resolved', async () => { await run('systemctl', ['restart', 'systemd-resolved']); });
export function init(c) { ctx = { ...ctx, ...c }; }

const AUTO_UPG = '/etc/apt/apt.conf.d/20auto-upgrades';
const LLMNR_DROPIN = '/etc/systemd/resolved.conf.d/panel-llmnr.conf';
const WEIGHT = { bad: 18, warn: 6 };

const item = (id, status, title, text = '', extra = {}) => ({ id, status, title, text, ...extra });
async function sshFailed(days = 30) {
  const r = await run('journalctl', ['-u', 'ssh', '--since', `-${days}d`, '--no-pager', '-o', 'short-unix', '--grep', 'Failed password|Invalid user'], { timeout: 30000 });
  const lines = r.out.split('\n').filter((l) => /^\d/.test(l));
  const first = lines.length ? Number(lines[0].split('.')[0]) * 1000 : null;
  return { count: lines.length, days: first ? Math.max(1, Math.round((Date.now() - first) / 864e5)) : days };
}
async function fail2ban() {
  const on = (await run('systemctl', ['is-active', 'fail2ban'])).out.trim() === 'active';
  if (!on) return { installed: exists('/usr/bin/fail2ban-client'), on: false };
  const s = await run('fail2ban-client', ['status', 'sshd']);
  const n = (k) => Number((s.out.match(new RegExp(`${k}:\\s*(\\d+)`)) || [])[1] || 0);
  const ips = ((s.out.match(/Banned IP list:\s*(.*)/) || [])[1] || '').trim().split(/\s+/).filter(Boolean);
  return { installed: true, on: true, banned: n('Currently banned'), total: n('Total banned'), ips };
}
function llmnrOpen() {
  const t = readText('/proc/net/udp') + readText('/proc/net/udp6');
  return /:14EB /.test(t) && !/^LLMNR=no/m.test(readText(LLMNR_DROPIN)); // 0x14EB = 5355
}

/** Wszystkie sprawdzenia + wynik. */
export async function check() {
  const out = [];
  const [k, fwOn, fwSt, upd, f2b, failed, certs] = await Promise.all([
    AC.keys(), FW.active(), FW.status().catch(() => null), SA.updates().catch(() => null), fail2ban(), sshFailed(), S.certs().catch(() => []),
  ]);
  // 1. logowanie roota hasłem
  const usedKeys = k.keys.filter((x) => x.last && Date.now() - x.last.ts < 90 * 864e5);
  if (k.rootLogin === 'yes' && k.password !== 'no') {
    out.push(item('ssh-haslo', 'bad', 'Do roota można się logować hasłem',
      `${failed.count} nieudanych prób logowania w ${failed.days} ${failed.days === 1 ? 'dzień' : 'dni'}. Logowanie roota tylko kluczem zatrzyma wszystkie. Konta SFTP dalej logują się hasłem.`,
      usedKeys.length ? { fix: { id: 'ssh-tylko-klucz', label: 'Tylko klucz SSH', owner: true, confirm: `Root będzie mógł się logować tylko kluczem. Używane klucze: ${usedKeys.map((x) => x.comment || x.fp.slice(0, 18)).join(', ')}. Jeśli coś pójdzie nie tak, hasło włączysz z powrotem w Dostęp → Klucze SSH albo w Terminalu panelu.` } }
        : { link: { href: '#/dostep', label: 'Najpierw dodaj swój klucz' }, hint: 'Żaden klucz nie logował się w ostatnich 90 dniach — panel nie wyłączy hasła, dopóki nie zalogujesz się kluczem.' }));
  } else out.push(item('ssh-haslo', 'ok', 'Root loguje się tylko kluczem SSH', `${k.keys.length} ${k.keys.length === 1 ? 'klucz' : 'klucze'} · ${failed.count} odrzuconych prób w ${failed.days} dni`));
  // 2. zapora
  const risky = fwSt?.risky || [];
  if (!fwOn) out.push(item('zapora', 'bad', `Zapora wyłączona${risky.length ? ` — ${risky.map((p) => `${p.label || 'port'} (${p.port})`).slice(0, 2).join(', ')} widać z internetu` : ''}`,
    'Bezpieczny zestaw zostawi SSH, strony i usługi z listy; resztę zamknie. Bezpiecznik sam ją wyłączy, jeśli serwer przestanie być osiągalny.', { link: { href: '#/zapora', label: 'Włącz zaporę', pri: true } }));
  else if (risky.length) out.push(item('zapora', 'warn', `Zapora działa, ale ${risky.length === 1 ? 'jeden port jest' : risky.length + ' porty są'} otwarte dla wszystkich`, risky.map((p) => `${p.label || 'port'} (${p.port})`).join(', '), { link: { href: '#/zapora', label: 'Pokaż zaporę' } }));
  else out.push(item('zapora', 'ok', 'Zapora działa', 'Z internetu widać tylko to, co ma być widać.'));
  // 3. restart po aktualizacji jądra / bibliotek
  if (upd?.reboot) {
    const plan = upd.plan;
    out.push(item('restart', plan ? 'ok' : 'warn', plan ? `Restart zaplanowany na ${new Date(plan.at).toLocaleString('pl-PL', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}` : 'Poprawki czekają na restart serwera',
      plan ? 'Po restarcie panel sam sprawdzi, czy wszystko wstało.' : `${(upd.rebootPkgs || []).length || 'Kilka'} ${upd.rebootPkgs?.length === 1 ? 'pakiet' : 'pakietów'} (np. ${(upd.rebootPkgs || ['jądro']).slice(0, 2).join(', ')}) zadziała dopiero po restarcie.`,
      plan ? {} : { fix: { id: 'restart-noca', label: 'Zaplanuj na 4:30', confirm: 'Serwer uruchomi się ponownie dziś w nocy o 4:30 (strony nie będą działać ok. 1–2 minuty). Możesz to anulować w Aktualizacjach.' } }));
  }
  // 4. aktualizacje
  const sec = (upd?.packages || []).filter((p) => p.security).length;
  const auto = /Unattended-Upgrade\s+"1"/.test(readText(AUTO_UPG));
  if (!auto) out.push(item('auto-aktualizacje', 'warn', 'Automatyczne poprawki bezpieczeństwa są wyłączone', 'Serwer może sam instalować poprawki bezpieczeństwa co noc (bez dużych zmian wersji).', { fix: { id: 'auto-aktualizacje', label: 'Włącz', confirm: 'Co noc system sam zainstaluje poprawki bezpieczeństwa (unattended-upgrades).' } }));
  if (sec) out.push(item('poprawki', 'warn', `${sec} ${sec === 1 ? 'poprawka' : 'poprawek'} bezpieczeństwa czeka na instalację`, (upd.packages.filter((p) => p.security).slice(0, 4).map((p) => p.name).join(', ')), { link: { href: '#/aktualizacje', label: 'Zainstaluj' } }));
  else if (auto) out.push(item('poprawki', 'ok', 'Poprawki bezpieczeństwa instalują się same', upd?.lastAuto ? `ostatnio ${new Date(upd.lastAuto).toLocaleDateString('pl-PL')}` : ''));
  // 5. fail2ban
  if (!f2b.on) out.push(item('fail2ban', f2b.installed ? 'bad' : 'warn', f2b.installed ? 'fail2ban nie działa' : 'Brak blokady atakujących adresów (fail2ban)', 'fail2ban blokuje adresy, które próbują zgadywać hasła.', { fix: { id: f2b.installed ? 'fail2ban-start' : 'fail2ban-instaluj', label: f2b.installed ? 'Uruchom' : 'Zainstaluj', confirm: f2b.installed ? 'Uruchomię fail2ban i włączę go przy starcie serwera.' : 'Zainstaluję fail2ban z ochroną SSH (5 nieudanych prób = blokada na 10 minut).' } }));
  else out.push(item('fail2ban', 'ok', 'fail2ban blokuje atakujących', `teraz zablokowane: ${f2b.banned} ${f2b.banned === 1 ? 'adres' : 'adresy'}, w sumie ${f2b.total}`, { banned: f2b.ips }));
  // 6. LLMNR
  if (llmnrOpen()) out.push(item('llmnr', 'warn', 'LLMNR (port 5355) otwarty na świat', 'Wyszukiwanie komputerów w sieci lokalnej — niepotrzebne na serwerze. Wyłączenie niczego nie psuje.', { fix: { id: 'llmnr', label: 'Wyłącz', confirm: 'Wyłączę LLMNR i mDNS w systemd-resolved (zmiana w /etc/systemd/resolved.conf.d/).' } }));
  // 7. certyfikaty
  const soon = certs.filter((c) => c.validTo && c.validTo - Date.now() < 14 * 864e5);
  const valid = certs.filter((c) => !c.validTo || c.validTo > Date.now());
  if (soon.length) out.push(item('ssl', soon.some((c) => c.validTo < Date.now()) ? 'bad' : 'warn', `${soon.length} ${soon.length === 1 ? 'certyfikat wygasa' : 'certyfikaty wygasają'} w ciągu 14 dni`, soon.map((c) => c.name).slice(0, 4).join(', '), { link: { href: '#/ssl', label: 'Certyfikaty' } }));
  else if (certs.length) { const next = certs.filter((c) => c.validTo).sort((a, b) => a.validTo - b.validTo)[0]; out.push(item('ssl', 'ok', 'Certyfikaty SSL ważne', `${valid.length} ${valid.length === 1 ? 'certyfikat' : 'certyfikatów'}${next ? `, najbliższy wygasa ${new Date(next.validTo).toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric' })}` : ''}`)); }
  // 8. panel
  const n = ctx.users();
  out.push(item('panel', 'ok', 'Panel: logowanie z kodem z aplikacji', `${n} ${n === 1 ? 'konto' : 'kont'} · blokada po nieudanych próbach`));

  const order = { bad: 0, warn: 1, ok: 2 };
  out.sort((a, b) => order[a.status] - order[b.status]);
  const score = Math.max(0, 100 - out.reduce((s, x) => s + (WEIGHT[x.status] || 0), 0));
  return { score, bad: out.filter((x) => x.status === 'bad').length, warn: out.filter((x) => x.status === 'warn').length, items: out, at: Date.now(), attempts: failed };
}

/** Naprawy (każda zapisana w dzienniku zmian). */
export async function fix(id, who) {
  if (id === 'ssh-tylko-klucz') {
    if (who.role !== 'wlasciciel') throw Object.assign(new Error('To zmienia tylko właściciel.'), { status: 403 });
    await AC.rootPassword(false, who);
    return { ok: true, message: 'Root loguje się teraz tylko kluczem SSH.' };
  }
  if (id === 'restart-noca') {
    const d = new Date(); d.setHours(4, 30, 0, 0); if (d.getTime() < Date.now() + 5 * 60e3) d.setDate(d.getDate() + 1);
    SA.planRestart(d.getTime(), who);
    return { ok: true, message: `Restart zaplanowany na ${d.toLocaleString('pl-PL', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}.` };
  }
  if (id === 'auto-aktualizacje') {
    const undo = J.fileBefore(AUTO_UPG);
    if (!exists('/usr/bin/unattended-upgrade')) {
      const r = await run('apt-get', ['install', '-y', '-q', 'unattended-upgrades'], { timeout: 300000, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
      if (!r.ok) throw new Error('Nie udało się zainstalować unattended-upgrades.');
    }
    fs.writeFileSync(AUTO_UPG, 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n');
    J.add(who, 'system', 'Włączono automatyczne poprawki bezpieczeństwa', { type: 'plik', data: undo });
    return { ok: true, message: 'Poprawki bezpieczeństwa będą się instalować same.' };
  }
  if (id === 'llmnr') {
    const undo = J.fileBefore(LLMNR_DROPIN, ['resolved']);
    fs.mkdirSync('/etc/systemd/resolved.conf.d', { recursive: true });
    fs.writeFileSync(LLMNR_DROPIN, '# Panel serwera: wyszukiwanie komputerów w sieci lokalnej jest niepotrzebne na serwerze\n[Resolve]\nLLMNR=no\nMulticastDNS=no\n');
    const r = await run('systemctl', ['restart', 'systemd-resolved']);
    if (!r.ok) { fs.rmSync(LLMNR_DROPIN, { force: true }); await run('systemctl', ['restart', 'systemd-resolved']); throw new Error('systemd-resolved nie wstał po zmianie — cofnąłem ją.'); }
    J.add(who, 'system', 'Wyłączono LLMNR i mDNS (port 5355)', { type: 'plik', data: undo });
    return { ok: true, message: 'LLMNR wyłączony — port 5355 zamknięty.' };
  }
  if (id === 'fail2ban-start') {
    const r = await run('systemctl', ['enable', '--now', 'fail2ban']);
    if (!r.ok) throw new Error('fail2ban nie wstał: ' + r.err.trim().slice(0, 200));
    J.add(who, 'system', 'Uruchomiono fail2ban');
    return { ok: true, message: 'fail2ban działa.' };
  }
  if (id === 'fail2ban-instaluj') {
    if (!ctx.startJob) throw new Error('Brak kolejki zadań.');
    return { job: ctx.startJob('fail2ban', 'Instalacja fail2ban', who, async (say) => {
      say('▸ instaluję fail2ban\n');
      const r = await run('apt-get', ['install', '-y', '-q', 'fail2ban'], { timeout: 600000, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
      if (!r.ok) throw new Error('apt-get install fail2ban nie wyszedł.');
      if (!exists('/etc/fail2ban/jail.d/panel-sshd.conf')) fs.writeFileSync('/etc/fail2ban/jail.d/panel-sshd.conf', '# Panel serwera\n[sshd]\nenabled = true\nbackend = systemd\nmaxretry = 5\nbantime = 10m\n');
      await run('systemctl', ['enable', '--now', 'fail2ban']); await run('systemctl', ['restart', 'fail2ban']);
      J.add(who, 'system', 'Zainstalowano fail2ban (ochrona SSH)');
      say('✓ fail2ban działa\n');
      return { ok: true };
    }) };
  }
  throw Object.assign(new Error('Nieznana naprawa.'), { status: 400 });
}
