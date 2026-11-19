// Panel serwera — API + pliki strony. Słucha tylko lokalnie (127.0.0.1), na zewnątrz wystawia go Apache albo Tailscale.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-generator';
import * as CFG from './lib/config.mjs';
import * as A from './lib/auth.mjs';
import * as S from './lib/system.mjs';
import * as D from './lib/data.mjs';
import * as C from './lib/create.mjs';
import * as AP from './lib/autopilot.mjs';
import * as F from './lib/firewall.mjs';
import * as O from './lib/offsite.mjs';
import * as ST from './lib/stats.mjs';
import * as R from './lib/report.mjs';
import * as T from './lib/sitetools.mjs';
import * as OV from './lib/ovh.mjs';
import * as SP from './lib/statuspage.mjs';
import * as G from './lib/games.mjs';
import * as J from './lib/journal.mjs';
import * as DB from './lib/dbadmin.mjs';
import * as DR from './lib/doctor.mjs';
import * as TM from './lib/terminal.mjs';
import * as APP from './lib/apps.mjs';
import * as SY from './lib/sysadmin.mjs';
import * as AC from './lib/access.mjs';
import * as RS from './lib/rescue.mjs';
import * as GR from './lib/group.mjs';
import * as SU from './lib/setup.mjs';
import { run, spawnCollect, tail, readText, stamp } from './lib/util.mjs';

const VERSION = '1.5.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/panel-serwera';
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(HERE, 'public');
const BASE = (process.env.PANEL_BASE || '/').replace(/\/?$/, '/');
const COOKIE_SECURE = process.env.COOKIE_SECURE !== '0';
const PANEL_HOSTS = (process.env.PANEL_HOST || CFG.C().adres || '').split(',').map((s) => s.trim()).filter(Boolean); // strony, przez które działa panel — nie da się ich wyłączyć
const PUBLIC_URL = CFG.publicUrl() || 'http://localhost:8099/';
const COOKIE = 'panel_sid';
const IDLE_MS = 12 * 3600e3;
const MAX_MS = 7 * 24 * 3600e3;

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(DATA_DIR, 'panel.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS users(login TEXT PRIMARY KEY, pass TEXT NOT NULL, totp TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, last_step INTEGER NOT NULL DEFAULT -1, created INTEGER);
  CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, login TEXT, created INTEGER, last INTEGER, ip TEXT, ua TEXT);
  CREATE TABLE IF NOT EXISTS log(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, login TEXT, ip TEXT, action TEXT, detail TEXT, ok INTEGER);
  CREATE TABLE IF NOT EXISTS fails(ip TEXT, ts INTEGER);
`);
// konta z uprawnieniami (od 1.2): wlasciciel / admin / podglad / strony (tylko wybrane strony)
{
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!cols.has('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'wlasciciel'");
  if (!cols.has('sites')) db.exec("ALTER TABLE users ADD COLUMN sites TEXT NOT NULL DEFAULT '[]'");
  if (!cols.has('name')) db.exec("ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  if (!cols.has('last_login')) db.exec('ALTER TABLE users ADD COLUMN last_login INTEGER');
  db.exec('CREATE TABLE IF NOT EXISTS zaproszenia(id TEXT PRIMARY KEY, token TEXT UNIQUE, name TEXT, role TEXT, sites TEXT, created INTEGER, expires INTEGER, by TEXT, login TEXT, pass TEXT, totp TEXT)');
}
const q = {
  activeUsers: db.prepare('SELECT count(*) c FROM users WHERE active=1'),
  user: db.prepare('SELECT * FROM users WHERE login=?'),
  putUser: db.prepare('INSERT OR REPLACE INTO users(login,pass,totp,active,last_step,created) VALUES(?,?,?,0,-1,?)'),
  activate: db.prepare('UPDATE users SET active=1, last_step=? WHERE login=?'),
  delPending: db.prepare('DELETE FROM users WHERE active=0'),
  step: db.prepare('UPDATE users SET last_step=? WHERE login=?'),
  setPass: db.prepare('UPDATE users SET pass=? WHERE login=?'),
  sess: db.prepare('SELECT * FROM sessions WHERE id=?'),
  putSess: db.prepare('INSERT INTO sessions(id,login,created,last,ip,ua) VALUES(?,?,?,?,?,?)'),
  touch: db.prepare('UPDATE sessions SET last=? WHERE id=?'),
  delSess: db.prepare('DELETE FROM sessions WHERE id=?'),
  delUserSess: db.prepare('DELETE FROM sessions WHERE login=? AND id<>?'),
  oldSess: db.prepare('DELETE FROM sessions WHERE last<? OR created<?'),
  listSess: db.prepare('SELECT id,created,last,ip,ua FROM sessions WHERE login=? ORDER BY last DESC'),
  log: db.prepare('INSERT INTO log(ts,login,ip,action,detail,ok) VALUES(?,?,?,?,?,?)'),
  lastLogin: db.prepare('UPDATE users SET last_login=? WHERE login=?'),
  logs: db.prepare('SELECT * FROM log ORDER BY id DESC LIMIT ?'),
  fail: db.prepare('INSERT INTO fails(ip,ts) VALUES(?,?)'),
  fails: db.prepare('SELECT count(*) c, max(ts) m FROM fails WHERE ip=? AND ts>?'),
  failsAll: db.prepare('SELECT count(*) c FROM fails WHERE ts>?'),
  clearFails: db.prepare('DELETE FROM fails WHERE ip=? OR ts<?'),
};
setInterval(() => q.oldSess.run(Date.now() - IDLE_MS, Date.now() - MAX_MS), 10 * 60e3).unref();
const ROLES = { wlasciciel: 'Właściciel — wszystko, także konta', admin: 'Administrator — wszystko oprócz kont', podglad: 'Podgląd — widzi stan serwera, niczego nie zmienia', strony: 'Wybrane strony — pliki, wersje, GitHub, hasło i statystyki swoich stron' };
C.init(db);
AP.init({ database: db, dataDir: DATA_DIR, publicUrl: PUBLIC_URL });
F.init(db, DATA_DIR);
O.init(db, DATA_DIR);
ST.init(db);
R.init({ db, AP, ST, O, F });
T.init(db, DATA_DIR, PUBLIC_URL);
OV.init(db);
SP.init(db);
G.init(db);
T.useOvh(OV);
J.init(db);
DB.init(db, DATA_DIR, { createdSites: () => C.list() });
APP.init(db, DATA_DIR);
AC.init(db);
GR.init(db);
SY.init(db, DATA_DIR, { notify: (t, b, l, o) => AP.sendNotification(t, b, l, o || {}), event: (...a) => AP.event(...a) });
if (process.env.AUTOPILOT !== '0') SY.afterBoot();
SY.sample();
setInterval(() => { try { SY.sample(); } catch (e) { console.error('panel: zasoby', e.message); } }, 5 * 60e3).unref();
DR.init({ panelHosts: PANEL_HOSTS, fails: (ip) => q.fails.get(ip, Date.now() - 15 * 60e3).c, clearFails: (ip) => q.clearFails.run(ip, Date.now() - 24 * 3600e3), ovh: OV });
TM.init(DATA_DIR, { ended: (x) => {
  const min = Math.max(1, Math.round((x.closedAt - x.started) / 60000));
  q.log.run(Date.now(), x.login, x.ip, 'terminal:koniec', `${x.reason}, ${min} min`, 1);
  J.add({ login: x.login }, 'terminal', `Sesja terminala z ${x.ip} (${min} min, ${x.reason})`, null, '#/terminal');
} });
const TMP_DIR = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });

/* ---------------------------------------------------- pierwsze uruchomienie */

const SETUP_FILE = path.join(DATA_DIR, 'kod-konfiguracji.txt');
function setupCode() {
  if (q.activeUsers.get().c > 0) { fs.rmSync(SETUP_FILE, { force: true }); return null; }
  let code = readText(SETUP_FILE).trim();
  if (!code) { code = A.randomToken(18); fs.writeFileSync(SETUP_FILE, code + '\n', { mode: 0o600 }); }
  return code;
}
const sameCode = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* ------------------------------------------------------------- zadania tła */

const jobs = new Map();
let jobSeq = 0;
function startJob(kind, label, who, fn) {
  const busy = [...jobs.values()].find((j) => j.kind === kind && !j.end);
  if (busy) throw httpErr(409, `„${busy.label}” już trwa.`);
  const job = { id: String(++jobSeq), kind, label, who, start: Date.now(), end: null, ok: null, out: '' };
  jobs.set(job.id, job);
  const say = (s) => { job.out = tail(job.out + s, 60000); };
  (async () => {
    try {
      const r = await fn(say);
      if (r && typeof r === 'object') { job.ok = r.ok !== false; job.result = r.result ?? null; } else job.ok = r !== false;
    }
    catch (e) { say(`\n✗ ${e.message || e}\n`); job.ok = false; }
    job.end = Date.now();
    q.log.run(Date.now(), who.login, who.ip, kind + ':koniec', label, job.ok ? 1 : 0);
    S.services.reset(); S.sites.reset(); D.databases.reset();
  })();
  if (jobs.size > 40) jobs.delete(jobs.keys().next().value);
  return job;
}
async function steps(list, say) {
  for (const [cmd, args, desc] of list) {
    say(`▸ ${desc}\n`);
    const r = await spawnCollect(cmd, args, { onData: say });
    if (!r.ok) { say(`✗ krok nie powiódł się (kod ${r.code})\n`); return false; }
  }
  say('✓ gotowe\n');
  return true;
}

/* -------------------------------------------------------------- narzędzia http */

function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf && (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1')) return String(xf).split(',').pop().trim();
  return req.socket.remoteAddress || '';
}
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SEC_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': typeof body === 'string' && headers['Content-Type'] ? headers['Content-Type'] : 'application/json; charset=utf-8', ...headers });
  res.end(data);
}
function basePath(req) { // Apache podaje, pod jaką ścieżką wystawił panel (np. /serwer/ na głównej domenie)
  const b = String(req?.headers['x-panel-base'] || BASE);
  return /^\/[A-Za-z0-9/_-]*\/$/.test(b) ? b : BASE;
}
function cookie(res, value, maxAge, req) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=${basePath(req)}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`);
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 256 * 1024) throw httpErr(413, 'Za duże zapytanie.'); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpErr(400, 'Nieprawidłowe dane.'); }
}
function streamFile(res, f) {
  const safe = f.name.replace(/[^A-Za-z0-9._-]/g, '_');
  res.writeHead(200, { ...SEC_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': f.type, 'Content-Disposition': `attachment; filename="${safe}"`, ...(f.size ? { 'Content-Length': f.size } : {}) });
  f.stream.on('error', () => res.destroy());
  f.stream.pipe(res);
}

function session(req) {
  const id = A.parseCookies(req.headers.cookie)[COOKIE];
  if (!id) return null;
  const s = q.sess.get(A.sha256(id));
  if (!s) return null;
  const now = Date.now();
  if (now - s.last > IDLE_MS || now - s.created > MAX_MS) { q.delSess.run(s.id); return null; }
  if (now - s.last > 60e3) q.touch.run(now, s.id);
  return s;
}
function newSession(res, login, req) {
  const tok = A.randomToken(32);
  const now = Date.now();
  q.putSess.run(A.sha256(tok), login, now, now, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
  cookie(res, tok, Math.floor(MAX_MS / 1000), req);
}
function tooMany(ip) {
  const since = Date.now() - 15 * 60e3;
  const r = q.fails.get(ip, since);
  if (r.c >= 5) return Math.ceil((r.m + 15 * 60e3 - Date.now()) / 60e3);
  if (q.failsAll.get(Date.now() - 3600e3).c >= 40) return 30; // ktoś zgaduje z wielu adresów
  return 0;
}
function failed(ip, what) {
  q.fail.run(ip, Date.now());
  console.error(`panel-serwera: nieudane logowanie (${what}) z ${ip}`);
}

/* ------------------------------------------------------------------- alarmy */

async function alerts() {
  const out = [];
  const m = S.metrics();
  const pct = m.disk.used / m.disk.total * 100;
  if (pct >= 93) out.push({ level: 'error', text: `Dysk prawie pełny: ${Math.round(pct)}% zajęte`, link: '#/dysk' });
  else if (pct >= 85) out.push({ level: 'warn', text: `Dysk zajęty w ${Math.round(pct)}%`, link: '#/dysk' });
  const settings = D.backupSettings();
  if (settings.minFreeMb && m.disk.free < settings.minFreeMb * 1024 * 1024) out.push({ level: 'warn', text: `Mniej niż ${(settings.minFreeMb / 1024).toFixed(1).replace('.', ',')} GB wolnego — nocna kopia się nie wykona`, link: '#/dysk' });
  if (m.mem.available / m.mem.total < 0.1) out.push({ level: 'warn', text: 'Kończy się pamięć RAM', link: '#/uslugi' });
  for (const s of await S.services()) {
    if (s.failed) out.push({ level: s.group === 'other' ? 'warn' : 'error', text: `Usługa ${s.name} (${s.unit}) padła`, link: '#/uslugi' });
    else if (s.group !== 'other' && S.APPS[s.unit] && !s.active && s.enabled) out.push({ level: 'error', text: `Usługa ${s.name} jest zatrzymana`, link: '#/uslugi' });
  }
  for (const s of await S.sites()) {
    if (s.status === 'nodns') out.push({ level: 'warn', text: `${s.name}: brak wpisu DNS (adres jeszcze nie istnieje)`, link: '#/strony' });
    if (s.status === 'down') out.push({ level: 'error', text: `${s.name} ${s.http?.code ? 'zwraca błąd ' + s.http.code : 'nie odpowiada'}`, link: '#/strony' });
    if (s.cert?.validTo) {
      const days = Math.floor((s.cert.validTo - Date.now()) / 864e5);
      if (days < 7) out.push({ level: 'error', text: `Certyfikat ${s.name} wygasa za ${days} dni`, link: '#/ssl' });
      else if (days < 21) out.push({ level: 'warn', text: `Certyfikat ${s.name} wygasa za ${days} dni (powinien odnowić się sam)`, link: '#/ssl' });
    }
  }
  const runs = D.backupRuns(5);
  const lastOk = runs.find((r) => r.status === 'ok');
  if (runs[0] && runs[0].status === 'error') out.push({ level: 'warn', text: `Ostatnia nocna kopia nie wykonała się: ${runs[0].error}`, link: '#/kopie' });
  else if (lastOk && Date.now() - lastOk.start > 36 * 3600e3) out.push({ level: 'warn', text: 'Od ponad doby nie było udanej kopii', link: '#/kopie' });
  const tp = await S.testProcs();
  if (tp.length) out.push({ level: 'info', text: `${tp.length} procesów testowych zajmuje ${Math.round(tp.reduce((a, p) => a + p.rss, 0) / 1048576)} MB RAM`, link: '#/uslugi' });
  return out;
}

function nextRun(hour, minute) {
  if (hour == null) return null;
  const d = new Date(); d.setSeconds(0, 0); d.setHours(hour, minute);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/* ------------------------------------------------------------------- trasy */

const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, opts });

/* Uprawnienia: właściciel i administrator mogą wszystko (konta — tylko właściciel). Pozostali dostają
   tylko to, co jest wprost wymienione niżej — nowa trasa jest domyślnie zamknięta. */
const ANY_ROUTES = new Set(['GET api/stan', 'POST api/wyloguj', 'POST api/wyloguj-wszedzie', 'GET api/konto', 'POST api/konto/haslo', 'GET api/zadania/:id', 'POST api/grupa/odlacz-mnie']);
const VIEW_ROUTES = new Set(['api/grupa/stan', 'api/pulpit', 'api/strony', 'api/uslugi', 'api/kopie', 'api/autopilot', 'api/statystyki', 'api/statystyki/:site', 'api/ssl', 'api/cron', 'api/dysk', 'api/zapora', 'api/strona/:name', 'api/autopilot/push', 'api/gry'].map((x) => 'GET ' + x));
const SITE_ROUTES = new Set(['GET api/strony', 'GET api/statystyki', 'GET api/statystyki/:site', 'GET api/strona/:name', 'GET api/strona/:name/pliki', 'GET api/strona/:name/plik', 'POST api/strona/:name/plik', 'GET api/strona/:name/plik/wersja', 'POST api/strona/:name/plik/wersja',
  'POST api/strona/:name/pliki/:act', 'POST api/strona/:name/wgraj', 'GET api/strona/:name/pobierz', 'POST api/strona/:name/wersje', 'POST api/strona/:name/wersje/:id/przywroc', 'POST api/strona/:name/git', 'POST api/strona/:name/git/wdroz', 'POST api/strona/:name/haslo', 'POST api/strona/:name/przerwa']);
function allowed(r, who, p) {
  const key = `${r.method} ${r.pattern}`;
  if (r.opts.owner) return who.role === 'wlasciciel';
  if (who.role === 'wlasciciel' || who.role === 'admin') return true;
  if (ANY_ROUTES.has(key)) return true;
  if (who.role === 'podglad') return VIEW_ROUTES.has(key);
  if (who.role === 'strony') {
    if (!SITE_ROUTES.has(key)) return false;
    const n = p.name ?? p.site;
    return n == null || who.sites.includes(decodeURIComponent(n));
  }
  return false;
}
const mine = (who, name) => who.role !== 'strony' || who.sites.includes(name);

route('GET', 'api/stan', (req, res, { sess, who }) => {
  if (!sess && who?.viaGroup) return send(res, 200, { version: VERSION, setup: false, login: who.login, role: who.role, sites: [], name: '', konfig: CFG.publicInfo(), grupa: true });
  const code = setupCode();
  const u = sess ? q.user.get(sess.login) : null;
  let sites = []; try { sites = JSON.parse(u?.sites || '[]'); } catch {}
  send(res, 200, { version: VERSION, setup: !!code, login: u ? sess.login : null, role: u?.role || null, sites, name: u?.name || '', konfig: CFG.publicInfo() });
}, { open: true });

route('POST', 'api/konfiguracja/start', async (req, res, { b, ip }) => {
  const code = setupCode();
  if (!code) throw httpErr(403, 'Panel jest już skonfigurowany.');
  if (tooMany(ip)) throw httpErr(429, 'Za dużo prób. Spróbuj za kilkanaście minut.');
  if (!sameCode(b.code, code)) { failed(ip, 'kod konfiguracji'); throw httpErr(403, 'Nieprawidłowy kod konfiguracji.'); }
  const login = String(b.login || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(login)) throw httpErr(400, 'Login: 3–32 znaki, małe litery, cyfry, kropka, myślnik.');
  if (String(b.password || '').length < 10) throw httpErr(400, 'Hasło musi mieć co najmniej 10 znaków.');
  const secret = A.newTotpSecret();
  q.delPending.run();
  q.putUser.run(login, await A.hashPassword(b.password), secret, Date.now());
  const uri = `otpauth://totp/${encodeURIComponent(`Serwer ${CFG.C().nazwa}:` + login)}?secret=${secret}&issuer=${encodeURIComponent(`Serwer ${CFG.C().nazwa}`)}`;
  const qr = qrcode(0, 'M'); qr.addData(uri); qr.make();
  send(res, 200, { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr: qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true }) });
}, { open: true });

