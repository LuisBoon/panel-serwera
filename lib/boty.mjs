// Ochrona przed botami: kto dziś szukał dziur na stronach (wp-login, .env, .git, phpmyadmin…), blokowanie
// jednym kliknięciem i automat. Blokuje fail2ban (porty 80/443) — dwie własne cele panelu:
//   panel-blokady  — adresy zablokowane ręcznie (na stałe; lista trzymana też w bazie panelu i odtwarzana),
//   panel-skanery  — automat: 10 prób szukania dziur w ciągu doby → blokada na dobę (dłużej przy powtórkach).
// Strony z WordPressem mają własną regułę bez ścieżek WordPressa, żeby nie blokować ich administratorów.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import * as S from './system.mjs';
import { C } from './config.mjs';
import { run, cached } from './util.mjs';

let db, groupHosts = () => [];
const LOG_DIR = process.env.BOTY_LOGI || '/var/log/apache2';
const F2B = process.env.BOTY_F2B || '/etc/fail2ban';
const JAIL_FILE = () => path.join(F2B, 'jail.d', 'panel-serwera.conf');
const KINDS = [
  ['wp-login', /wp-login\.php/i, true], ['xmlrpc', /xmlrpc\.php/i, true], ['wp-admin', /\/wp-(admin|includes|content)\//i, true],
  ['.env', /\/\.env\b/i], ['.git', /\/\.(git|svn|hg)\//i], ['phpmyadmin', /\/(phpmyadmin|pma|myadmin|mysqladmin|dbadmin)\b/i],
  ['phpunit', /\/vendor\/phpunit\//i], ['cgi-bin', /\/cgi-bin\//i], ['klucze', /\/\.(aws|ssh|docker|kube)\b/i],
  ['kopie', /\.(sql|sql\.gz|bak|old|swp)(\?|$|\s)/i], ['shell', /\/(shell|cmd|wso|alfa|c99|r57|up|upload)\.php/i],
  ['routery', /\/(boaform|HNAP1|actuator|cgi\/|GponForm|setup\.cgi)/i], ['inne', /(\/\.DS_Store|\/server-status|\/phpinfo|\/etc\/passwd|\.\.\/\.\.\/|\/config\.(php|json|yml)\.(bak|old))/i],
];
// do fail2ban (składnia Pythona) — to samo co KINDS
const RE_ALL = 'wp-login\\.php|xmlrpc\\.php|/wp-(?:admin|includes|content)/|/\\.env\\b|/\\.(?:git|svn|hg)/|/(?:phpmyadmin|pma|myadmin|mysqladmin|dbadmin)\\b|/vendor/phpunit/|/cgi-bin/|/\\.(?:aws|ssh|docker|kube)\\b|\\.(?:sql|sql\\.gz|bak|old|swp)(?:\\?| )|/(?:shell|cmd|wso|alfa|c99|r57)\\.php|/(?:boaform|HNAP1|actuator|GponForm)|/\\.DS_Store|/phpinfo|/etc/passwd|\\.\\./\\.\\./';
const RE_NOWP = RE_ALL.replace('wp-login\\.php|xmlrpc\\.php|/wp-(?:admin|includes|content)/|', '');
const GREP_RE = '(wp-login\\.php|xmlrpc\\.php|/wp-(admin|includes|content)/|/\\.env|/\\.(git|svn|hg)/|/(phpmyadmin|pma|myadmin|mysqladmin|dbadmin)|/vendor/phpunit/|/cgi-bin/|/\\.(aws|ssh|docker|kube)|\\.(sql|sql\\.gz|bak|old|swp)[? ]|/(shell|cmd|wso|alfa|c99|r57)\\.php|/(boaform|HNAP1|actuator|GponForm)|/\\.DS_Store|/phpinfo|/etc/passwd|\\.\\./\\.\\./)';

export function init(database, opts = {}) {
  db = database;
  if (opts.groupHosts) groupHosts = opts.groupHosts;
  db.exec('CREATE TABLE IF NOT EXISTS boty_blokady(ip TEXT PRIMARY KEY, ts INTEGER, by TEXT, note TEXT)');
}
export function settings() {
  let v = {};
  try { v = JSON.parse(db.prepare("SELECT v FROM ustawienia WHERE k='boty'").get()?.v || '{}'); } catch {}
  return { auto: !!v.auto, limit: Number(v.limit) || 10, allow: Array.isArray(v.allow) ? v.allow : [] };
}
function saveRaw(s) { db.prepare("INSERT OR REPLACE INTO ustawienia(k,v) VALUES('boty',?)").run(JSON.stringify(s)); }

const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+:[0-9a-f:]*)(\/\d{1,3})?$/i;
export function validIp(ip) { return IP_RE.test(String(ip || '').trim()); }

/** Adresy, których nigdy nie blokujemy: lokalne, serwer w domu, serwery z grupy, lista „zawsze wpuszczaj”. */
async function trusted() {
  const out = [{ ip: '127.0.0.1', label: 'ten serwer' }, { ip: '::1', label: 'ten serwer' }];
  const home = C().dom?.host;
  if (home) { try { for (const a of await dns.resolve4(home)) out.push({ ip: a, label: C().dom?.opis || 'serwer w domu', kind: 'dom' }); } catch {} }
  for (const g of groupHosts()) { try { const h = new URL(g.url).hostname; for (const a of validIp(h) ? [h] : await dns.resolve4(h)) out.push({ ip: a, label: `serwer z grupy: ${g.name}`, kind: 'grupa' }); } catch {} }
  for (const a of settings().allow) out.push({ ip: a.ip, label: a.note || 'zawsze wpuszczaj', kind: 'lista' });
  return out;
}

function siteLogs() {
  const sites = S.siteConfigs();
  const map = new Map();
  for (const s of sites) for (const l of s.logs) if (/access/.test(path.basename(l))) map.set(l, { site: s.name, wp: isWp(s.root) });
  return map;
}
function isWp(root) { return !!root && (fs.existsSync(path.join(root, 'wp-config.php')) || fs.existsSync(path.join(root, 'wp-includes', 'version.php'))); }
function accessLogs() { try { return fs.readdirSync(LOG_DIR).filter((f) => /access.*\.log$/.test(f)).map((f) => path.join(LOG_DIR, f)); } catch { return []; } }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const todayTag = (d = new Date()) => `[${String(d.getDate()).padStart(2, '0')}/${MON[d.getMonth()]}/${d.getFullYear()}:`;
// linia „combined” (albo „vhost:port IP …” z other_vhosts_access.log)
const LINE = /^(?:(\S+:\d+) )?(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) (?:\d+|-)(?: "[^"]*" "([^"]*)")?/;

async function banned() {
  const r = await run('fail2ban-client', ['banned'], { timeout: 15000 });
  const set = new Map();
  if (!r.ok) return set;
  // wynik: [{'sshd': ['1.2.3.4']}, {'apache-noscript': [...]}]
  for (const m of r.out.matchAll(/'([^']+)':\s*\[([^\]]*)\]/g)) for (const ip of m[2].matchAll(/'([^']+)'/g)) { if (!set.has(ip[1])) set.set(ip[1], []); set.get(ip[1]).push(m[1]); }
  return set;
}
async function jailOn(name) { return (await run('fail2ban-client', ['status', name], { timeout: 10000 })).ok; }

const reportCached = cached(5 * 60e3, () => build());
export function report(force = false) { return reportCached(force); }
async function build() {
  const files = accessLogs();
  const tag = todayTag();
  const logs = siteLogs();
  const trust = await trusted();
  const tmap = new Map(trust.map((t) => [t.ip, t]));
  // 1) wszystkie dzisiejsze zapytania i najczęstsze adresy (awk liczy szybciej niż node)
  const awk = await run('bash', ['-c', `cat -- "$@" 2>/dev/null | grep -F -- "${tag}" | awk '{ip=($1 ~ /:[0-9]+$/ && $2 ~ /^[0-9a-fA-F.:]+$/) ? $2 : $1; n[ip]++; t++} END {print "T", t+0; for (i in n) if (n[i] >= 200) print n[i], i}'`, 'x', ...files], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  let total = 0; const heavy = [];
  for (const l of awk.out.split('\n')) { const m = l.match(/^T (\d+)$/); if (m) total = Number(m[1]); else { const x = l.match(/^(\d+) (\S+)$/); if (x) heavy.push({ ip: x[2], n: Number(x[1]) }); } }
  // 2) próby szukania dziur
  const g = await run('bash', ['-c', `for f in "$@"; do grep -HiE -- '${GREP_RE}' "$f" 2>/dev/null | grep -F -- "${tag}"; done`, 'x', ...files], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  const ips = new Map();
  for (const raw of g.out.split('\n')) {
    if (!raw) continue;
    const i = raw.indexOf(':');
    const file = raw.slice(0, i), line = raw.slice(i + 1);
    const m = line.match(LINE);
    if (!m) continue;
    const [, vhost, ip, , , url, code] = m;
    const site = logs.get(file) || (vhost ? { site: vhost.replace(/:\d+$/, ''), wp: false } : { site: '', wp: false });
    const kind = KINDS.find(([, re, wpOnly]) => re.test(url) && !(wpOnly && site.wp));
    if (!kind) continue;
    let x = ips.get(ip);
    if (!x) ips.set(ip, x = { ip, n: 0, kinds: new Map(), sites: new Set(), ok: 0, last: '' });
    x.n++; x.kinds.set(kind[0], (x.kinds.get(kind[0]) || 0) + 1);
    if (site.site) x.sites.add(site.site);
    if (code === '200') x.ok++;
    x.last = m[3];
  }
  const ban = await banned();
  const mine = new Map(db.prepare('SELECT * FROM boty_blokady').all().map((r) => [r.ip, r]));
  const scanners = [...ips.values()].filter((x) => !tmap.has(x.ip)).sort((a, b) => b.n - a.n).map((x) => ({
    ip: x.ip, n: x.n, kinds: [...x.kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k), sites: [...x.sites].slice(0, 4), ok: x.ok,
    banned: ban.get(x.ip) || [], mine: mine.has(x.ip),
  }));
  const s = settings();
  return {
    day: tag.slice(1, -1), total, attempts: scanners.reduce((a, x) => a + x.n, 0), addresses: scanners.length,
    wouldBlock: scanners.filter((x) => x.n >= s.limit).length,
    scanners: scanners.slice(0, 60),
    trustedSeen: heavy.filter((h) => tmap.has(h.ip) && !['127.0.0.1', '::1'].includes(h.ip)).map((h) => ({ ...h, label: tmap.get(h.ip).label })),
    trusted: trust.filter((t) => t.kind),
    wpSites: [...new Set([...logs.values()].filter((x) => x.wp).map((x) => x.site))],
  };
}

export async function status(force) {
  const s = settings();
  const [r, blk, auto] = await Promise.all([report(force), jailOn('panel-blokady'), jailOn('panel-skanery')]);
  const blocked = db.prepare('SELECT * FROM boty_blokady ORDER BY ts DESC').all();
  return { settings: s, ...r, blocked, jails: { blokady: blk, skanery: auto }, f2b: fs.existsSync(path.join(F2B, 'jail.d')) };
}

/* -------------------------------------------------------- konfiguracja fail2ban */

export function writeConfig(groupTrusted) {
  const s = settings();
  const logs = siteLogs();
  const all = accessLogs();
  const wp = all.filter((f) => logs.get(f)?.wp);
  const plain = all.filter((f) => !logs.get(f)?.wp);
  const extra = [...new Set(groupTrusted.map((t) => t.ip))].join(' ');
  const filt = (re) => `# Zarządzane przez panel serwera — szukanie dziur (wp-login, .env, .git, phpmyadmin…)\n[Definition]\nfailregex = ^(?:\\S+:\\d+ )?<HOST> [^"]*"[A-Z]+ [^" ]*(?:${re})\nignoreregex =\ndatepattern = %%d/%%b/%%Y:%%H:%%M:%%S %%z\n`;
  fs.writeFileSync(path.join(F2B, 'filter.d', 'panel-skanery.conf'), filt(RE_ALL.replace(/%/g, '%%')));
  fs.writeFileSync(path.join(F2B, 'filter.d', 'panel-skanery-wp.conf'), filt(RE_NOWP.replace(/%/g, '%%')));
  fs.writeFileSync(path.join(F2B, 'filter.d', 'panel-blokady.conf'), '# Zarządzane przez panel serwera — cel na ręczne blokady (nic nie pasuje do logu)\n[Definition]\nfailregex = ^PANEL-BLOKADY-NIGDY <HOST>$\nignoreregex =\n');
  const jail = (name, filter, files) => `[${name}]\nenabled  = ${s.auto && files.length ? 'true' : 'false'}\nbackend  = auto\nfilter   = ${filter}\nlogpath  = ${files.join('\n           ') || '/var/log/apache2/access.log'}\nport     = http,https\nmaxretry = ${s.limit}\nfindtime = 1d\nbantime  = 1d\nignoreip = %(known/ignoreip)s ${extra}\n\n`;
  const txt = `# Zarządzane przez panel serwera (Bezpieczeństwo → Boty i skanery). Zmiany ręczne zostaną nadpisane.\n\n[panel-blokady]\nenabled  = true\nbackend  = auto\nfilter   = panel-blokady\nlogpath  = /var/log/apache2/error.log\nport     = http,https\nmaxretry = 1\nbantime  = -1\nbantime.increment = false\n\n${jail('panel-skanery', 'panel-skanery', plain)}${jail('panel-skanery-wp', 'panel-skanery-wp', wp)}`;
  fs.writeFileSync(JAIL_FILE(), txt);
}
async function reload() {
  const t = await run('fail2ban-client', ['-t'], { timeout: 60000 });
  if (!t.ok) throw new Error('fail2ban nie przyjął konfiguracji: ' + (t.err || t.out).trim().split('\n').slice(-2).join(' '));
  const r = await run('fail2ban-client', ['reload'], { timeout: 60000 });
  if (!r.ok) throw new Error('fail2ban nie przeładował się: ' + (r.err || r.out).trim().split('\n').pop());
}
/** Nowa konfiguracja: zapis plików, test, przeładowanie; przy błędzie przywraca poprzednią. */
export async function apply() {
  if (!fs.existsSync(path.join(F2B, 'jail.d'))) throw new Error('Na serwerze nie ma fail2ban — zainstaluj go w Bezpieczeństwie.');
  const keep = ['jail.d/panel-serwera.conf', 'filter.d/panel-skanery.conf', 'filter.d/panel-skanery-wp.conf', 'filter.d/panel-blokady.conf'].map((f) => [path.join(F2B, f), fs.existsSync(path.join(F2B, f)) ? fs.readFileSync(path.join(F2B, f)) : null]);
  writeConfig((await trusted()).filter((t) => t.kind));
  try { await reload(); }
  catch (e) { for (const [f, c] of keep) { if (c == null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, c); } await run('fail2ban-client', ['reload'], { timeout: 60000 }); throw e; }
  await restoreBans();
}
/** Ręczne blokady z bazy panelu, których fail2ban nie ma (np. po restarcie) — dokładamy. */
export async function restoreBans() {
  const list = db.prepare('SELECT ip FROM boty_blokady').all().map((r) => r.ip);
  if (!list.length || !(await jailOn('panel-blokady'))) return 0;
  const now = (await banned());
  let n = 0;
  for (const ip of list) if (!(now.get(ip) || []).includes('panel-blokady')) { await run('fail2ban-client', ['set', 'panel-blokady', 'banip', ip], { timeout: 15000 }); n++; }
  return n;
}

export async function setAuto(on) {
  const s = settings(); s.auto = !!on; saveRaw(s);
  try { await apply(); } catch (e) { s.auto = !on; saveRaw(s); throw e; }
  reportCached(true).catch(() => {});
  return settings();
}
export async function block(ip, who, note) {
  ip = String(ip || '').trim();
  if (!validIp(ip)) throw new Error('Nieprawidłowy adres IP.');
  const t = await trusted();
  if (t.some((x) => x.ip === ip)) throw new Error('Ten adres jest na liście zaufanych — najpierw go z niej usuń.');
  if (!(await jailOn('panel-blokady'))) await apply();
  const r = await run('fail2ban-client', ['set', 'panel-blokady', 'banip', ip], { timeout: 15000 });
  if (!r.ok) throw new Error('fail2ban nie zablokował adresu: ' + (r.err || r.out).trim().split('\n').pop());
  db.prepare('INSERT OR REPLACE INTO boty_blokady(ip,ts,by,note) VALUES(?,?,?,?)').run(ip, Date.now(), who, String(note || '').slice(0, 120));
  reportCached(true).catch(() => {});
}
export async function unblock(ip) {
  ip = String(ip || '').trim();
  if (!validIp(ip)) throw new Error('Nieprawidłowy adres IP.');
  for (const j of ['panel-blokady', 'panel-skanery', 'panel-skanery-wp']) await run('fail2ban-client', ['set', j, 'unbanip', ip], { timeout: 15000 });
  db.prepare('DELETE FROM boty_blokady WHERE ip=?').run(ip);
  reportCached(true).catch(() => {});
}
export async function allow(ip, note, add) {
  ip = String(ip || '').trim();
  if (!validIp(ip)) throw new Error('Nieprawidłowy adres IP.');
  const s = settings();
  s.allow = s.allow.filter((a) => a.ip !== ip);
  if (add) s.allow.push({ ip, note: String(note || '').slice(0, 60) });
  saveRaw(s);
  if (add) { db.prepare('DELETE FROM boty_blokady WHERE ip=?').run(ip); for (const j of ['panel-blokady', 'panel-skanery', 'panel-skanery-wp']) await run('fail2ban-client', ['set', j, 'unbanip', ip], { timeout: 15000 }); }
  if (fs.existsSync(JAIL_FILE())) await apply();
  reportCached(true).catch(() => {});
  return settings();
}
/** Wiersz do Bezpieczeństwa: ile prób dziś i czy automat działa. */
export async function securityItem() {
  try {
    const r = await report();
    const s = settings();
    if (!r.attempts) return null;
    if (s.auto) return { id: 'boty', status: 'ok', title: `Skanery dziur blokowane automatycznie`, text: `Dziś ${r.attempts} prób z ${r.addresses} adresów — po ${s.limit} próbach adres dostaje blokadę na dobę.` };
    return { id: 'boty', status: r.wouldBlock ? 'warn' : 'ok', title: `${r.attempts.toLocaleString('pl-PL')} prób szukania dziur dziś`, text: `${r.addresses} adresów szukało wp-login, .env, .git, phpmyadmin… Automat zablokowałby dziś ${r.wouldBlock}.` };
  } catch { return null; }
}