route('POST', 'api/konfiguracja/koniec', async (req, res, { b, ip }) => {
  const code = setupCode();
  if (!code) throw httpErr(403, 'Panel jest już skonfigurowany.');
  if (!sameCode(b.code, code)) { failed(ip, 'kod konfiguracji'); throw httpErr(403, 'Nieprawidłowy kod konfiguracji.'); }
  const u = q.user.get(String(b.login || '').trim().toLowerCase());
  if (!u || u.active) throw httpErr(400, 'Zacznij konfigurację od nowa.');
  const st = A.verifyTotp(u.totp, b.totp, -1);
  if (st == null) throw httpErr(400, 'Kod z aplikacji się nie zgadza. Sprawdź godzinę w telefonie i wpisz nowy kod.');
  q.activate.run(st, u.login);
  fs.rmSync(SETUP_FILE, { force: true });
  q.log.run(Date.now(), u.login, ip, 'konto:utworzone', 'pierwsza konfiguracja panelu', 1);
  newSession(res, u.login, req);
  send(res, 200, { ok: true, login: u.login });
}, { open: true });

route('POST', 'api/logowanie', async (req, res, { b, ip }) => {
  const wait = tooMany(ip);
  if (wait) throw httpErr(429, `Za dużo nieudanych prób. Spróbuj za ${wait} min.`);
  const u = q.user.get(String(b.login || '').trim().toLowerCase());
  const passOk = await A.checkPassword(b.password, u?.active ? u.pass : '');
  const st = passOk ? A.verifyTotp(u.totp, b.totp, u.last_step) : null;
  if (!passOk || st == null) {
    failed(ip, passOk ? 'zły kod 2FA' : 'złe hasło');
    q.log.run(Date.now(), String(b.login || '').slice(0, 40), ip, 'logowanie', passOk ? 'zły kod z aplikacji' : 'złe hasło lub login', 0);
    throw httpErr(401, 'Nieprawidłowy login, hasło lub kod z aplikacji.');
  }
  q.step.run(st, u.login);
  q.lastLogin.run(Date.now(), u.login);
  q.clearFails.run(ip, Date.now() - 24 * 3600e3);
  q.log.run(Date.now(), u.login, ip, 'logowanie', String(req.headers['user-agent'] || '').slice(0, 120), 1);
  newSession(res, u.login, req);
  send(res, 200, { ok: true, login: u.login });
}, { open: true });

route('POST', 'api/wyloguj', (req, res, { sess }) => {
  if (sess) q.delSess.run(sess.id);
  cookie(res, '', 0, req);
  send(res, 200, { ok: true });
});

route('POST', 'api/wyloguj-wszedzie', (req, res, { sess, who }) => {
  q.delUserSess.run(sess.login, sess.id);
  q.log.run(Date.now(), who.login, who.ip, 'konto:wyloguj-wszedzie', '', 1);
  send(res, 200, { ok: true });
});

route('GET', 'api/konto', (req, res, { sess }) => {
  send(res, 200, { login: sess.login, sessions: q.listSess.all(sess.login).map((s) => ({ ...s, id: undefined, current: s.id === sess.id })) });
});

route('POST', 'api/konto/haslo', async (req, res, { sess, b, who }) => {
  const u = q.user.get(sess.login);
  if (!(await A.checkPassword(b.old, u.pass))) throw httpErr(400, 'Obecne hasło się nie zgadza.');
  if (String(b.new || '').length < 10) throw httpErr(400, 'Nowe hasło musi mieć co najmniej 10 znaków.');
  q.setPass.run(await A.hashPassword(b.new), u.login);
  q.delUserSess.run(u.login, sess.id);
  q.log.run(Date.now(), who.login, who.ip, 'konto:haslo', 'zmiana hasła (inne sesje wylogowane)', 1);
  send(res, 200, { ok: true });
});

route('GET', 'api/pulpit', async (req, res) => {
  const [svc, sites, al] = await Promise.all([S.services(), S.sites(), alerts()]);
  const runs = D.backupRuns(10);
  const set = D.backupSettings();
  send(res, 200, {
    metrics: S.metrics(), alerts: al,
    services: svc.filter((s) => s.group !== 'other').slice(0, 9),
    servicesCount: svc.length,
    sites: sites.map((s) => ({ name: s.name, status: s.status, code: s.http?.code || 0, certTo: s.cert?.validTo || null, enabled: s.enabled })),
    backup: { last: runs[0] || null, lastOk: runs.find((r) => r.status === 'ok') || null, next: nextRun(set.hour, set.minute) },
    jobs: [...jobs.values()].filter((j) => !j.end),
    autopilot: { enabled: AP.settings().enabled },
  });
});

route('GET', 'api/strony', async (req, res, { who }) => {
  const created = Object.fromEntries(C.list().filter((r) => r.host).map((r) => [r.host, { slug: r.slug, kind: r.kind, ssl: r.ssl }]));
  const list = (await S.sites(new URL(req.url, 'http://x').searchParams.has('odswiez'))).filter((x) => mine(who, x.name));
  send(res, 200, { sites: list, du: S.duInfo(), panelHosts: PANEL_HOSTS, created, uptime: AP.uptimeAll() });
});
route('POST', 'api/strony/:name/:act', async (req, res, { p, who }) => {
  if (!['wlacz', 'wylacz'].includes(p.act)) throw httpErr(404, 'Nieznana akcja.');
  try {
    await S.setSiteEnabled(p.name, p.act === 'wlacz', PANEL_HOSTS);
    q.log.run(Date.now(), who.login, who.ip, 'strona:' + p.act, p.name, 1);
    send(res, 200, { ok: true });
  } catch (e) { q.log.run(Date.now(), who.login, who.ip, 'strona:' + p.act, p.name + ' — ' + e.message, 0); throw httpErr(400, e.message); }
});

route('GET', 'api/uslugi', async (req, res) => { send(res, 200, { services: await S.services(true), tests: await S.testProcs() }); });
route('POST', 'api/uslugi/:unit/:act', async (req, res, { p, who }) => {
  const map = { restart: 'restart', stop: 'stop', start: 'start', przeladuj: 'reload' };
  if (!map[p.act]) throw httpErr(404, 'Nieznana akcja.');
  try {
    const r = await S.serviceAction(p.unit, map[p.act]);
    q.log.run(Date.now(), who.login, who.ip, 'usluga:' + p.act, p.unit, 1);
    send(res, 200, r);
  } catch (e) { q.log.run(Date.now(), who.login, who.ip, 'usluga:' + p.act, p.unit + ' — ' + e.message.split('\n')[0], 0); throw httpErr(400, e.message); }
});
route('POST', 'api/testowe/zatrzymaj', async (req, res, { b, who }) => {
  const pids = Array.isArray(b.pids) ? b.pids.map(Number).filter(Boolean) : (await S.testProcs()).map((x) => x.pid);
  const killed = await S.killTestProcs(pids);
  q.log.run(Date.now(), who.login, who.ip, 'procesy-testowe:zatrzymaj', killed.join(', '), 1);
  send(res, 200, { killed });
});

/* ---------------------------------------------------------------- bazy danych */

const site = (p) => decodeURIComponent(p.name);
const spOf = (req) => new URL(req.url, 'http://x').searchParams;
const tErr = (fn) => async (req, res, ctx) => { try { await fn(req, res, ctx); } catch (e) { if (res.headersSent) throw e; throw httpErr(e.status || 400, e.message); } };
const slog = (who, action, detail, ok = 1) => q.log.run(Date.now(), who.login, who.ip, action, String(detail).slice(0, 300), ok);

const dbp = (p) => ({ engine: p.engine, name: decodeURIComponent(p.id) });
route('GET', 'api/bazy', tErr(async (req, res) => { send(res, 200, { ...(await DB.overview()), jobs: [...jobs.values()].filter((j) => j.kind.startsWith('baza')).slice(-5) }); }));
route('GET', 'api/bazy/:engine/:id', tErr(async (req, res, { p }) => { const x = dbp(p); send(res, 200, { ...(await DB.detail(x.engine, x.name)), jobs: [...jobs.values()].filter((j) => j.db === `${x.engine}:${x.name}`).slice(-3) }); }));
route('GET', 'api/bazy/:engine/:id/tabela/:t', tErr(async (req, res, { p }) => {
  const x = dbp(p); const sp = spOf(req);
  send(res, 200, await DB.rows(x.engine, x.name, decodeURIComponent(p.t), { od: Math.max(0, Number(sp.get('od')) || 0), szukaj: String(sp.get('szukaj') || '').slice(0, 300) }));
}));
route('GET', 'api/bazy/:engine/:id/pobierz', tErr(async (req, res, { p, who }) => {
  const x = dbp(p);
  const f = x.engine === 'pliki' ? await D.dbDump('pliki', x.name, TMP_DIR) : await DB.dumpStream(x.engine, x.name, TMP_DIR);
  slog(who, 'baza:pobierz', `${x.engine}/${x.name}`);
  streamFile(res, f);
}));
route('POST', 'api/bazy/:engine/:id/wiersz', tErr(async (req, res, { p, b, who }) => {
  const x = dbp(p);
  await DB.rowEdit(x.engine, x.name, String(b.table || ''), b.action, b.key, b.values, who);
  slog(who, 'baza:wiersz', `${x.engine}/${x.name}/${b.table} ${b.action}`);
  send(res, 200, { ok: true });
}));
route('POST', 'api/bazy/:engine/:id/sql', tErr(async (req, res, { p, b, who }) => {
  const x = dbp(p);
  const r = await DB.runQuery(x.engine, x.name, b.sql, { write: !!b.write, confirm: !!b.confirm }, who);
  if (r.kind !== 'read' && !r.needConfirm) slog(who, 'baza:zapytanie', `${x.engine}/${x.name}: ${String(b.sql).slice(0, 200)}`);
  send(res, 200, r);
}));
route('POST', 'api/bazy/nowa', tErr(async (req, res, { b, who }) => {
  const r = await DB.createDatabase({ engine: b.engine, name: b.name, access: b.access, ip: b.ip }, who);
  slog(who, 'baza:nowa', `${r.engine}/${r.name}`);
  send(res, 200, r);
}));
route('POST', 'api/bazy/konto', tErr(async (req, res, { b, who }) => {
  const r = await DB.createAccount({ engine: b.engine, user: b.user, access: b.access, ip: b.ip, dbs: b.dbs }, who);
  slog(who, 'baza:konto-nowe', `${r.engine}/${r.user}`);
  send(res, 200, r);
}));
route('POST', 'api/bazy/konto/:engine/:user/:act', tErr(async (req, res, { p, b, who }) => {
  const u = decodeURIComponent(p.user);
  const r = await DB.userAction(p.engine, u, p.act, b, who);
  slog(who, 'baza:konto-' + p.act, `${p.engine}/${u}`);
  send(res, 200, r);
}));
const dbJob = (kind, label, who, key, fn) => { const j = startJob(kind, label, who, fn); j.db = key; return j; };
route('POST', 'api/bazy/:engine/:id/kopia', tErr(async (req, res, { p, who }) => {
  const x = dbp(p);
  const job = dbJob('baza-kopia', `Kopia bazy ${x.name}`, who, `${x.engine}:${x.name}`, async (say) => { const f = await DB.backupDatabase(x.engine, x.name, 'reczna', say); say(`✓ gotowe: ${f}\n`); return true; });
  send(res, 200, { job });
}));
route('POST', 'api/bazy/:engine/:id/klonuj', tErr(async (req, res, { p, b, who }) => {
  const x = dbp(p);
  const job = dbJob('baza-klon', `Kopia ${x.name} → ${b.to}`, who, `${x.engine}:${x.name}`, (say) => DB.cloneDatabase(x.engine, x.name, String(b.to || ''), who, say));
  send(res, 200, { job });
}));
route('POST', 'api/bazy/:engine/:id/usun', tErr(async (req, res, { p, b, who }) => {
  const x = dbp(p);
  if (String(b.confirm || '').trim() !== x.name) throw httpErr(400, `Aby potwierdzić, wpisz dokładnie: ${x.name}`);
  const job = dbJob('baza-usun', `Usuwanie bazy ${x.name}`, who, `${x.engine}:${x.name}`, (say) => DB.dropDatabase(x.engine, x.name, { withUsers: !!b.withUsers }, who, say));
  send(res, 200, { job });
}));
route('POST', 'api/bazy/:engine/:id/przywroc', tErr(async (req, res, { p, b, who }) => {
  const x = dbp(p);
  if (String(b.confirm || '').trim() !== x.name) throw httpErr(400, `Aby potwierdzić, wpisz dokładnie: ${x.name}`);
  const job = dbJob('baza-przywroc', `Przywracanie bazy ${x.name}`, who, `${x.engine}:${x.name}`, (say) => DB.restoreBackup(x.engine, x.name, b.file, who, say));
  send(res, 200, { job });
}));
route('POST', 'api/bazy/:engine/:id/wgraj', tErr(async (req, res, { p, who }) => {
  const x = dbp(p);
  const n = String(spOf(req).get('n') || 'plik.sql');
  if (!/\.(sql|sql\.gz|archive|archive\.gz|gz)$/i.test(n)) throw httpErr(400, 'Wgraj plik .sql albo .sql.gz (dla MongoDB: archiwum z mongodump).');
  const file = path.join(TMP_DIR, `wgraj-${Date.now()}-${n.replace(/[^A-Za-z0-9._-]/g, '_')}`);
  const max = 500 * 1024 * 1024;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { mode: 0o600 });
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); reject(httpErr(413, 'Plik jest za duży (najwięcej 500 MB).')); } });
    req.pipe(out);
    out.on('finish', resolve); out.on('error', reject); req.on('error', reject);
  });
  slog(who, 'baza:wgraj', `${x.engine}/${x.name} ${n}`);
  const job = dbJob('baza-wgraj', `Wgrywanie do ${x.name}`, who, `${x.engine}:${x.name}`, async (say) => { try { return await DB.importInto(x.engine, x.name, file, who, say); } finally { fs.rmSync(file, { force: true }); } });
  send(res, 200, { job });
}), { raw: true });
route('POST', 'api/bazy/silnik/:engine/zainstaluj', tErr(async (req, res, { p, who }) => {
  if (TEST_COPY && !process.env.SILNIKI_TEST) throw httpErr(400, 'To kopia testowa panelu — silników nie instaluje.');
  const job = startJob('baza-silnik', `Instalacja ${DB.NAMES[p.engine] || p.engine}`, who, (say) => DB.installEngine(p.engine, say));
  slog(who, 'baza:silnik-instalacja', p.engine);
  send(res, 200, { job });
}));
route('POST', 'api/bazy/silnik/:engine/:act', tErr(async (req, res, { p, who }) => {
  await DB.engineAction(p.engine, p.act);
  slog(who, 'baza:silnik-' + p.act, p.engine);
  J.add(who, 'bazy', `${DB.NAMES[p.engine]}: ${{ start: 'włączono', stop: 'wyłączono', restart: 'uruchomiono ponownie' }[p.act]}`);
  send(res, 200, { ok: true });
}));

/* ---------------------------------------------------------------- aplikacja i ustawienia strony */

route('GET', 'api/strona/:name/aplikacja', tErr(async (req, res, { p }) => {
  const a = await APP.appInfo(site(p));
  if (!a) throw httpErr(404, 'Ta strona nie ma aplikacji w tle.');
  send(res, 200, { ...a, jobs: [...jobs.values()].filter((j) => j.site === site(p) && j.kind.startsWith('aplikacja')).slice(-3) });
}));
route('GET', 'api/strona/:name/aplikacja/zmienna', tErr(async (req, res, { p, who }) => { const k = String(spOf(req).get('k') || ''); slog(who, 'aplikacja:pokaz-zmienna', `${site(p)} ${k}`); send(res, 200, { value: await APP.revealEnv(site(p), k) }); }));
route('GET', 'api/strona/:name/aplikacja/logi', tErr(async (req, res, { p }) => { send(res, 200, await APP.logs(site(p), { cursor: String(spOf(req).get('kursor') || '') })); }));
const appJob = (p, who, label, fn) => { const j = startJob('aplikacja:' + site(p), label, who, fn); j.site = site(p); return j; };
route('POST', 'api/strona/:name/aplikacja/zmienne', tErr(async (req, res, { p, b, who }) => {
  slog(who, 'aplikacja:zmienne', `${site(p)}: ${(b.changes || []).filter((c) => !c.keep).map((c) => c.key).join(', ')}`);
  send(res, 200, { job: appJob(p, who, `Zmienne: ${site(p)}`, async (say) => { await APP.setEnv(site(p), b.changes, who, say); say('✓ zapisano, aplikacja działa\n'); return true; }) });
}));
route('POST', 'api/strona/:name/aplikacja/restart', tErr(async (req, res, { p, who }) => {
  const u = await APP.unitFor(site(p));
  if (!u) throw httpErr(404, 'Ta strona nie ma aplikacji w tle.');
  await S.serviceAction(u, 'restart');
  slog(who, 'aplikacja:restart', site(p));
  send(res, 200, { ok: true });
}));
route('POST', 'api/strona/:name/aplikacja/zip', tErr(async (req, res, { p, who }) => {
  const file = path.join(TMP_DIR, `app-${Date.now()}.zip`);
  const max = 300 * 1024 * 1024;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { mode: 0o600 });
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); reject(httpErr(413, 'Plik jest za duży (najwięcej 300 MB).')); } });
    req.pipe(out); out.on('finish', resolve); out.on('error', reject); req.on('error', reject);
  });
  slog(who, 'aplikacja:zip', site(p));
  send(res, 200, { job: appJob(p, who, `Aktualizacja: ${site(p)}`, async (say) => { try { return await APP.update(site(p), { zip: file }, who, say); } finally { fs.rmSync(file, { force: true }); } }) });
}), { raw: true });
route('POST', 'api/strona/:name/aplikacja/git', tErr(async (req, res, { p, who }) => {
  slog(who, 'aplikacja:git', site(p));
  send(res, 200, { job: appJob(p, who, `Aktualizacja z GitHuba: ${site(p)}`, (say) => APP.update(site(p), { git: true }, who, say)) });
}));
route('POST', 'api/strona/:name/aplikacja/wroc', tErr(async (req, res, { p, b, who }) => {
  slog(who, 'aplikacja:wroc', `${site(p)} ${b.id || 'ostatnia'}`);
  send(res, 200, { job: appJob(p, who, `Powrót do poprzedniej wersji: ${site(p)}`, (say) => APP.rollback(site(p), b.id ? String(b.id) : null, who, say)) });
}));
route('GET', 'api/strona/:name/ustawienia', tErr(async (req, res, { p }) => {
  const name = site(p);
  const aliases = C.list().filter((r) => r.kind === 'przekierowanie' && r.target && new URL(r.target).hostname === name).map((r) => ({ host: r.host, slug: r.slug, ssl: r.ssl }));
  send(res, 200, { ...APP.siteSettings(name), aliases, jobs: [...jobs.values()].filter((j) => j.kind === 'php').slice(-2) });
}));
route('POST', 'api/strona/:name/ustawienia', tErr(async (req, res, { p, b, who }) => {
  const out = []; const r = await APP.saveSiteSettings(site(p), b, who, (t) => out.push(t));
  slog(who, 'strona:ustawienia', site(p));
  send(res, 200, { ...r, log: out.join('') });
}));
route('POST', 'api/php/:v/zainstaluj', tErr(async (req, res, { p, who }) => {
  if (TEST_COPY && !process.env.SILNIKI_TEST) throw httpErr(400, 'To kopia testowa panelu — nie instaluje pakietów.');
  slog(who, 'php:instalacja', p.v);
  send(res, 200, { job: startJob('php', `Instalacja PHP ${p.v}`, who, (say) => APP.installPhp(p.v, say)) });
}));
route('GET', 'api/strona/:name/vhost', tErr(async (req, res, { p }) => { send(res, 200, APP.vhostRead(site(p), String(spOf(req).get('f') || ''))); }));
route('POST', 'api/strona/:name/vhost', tErr(async (req, res, { p, b, who }) => {
  const r = await APP.vhostWrite(site(p), String(b.file || ''), String(b.text ?? ''), b.mtime, who);
  slog(who, 'strona:vhost', `${site(p)} ${b.file}`);
  send(res, 200, r);
}));

/* ---------------------------------------------------------------- wydajność, aktualizacje, alarmy */

route('GET', 'api/wydajnosc', tErr(async (req, res) => {
  const days = Math.max(1, Math.min(30, Number(spOf(req).get('dni')) || 30));
  const u = await SY.usage();
  const { history, ...m } = S.metrics();
  send(res, 200, { usage: u, history: SY.history(days), forecast: SY.diskForecast(), tips: await SY.tips(u), metrics: m, days });
}));
route('GET', 'api/aktualizacje', tErr(async (req, res) => { send(res, 200, { ...(await SY.updates()), jobs: [...jobs.values()].filter((j) => j.kind === 'aktualizacje').slice(-2) }); }));
route('POST', 'api/aktualizacje/zainstaluj', tErr(async (req, res, { who }) => {
  if (TEST_COPY) throw httpErr(400, 'To kopia testowa panelu — nie instaluje aktualizacji.');
  slog(who, 'aktualizacje:zainstaluj', '');
  J.add(who, 'system', 'Instalacja aktualizacji systemu z panelu');
  send(res, 200, { job: startJob('aktualizacje', 'Instalacja aktualizacji', who, async (say) => { const ok = await SY.installUpdates(say); const done = await AP.restartStale('po aktualizacji z panelu').catch(() => []); if (done.length) say(`▸ odświeżono usługi: ${done.join(', ')}\n`); say('✓ gotowe\n'); return ok; }) });
}));
route('POST', 'api/aktualizacje/restart', tErr(async (req, res, { b, who }) => {
  const r = SY.planRestart(b.anuluj ? null : b.at, who);
  slog(who, 'system:restart-plan', b.anuluj ? 'anulowano' : new Date(r.at).toISOString());
  send(res, 200, { plan: r });
}));
route('GET', 'api/alarmy', tErr(async (req, res) => {
  let games = []; try { if (G.ready()) games = (await G.list()).map((g) => ({ id: g.id, name: g.name })); } catch {}
  send(res, 200, { alarms: SY.alarms().map((a) => ({ ...a, text: SY.alarmText(a) })), metrics: SY.METRICS, sites: (await S.sites()).map((s) => s.name), services: (await S.services()).filter((x) => x.group !== 'other').map((x) => ({ unit: x.unit, name: x.name })), games });
}));
route('POST', 'api/alarmy', tErr(async (req, res, { b, who }) => { SY.alarmSave(b, who); send(res, 200, { ok: true }); }));
route('POST', 'api/alarmy/:id/usun', tErr(async (req, res, { p, who }) => { SY.alarmDelete(p.id, who); send(res, 200, { ok: true }); }));

/* ---------------------------------------------------------------- dostęp (SFTP, klucze SSH) i plan awaryjny */

route('GET', 'api/dostep', tErr(async (req, res) => {
  const sites = (await S.sites()).map((x) => ({ name: x.name, root: S.siteConfigs().find((c) => c.name === x.name)?.root || '' })).filter((x) => /^\/var\/www\//.test(x.root));
  send(res, 200, { sftp: await AC.sftpList(), sites, ssh: await AC.keys() });
}), { owner: true });
route('POST', 'api/dostep/sftp', tErr(async (req, res, { b, who }) => {
  if (TEST_COPY && !process.env.SILNIKI_TEST) throw httpErr(400, 'To kopia testowa panelu.');
  const r = await AC.sftpCreate({ user: b.user, site: b.site, note: b.note }, who);
  slog(who, 'dostep:sftp-nowe', `${r.user} → ${b.site}`);
  send(res, 200, r);
}), { owner: true });
route('POST', 'api/dostep/sftp/:user/:act', tErr(async (req, res, { p, who }) => {
  const u = decodeURIComponent(p.user);
  let r = { ok: true };
  if (p.act === 'haslo') r = await AC.sftpPassword(u, who);
  else if (p.act === 'blokuj' || p.act === 'odblokuj') await AC.sftpLock(u, p.act === 'blokuj', who);
  else if (p.act === 'usun') await AC.sftpDelete(u, who);
  else throw httpErr(400, 'Nieznana akcja.');
  slog(who, 'dostep:sftp-' + p.act, u);
  send(res, 200, r);
}), { owner: true });
route('POST', 'api/dostep/klucze', tErr(async (req, res, { b, who }) => { const r = await AC.keyAdd(b.key, who); slog(who, 'dostep:klucz-dodaj', r.fp); send(res, 200, r); }), { owner: true });
route('POST', 'api/dostep/klucze/usun', tErr(async (req, res, { b, who }) => { await AC.keyRemove(String(b.fp || ''), who); slog(who, 'dostep:klucz-usun', b.fp); send(res, 200, { ok: true }); }), { owner: true });
route('POST', 'api/dostep/root-haslo', tErr(async (req, res, { b, who }) => {
  if (TEST_COPY) throw httpErr(400, 'To kopia testowa panelu.');
  await AC.rootPassword(!!b.on, who); slog(who, 'dostep:root-haslo', b.on ? 'wł.' : 'wył.'); send(res, 200, { ok: true });
}), { owner: true });
route('GET', 'api/awaria', tErr(async (req, res) => { send(res, 200, await RS.status(O)); }));
route('GET', 'api/awaria/paczka', tErr(async (req, res, { who }) => { slog(who, 'awaria:paczka', ''); streamFile(res, await RS.rescuePackage(TMP_DIR)); }));

/* ---------------------------------------------------------------- ustawienia panelu */

route('GET', 'api/ustawienia', tErr(async (req, res) => {
  const v = SU.view();
  const lt = await SU.latest();
  send(res, 200, { config: v, version: VERSION, latest: lt, update: lt?.version && SU.newer(lt.version, VERSION), repo: SU.REPO, ip: S.metrics().ip, dns: v.adres ? await SU.dnsInfo(v.adres) : null, cli: fs.existsSync('/usr/local/bin/panel-serwera'), jobs: [...jobs.values()].filter((j) => j.kind === 'adres-panelu').slice(-1) });
}), { owner: true });
route('POST', 'api/ustawienia', tErr(async (req, res, { b, who }) => {
  const c = SU.update(b);
  slog(who, 'ustawienia:zapisz', Object.keys(b).join(', '));
  J.add(who, 'system', `Ustawienia panelu: ${Object.keys(b).filter((k) => k !== 'kreator').join(', ') || 'koniec kreatora'}`);
  send(res, 200, { ok: true, konfig: CFG.publicInfo() });
}), { owner: true });
route('POST', 'api/ustawienia/adres', tErr(async (req, res, { b, who }) => {
  if (TEST_COPY && !process.env.SILNIKI_TEST) throw httpErr(400, 'To kopia testowa panelu.');
  slog(who, 'ustawienia:adres', String(b.domena || ''));
  send(res, 200, { job: startJob('adres-panelu', `Adres panelu: ${b.domena}`, who, async (say) => { const u = await SU.setupPanelDomain(b.domena, b.email, say); const d = new URL(u).hostname; if (!PANEL_HOSTS.includes(d)) PANEL_HOSTS.push(d); J.add(who, 'system', `Adres panelu: ${u}`); return { ok: true, result: { url: u } }; }) });
}), { owner: true });
route('POST', 'api/ustawienia/aktualizuj', tErr(async (req, res, { who }) => {
  if (TEST_COPY) throw httpErr(400, 'To kopia testowa panelu.');
  const r = await SU.runUpdate();
  slog(who, 'panel:aktualizacja', '');
  J.add(who, 'system', 'Aktualizacja panelu z GitHuba');
  send(res, 200, r);
}), { owner: true });

/* ---------------------------------------------------------------- grupa serwerów */

route('GET', 'api/grupa', tErr(async (req, res) => { send(res, 200, { servers: GR.servers(), access: GR.accessList(), roles: GR.ROLES, me: { nazwa: CFG.C().nazwa, url: PUBLIC_URL } }); }), { owner: true });
route('GET', 'api/grupa/stan', tErr(async (req, res, { who }) => {
  const remote = who.viaGroup ? [] : await GR.overview(who);
  const { history, ...m } = S.metrics();
  const local = { id: '', nazwa: CFG.C().nazwa, url: PUBLIC_URL, ok: true, version: VERSION, konfig: CFG.publicInfo(), pulpit: GR.summary({ metrics: m, alerts: await alerts(), sites: await (async () => { const l = await S.sites(); return { total: l.filter((x) => x.enabled).length, ok: l.filter((x) => x.enabled && x.status === 'ok').length }; })() }) };
  send(res, 200, { servers: [local, ...remote] });
}));
route('POST', 'api/grupa/kod', tErr(async (req, res, { b, who }) => { const r = GR.newCode(String(b.rola || 'admin'), who); slog(who, 'grupa:kod', r.rola); send(res, 200, r); }), { owner: true });
route('POST', 'api/grupa/sparuj', tErr(async (req, res, { b, ip }) => {
  const wait = tooMany(ip);
  if (wait) throw httpErr(429, `Za dużo prób. Spróbuj za ${wait} min.`);
  try { const r = GR.pair(b, ip); q.log.run(Date.now(), r.nazwa, ip, 'grupa:sparowano', `${String(b.nazwa || '').slice(0, 60)} (${r.rola})`, 1); send(res, 200, { ...r, wersja: VERSION }); }
  catch (e) { failed(ip, 'kod grupy'); throw e; }
}), { open: true });
route('POST', 'api/grupa/polacz', tErr(async (req, res, { b, who }) => { const r = await GR.connect({ url: b.url, code: b.code }, who); slog(who, 'grupa:polacz', `${r.nazwa} (${r.rola})`); J.add(who, 'system', `Połączono serwer „${r.nazwa}” (${GR.ROLES[r.rola] || r.rola})`, null, '#/serwery'); send(res, 200, r); }), { owner: true });
route('POST', 'api/grupa/:id/odlacz', tErr(async (req, res, { p, who }) => { await GR.disconnect(p.id); slog(who, 'grupa:odlacz', p.id); J.add(who, 'system', 'Odłączono serwer z grupy', null, '#/serwery'); send(res, 200, { ok: true }); }), { owner: true });
route('POST', 'api/grupa/:id/nazwa', tErr(async (req, res, { p, b }) => { GR.rename(p.id, b.nazwa); send(res, 200, { ok: true }); }), { owner: true });
route('POST', 'api/grupa/dostep/:id/odwolaj', tErr(async (req, res, { p, who }) => { GR.revokeAccess(p.id); slog(who, 'grupa:odwolaj', p.id); J.add(who, 'system', 'Odebrano innemu panelowi dostęp do tego serwera', null, '#/serwery'); send(res, 200, { ok: true }); }), { owner: true });
route('POST', 'api/grupa/odlacz-mnie', tErr(async (req, res, { who }) => {
  if (!who.viaGroup) throw httpErr(400, 'To wywołuje tylko inny panel.');
  GR.revokeAccess(who.groupId); q.log.run(Date.now(), who.login, who.ip, 'grupa:odlaczony', '', 1); send(res, 200, { ok: true });
}));

/* ---------------------------------------------------------------- „Coś nie działa?” */

route('GET', 'api/napraw', tErr(async (req, res) => { send(res, 200, { problems: DR.PROBLEMS, targets: await DR.targets() }); }));
route('POST', 'api/napraw/sprawdz', tErr(async (req, res, { b, ip }) => { send(res, 200, await DR.check(String(b.problem || ''), b.target, { clientIp: ip })); }));
route('POST', 'api/napraw/napraw', tErr(async (req, res, { b, who }) => {
  const text = await DR.fix(String(b.id || ''), b.args || {}, who);
  slog(who, 'naprawa:' + b.id, JSON.stringify(b.args || {}));
  J.add(who, 'naprawa', `Naprawa: ${text}`, null, '#/napraw');
  S.sites.reset(); S.services.reset();
  send(res, 200, { ok: true, text });
}));

/* ---------------------------------------------------------------- terminal (tylko właściciel) */

route('GET', 'api/terminal', tErr(async (req, res) => { send(res, 200, { sessions: TM.list(), logs: TM.logs() }); }), { owner: true });
route('POST', 'api/terminal/otworz', tErr(async (req, res, { b, ip, who }) => {
  const wait = tooMany(ip);
  if (wait) throw httpErr(429, `Za dużo nieudanych prób. Spróbuj za ${wait} min.`);
  const u = q.user.get(who.login);
  const st = A.verifyTotp(u.totp, b.totp, u.last_step);
  if (st == null) { failed(ip, 'kod 2FA terminala'); slog(who, 'terminal:otworz', 'zły kod z aplikacji', 0); throw httpErr(401, 'Kod z aplikacji się nie zgadza — wpisz aktualny.'); }
  q.step.run(st, u.login);
  const r = TM.open(who, { cols: b.cols, rows: b.rows });
  slog(who, 'terminal:otworz', `sesja z ${ip}`);
  send(res, 200, r);
}), { owner: true });
route('GET', 'api/terminal/:id/czytaj', tErr(async (req, res, { p, who }) => { send(res, 200, await TM.read(p.id, who.login, Number(spOf(req).get('od')) || 0)); }), { owner: true });
route('POST', 'api/terminal/:id/pisz', tErr(async (req, res, { p, b, who }) => { TM.write(p.id, who.login, b.data); send(res, 200, { ok: true }); }), { owner: true });
route('POST', 'api/terminal/:id/rozmiar', tErr(async (req, res, { p, b, who }) => { TM.resize(p.id, who.login, b.cols, b.rows); send(res, 200, { ok: true }); }), { owner: true });
route('POST', 'api/terminal/:id/zamknij', tErr(async (req, res, { p, who }) => { TM.closeFor(p.id, who.login, 'zamknięto'); send(res, 200, { ok: true }); }), { owner: true });
route('GET', 'api/terminal/zapis/:name', tErr(async (req, res, { p, who }) => {
  const f = TM.logPath(decodeURIComponent(p.name));
  slog(who, 'terminal:zapis', p.name);
  streamFile(res, { name: path.basename(f), stream: fs.createReadStream(f), size: fs.statSync(f).size, type: 'text/plain; charset=utf-8' });
}), { owner: true });

/* ---------------------------------------------------------------- dziennik zmian */

route('GET', 'api/dziennik', tErr(async (req, res) => { const sp = spOf(req); send(res, 200, { items: J.list({ area: sp.get('obszar') || null, before: Number(sp.get('przed')) || null }) }); }));
route('POST', 'api/dziennik/:id/cofnij', tErr(async (req, res, { p, who }) => {
  const r = await J.undo(p.id, who);
  slog(who, 'dziennik:cofnij', p.id);
  S.sites.reset(); S.services.reset(); DB.resetUsage();
  send(res, 200, r);
}));

route('GET', 'api/kopie', async (req, res) => {
  const set = D.backupSettings();
  send(res, 200, { runs: D.backupRuns(30), files: D.backupFiles(), settings: set, next: nextRun(set.hour, set.minute), jobs: [...jobs.values()].filter((j) => j.kind.startsWith('kopia') || j.kind === 'przywracanie' || j.kind === 'chmura').slice(-5), chmura: { ...O.publicSettings(), providers: O.PROVIDERS, busy: O.isBusy() } });
});
route('POST', 'api/kopie/teraz', async (req, res, { who }) => {
  q.log.run(Date.now(), who.login, who.ip, 'kopia:teraz', 'ręczne uruchomienie nocnej kopii', 1);
  const job = startJob('kopia', 'Kopia zapasowa', who, async (say) => {
    say('▸ uruchamiam pełną kopię (bazy, kod, konfiguracja, migawki plików)…\n');
    const before = readText(D.BACKUP_LOG).length;
    const r = await spawnCollect('nice', ['-n', '10', D.BACKUP_SCRIPT]);
    const log = readText(D.BACKUP_LOG).slice(before);
    say(log || r.out);
    const okRun = r.ok && /=== koniec backupu ===/.test(log);
    say(okRun ? '✓ kopia gotowa\n' : '✗ kopia się nie udała — szczegóły wyżej\n');
    return okRun;
  });
  send(res, 200, { job });
});
route('GET', 'api/kopie/pobierz', async (req, res, { who }) => {
  const p = new URL(req.url, 'http://x').searchParams.get('p');
  const f = D.backupDownload(p);
  q.log.run(Date.now(), who.login, who.ip, 'kopia:pobierz', p, 1);
  streamFile(res, f);
});
route('POST', 'api/kopie/usun', async (req, res, { b, who }) => {
  try {
    const real = D.backupDelete(b.p);
    q.log.run(Date.now(), who.login, who.ip, 'kopia:usun', real, 1);
    send(res, 200, { ok: true });
  } catch (e) { throw httpErr(400, e.message); }
});
route('POST', 'api/kopie/plan', async (req, res, { b }) => {
  try { send(res, 200, await D.restorePlan(b.p)); } catch (e) { throw httpErr(400, e.message); }
});
route('POST', 'api/kopie/przywroc', async (req, res, { b, who }) => {
  let plan;
  try { plan = await D.restorePlan(b.p); } catch (e) { throw httpErr(400, e.message); }
  if (String(b.confirm || '').trim() !== plan.confirm) throw httpErr(400, `Aby potwierdzić, wpisz dokładnie: ${plan.confirm}`);
  q.log.run(Date.now(), who.login, who.ip, 'kopia:przywroc', plan.file, 1);
  if (plan.kind === 'engine') return send(res, 200, { job: startJob('przywracanie', `Przywracanie bazy ${plan.db}`, who, (say) => DB.restoreBackup(plan.engine, plan.db, plan.file, who, say)) });
  const job = startJob('przywracanie', plan.kind === 'gibcord' ? 'Przywracanie bazy GibCorda' : `Przywracanie bazy ${plan.db}`, who, async (say) => {
    const ok = await steps(D.restoreSteps(plan), say);
    if (!ok && plan.kind === 'gibcord') { say('▸ uruchamiam GibCorda z powrotem\n'); await spawnCollect('systemctl', ['start', D.gibcordUnit()]); }
    return ok;
  });
  send(res, 200, { job });
});
route('POST', 'api/kopie/ustawienia', async (req, res, { b, who }) => {
  try {
    const s = D.saveBackupSettings(b);
    q.log.run(Date.now(), who.login, who.ip, 'kopia:ustawienia', JSON.stringify({ keepDb: s.keepDb, keepCode: s.keepCode, keepMedia: s.keepMedia, minFreeMb: s.minFreeMb }), 1);
    send(res, 200, s);
  } catch (e) { throw httpErr(400, e.message); }
});

route('GET', 'api/dysk', async (req, res) => {
  const sp = new URL(req.url, 'http://x').searchParams;
  if (!S.duSnapshot() && !S.duInfo().busy) S.refreshDu();
  send(res, 200, { metrics: S.metrics().disk, tree: S.diskTree(sp.get('dir') || '/'), du: S.duInfo(), clean: sp.has('drzewo') ? null : await S.cleanupCandidates() });
});
route('POST', 'api/dysk/przelicz', async (req, res) => { S.refreshDu(); send(res, 200, { ok: true }); });
route('POST', 'api/dysk/sprzataj', async (req, res, { b, who }) => {
  const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
  if (!ids.length) throw httpErr(400, 'Nic nie wybrano.');
  const job = startJob('sprzatanie', 'Sprzątanie dysku', who, async (say) => {
    const before = S.metrics().disk.free;
    for (const id of ids) { say(`▸ ${id}: `); say((await S.cleanup(id)) + '\n'); }
    const freed = S.metrics().disk.free - before;
    say(`✓ zwolniono ${(Math.max(0, freed) / 1048576).toFixed(0)} MB\n`);
    q.log.run(Date.now(), who.login, who.ip, 'dysk:sprzataj', `${ids.join(', ')} — ${(freed / 1048576).toFixed(0)} MB`, 1);
    S.refreshDu();
    return true;
  });
  send(res, 200, { job });
});

route('GET', 'api/logi/zrodla', async (req, res) => { send(res, 200, { sources: await S.logSources() }); });
route('GET', 'api/logi', async (req, res) => {
  const sp = new URL(req.url, 'http://x').searchParams;
  const id = sp.get('z') || 'panel';
  const n = Math.max(20, Math.min(2000, Number(sp.get('n')) || 200));
  const filter = (sp.get('f') || '').slice(0, 200);
  if (id === 'panel') {
    let rows = q.logs.all(filter ? 5000 : n);
    if (filter) { const f = filter.toLowerCase(); rows = rows.filter((r) => `${r.login} ${r.ip} ${r.action} ${r.detail}`.toLowerCase().includes(f)).slice(0, n); }
    return send(res, 200, { audit: rows });
  }
  try { send(res, 200, { lines: await S.readLog(id, n, filter) }); } catch (e) { throw httpErr(400, e.message); }
});

route('GET', 'api/ssl', async (req, res) => {
  const force = new URL(req.url, 'http://x').searchParams.has('odswiez');
  const [certs, sites, cron] = await Promise.all([S.certs(force), S.sites(force), S.cronList()]);
  send(res, 200, { certs, sites: sites.filter((s) => s.https).map((s) => ({ name: s.name, enabled: s.enabled, cert: s.cert })), auto: cron.items.filter((i) => /certbot|acme\.sh/.test(i.cmd)).concat(cron.timers.filter((t) => /certbot/.test(t.unit)).map((t) => ({ human: 'systemd timer', cmd: t.unit, next: t.next }))) });
});
route('POST', 'api/ssl/:name/odnow', async (req, res, { p, who }) => {
  let cmd;
  try { cmd = await S.renewCert(p.name); } catch (e) { throw httpErr(400, e.message); }
  q.log.run(Date.now(), who.login, who.ip, 'ssl:odnow', p.name, 1);
  const job = startJob('ssl', `Odnawianie certyfikatu ${p.name}`, who, async (say) => {
    const r = await spawnCollect(cmd[0], cmd[1], { onData: say });
    S.certs.reset(); S.sites.reset();
    say(r.ok ? '✓ gotowe\n' : '✗ nie udało się\n');
    return r.ok;
  });
  send(res, 200, { job });
});

route('GET', 'api/cron', async (req, res) => {
  const c = await S.cronList();
  send(res, 200, { ...c, items: c.items.filter((i) => i.source !== '/etc/cron.d/panel-serwera'), panel: SY.cronJobs(), services: (await S.services()).map((x) => ({ unit: x.unit, name: x.name })), jobs: [...jobs.values()].filter((j) => j.kind === 'harmonogram').slice(-3) });
});
route('POST', 'api/cron/zadanie', tErr(async (req, res, { b, who }) => { const r = SY.cronSave(b, who); slog(who, 'harmonogram:zapisz', r.name); send(res, 200, r); }));
route('POST', 'api/cron/:id/usun', tErr(async (req, res, { p, who }) => { SY.cronDelete(p.id, who); slog(who, 'harmonogram:usun', p.id); send(res, 200, { ok: true }); }));
route('POST', 'api/cron/:id/wlacz', tErr(async (req, res, { p, b, who }) => { SY.cronToggle(p.id, !!b.on, who); send(res, 200, { ok: true }); }));
route('POST', 'api/cron/:id/uruchom', tErr(async (req, res, { p, who }) => { slog(who, 'harmonogram:uruchom', p.id); send(res, 200, { job: startJob('harmonogram', 'Zadanie z harmonogramu', who, (say) => SY.cronRunNow(p.id, say)) }); }));

route('GET', 'api/zadania/:id', (req, res, { p, who }) => {
  const j = jobs.get(p.id);
  if (!j || (!['wlasciciel', 'admin'].includes(who.role) && j.who?.login !== who.login)) throw httpErr(404, 'Nie ma takiego zadania.');
  send(res, 200, j);
});

/* ------------------------------------------------------------ tworzenie */

route('GET', 'api/utworz', async (req, res) => {
  const created = C.list().map((r) => ({ ...r, hasAccess: !!r.db }));
  send(res, 200, { templates: C.TEMPLATES, domains: C.baseDomains(), created, ip: S.metrics().ip, ovh: OV.info() });
});
route('GET', 'api/utworz/sprawdz', async (req, res) => {
  const sp = new URL(req.url, 'http://x').searchParams;
  send(res, 200, await C.check({ template: sp.get('szablon'), host: sp.get('adres'), name: sp.get('nazwa') }));
});
route('POST', 'api/utworz/zip', async (req, res, { who }) => {
  const max = 300 * 1024 * 1024;
  const len = Number(req.headers['content-length'] || 0);
  if (!len) throw httpErr(400, 'Brak pliku.');
  if (len > max) throw httpErr(413, 'Plik jest za duży (maks. 300 MB).');
  const token = A.randomToken(12);
  const file = path.join(TMP_DIR, `zip-${token}.zip`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { mode: 0o600 });
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); reject(httpErr(413, 'Plik jest za duży.')); } });
    req.pipe(out);
    out.on('finish', resolve); out.on('error', reject); req.on('error', reject);
  });
  try {
    const info = await C.zipInspect(file);
    setTimeout(() => fs.rm(file, { force: true }, () => {}), 6 * 3600e3).unref();
    q.log.run(Date.now(), who.login, who.ip, 'utworz:zip', `${info.files} plików`, 1);
    send(res, 200, { token, info, size: fs.statSync(file).size });
  } catch (e) { fs.rmSync(file, { force: true }); throw httpErr(400, e.message); }
}, { raw: true });
route('POST', 'api/utworz', async (req, res, { b, who }) => {
  const opts = { template: String(b.szablon || ''), host: String(b.adres || ''), name: String(b.nazwa || ''), db: b.baza === undefined ? undefined : !!b.baza, startPage: b.wkrotce !== false, target: String(b.cel || ''), zip: String(b.zip || ''), tmpDir: TMP_DIR };
  const chk = await C.check(opts);
  if (!chk.ok) throw httpErr(400, chk.problems.join(' '));
  q.log.run(Date.now(), who.login, who.ip, 'utworz:' + opts.template, chk.host || chk.slug, 1);
  const job = startJob('tworzenie', `Tworzenie: ${chk.host || chk.slug}`, who, async (say) => {
    if (chk.host && !chk.dns?.ok && OV.manages(chk.host)) {
      try { await OV.ensure(chk.host, say); say('  (nowy adres zacznie działać w ciągu kilku minut — certyfikat pobiorę sam)\n'); } catch (e) { say(`✗ OVH: ${e.message} — dodaj rekord ręcznie\n`); }
    }
    const r = await C.create(opts, who, say);
    AP.event('tworzenie', 'ok', `Utworzono ${C.TEMPLATES[opts.template].name.toLowerCase()}: ${r.host || r.slug}`, { detail: who.login });
    return { ok: true, result: r };
  });
  send(res, 200, { job });
});
route('POST', 'api/utworz/:slug/usun', async (req, res, { p, b, who }) => {
  const r = C.list().find((x) => x.slug === p.slug);
  if (!r) throw httpErr(404, 'Nie ma takiej pozycji.');
  if (String(b.confirm || '').trim() !== (r.host || r.slug)) throw httpErr(400, `Aby potwierdzić, wpisz: ${r.host || r.slug}`);
  q.log.run(Date.now(), who.login, who.ip, 'utworz:usun', r.host || r.slug, 1);
  const job = startJob('usuwanie', `Usuwanie: ${r.host || r.slug}`, who, async (say) => {
    await C.remove(r.slug, say);
    if (r.host && OV.manages(r.host) && b.dns !== false) { try { await OV.remove(r.host, say); } catch (e) { say(`✗ OVH: ${e.message}\n`); } }
    AP.event('tworzenie', 'info', `Usunięto ${r.host || r.slug} (kopia w ${path.join(CFG.C().kopie.katalog, 'usuniete')})`, { detail: who.login });
    return true;
  });
  send(res, 200, { job });
});
route('POST', 'api/utworz/:slug/ssl', async (req, res, { p, who }) => {
  const r = C.list().find((x) => x.slug === p.slug);
  if (!r || !r.host) throw httpErr(404, 'Nie ma takiej strony.');
  const job = startJob('ssl', `Certyfikat: ${r.host}`, who, async (say) => (await C.trySsl(r.slug, say)) === 'gotowe');
  send(res, 200, { job });
});
route('GET', 'api/utworz/:slug/dostep', async (req, res, { p, who }) => {
  try {
    const txt = C.credentials(p.slug);
    q.log.run(Date.now(), who.login, who.ip, 'utworz:dane-dostepowe', p.slug, 1);
    send(res, 200, { text: txt });
  } catch (e) { throw httpErr(404, e.message); }
});

/* ------------------------------------------------------------- autopilot */

route('GET', 'api/autopilot', async (req, res) => { send(res, 200, { ...(await AP.status()), raport: R.settings() }); });
route('POST', 'api/autopilot/ustawienia', async (req, res, { b, who }) => {
  try {
    const s = AP.saveSettings(b);
    q.log.run(Date.now(), who.login, who.ip, 'autopilot:ustawienia', JSON.stringify(b).slice(0, 300), 1);
    send(res, 200, s);
  } catch (e) { throw httpErr(400, e.message); }
});
route('POST', 'api/autopilot/restart', async (req, res, { b, who }) => {
  const s = AP.planReboot(!!b.anuluj);
  q.log.run(Date.now(), who.login, who.ip, 'autopilot:restart-serwera', b.anuluj ? 'anulowano' : new Date(s.reboot.once).toISOString(), 1);
  send(res, 200, { once: s.reboot.once });
});
route('POST', 'api/autopilot/test', async (req, res, { who }) => {
  const r = await AP.sendNotification('Próbne powiadomienie', 'Jeśli to widzisz, autopilot umie Ci dać znać. Nic nie trzeba robić.', 'info', { force: true });
  q.log.run(Date.now(), who.login, who.ip, 'autopilot:test', JSON.stringify(r), r.some((x) => x.ok) ? 1 : 0);
  send(res, 200, { results: r });
});
route('POST', 'api/autopilot/teraz', async (req, res) => { await AP.runNow(); send(res, 200, { ok: true }); });
route('POST', 'api/autopilot/odswiez-uslugi', async (req, res, { who }) => {
  q.log.run(Date.now(), who.login, who.ip, 'autopilot:odswiez-uslugi', '', 1);
  const job = startJob('odswiezanie', 'Odświeżanie usług po aktualizacji', who, async (say) => {
    const done = await AP.restartStale('na prośbę');
    say(done.length ? `✓ uruchomiono ponownie: ${done.join(', ')}\n` : 'Nic nie trzeba było odświeżać.\n');
    await AP.runNow();
    return true;
  });
  send(res, 200, { job });
});
route('GET', 'api/autopilot/push', (req, res) => { send(res, 200, { key: AP.vapidPublic(), devices: AP.pushCount() }); });
route('POST', 'api/autopilot/push', (req, res, { b, who }) => {
  try { AP.addPush(b.sub, req.headers['user-agent']); } catch (e) { throw httpErr(400, e.message); }
  q.log.run(Date.now(), who.login, who.ip, 'autopilot:push-dodano', String(req.headers['user-agent'] || '').slice(0, 100), 1);
  send(res, 200, { ok: true, devices: AP.pushCount() });
});
route('POST', 'api/autopilot/push-usun', (req, res, { b }) => { AP.removePush(b.endpoint); send(res, 200, { ok: true, devices: AP.pushCount() }); });
route('GET', 'api/autopilot/ataki', async (req, res) => { send(res, 200, { jails: await AP.fail2ban() }); });
route('POST', 'api/autopilot/ataki', async (req, res, { b, who }) => {
  try { if (b.odblokuj) await AP.unban(String(b.jail), String(b.ip)); else await AP.ban(String(b.jail), String(b.ip)); }
  catch (e) { throw httpErr(400, e.message); }
  q.log.run(Date.now(), who.login, who.ip, b.odblokuj ? 'ataki:odblokuj' : 'ataki:zablokuj', `${b.jail} ${b.ip}`, 1);
  send(res, 200, { ok: true });
});
route('GET', 'api/autopilot/dostepnosc/:site', (req, res, { p }) => { send(res, 200, AP.uptime(decodeURIComponent(p.site))); });

/* ------------------------------------------------------------ statystyki */

route('GET', 'api/statystyki', async (req, res, { who }) => {
  const sp = new URL(req.url, 'http://x').searchParams;
  if (sp.has('odswiez')) await ST.update();
  const r = ST.summary(Number(sp.get('dni')) || 7);
  if (who.role === 'strony') { r.sites = r.sites.filter((x) => mine(who, x.name)); r.tips = r.tips.filter((x) => mine(who, x.site)); r.total = null; }
  send(res, 200, r);
});
route('GET', 'api/statystyki/:site', async (req, res, { p }) => {
  const sp = new URL(req.url, 'http://x').searchParams;
  send(res, 200, ST.details(decodeURIComponent(p.site), Number(sp.get('dni')) || 7));
});

/* ------------------------------------------------------------ karta strony */


route('GET', 'api/strona/:name', tErr(async (req, res, { p }) => {
  const name = site(p);
  const info = T.siteInfo(name);
  const all = await S.sites();
  const st = all.find((x) => x.name === name) || null;
  send(res, 200, {
    info: { name, kind: info.kind, roots: info.roots, unit: info.unit, https: info.https, made: info.made ? { slug: info.made.slug, kind: info.made.kind, db: info.made.db } : null },
    status: st ? { status: st.status, code: st.http?.code || 0, ms: st.http?.ms, cert: st.cert, enabled: st.enabled, logs: st.logs, services: st.services, aliases: st.aliases } : null,
    extras: T.extrasInfo(name), git: await T.gitInfo(name), versions: T.versions(name), uptime: AP.uptime(name), staging: T.stagingInfo(name),
    stagingOf: db.prepare("SELECT site FROM kopie_testowe WHERE host=?").get(name)?.site || null,
    stats: ST.details(name, 7), panelHost: PANEL_HOSTS.includes(name), app: await APP.unitFor(name).catch(() => null),
    jobs: [...jobs.values()].filter((j) => j.site === name).slice(-3),
  });
}));
route('GET', 'api/strona/:name/pliki', tErr(async (req, res, { p }) => { const sp = spOf(req); send(res, 200, T.listDir(site(p), sp.get('r'), sp.get('p') || '')); }));
route('GET', 'api/strona/:name/plik', tErr(async (req, res, { p, who }) => {
  const sp = spOf(req);
  const f = T.readFile(site(p), sp.get('r'), sp.get('p'));
  if (f.secret) slog(who, 'pliki:otworz-poufny', `${site(p)}/${f.rel}`);
  send(res, 200, f);
}));
route('POST', 'api/strona/:name/plik', tErr(async (req, res, { p, b, who }) => {
  const r = T.writeFile(site(p), b.r, b.p, b.text, b.mtime);
  slog(who, 'pliki:zapisz', `${site(p)}/${b.p}`);
  send(res, 200, r);
}));
route('GET', 'api/strona/:name/plik/wersja', tErr(async (req, res, { p }) => { const sp = spOf(req); send(res, 200, { text: T.fileVersionText(site(p), sp.get('r'), sp.get('p'), sp.get('id')) }); }));
route('POST', 'api/strona/:name/plik/wersja', tErr(async (req, res, { p, b, who }) => { const r = T.restoreFileVersion(site(p), b.r, b.p, b.id); slog(who, 'pliki:przywroc-wersje', `${site(p)}/${b.p} ${b.id}`); send(res, 200, r); }));
route('POST', 'api/strona/:name/pliki/:act', tErr(async (req, res, { p, b, who }) => {
  const n = site(p);
  const fn = { folder: () => T.makeDir(n, b.r, b.p, b.name), nowy: () => T.newFile(n, b.r, b.p, b.name), nazwa: () => T.renameItem(n, b.r, b.p, b.name), usun: () => T.trashItem(n, b.r, b.p) }[p.act];
  if (!fn) throw httpErr(404, 'Nieznana akcja.');
  const r = fn();
  slog(who, 'pliki:' + p.act, `${n}/${b.p}${b.name ? ' → ' + b.name : ''}`);
  send(res, 200, r);
}));
route('POST', 'api/strona/:name/wgraj', tErr(async (req, res, { p, who }) => {
  const sp = spOf(req);
  const r = await T.upload(site(p), sp.get('r'), sp.get('p') || '', sp.get('n') || '', req);
  slog(who, 'pliki:wgraj', `${site(p)}/${r.rel}`);
  send(res, 200, r);
}), { raw: true });
route('GET', 'api/strona/:name/pobierz', tErr(async (req, res, { p, who }) => {
  const sp = spOf(req);
  const f = sp.has('zip') ? await T.downloadZip(site(p), sp.get('r'), sp.get('p') || '') : T.downloadFile(site(p), sp.get('r'), sp.get('p'));
  slog(who, 'pliki:pobierz', `${site(p)}/${sp.get('p') || ''}${sp.has('zip') ? ' (zip)' : ''}`);
  streamFile(res, f);
}));
route('POST', 'api/strona/:name/wersje', tErr(async (req, res, { p, b, who }) => {
  const id = await T.snapshot(site(p), String(b.label || 'Zapisane ręcznie'), 'panel', who.login);
  slog(who, 'wersje:zapisz', site(p));
  send(res, 200, { id });
}));
route('POST', 'api/strona/:name/wersje/:id/przywroc', tErr(async (req, res, { p, who }) => {
  const n = site(p);
  slog(who, 'wersje:przywroc', `${n} #${p.id}`);
  const job = startJob('wersje:' + n, `Przywracanie wersji: ${n}`, who, async (say) => {
    await T.restoreVersion(n, p.id, who.login, say);
    AP.event('wersje', 'info', `Przywrócono wcześniejszą wersję ${n}`, { detail: who.login });
    return true;
  });
  job.site = n;
  send(res, 200, { job });
}));
route('POST', 'api/strona/:name/git', tErr(async (req, res, { p, b, who }) => {
  const n = site(p);
  if (b.usun) { T.gitRemove(n); slog(who, 'git:odlacz', n); return send(res, 200, { ok: true }); }
  if (b.klucz) return send(res, 200, { publicKey: await T.gitKey(n) });
  const r = await T.gitSetup(n, b);
  slog(who, 'git:polacz', `${n} ${b.repo} ${b.branch || 'main'}`);
  send(res, 200, r);
}));
const deployJob = (n, who, force) => {
  const job = startJob('git:' + n, `Aktualizacja z repozytorium: ${n}`, who, async (say) => {
    const r = await T.deploy(n, who.login, say, { force });
    if (!r.same) AP.event('wersje', 'ok', `${n}: wgrano „${r.msg}” z repozytorium`, { detail: who.login, auto: who.login === 'github' });
    return true;
  });
  job.site = n;
  return job;
};
route('POST', 'api/strona/:name/git/wdroz', tErr(async (req, res, { p, b, who }) => { slog(who, 'git:wdroz', site(p)); send(res, 200, { job: deployJob(site(p), who, !!b.force) }); }));
route('POST', 'api/strona/:name/haslo', tErr(async (req, res, { p, b, who }) => {
  if (PANEL_HOSTS.includes(site(p))) throw httpErr(400, 'Przez tę stronę działa panel — nie zakładaj na nią hasła.');
  const r = await T.setPassword(site(p), { on: !!b.on, user: b.user, pass: b.pass });
  slog(who, b.on ? 'ochrona:haslo-wl' : 'ochrona:haslo-wyl', site(p));
  send(res, 200, r);
}));
route('POST', 'api/strona/:name/przerwa', tErr(async (req, res, { p, b, who }) => {
  if (PANEL_HOSTS.includes(site(p))) throw httpErr(400, 'Przez tę stronę działa panel — przerwa by go zablokowała.');
  const r = await T.setMaintenance(site(p), { on: !!b.on, text: b.text });
  slog(who, b.on ? 'przerwa:wl' : 'przerwa:wyl', site(p));
  AP.event('strony', 'info', b.on ? `Włączono przerwę techniczną na ${site(p)}` : `Koniec przerwy technicznej na ${site(p)}`, { detail: who.login });
  send(res, 200, r);
}));

route('POST', 'api/strona/:name/kopia-testowa', tErr(async (req, res, { p, b, who }) => {
  const n = site(p);
  const act = String(b.akcja || 'utworz');
  if (!['utworz', 'opublikuj', 'usun'].includes(act)) throw httpErr(400, 'Nieznana akcja.');
  if (act === 'opublikuj' && String(b.confirm || '').trim() !== n) throw httpErr(400, `Aby potwierdzić, wpisz: ${n}`);
  slog(who, 'kopia-testowa:' + act, n);
  const label = { utworz: 'Tworzenie kopii testowej', opublikuj: 'Publikowanie kopii testowej', usun: 'Usuwanie kopii testowej' }[act];
  const job = startJob('kopia-testowa:' + n, `${label}: ${n}`, who, async (say) => {
    if (act === 'utworz') { const r = await T.stagingCreate(n, who.login, C, say); AP.event('wersje', 'info', `Utworzono kopię testową ${n} → ${r.host}`, { detail: who.login }); }
    if (act === 'opublikuj') { await T.stagingPublish(n, who.login, say); AP.event('wersje', 'ok', `Opublikowano kopię testową na ${n}`, { detail: who.login }); }
    if (act === 'usun') { await T.stagingRemove(n, C, say); AP.event('wersje', 'info', `Usunięto kopię testową ${n}`, { detail: who.login }); }
    return true;
  });
  job.site = n;
  send(res, 200, { job });
}));

/** Webhook z GitHuba/GitLaba: bez logowania, ale z podpisem HMAC (sekret z panelu). */
async function gitHook(req, res, hook) {
  const g = T.siteByHook(hook);
  if (!g || req.method !== 'POST') return send(res, 404, { error: 'Nie ma.' });
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 2 * 1024 * 1024) return send(res, 413, { error: 'Za duże.' }); chunks.push(c); }
  const raw = Buffer.concat(chunks);
  if (!T.verifyHook(g, req.headers, raw)) { console.error(`panel-serwera: webhook ${g.site} — zły podpis z ${clientIp(req)}`); return send(res, 401, { error: 'Zły podpis.' }); }
  const ev = String(req.headers['x-github-event'] || req.headers['x-gitlab-event'] || '');
  if (ev === 'ping') return send(res, 200, { ok: true, pong: true });
  let body = {}; try { body = JSON.parse(raw.toString('utf8')); } catch {}
  if (body.ref && body.ref !== `refs/heads/${g.branch}`) return send(res, 202, { ok: true, skipped: 'inna gałąź' });
  if (!g.auto) return send(res, 202, { ok: true, skipped: 'automatyczne aktualizacje wyłączone' });
  try { deployJob(g.site, { login: 'github', ip: clientIp(req) }, false); } catch (e) { return send(res, 202, { ok: true, skipped: e.message }); }
  send(res, 202, { ok: true });
}

/* ------------------------------------------------------- raport tygodniowy */

route('GET', 'api/raport', async (req, res) => { send(res, 200, { ...(await R.build()), settings: R.settings() }); });
route('POST', 'api/raport/ustawienia', async (req, res, { b, who }) => {
  const r = R.save({ enabled: b.enabled, ...(b.hour != null ? { hour: b.hour } : {}), ...(b.day != null ? { day: b.day } : {}) });
  q.log.run(Date.now(), who.login, who.ip, 'raport:ustawienia', JSON.stringify(b).slice(0, 100), 1);
  send(res, 200, r);
});
route('POST', 'api/raport/wyslij', async (req, res, { who }) => {
  const r = await R.sendNow();
  q.log.run(Date.now(), who.login, who.ip, 'raport:wyslij', JSON.stringify(r.results), r.results.some((x) => x.ok) ? 1 : 0);
  send(res, 200, { results: r.results });
});
AP.addRule('raport', async () => { if (!TEST_COPY) await R.rule(); });

/* -------------------------------------------------------- kopie w chmurze */

route('POST', 'api/chmura/ustaw', async (req, res, { b, who }) => {
  if (TEST_COPY && !process.env.CHMURA_TEST) throw httpErr(400, 'To kopia testowa panelu.');
  try {
    const r = await O.configure(b);
    q.log.run(Date.now(), who.login, who.ip, 'chmura:ustaw', b.provider, 1);
    AP.event('kopie', 'ok', `Połączono kopie w chmurze (${O.PROVIDERS[b.provider].name})`, { detail: who.login });
    send(res, 200, r);
  } catch (e) { q.log.run(Date.now(), who.login, who.ip, 'chmura:ustaw', `${b.provider} — ${e.message}`, 0); throw httpErr(400, e.message); }
});
route('POST', 'api/chmura/opcje', async (req, res, { b, who }) => {
  const r = O.setOptions(b);
  q.log.run(Date.now(), who.login, who.ip, 'chmura:opcje', JSON.stringify(b).slice(0, 200), 1);
  send(res, 200, r);
});
const cloudJob = (who, what) => startJob('chmura', what === 'test' ? 'Sprawdzanie kopii w chmurze' : 'Wysyłka kopii do chmury', who, async (say) => {
  const r = what === 'test' ? await O.verify(say) : await O.upload(say);
  if (what === 'test') AP.event('kopie', r.ok ? 'ok' : 'error', r.ok ? 'Kopia w chmurze sprawdzona — da się ją odczytać' : `Kopia w chmurze nie przeszła sprawdzenia: ${r.msg}`, { notify: r.ok ? false : 'wazne' });
  else AP.event('kopie', r.ok ? 'ok' : 'error', r.ok ? 'Wysłano kopie do chmury' : `Wysyłka kopii do chmury nie udała się: ${r.msg}`, { notify: r.ok ? false : 'wazne', detail: (r.sent || []).map((x) => `${x.label}: ${x.sent}`).join('\n') });
  return r.ok;
});
route('POST', 'api/chmura/wyslij', async (req, res, { who }) => { q.log.run(Date.now(), who.login, who.ip, 'chmura:wyslij', '', 1); send(res, 200, { job: cloudJob(who, 'up') }); });
route('POST', 'api/chmura/sprawdz', async (req, res, { who }) => { q.log.run(Date.now(), who.login, who.ip, 'chmura:sprawdz', '', 1); send(res, 200, { job: cloudJob(who, 'test') }); });
route('GET', 'api/chmura/klucz', async (req, res, { who }) => {
  let txt;
  try { txt = await O.recoveryKit(); } catch (e) { throw httpErr(400, e.message); }
  q.log.run(Date.now(), who.login, who.ip, 'chmura:pakiet-odzyskiwania', 'pobrano klucze kopii w chmurze', 1);
  res.writeHead(200, { ...SEC_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="kopie-${String(CFG.C().nazwa).replace(/[^A-Za-z0-9_-]/g, '_')}-odzyskiwanie.txt"` });
  res.end(txt);
});
const SYS = { login: 'autopilot', ip: '' };
AP.addRule('chmura', async () => {
  if (TEST_COPY || !O.ready() || O.isBusy()) return;
  const s = O.settings();
  const now = new Date();
  const target = new Date(now); target.setHours(s.hour, s.minute, 0, 0);
  const nightly = D.backupRuns(3)[0];
  const backupRunning = nightly?.status === 'running' && Date.now() - nightly.start < 3 * 3600e3;
  if (now >= target && (!s.last || s.last.start < target.getTime()) && !backupRunning && ![...jobs.values()].some((j) => j.kind === 'chmura' && !j.end)) {
    cloudJob(SYS, 'up');
    return;
  }
  const t = new Date(now); t.setHours(5, 30, 0, 0);
  if (now.getDay() === 0 && now >= t && s.last?.ok && (!s.lastTest || Date.now() - s.lastTest.start > 6 * 864e5) && ![...jobs.values()].some((j) => j.kind === 'chmura' && !j.end)) cloudJob(SYS, 'test');
});
AP.addTodo(async () => {
  const s = O.publicSettings();
  if (!s.configured) return [{ level: 'decision', text: 'Kopie leżą tylko na tym serwerze', desc: 'Jeśli padnie dysk, przepadną razem ze stronami. Podłącz chmurę (np. Backblaze B2 — 10 GB za darmo), a kopie będą co noc wysyłane zaszyfrowane.', link: '#/kopie', cta: 'Podłącz chmurę' }];
  if (s.enabled && s.last && !s.last.ok) return [{ level: 'error', text: 'Ostatnia wysyłka kopii do chmury się nie udała', desc: s.last.msg, link: '#/kopie', cta: 'Pokaż' }];
  if (s.enabled && s.last?.ok && Date.now() - s.last.start > 50 * 3600e3) return [{ level: 'warn', text: 'Od dwóch dni nic nie poszło do chmury', desc: 'Sprawdź połączenie z chmurą w zakładce Kopie.', link: '#/kopie', cta: 'Pokaż' }];
  return [];
});

/* ------------------------------------------------------- strona statusu */

route('GET', 'api/status-strona', async (req, res) => { send(res, 200, { settings: SP.settings(), preview: await SP.data(), sites: S.siteConfigs().map((x) => x.name).sort(), units: (await S.services()).filter((x) => x.group !== 'other').map((x) => ({ unit: x.unit, name: x.name })), url: CFG.C().status?.url || (PUBLIC_URL + 'status/') }); });
route('POST', 'api/status-strona', async (req, res, { b, who }) => {
  let r;
  if (b.komunikat) r = SP.addNotice(b.komunikat, b.level);
  else if (b.usunKomunikat) r = SP.removeNotice(b.usunKomunikat);
  else r = SP.save(b);
  q.log.run(Date.now(), who.login, who.ip, 'status-strona', JSON.stringify(b).slice(0, 200), 1);
  send(res, 200, r);
});
async function publicStatus(req, res, rel) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Tylko GET.' });
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'public, max-age=60' };
  if (rel === 'status/dane.json') {
    const v = await SP.data();
    if (!v.enabled) return send(res, 404, { error: 'Nie ma.' });
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ title: v.title, services: v.services.map((x) => ({ name: x.name, state: x.state, uptime90: x.avg })), checked: v.checked }));
  }
  if (rel === 'status') { res.writeHead(301, { Location: 'status/' }); return res.end(); }
  const page = await SP.html();
  if (!page) return send(res, 404, { error: 'Strona statusu jest wyłączona.' });
  res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  res.end(req.method === 'HEAD' ? undefined : page);
}

/* --------------------------------------------------------- serwery gier */

route('GET', 'api/gry', async (req, res) => {
  const i = G.info();
  let servers = [], error = null;
  if (i.connected) { try { servers = await G.list(new URL(req.url, 'http://x').searchParams.has('odswiez')); } catch (e) { error = e.message; } }
  send(res, 200, { ...i, servers, error, ip: i.connected ? undefined : S.metrics().ip });
});
route('POST', 'api/gry/polacz', async (req, res, { b, who }) => {
  try { const r = await G.connect(b); q.log.run(Date.now(), who.login, who.ip, 'gry:polacz', r.user, 1); send(res, 200, r); } catch (e) { throw httpErr(400, e.message); }
});
route('POST', 'api/gry/odlacz', async (req, res, { who }) => { q.log.run(Date.now(), who.login, who.ip, 'gry:odlacz', '', 1); send(res, 200, G.disconnect()); });
route('POST', 'api/gry/:id/:sig', async (req, res, { p, who }) => {
  try { await G.power(p.id, p.sig); } catch (e) { throw httpErr(400, e.message); }
  q.log.run(Date.now(), who.login, who.ip, 'gry:' + p.sig, p.id, 1);
  AP.event('gry', 'info', `Serwer gry ${p.id}: ${{ start: 'uruchomiony', stop: 'zatrzymany', restart: 'restart', kill: 'wyłączony siłą' }[p.sig]}`, { detail: who.login });
  send(res, 200, { ok: true });
});

/* ---------------------------------------------------------- domeny (OVH) */

route('GET', 'api/ovh', async (req, res) => {
  const sp = new URL(req.url, 'http://x').searchParams;
  const i = OV.info();
  let recs = null;
  if (sp.get('strefa') && i.connected) { try { recs = await OV.records(sp.get('strefa')); } catch (e) { throw httpErr(400, e.message); } }
  send(res, 200, { ...i, tokenUrl: OV.TOKEN_URL, records: recs, ip: S.metrics().ip });
});
route('POST', 'api/ovh/polacz', async (req, res, { b, who }) => {
  try {
    const r = await OV.connect(b);
    q.log.run(Date.now(), who.login, who.ip, 'ovh:polacz', r.zones.join(', '), 1);
    AP.event('tworzenie', 'ok', `Połączono z OVH — domeny: ${r.zones.join(', ')}`, { detail: who.login });
    send(res, 200, r);
  } catch (e) { q.log.run(Date.now(), who.login, who.ip, 'ovh:polacz', e.message, 0); throw httpErr(400, e.message); }
});
route('POST', 'api/ovh/odlacz', async (req, res, { who }) => { q.log.run(Date.now(), who.login, who.ip, 'ovh:odlacz', '', 1); send(res, 200, OV.disconnect()); });
route('POST', 'api/ovh/wildcard', async (req, res, { b, who }) => {
  try { const r = await OV.wildcard(String(b.zone || '')); q.log.run(Date.now(), who.login, who.ip, 'ovh:wildcard', b.zone, 1); send(res, 200, r); } catch (e) { throw httpErr(400, e.message); }
});
route('POST', 'api/ovh/rekord', async (req, res, { b, who }) => {
  const host = String(b.host || '').toLowerCase();
  if (!OV.manages(host)) throw httpErr(400, 'Ta domena nie jest w OVH albo OVH nie jest połączone.');
  try { const r = await OV.ensure(host); q.log.run(Date.now(), who.login, who.ip, 'ovh:rekord', host, 1); send(res, 200, r); } catch (e) { throw httpErr(400, e.message); }
});

/* ------------------------------------------------------------------ konta */

const userObj = (u) => { let sites = []; try { sites = JSON.parse(u.sites || '[]'); } catch {} return { login: u.login, name: u.name, role: u.role, sites, created: u.created, lastLogin: u.last_login, active: !!u.active }; };
function checkRoleSites(role, sites) {
  if (!ROLES[role]) throw httpErr(400, 'Nieznana rola.');
  const all = new Set(S.siteConfigs().map((x) => x.name));
  const list = Array.isArray(sites) ? [...new Set(sites.map(String))].filter((x) => all.has(x)) : [];
  if (role === 'strony' && !list.length) throw httpErr(400, 'Wybierz co najmniej jedną stronę.');
  return role === 'strony' ? list : [];
}
route('GET', 'api/konta', (req, res, { who }) => {
  const users = db.prepare('SELECT * FROM users WHERE active=1 ORDER BY created').all().map(userObj);
  const invites = db.prepare('SELECT id,name,role,sites,created,expires,by FROM zaproszenia WHERE expires>? ORDER BY created DESC').all(Date.now()).map((x) => ({ ...x, sites: JSON.parse(x.sites || '[]') }));
  send(res, 200, { users, invites, roles: ROLES, sites: S.siteConfigs().map((x) => x.name).sort(), me: who.login });
}, { owner: true });
route('POST', 'api/konta/zapros', (req, res, { b, who }) => {
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw httpErr(400, 'Wpisz, kogo zapraszasz (np. imię).');
  const role = String(b.role || '');
  const sites = checkRoleSites(role, b.sites);
  const token = A.randomToken(24);
  const id = A.randomToken(6);
  db.prepare('INSERT INTO zaproszenia(id,token,name,role,sites,created,expires,by) VALUES(?,?,?,?,?,?,?,?)').run(id, A.sha256(token), name, role, JSON.stringify(sites), Date.now(), Date.now() + 24 * 3600e3, who.login);
  q.log.run(Date.now(), who.login, who.ip, 'konta:zaproszenie', `${name} (${role}${sites.length ? ': ' + sites.join(', ') : ''})`, 1);
  send(res, 200, { link: `${PUBLIC_URL}#zaproszenie=${token}`, expires: Date.now() + 24 * 3600e3 });
}, { owner: true });
route('POST', 'api/konta/zaproszenie-usun', (req, res, { b, who }) => {
  db.prepare('DELETE FROM zaproszenia WHERE id=?').run(String(b.id || ''));
  q.log.run(Date.now(), who.login, who.ip, 'konta:zaproszenie-usun', String(b.id), 1);
  send(res, 200, { ok: true });
}, { owner: true });
route('POST', 'api/konta/:login', (req, res, { p, b, who }) => {
  const u = q.user.get(p.login);
  if (!u || !u.active) throw httpErr(404, 'Nie ma takiego konta.');
  if (b.usun) {
    if (u.login === who.login) throw httpErr(400, 'Nie możesz usunąć własnego konta.');
    if (u.role === 'wlasciciel' && db.prepare("SELECT count(*) c FROM users WHERE active=1 AND role='wlasciciel'").get().c <= 1) throw httpErr(400, 'To jedyny właściciel — nie da się go usunąć.');
    db.prepare('DELETE FROM sessions WHERE login=?').run(u.login);
    db.prepare('DELETE FROM users WHERE login=?').run(u.login);
    q.log.run(Date.now(), who.login, who.ip, 'konta:usun', u.login, 1);
    return send(res, 200, { ok: true });
  }
  const role = String(b.role || u.role);
  if (u.login === who.login && role !== 'wlasciciel') throw httpErr(400, 'Nie odbieraj sobie roli właściciela.');
  const sites = checkRoleSites(role, b.sites);
  db.prepare('UPDATE users SET role=?, sites=?, name=? WHERE login=?').run(role, JSON.stringify(sites), String(b.name ?? u.name).slice(0, 60), u.login);
  q.log.run(Date.now(), who.login, who.ip, 'konta:zmiana', `${u.login}: ${role}${sites.length ? ' (' + sites.join(', ') + ')' : ''}`, 1);
  send(res, 200, { ok: true });
}, { owner: true });

// przyjęcie zaproszenia (bez logowania): login + hasło → kod QR → kod z aplikacji
const inviteBy = (token) => db.prepare('SELECT * FROM zaproszenia WHERE token=? AND expires>?').get(A.sha256(String(token || '')), Date.now());
route('GET', 'api/zaproszenie/:token', (req, res, { p, ip }) => {
  if (tooMany(ip)) throw httpErr(429, 'Za dużo prób. Spróbuj za kilkanaście minut.');
  const z = inviteBy(p.token);
  if (!z) { failed(ip, 'zaproszenie'); throw httpErr(404, 'To zaproszenie wygasło albo zostało już użyte. Poproś o nowe.'); }
  send(res, 200, { name: z.name, role: z.role, roleText: ROLES[z.role], sites: JSON.parse(z.sites || '[]'), by: z.by, expires: z.expires });
}, { open: true });
route('POST', 'api/zaproszenie/start', async (req, res, { b, ip }) => {
  if (tooMany(ip)) throw httpErr(429, 'Za dużo prób. Spróbuj za kilkanaście minut.');
  const z = inviteBy(b.token);
  if (!z) { failed(ip, 'zaproszenie'); throw httpErr(404, 'To zaproszenie wygasło albo zostało już użyte.'); }
  const login = String(b.login || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(login)) throw httpErr(400, 'Login: 3–32 znaki, małe litery, cyfry, kropka, myślnik.');
  const ex = q.user.get(login);
  if (ex && ex.active) throw httpErr(400, 'Ten login jest już zajęty — wybierz inny.');
  if (String(b.password || '').length < 10) throw httpErr(400, 'Hasło musi mieć co najmniej 10 znaków.');
  const secret = A.newTotpSecret();
  db.prepare('UPDATE zaproszenia SET login=?, pass=?, totp=? WHERE id=?').run(login, await A.hashPassword(b.password), secret, z.id);
  const uri = `otpauth://totp/${encodeURIComponent(`Serwer ${CFG.C().nazwa}:` + login)}?secret=${secret}&issuer=${encodeURIComponent(`Serwer ${CFG.C().nazwa}`)}`;
  const qr = qrcode(0, 'M'); qr.addData(uri); qr.make();
  send(res, 200, { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr: qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true }) });
}, { open: true });
route('POST', 'api/zaproszenie/koniec', async (req, res, { b, ip }) => {
  const z = inviteBy(b.token);
  if (!z || !z.login || !z.totp) throw httpErr(400, 'Zacznij od nowa — otwórz link z zaproszenia jeszcze raz.');
  const st = A.verifyTotp(z.totp, b.totp, -1);
  if (st == null) { failed(ip, 'zaproszenie 2FA'); throw httpErr(400, 'Kod z aplikacji się nie zgadza. Sprawdź godzinę w telefonie i wpisz nowy kod.'); }
  if (q.user.get(z.login)?.active) throw httpErr(400, 'Ten login jest już zajęty — otwórz link jeszcze raz i wybierz inny.');
  db.prepare('INSERT OR REPLACE INTO users(login,pass,totp,active,last_step,created,role,sites,name,last_login) VALUES(?,?,?,1,?,?,?,?,?,?)').run(z.login, z.pass, z.totp, st, Date.now(), z.role, z.sites, z.name, Date.now());
  db.prepare('DELETE FROM zaproszenia WHERE id=?').run(z.id);
  q.log.run(Date.now(), z.login, ip, 'konto:utworzone', `z zaproszenia od ${z.by} (${z.role})`, 1);
  AP.event('konta', 'info', `${z.name} (${z.login}) ma teraz dostęp do panelu — ${ROLES[z.role].split(" — ")[0].toLowerCase()}`, { notify: 'info' });
  newSession(res, z.login, req);
  send(res, 200, { ok: true, login: z.login });
}, { open: true });

/* ---------------------------------------------------------------- zapora */

const TEST_COPY = process.env.AUTOPILOT === '0'; // kopia testowa panelu: nie zmienia zapory serwera
const fwGuard = () => { if (TEST_COPY) throw httpErr(400, 'To kopia testowa panelu — zapory nie zmienia.'); };
route('GET', 'api/zapora', async (req, res) => { send(res, 200, { ...(await F.status()), serviceNames: Object.fromEntries(Object.entries(F.SERVICES).map(([k, v]) => [k, v.name])), undoSeconds: F.UNDO_SECONDS, jobs: [...jobs.values()].filter((j) => j.kind === 'zapora').slice(-1) }); });
route('POST', 'api/zapora/wlacz', async (req, res, { who }) => {
  fwGuard();
  q.log.run(Date.now(), who.login, who.ip, 'zapora:wlacz', '', 1);
  const job = startJob('zapora', 'Włączanie zapory', who, async (say) => {
    const t0 = Date.now();
    await F.enable(say);
    say('▸ sprawdzam, czy z internetu dalej da się wejść (czekam na zwykły ruch z zewnątrz)…\n');
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 10e3));
      const seen = await F.seenFromOutside(t0 + 3000);
      if (seen.www) {
        await F.confirm();
        say(`✓ strony są osiągalne z internetu${seen.ssh ? ', SSH też' : ''} — bezpiecznik zdjęty, zapora zostaje włączona\n`);
        AP.event('zapora', 'ok', 'Włączono zaporę — baza danych nie jest już widoczna z internetu', { detail: who.login });
        return true;
      }
    }
    say('✗ przez 4 minuty nie widzę ruchu z zewnątrz — jeśli panel działa, kliknij „Działa, zostaw”; inaczej zapora wyłączy się sama\n');
    return false;
  });
  send(res, 200, { job });
});
route('POST', 'api/zapora/potwierdz', async (req, res, { who }) => { fwGuard(); await F.confirm(); q.log.run(Date.now(), who.login, who.ip, 'zapora:potwierdz', '', 1); send(res, 200, { ok: true }); });
route('POST', 'api/zapora/wylacz', async (req, res, { b, who }) => {
  fwGuard();
  if (String(b.confirm || '').trim().toLowerCase() !== 'wyłącz') throw httpErr(400, 'Aby potwierdzić, wpisz: wyłącz');
  await F.disable();
  q.log.run(Date.now(), who.login, who.ip, 'zapora:wylacz', '', 1);
  AP.event('zapora', 'warn', 'Wyłączono zaporę', { detail: who.login });
  send(res, 200, { ok: true });
});
route('POST', 'api/zapora/usluga', async (req, res, { b, who }) => {
  fwGuard();
  try { await F.setService(String(b.id), !!b.on); } catch (e) { throw httpErr(400, e.message); }
  q.log.run(Date.now(), who.login, who.ip, 'zapora:usluga', `${b.id} ${b.on ? 'otwarta' : 'zamknięta'}`, 1);
  send(res, 200, { ok: true });
});
route('POST', 'api/zapora/zaufane', async (req, res, { b, who }) => {
  fwGuard();
  try { if (b.usun) await F.removeTrusted(String(b.host)); else await F.addTrusted(b); } catch (e) { throw httpErr(400, e.message); }
  q.log.run(Date.now(), who.login, who.ip, b.usun ? 'zapora:zaufany-usun' : 'zapora:zaufany', `${b.host} ${b.ports || ''}`, 1);
  send(res, 200, { ok: true });
});
route('POST', 'api/zapora/wlasne', async (req, res, { b, who }) => {
  fwGuard();
  try { if (b.usun) await F.removeCustom(String(b.id)); else await F.addCustom(b); } catch (e) { throw httpErr(400, e.message); }
  q.log.run(Date.now(), who.login, who.ip, b.usun ? 'zapora:regula-usun' : 'zapora:regula', `${b.port || b.id} ${b.proto || ''} ${b.from || ''}`, 1);
  send(res, 200, { ok: true });
});
AP.addRule('system', async () => {
  if (TEST_COPY) return;
  await SY.restartTick();
  await SY.alarmTick({ games: () => (G.ready() ? G.list() : Promise.resolve(null)) });
});
AP.addRule('bazy', async () => {
  if (TEST_COPY || !AP.due('bazy-dom', 10 * 60e3)) return;
  await DB.followHome((t, bad) => AP.event('bazy', bad ? 'error' : 'info', t, { auto: true, notify: bad ? 'error' : null }));
});
AP.addTodo(() => DB.todos());
AP.addRule('zapora', async () => {
  if (TEST_COPY || !AP.due('zapora', 5 * 60e3)) return;
  await F.maintain((c) => AP.event('zapora', 'info', `Zmienił się adres ${c.host} (${c.from || '—'} → ${c.to}) — zapora wpuszcza już nowy`, { auto: true, notify: 'info' }));
});
AP.addTodo(async () => {
  const st = await F.status();
  if (!st.active && st.risky.some((p) => p.port === 3306)) return [{ level: 'decision', text: 'Baza danych jest widoczna z całego internetu', desc: `${st.attacks} prób włamania do bazy w tym tygodniu. Zapora zostawi dostęp tylko serwerowi gier i Tailscale.`, link: '#/zapora', cta: 'Pokaż zaporę' }];
  if (st.undoAt) return [{ level: 'warn', text: 'Zapora czeka na potwierdzenie', desc: 'Jeśli strony i panel działają, potwierdź — inaczej zapora sama się wyłączy.', link: '#/zapora', cta: 'Potwierdź' }];
  return [];
});

/* ------------------------------------------------------------ pliki strony */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(rel, res) {
  if (!rel || rel === '/') rel = 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Nie ma.' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Nie ma takiej strony.' });
    const ext = path.extname(file);
    const sec = rel === 'terminal.html' ? { ...SEC_HEADERS, 'Content-Security-Policy': SEC_HEADERS['Content-Security-Policy'].replace("style-src 'self'", "style-src 'self' 'unsafe-inline'") } : SEC_HEADERS;
    res.writeHead(200, { ...sec, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || rel === 'sw.js' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
}

/* ----------------------------------------------------- grupa: inne panele */

async function proxyRemote(req, res, rel, url) {
  const m = /^zdalny\/([a-f0-9]{12})\/(api\/.*)$/.exec(rel);
  if (!m) throw httpErr(404, 'Nie ma takiego adresu.');
  if (/^api\/(grupa|logowanie|wyloguj|konfiguracja|zaproszenie)/.test(m[2])) throw httpErr(403, 'Tego nie robi się zdalnie.');
  const ip = clientIp(req);
  if (req.method !== 'GET') {
    if (req.headers['x-panel'] !== '1') throw httpErr(403, 'Brak nagłówka panelu.');
    const origin = req.headers.origin;
    if (origin && req.headers.host && new URL(origin).host !== (req.headers['x-forwarded-host'] || req.headers.host)) throw httpErr(403, 'Zapytanie z obcej strony.');
  }
  const sess = session(req);
  if (!sess) throw httpErr(401, 'Zaloguj się.');
  const u = q.user.get(sess.login);
  if (!u) throw httpErr(401, 'Zaloguj się.');
  if (!['wlasciciel', 'admin'].includes(u.role) && !(u.role === 'podglad' && req.method === 'GET')) throw httpErr(403, 'Nie masz dostępu do innych serwerów.');
  await GR.proxy(m[1], m[2] + url.search, req, res, { login: sess.login, ip });
}

/* ----------------------------------------------------------------- serwer */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (BASE !== '/' && rel.startsWith(BASE)) rel = '/' + rel.slice(BASE.length);
  rel = rel.replace(/^\/+/, '');
  if (rel === 'status' || rel === 'status/' || rel === 'status/dane.json') return publicStatus(req, res, rel).catch((e) => { console.error('panel-serwera: status', e); if (!res.headersSent) send(res, 500, { error: 'Błąd.' }); });
  if (rel.startsWith('hook/git/')) return gitHook(req, res, rel.slice('hook/git/'.length)).catch((e) => { console.error('panel-serwera: webhook', e); if (!res.headersSent) send(res, 500, { error: 'Błąd.' }); });
  if (rel.startsWith('zdalny/')) return proxyRemote(req, res, rel, url).catch((e) => { if (!res.headersSent) send(res, e.status || 500, { error: e.message }); else res.destroy(); });
  if (!rel.startsWith('api/')) return serveStatic(rel, res);
  const ip = clientIp(req);
  let r0 = null;
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(rel));
    r0 = r;
    if (!r) throw httpErr(404, 'Nie ma takiego adresu.');
    const p = rel.match(r.re).groups || {};
    if (req.method !== 'GET') {
      // ochrona przed CSRF: własny nagłówek (nie da się go wysłać z obcej strony bez CORS) + zgodny Origin
      if (req.headers['x-panel'] !== '1') throw httpErr(403, 'Brak nagłówka panelu.');
      const origin = req.headers.origin;
      if (origin && req.headers.host && new URL(origin).host !== (req.headers['x-forwarded-host'] || req.headers.host)) throw httpErr(403, 'Zapytanie z obcej strony.');
    }
    const sess = session(req);
    // panel, który zarządza tym serwerem (grupa): token zamiast sesji, prawa administratora albo podglądu
    const grp = !sess && req.headers['x-panel-grupa'] ? GR.checkToken(req.headers['x-panel-grupa'], ip) : null;
    if (!sess && req.headers['x-panel-grupa'] && !grp) { failed(ip, 'token grupy'); throw httpErr(401, 'Ten panel nie ma już dostępu do serwera (połączenie odwołane).'); }
    if (!r.opts.open && !sess && !grp) throw httpErr(401, 'Zaloguj się.');
    const u = sess ? q.user.get(sess.login) : null;
    if (sess && !u) { q.delSess.run(sess.id); throw httpErr(401, 'Zaloguj się.'); }
    let sites = []; try { sites = JSON.parse(u?.sites || '[]'); } catch {}
    const who = grp ? { login: `${grp.nazwa}:${String(req.headers['x-panel-kto'] || '?').replace(/[^\w.@-]/g, '').slice(0, 32)}`, ip, role: grp.rola, sites: [], name: '', viaGroup: true, groupId: grp.id }
      : { login: sess?.login || '', ip, role: u?.role || 'wlasciciel', sites, name: u?.name || '' };
    if (!r.opts.open && !allowed(r, who, p)) throw httpErr(403, who.role === 'podglad' ? 'Masz dostęp tylko do podglądu.' : 'Nie masz do tego dostępu.');
    // wyłączony moduł (Ustawienia panelu) — to, co daje dostęp do powłoki i plików, blokujemy także tutaj, nie tylko w menu
    const mod = /^api\/(terminal|dostep)(\/|$)/.exec(rel);
    if (mod && !CFG.on(mod[1])) throw httpErr(403, `Moduł „${CFG.MODULES[mod[1]][0]}” jest wyłączony (Ustawienia panelu).`);
    const b = req.method === 'POST' && !r.opts.raw ? await body(req) : {};
    await r.handler(req, res, { p, b, ip, sess, who });
  } catch (e) {
    // błędy z kontroli danych (zła ścieżka, nazwa, brak pliku) to błąd zapytania, nie serwera
    const status = e.status || (r0 && r0.opts && /^(Nie ma|Nieprawidłow|Ten plik|Ten rodzaj|Nieznan|Bazy|Tej|Tę)/.test(e.message || '') ? 400 : 500);
    if (status === 500) console.error('panel-serwera:', e);
    if (!res.headersSent) send(res, status, { error: e.message || 'Błąd serwera.' });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const code = setupCode();
  console.log(`panel-serwera ${VERSION}: ${HOST}:${PORT}, dane ${DATA_DIR}, adres bazowy ${BASE}${code ? ' — czeka na pierwszą konfigurację (kod w ' + SETUP_FILE + ')' : ''}`);
  setTimeout(() => S.refreshDu(), 3000);
  setInterval(() => S.refreshDu(), 30 * 60e3).unref();
});
