// Bazy danych — wspólny przód dla silników (MariaDB, PostgreSQL, MongoDB, Redis, SQLite):
// przegląd baz, kont i ryzyk, zakładanie bazy z kontem i hasłem, dostęp (tylko serwer / dom / adres IP),
// edycja danych i zapytania z bezpiecznikami, kopie, wgrywanie .sql i instalacja kolejnych silników.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { run, spawnCollect, cached, readText, stamp } from './util.mjs';
import * as S from './system.mjs';
import * as F from './firewall.mjs';
import * as J from './journal.mjs';
import * as D from './data.mjs';
import * as M from './db/maria.mjs';
import * as PG from './db/pg.mjs';
import * as MG from './db/mongo.mjs';
import * as RD from './db/redis.mjs';
import * as LT from './db/lite.mjs';
import { password, checkNew, checkName, homeIp, serverIp, BACKUP_DIR, homeHost } from './db/common.mjs';
import { C as CFG } from './config.mjs';

export const ENGINES = { mariadb: M, postgres: PG, mongo: MG, redis: RD, sqlite: LT };
export const NAMES = { mariadb: 'MariaDB', postgres: 'PostgreSQL', mongo: 'MongoDB', redis: 'Redis', sqlite: 'SQLite' };
const PORTS = { mariadb: 3306, postgres: 5432, mongo: 27017, redis: 6379 };
const PREFIX = { mariadb: '', postgres: 'pg-', mongo: 'mongo-', sqlite: 'sqlite-' };
let db, DATA_DIR, createdSites = () => [];

export function init(database, dataDir, opts = {}) {
  db = database; DATA_DIR = dataDir; createdSites = opts.createdSites || createdSites;
  PG.init(dataDir); MG.init(dataDir);
  db.exec(`CREATE TABLE IF NOT EXISTS bazy_konta(engine TEXT, user TEXT, mode TEXT, ip TEXT, created INTEGER, by TEXT, PRIMARY KEY(engine,user));
           CREATE TABLE IF NOT EXISTS bazy_meta(engine TEXT, name TEXT, created INTEGER, by TEXT, PRIMARY KEY(engine,name));`);
  J.handler('wiersz', async (d) => { await eng(d.engine).rowUndo(d.name, d.table, d.undo); });
  J.handler('konto-maria', async (d) => { await M.restoreUser(d.user, d.snap); usage.reset(); });
  J.handler('konto-blokada', async (d) => { await eng(d.engine).setLocked(d.user, d.locked); });
  J.handler('baza-kopia', async (d) => { const ok = await restoreFile(d.engine, d.name, d.file, () => {}); if (!ok) throw new Error('Nie udało się przywrócić kopii — szczegóły w logu panelu.'); });
}
function eng(e) { const E = ENGINES[e]; if (!E) throw new Error('Nieznany rodzaj bazy.'); return E; }
function ready(e) {
  if (e === 'postgres' && !PG.ready()) throw new Error('PostgreSQL nie jest zainstalowany — zainstaluj go w zakładce „Silniki”.');
  if (e === 'mongo' && !MG.ready()) throw new Error('MongoDB nie jest zainstalowany — zainstaluj go w zakładce „Silniki”.');
  return eng(e);
}

/* ------------------------------------------------------------- silniki */

async function unit(u) {
  const r = await run('systemctl', ['show', u, '-p', 'ActiveState', '-p', 'MemoryCurrent', '-p', 'UnitFileState']);
  const g = (k) => (r.out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '';
  const mem = Number(g('MemoryCurrent'));
  return { active: g('ActiveState') === 'active', state: g('ActiveState'), enabled: g('UnitFileState') === 'enabled', mem: Number.isFinite(mem) && mem < 1e15 ? mem : null };
}
const pgUnit = () => `postgresql@${PG.majorVersion()}-main`;
export const UNITS = { mariadb: 'mariadb', postgres: 'postgresql', mongo: 'mongod', redis: 'redis-server' };
let installing = null;
async function listeningPublic() {
  const r = await run('ss', ['-Hltn']);
  const pub = new Set();
  for (const l of r.out.split('\n')) { const m = l.trim().split(/\s+/)[3]?.match(/^(.*):(\d+)$/); if (m && !/^(127\.|\[::1\]|\[::ffff:127)/.test(m[1])) pub.add(Number(m[2])); }
  return pub;
}
export async function engines() {
  const out = [];
  const pub = await listeningPublic().catch(() => new Set());
  const fwOn = (await fwInfo()).active;
  const ma = await unit('mariadb');
  out.push({ id: 'mariadb', name: 'MariaDB', installed: true, ready: true, ...ma, version: ma.active ? await M.version() : '', port: 3306, desc: 'Dla stron PHP, WordPressa i FiveM. To samo co MySQL.' });
  const pgi = PG.installed();
  const pu = pgi ? await unit(pgUnit()) : {};
  out.push({ id: 'postgres', name: 'PostgreSQL', installed: pgi, ready: PG.ready(), ...pu, version: pgi && pu.active && PG.ready() ? await PG.version() : PG.majorVersion(), port: 5432, ram: 'około 40 MB', desc: 'Dla nowszych aplikacji (Node, Python, Django).' });
  const mgi = MG.installed();
  const mu = mgi ? await unit('mongod') : {};
  out.push({ id: 'mongo', name: 'MongoDB', installed: mgi, ready: MG.ready(), ...mu, version: mgi && mu.active && MG.ready() ? await MG.version() : '', port: 27017, ram: 'około 300 MB', desc: 'Dokumenty JSON zamiast tabel.' });
  const rdi = RD.installed();
  const ru = rdi ? await unit('redis-server') : {};
  let rv = ''; if (ru.active) { try { rv = (await RD.info()).version; } catch {} }
  out.push({ id: 'redis', name: 'Redis', installed: rdi, ready: rdi, ...ru, version: rv, port: 6379, desc: 'Szybka pamięć podręczna i kolejki. Tylko z tego serwera.' });
  out.push({ id: 'sqlite', name: 'SQLite', installed: true, ready: true, active: true, desc: 'Jeden plik dla małych aplikacji. Nic nie trzeba instalować.' });
  for (const e of out) {
    e.installing = installing === e.id;
    if (e.port) e.portInfo = !pub.has(e.port) ? `port ${e.port} (tylko lokalnie)` : fwOn ? `port ${e.port} (z zewnątrz tylko zaufane adresy)` : `port ${e.port} — widoczny z internetu (włącz zaporę)`;
    e.portOpen = pub.has(e.port || 0) && !fwOn;
  }
  return out;
}

/* ------------------------------------------------- kto używa której bazy */

const CONF_INCLUDE = ['.env', '*.env', '*config*.php', 'database.php', 'db*.php', 'settings*.php', 'wp-config.php', '*.ini', 'config*.json', 'appsettings*.json', '*.cfg', 'server.cfg'];
const usage = cached(10 * 60e3, async () => {
  const map = new Map();
  const add = (k, label, link) => { const l = map.get(k) || []; if (!l.some((x) => x.label === label)) l.push({ label, link }); map.set(k, l); };
  try {
    for (const r of await M.q('SELECT d.`database` db, d.username u, s.name n FROM panel.databases d LEFT JOIN panel.servers s ON s.id=d.server_id')) add(`mariadb:${r.db}`, `serwer gry ${r.n || '?'}`, '#/gry');
  } catch {}
  const names = new Map();
  try { for (const d of await M.list()) if (!d.system) names.set(d.name, 'mariadb'); } catch {}
  if (PG.ready()) { try { for (const d of await PG.list()) if (!d.system) names.set(d.name, names.has(d.name) ? names.get(d.name) : 'postgres'); } catch {} }
  for (const r of createdSites()) if (r.db) add(`mariadb:${r.db}`, `strona ${r.host}`, `#/strona/${encodeURIComponent(r.host)}`);
  // Redis: aplikacje z REDIS_HOST w .env (np. panel gier)
  for (const s of S.siteConfigs()) {
    if (!s.dir) continue;
    const env = readText(path.join(s.dir, '.env'));
    if (!/^REDIS_HOST=/m.test(env)) continue;
    const n = Number((env.match(/^REDIS_(?:DATABASE|DB)=(\d+)/m) || [])[1] || 0);
    add(`redis:db${n}`, `strona ${s.name}`, `#/strona/${encodeURIComponent(s.name)}`);
  }
  if (names.size) {
    const alt = [...names.keys()].map((n) => n.replace(/[.$]/g, '\\$&')).join('|');
    const pat = `([\`'"])(${alt})\\1|=[[:space:]]*['"]?(${alt})([^A-Za-z0-9_]|$)`;
    const args = ['-rIoE', ...CONF_INCLUDE.map((x) => `--include=${x}`), ...['node_modules', 'vendor', '.git', 'uploads', 'cache', 'storage', 'logs', 'panel-serwera', 'tests', 'test'].map((x) => `--exclude-dir=${x}`), '-e', pat, '/var/www', '/opt'];
    const r = await run('/usr/bin/grep', args, { timeout: 30000 });
    const sites = S.siteConfigs().filter((s) => s.dir).sort((a, b) => b.dir.length - a.dir.length);
    for (const line of r.out.split('\n')) {
      const i = line.indexOf(':'); if (i < 0) continue;
      const file = line.slice(0, i); const m = line.slice(i + 1).match(new RegExp(`(${alt})`));
      if (!m || /example|sample|dist\b/i.test(file)) continue;
      const site = sites.find((s) => file.startsWith(s.dir + '/'));
      const e = names.get(m[1]);
      if (site) add(`${e}:${m[1]}`, `strona ${site.name}`, `#/strona/${encodeURIComponent(site.name)}`);
      else { const o = file.match(/^\/opt\/([^/]+)/); add(`${e}:${m[1]}`, o ? `aplikacja /opt/${o[1]}` : file, null); }
    }
  }
  return map;
});

/* ------------------------------------------------------------ przegląd */

async function knownNotes() {
  const notes = new Map();
  try { for (const r of await M.q('SELECT username u FROM panel.database_hosts')) notes.set(`mariadb:${r.u}`, 'Panel gier zakłada tym kontem bazy dla serwerów gier — potrzebuje praw do wszystkich baz, ale wystarczy mu dostęp z tego serwera.'); } catch {}
  try { for (const r of await M.q('SELECT d.username u, s.name n FROM panel.databases d LEFT JOIN panel.servers s ON s.id=d.server_id')) notes.set(`mariadb:${r.u}`, `Konto serwera gry „${r.n || '?'}” z panelu gier (łączy się z serwera gier w domu).`); } catch {}
  for (const r of db.prepare('SELECT * FROM bazy_konta').all()) if (!notes.has(`${r.engine}:${r.user}`)) notes.set(`${r.engine}:${r.user}`, `Założone w panelu ${new Date(r.created).toLocaleDateString('pl-PL')}${r.by ? ' (' + r.by + ')' : ''}.`);
  return notes;
}
function scopeOf(hosts, hip, sip) {
  const local = new Set(['localhost', '127.0.0.1', '::1', sip].filter(Boolean));
  const ext = hosts.filter((h) => !local.has(h));
  if (!ext.length) return { scope: 'serwer', label: 'tylko ten serwer' };
  if (ext.some((h) => h.includes('%') || h === '0.0.0.0/0' || h === '::/0')) return { scope: 'internet', label: 'z całego internetu' };
  if (hip && ext.every((h) => h === hip)) return { scope: 'dom', label: `ten serwer i ${CFG().dom?.opis || 'dom'}`, ips: ext };
  return { scope: 'ip', label: `ten serwer i ${ext.join(', ')}`, ips: ext };
}
async function fwInfo() {
  try { const s = await F.status(); return { active: !!s.active, trusted: (s.trusted || F.settings().trusted || []).map((t) => ({ host: t.host, ports: t.ports, ip: t.ip })) }; } catch { return { active: false, trusted: [] }; }
}
const covers = (u, dbn) => u.global || u.dbs.some((d) => d.db === dbn || (d.pattern && new RegExp('^' + d.db.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$').test(dbn)));

export async function overview() {
  const [eng0, hip, fw, notes, use] = await Promise.all([engines(), homeIp(), fwInfo(), knownNotes(), usage().catch(() => new Map())]);
  const sip = serverIp();
  const dbs = [], users = [], errors = [];
  for (const e of eng0) {
    if (!e.installed || !e.ready) continue;
    const E = ENGINES[e.id];
    if (e.id !== 'sqlite' && !e.active) { errors.push({ engine: e.id, text: `${e.name} jest wyłączony.` }); continue; }
    try { for (const d of await E.list()) dbs.push({ engine: e.id, ...d }); } catch (er) { errors.push({ engine: e.id, text: `${e.name}: ${er.message}` }); }
    if (e.id === 'sqlite') continue;
    try { for (const u of await E.users()) users.push({ ...u, engine: e.id }); } catch (er) { errors.push({ engine: e.id, text: `${e.name} (konta): ${er.message}` }); }
  }
  const managed = new Map(db.prepare('SELECT * FROM bazy_konta').all().map((r) => [`${r.engine}:${r.user}`, r]));
  for (const u of users) {
    Object.assign(u, scopeOf(u.hosts, hip, sip));
    u.note = notes.get(`${u.engine}:${u.user}`) || '';
    u.mode = managed.get(`${u.engine}:${u.user}`)?.mode || null;
    const portOpen = !fw.active; // przy włączonej zaporze port bazy jest zamknięty dla obcych
    u.risk = null;
    if (!u.locked && !u.system && u.scope === 'internet') {
      u.risk = u.global === 'pelne' && portOpen ? 'bad' : 'warn';
      u.riskText = u.global === 'pelne' ? `Wszystkie bazy${u.grantOption ? ', może nadawać prawa innym' : ''} — z całego internetu${portOpen ? '' : ' (zapora blokuje obcych)'}.` : `Może łączyć się z całego internetu${portOpen ? '' : ' (zapora blokuje obcych)'}.`;
    }
  }
  for (const d of dbs) {
    d.usedBy = use.get(`${d.engine}:${d.name}`) || [];
    if (d.engine === 'sqlite' && d.app) d.usedBy = [{ label: d.service ? `aplikacja (usługa ${d.service})` : 'aplikacja', link: '#/uslugi' }];
    const who = users.filter((u) => u.engine === d.engine && !u.system && covers(u, d.name)).map((u) => ({ user: u.user, scope: u.scope, label: u.label, locked: u.locked, rights: u.global || u.dbs.find((x) => x.db === d.name)?.rights || 'pelne', all: !!u.global }));
    d.access = who;
    const open = who.filter((x) => !x.locked && !x.all); // konta „do wszystkich baz” pokazujemy osobno
    d.scope = open.some((x) => x.scope === 'internet') ? 'internet' : open.some((x) => x.scope === 'ip') ? 'ip' : open.some((x) => x.scope === 'dom') ? 'dom' : 'serwer';
    if (d.engine === 'sqlite') d.scope = 'plik';
    if (d.engine === 'redis') d.scope = 'serwer';
  }
  return { engines: eng0, dbs, users, errors, homeIp: hip, homeHost: homeHost(), homeLabel: CFG().dom?.opis || '', serverIp: sip, firewall: fw, files: (await D.databases()).files };
}

/* ------------------------------------------------------------- dostęp */

async function hostsFor(engine, access, ip) {
  if (['redis', 'sqlite'].includes(engine) && access !== 'serwer') throw new Error(`${NAMES[engine]} działa tylko na tym serwerze.`);
  if (access === 'serwer') return ['localhost'];
  if (access === 'dom') { if (!homeHost()) throw new Error('Serwer w domu nie jest ustawiony w konfiguracji panelu.'); const h = await homeIp(); if (!h) throw new Error(`Nie znam teraz adresu ${homeHost()} — spróbuj za chwilę.`); return ['localhost', h]; }
  if (access === 'ip') {
    const x = String(ip || '').trim();
    if (!net.isIP(x)) throw new Error('Wpisz poprawny adres IP, np. 203.0.113.7.');
    if (/^(0\.|127\.|10\.|192\.168\.)/.test(x)) throw new Error('To adres lokalny — wybierz „Tylko z tego serwera”.');
    return ['localhost', x];
  }
  throw new Error('Wybierz, skąd można się łączyć.');
}
/** Otwiera port bazy w zaporze dla serwera w domu albo podanego adresu — zapora wpuszcza tylko zaufanych. */
async function openPort(engine, access, ip) {
  if (access === 'serwer' || !PORTS[engine]) return;
  const host = access === 'dom' ? homeHost() : ip;
  const s = F.settings();
  const ex = s.trusted.find((t) => t.host === host);
  const ports = new Set(String(ex?.ports || '').split(',').filter(Boolean)); ports.add(String(PORTS[engine]));
  await F.addTrusted({ host, ports: [...ports].join(','), note: ex?.note || (access === 'dom' ? 'serwer gier w domu' : 'dostęp do bazy') });
  if (engine === 'mongo') await mongoListen(true);
}
async function mongoListen(all) {
  const f = '/etc/mongod.conf';
  const t = readText(f);
  const want = all ? '0.0.0.0' : '127.0.0.1';
  if (new RegExp(`bindIp:\\s*${want.replace(/\./g, '\\.')}\\b`).test(t)) return;
  fs.writeFileSync(f, t.replace(/bindIp:\s*\S+/, `bindIp: ${want}`));
  await run('systemctl', ['restart', 'mongod'], { timeout: 60000 }); MG.close();
}
function connInfo(engine, name, user, pass, remote) {
  const host = '127.0.0.1', port = PORTS[engine];
  const ext = remote ? (CFG().domena || serverIp()) : null;
  if (engine === 'mariadb') return { host, port, env: `DB_CONNECTION=mysql\nDB_HOST=${host}\nDB_PORT=${port}\nDB_DATABASE=${name}\nDB_USERNAME=${user}\nDB_PASSWORD=${pass}\n`, remote: ext && `Z zewnątrz: host ${ext}, port ${port}` };
  if (engine === 'postgres') return { host, port, env: `DATABASE_URL=postgres://${user}:${pass}@${host}:${port}/${name}\n`, remote: ext && `Z zewnątrz: postgres://${user}:••••@${ext}:${port}/${name}` };
  if (engine === 'mongo') return { host, port, env: `MONGODB_URI=mongodb://${user}:${pass}@${host}:${port}/${name}?authSource=admin\n`, remote: ext && `Z zewnątrz: mongodb://${user}:••••@${ext}:${port}/${name}?authSource=admin` };
  if (engine === 'redis') return { host, port, env: `REDIS_URL=redis://${user}:${pass}@${host}:${port}\nREDIS_PREFIX=${name}:\n`, remote: null, note: `Klucze muszą zaczynać się od „${name}:”, inne są dla tego konta niewidoczne.` };
  return {};
}

/* ---------------------------------------------------------- nowa baza */

export async function createDatabase({ engine, name, access = 'serwer', ip }, who) {
  const E = ready(engine);
  name = checkNew(name, 'Nazwa bazy');
  if (engine === 'mariadb' && M.SYSTEM_DBS.has(name)) throw new Error('Tej nazwy nie można użyć.');
  if (await E.exists(name)) throw new Error(`Baza ${name} już istnieje.`);
  if (engine !== 'sqlite' && await E.userExists(name)) throw new Error(`Konto ${name} już istnieje — wybierz inną nazwę.`);
  const hosts = await hostsFor(engine, access, ip);
  const pass = password();
  if (engine === 'sqlite') {
    const p = LT.createDb(name);
    record(engine, name, null, who);
    J.add(who, 'bazy', `Nowa baza SQLite ${name}`, null, `#/bazy/sqlite/${name}`);
    return { engine, name, path: p, env: `DB_PATH=${p}\n` };
  }
  if (engine === 'mariadb') {
    await M.createDb(name);
    try { await M.createUser(name, pass, hosts, [{ db: name, rights: 'pelne' }]); } catch (e) { await M.dropDb(name).catch(() => {}); throw e; }
  } else if (engine === 'postgres') {
    await PG.createUser(name, pass);
    try { await PG.createDb(name, name); if (hosts.length > 1) await PG.setHosts(name, hosts); } catch (e) { await PG.dropUser(name).catch(() => {}); throw e; }
  } else if (engine === 'mongo') {
    await MG.createDb(name);
    try { await MG.createUser(name, pass, hosts, [{ db: name, rights: 'pelne' }]); } catch (e) { await MG.dropDb(name).catch(() => {}); throw e; }
  } else if (engine === 'redis') await RD.createUser(name, pass);
  record(engine, name, { mode: access, ip: hosts[1] || '' }, who);
  await openPort(engine, access, hosts[1]);
  usage.reset();
  J.add(who, 'bazy', `Nowa baza ${NAMES[engine]} ${name} (konto ${name}, ${access === 'serwer' ? 'tylko ten serwer' : access === 'dom' ? 'też z domu' : 'też z ' + hosts[1]})`, null, `#/bazy/${engine}/${name}`);
  return { engine, name, user: name, password: pass, ...connInfo(engine, name, name, pass, access !== 'serwer') };
}
function record(engine, name, acct, who) {
  db.prepare('INSERT OR REPLACE INTO bazy_meta(engine,name,created,by) VALUES(?,?,?,?)').run(engine, name, Date.now(), who?.login || '');
  if (acct) db.prepare('INSERT OR REPLACE INTO bazy_konta(engine,user,mode,ip,created,by) VALUES(?,?,?,?,?,?)').run(engine, name, acct.mode, acct.ip || '', Date.now(), who?.login || '');
}

/* -------------------------------------------------------------- konta */

function checkDbs(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).map((x) => ({ db: checkName(x.db), rights: ['pelne', 'odczyt'].includes(x.rights) ? x.rights : 'pelne' }));
}
export async function createAccount({ engine, user, access = 'serwer', ip, dbs }, who) {
  const E = ready(engine);
  if (engine === 'sqlite') throw new Error('SQLite nie ma kont.');
  user = checkNew(user, 'Nazwa konta');
  const list = checkDbs(dbs);
  const hosts = await hostsFor(engine, access, ip);
  const pass = password();
  if (engine === 'mariadb') await M.createUser(user, pass, hosts, list);
  else if (engine === 'postgres') { await PG.createUser(user, pass); await PG.setRights(user, list); if (hosts.length > 1) await PG.setHosts(user, hosts); }
  else if (engine === 'mongo') await MG.createUser(user, pass, hosts, list);
  else if (engine === 'redis') await RD.createUser(user, pass);
  db.prepare('INSERT OR REPLACE INTO bazy_konta(engine,user,mode,ip,created,by) VALUES(?,?,?,?,?,?)').run(engine, user, access, hosts[1] || '', Date.now(), who?.login || '');
  await openPort(engine, access, hosts[1]);
  J.add(who, 'bazy', `Nowe konto ${NAMES[engine]} ${user}${list.length ? ' → ' + list.map((d) => `${d.db} (${d.rights === 'odczyt' ? 'odczyt' : 'pełne'})`).join(', ') : ''}`, null, '#/bazy/konta');
  const first = list[0]?.db || user;
  return { engine, user, password: pass, ...connInfo(engine, first, user, pass, access !== 'serwer') };
}

export async function userAction(engine, user, act, b, who) {
  const E = ready(engine);
  checkName(user);
  const snap = engine === 'mariadb' ? await M.snapshotUser(user).catch(() => null) : null;
  const undoMaria = snap ? { type: 'konto-maria', data: { user, snap } } : null;
  const label = `${NAMES[engine]} ${user}`;
  if (act === 'haslo') {
    const pass = password();
    await E.setPassword(user, pass);
    J.add(who, 'bazy', `Nowe hasło konta ${label}`, undoMaria, '#/bazy/konta');
    return { password: pass };
  }
  if (act === 'blokuj' || act === 'odblokuj') {
    await E.setLocked(user, act === 'blokuj');
    J.add(who, 'bazy', `${act === 'blokuj' ? 'Zablokowano' : 'Odblokowano'} konto ${label}`, { type: 'konto-blokada', data: { engine, user, locked: act !== 'blokuj' } }, '#/bazy/konta');
    return { ok: true };
  }
  if (act === 'usun') {
    await E.dropUser(user);
    db.prepare('DELETE FROM bazy_konta WHERE engine=? AND user=?').run(engine, user);
    J.add(who, 'bazy', `Usunięto konto ${label}`, undoMaria, '#/bazy/konta');
    usage.reset();
    return { ok: true };
  }
  if (act === 'skad') {
    let hosts = await hostsFor(engine, b.access, b.ip);
    if (engine === 'mariadb' && b.access === 'serwer') {
      // konto, które łączyło się „zewsząd”, mogło używać domeny serwera — zostawiamy też publiczny adres serwera
      const cur = snap?.map((s) => s.host) || [];
      if (cur.some((h) => h.includes('%')) && serverIp()) hosts = [...hosts, serverIp()];
    }
    if (engine === 'redis') throw new Error('Redis działa tylko na tym serwerze.');
    await E.setHosts(user, hosts);
    db.prepare('INSERT OR REPLACE INTO bazy_konta(engine,user,mode,ip,created,by) VALUES(?,?,?,?,COALESCE((SELECT created FROM bazy_konta WHERE engine=? AND user=?),?),?)')
      .run(engine, user, b.access, b.access === 'serwer' ? '' : hosts[1], engine, user, Date.now(), who?.login || '');
    await openPort(engine, b.access, hosts[1]);
    J.add(who, 'bazy', `Konto ${label}: ${b.access === 'serwer' ? 'tylko z tego serwera' : b.access === 'dom' ? 'ten serwer i dom' : 'ten serwer i ' + hosts[1]}`, undoMaria, '#/bazy/konta');
    return { ok: true };
  }
  if (act === 'prawa') {
    const list = checkDbs(b.dbs);
    if (engine === 'redis') throw new Error('Konto Redisa widzi tylko swoje klucze — tu nie ma czego zmieniać.');
    await E.setRights(user, list, { global: b.global === 'usun' ? 'usun' : 'zostaw' });
    J.add(who, 'bazy', `Prawa konta ${label}: ${list.map((d) => `${d.db} (${d.rights === 'odczyt' ? 'odczyt' : 'pełne'})`).join(', ') || 'brak'}${b.global === 'usun' ? ' (odebrano dostęp do wszystkich baz)' : ''}`, undoMaria, '#/bazy/konta');
    return { ok: true };
  }
  throw new Error('Nieznana akcja.');
}

/* --------------------------------------------------------- kopie baz */

const ext = (engine) => (engine === 'mongo' ? 'archive.gz' : 'sql.gz');
function backupName(engine, name, label) {
  const base = path.join(BACKUP_DIR, 'bazy', `${PREFIX[engine] ?? ''}${name}_${stamp()}${label ? '-' + label : ''}`);
  for (let i = 1; ; i++) { const f = `${base}${i > 1 ? '-' + i : ''}.${ext(engine)}`; if (!fs.existsSync(f)) return f; }
}
/** Zrzut bazy (albo jednej tabeli) do katalogu kopii. Zwraca ścieżkę pliku. */
export async function backupDatabase(engine, name, label = 'reczna', say = () => {}, table = null) {
  const E = ready(engine);
  if (engine === 'redis') throw new Error('Redis zapisuje kopię sam (plik dump.rdb) — pobierz ją przyciskiem „Pobierz”.');
  fs.mkdirSync(path.join(BACKUP_DIR, 'bazy'), { recursive: true, mode: 0o700 });
  const out = backupName(engine, name, label);
  const [cmd, args] = E.dumpArgs(name, table);
  say(`▸ kopia ${NAMES[engine]} ${name}${table ? '.' + table : ''} → ${out}\n`);
  const r = await spawnCollect('bash', ['-c', 'set -o pipefail; "$@" | gzip -6 > "$OUT"', 'x', cmd, ...args], { env: { ...process.env, OUT: out } });
  if (!r.ok) { fs.rmSync(out, { force: true }); throw new Error('Nie udało się zrobić kopii: ' + r.out.trim().split('\n').pop()); }
  return out;
}
export function dbBackups(engine, name) {
  const dir = path.join(BACKUP_DIR, 'bazy');
  const re = new RegExp(`^${(PREFIX[engine] ?? '').replace(/-/g, '\\-')}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d{4}-\\d{2}-\\d{2}_\\d{4})(.*)\\.(sql|archive)\\.gz$`);
  let files = []; try { files = fs.readdirSync(dir); } catch {}
  const out = [];
  for (const f of files) {
    const m = f.match(re); if (!m) continue;
    let s; try { s = fs.statSync(path.join(dir, f)); } catch { continue; }
    out.push({ path: path.join(dir, f), name: f, size: s.size, time: s.mtimeMs, label: m[2].replace(/^-/, '').replace(/-/g, ' ') || 'nocna' });
  }
  if (engine === 'mongo') for (const f of files) if (/^mongo-wszystkie_/.test(f)) { const s = fs.statSync(path.join(dir, f)); out.push({ path: path.join(dir, f), name: f, size: s.size, time: s.mtimeMs, label: 'nocna (wszystkie bazy)' }); }
  return out.sort((a, b) => b.time - a.time);
}
/** Wczytanie pliku do bazy (zrzut .sql / .sql.gz, archiwum MongoDB). */
export async function restoreFile(engine, name, file, say, { replace = true } = {}) {
  const E = ready(engine);
  if (engine === 'sqlite' && replace) {
    // zrzut SQLite tworzy tabele od zera — zastępujemy plik pustym
    const p = LT.pathOf(name);
    if (LT.list().find((x) => x.name === name)?.app) throw new Error('To baza działającej aplikacji — nie nadpisuję jej z panelu.');
    for (const x of ['', '-wal', '-shm']) fs.rmSync(p + x, { force: true });
  }
  const [cmd, args] = E.loadArgs(name);
  const gz = /\.gz$/.test(file);
  say(`▸ wczytuję ${path.basename(file)} do ${NAMES[engine]} ${name}\n`);
  let r;
  if (engine === 'mongo') r = await spawnCollect(cmd, [...args.filter((a) => a !== '--archive'), `--archive=${file}`, ...(gz ? ['--gzip'] : [])]);
  else r = await spawnCollect('bash', ['-c', `set -o pipefail; ${gz ? 'gunzip -c' : 'cat'} "$IN" | "$@"`, 'x', cmd, ...args], { env: { ...process.env, IN: file } });
  if (r.out.trim()) say(r.out.trim().split('\n').slice(-15).join('\n') + '\n');
  return r.ok;
}
export async function importInto(engine, name, file, who, say) {
  if (engine === 'redis') throw new Error('Do Redisa nie wgrywam plików.');
  if (engine === 'sqlite' && LT.list().find((x) => x.name === name)?.app) throw new Error('To baza działającej aplikacji — nie wgrywam do niej plików.');
  const before = await backupDatabase(engine, name, 'przed-wgraniem', say);
  const ok = await restoreFile(engine, name, file, say, { replace: false });
  J.add(who, 'bazy', `Wgrano plik do ${NAMES[engine]} ${name}${ok ? '' : ' (z błędami)'}`, { type: 'baza-kopia', data: { engine, name, file: before } }, `#/bazy/${engine}/${name}`);
  say(ok ? '✓ wgrane — kopia sprzed zmian: ' + before + '\n' : '✗ wgrywanie zakończyło się błędem — baza może być w połowie; przywróć kopię: ' + before + '\n');
  return ok;
}
export async function restoreBackup(engine, name, file, who, say) {
  const real = fs.realpathSync(String(file));
  if (!real.startsWith(path.join(BACKUP_DIR, 'bazy') + '/')) throw new Error('To nie jest kopia bazy.');
  const before = await backupDatabase(engine, name, 'przed-przywroceniem', say);
  const ok = await restoreFile(engine, name, real, say);
  J.add(who, 'bazy', `Przywrócono ${NAMES[engine]} ${name} z kopii ${path.basename(real)}`, { type: 'baza-kopia', data: { engine, name, file: before } }, `#/bazy/${engine}/${name}`);
  return ok;
}
export async function cloneDatabase(engine, name, to, who, say) {
  const E = ready(engine);
  to = checkNew(to, 'Nazwa kopii');
  if (!['mariadb', 'postgres', 'sqlite', 'mongo'].includes(engine)) throw new Error('Tego rodzaju bazy nie kopiuję.');
  if (await E.exists(to)) throw new Error(`Baza ${to} już istnieje.`);
  say(`▸ tworzę bazę ${to}\n`);
  if (engine === 'mariadb') await M.createDb(to);
  else if (engine === 'postgres') { const owner = (await PG.list()).find((d) => d.name === name)?.owner || 'panel_admin'; await PG.createDb(to, owner); }
  else if (engine === 'sqlite') { const src = LT.pathOf(name); LT.createDb(to); fs.rmSync(LT.pathOf(to)); await LT.backupTo(name, path.join(LT.DIR, to + '.sqlite')); try { fs.chownSync(path.join(LT.DIR, to + '.sqlite'), 33, 33); } catch {} say(`✓ skopiowano ${src}\n`); record(engine, to, null, who); return true; }
  let r;
  if (engine === 'mongo') r = await spawnCollect('bash', ['-c', 'set -o pipefail; mongodump --config="$CONF" --db="$1" --archive --quiet | mongorestore --config="$CONF" --archive --quiet --nsFrom="$1.*" --nsTo="$2.*"', 'x', name, to], { env: { ...process.env, CONF: MG.BACKUP_CONF } });
  else if (engine === 'postgres') r = await spawnCollect('bash', ['-c', 'set -o pipefail; runuser -u postgres -- pg_dump "$1" | runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 -d "$2"', 'x', name, to]);
  else r = await spawnCollect('bash', ['-c', 'set -o pipefail; mysqldump --single-transaction --quick --routines --events --default-character-set=utf8mb4 "$1" | mysql --default-character-set=utf8mb4 "$2"', 'x', name, to]);
  if (!r.ok) { say(r.out.slice(-2000) + '\n'); return false; }
  record(engine, to, null, who);
  J.add(who, 'bazy', `Skopiowano ${NAMES[engine]} ${name} → ${to}`, null, `#/bazy/${engine}/${to}`);
  usage.reset();
  say(`✓ gotowe: ${to}${engine === 'mariadb' ? ' — konta nie są kopiowane; nadaj dostęp w zakładce „Kto ma dostęp”' : ''}\n`);
  return true;
}
export async function dropDatabase(engine, name, { withUsers = false } = {}, who, say) {
  const E = ready(engine);
  checkName(name);
  if (!(await E.exists(name))) throw new Error('Nie ma takiej bazy.');
  let trash = null;
  if (engine !== 'redis') {
    fs.mkdirSync(path.join(BACKUP_DIR, 'usuniete'), { recursive: true, mode: 0o700 });
    const tmp = await backupDatabase(engine, name, 'przed-usunieciem', say);
    trash = path.join(BACKUP_DIR, 'usuniete', path.basename(tmp));
    fs.renameSync(tmp, trash);
    say(`▸ kopia przed usunięciem: ${trash}\n`);
  }
  const owners = [];
  if (withUsers && engine !== 'sqlite') {
    for (const u of await E.users()) {
      if (u.system || u.global) continue;
      const only = engine === 'redis' ? u.dbs[0]?.db === name : u.dbs.length > 0 && u.dbs.every((d) => d.db === name);
      if (only) owners.push(u.user);
    }
  }
  say(`▸ usuwam bazę ${name}\n`);
  if (engine === 'postgres') { await E.dropDb(name); for (const u of owners) await PG.dropUser(u).catch((e) => say(`  konto ${u}: ${e.message}\n`)); }
  else { await E.dropDb(name); for (const u of owners) { try { await E.dropUser(u); say(`▸ usunięto konto ${u}\n`); } catch (e) { say(`  konto ${u}: ${e.message}\n`); } } }
  for (const u of owners) db.prepare('DELETE FROM bazy_konta WHERE engine=? AND user=?').run(engine, u);
  db.prepare('DELETE FROM bazy_meta WHERE engine=? AND name=?').run(engine, name);
  J.add(who, 'bazy', `Usunięto bazę ${NAMES[engine]} ${name}${owners.length ? ' i konta ' + owners.join(', ') : ''}${trash ? ' (kopia w koszu kopii)' : ''}`, null, '#/bazy');
  usage.reset();
  say('✓ usunięto\n');
  return true;
}
/** Strumień do pobrania. */
export async function dumpStream(engine, name, tmpDir) {
  const E = ready(engine);
  if (engine === 'sqlite' || engine === 'mariadb') {
    if (engine === 'sqlite' && LT.list().find((x) => x.name === name)?.app) return D.dbDump('sqlite', name, tmpDir);
    if (engine === 'mariadb') return D.dbDump('mariadb', name, tmpDir);
  }
  if (engine === 'redis') {
    fs.mkdirSync(tmpDir, { recursive: true });
    const f = path.join(tmpDir, `redis-${process.pid}-${Date.now()}.rdb`);
    const r = await run('redis-cli', ['--rdb', f], { timeout: 120000 });
    if (!r.ok) throw new Error('Nie udało się pobrać kopii Redisa: ' + r.err);
    const s = fs.createReadStream(f); s.on('close', () => fs.rm(f, { force: true }, () => {}));
    return { name: `redis_${stamp()}.rdb`, stream: s, type: 'application/octet-stream', size: fs.statSync(f).size };
  }
  const [cmd, args] = E.dumpArgs(name);
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const gz = spawn('gzip', ['-6'], { stdio: ['pipe', 'pipe', 'ignore'] });
  p.stdout.pipe(gz.stdin);
  return { name: `${PREFIX[engine]}${name}_${stamp()}.${ext(engine)}`, stream: gz.stdout, type: 'application/gzip' };
}

/* ----------------------------------------------------------- dane i SQL */

export async function detail(engine, name) {
  const E = ready(engine);
  const o = await overview();
  const d = o.dbs.find((x) => x.engine === engine && x.name === name);
  if (!d) throw new Error('Nie ma takiej bazy.');
  let tables = [];
  try { tables = await E.tables(name); } catch (e) { d.tablesError = e.message; }
  return { db: d, tables, backups: dbBackups(engine, name), users: o.users.filter((u) => u.engine === engine && !u.system), homeIp: o.homeIp, homeHost: o.homeHost, homeLabel: o.homeLabel, engine: o.engines.find((e) => e.id === engine) };
}
export async function rows(engine, name, table, opts) { return ready(engine).rows(name, table, opts); }
const lastTableBackup = new Map();
export async function rowEdit(engine, name, table, action, key, values, who) {
  const E = ready(engine);
  if (!['insert', 'update', 'delete'].includes(action)) throw new Error('Nieznana akcja.');
  if (!E.rowAction) throw new Error('W tej bazie nie da się edytować wierszy — użyj zapytania.');
  const k = `${engine}:${name}:${table}`;
  if (!lastTableBackup.get(k) || Date.now() - lastTableBackup.get(k) > 30 * 60e3) {
    try { await backupDatabase(engine, name, 'przed-edycja', () => {}, engine === 'sqlite' ? null : table); lastTableBackup.set(k, Date.now()); } catch {}
  }
  const r = await E.rowAction(name, table, action, key, values);
  J.add(who, 'bazy', `${NAMES[engine]} ${name} → ${table}: ${r.text}`, { type: 'wiersz', data: { engine, name, table, undo: r.undo } }, `#/bazy/${engine}/${encodeURIComponent(name)}/tabela/${encodeURIComponent(table)}`);
  return { ok: true };
}
export async function runQuery(engine, name, sql, { write = false, confirm = false } = {}, who) {
  const E = ready(engine);
  sql = String(sql || '').trim().replace(/;\s*$/, '');
  if (sql.length > 100000) throw new Error('Zapytanie jest za długie — wgraj je jako plik .sql.');
  const c = E.classify(sql);
  if (c.kind === 'blocked') throw new Error(c.msg);
  const t0 = Date.now();
  if (c.kind === 'read') return { ...(await E.query(name, sql, { mode: 'read' })), kind: 'read', ms: Date.now() - t0 };
  if (!write) throw new Error('To zapytanie zmienia dane. Wyłącz „Tylko odczyt”, żeby je wykonać.');
  if (!confirm) {
    let affected = null;
    if (c.kind === 'dml') affected = (await E.query(name, sql, { mode: 'preview' })).affected;
    return { needConfirm: true, kind: c.kind, word: c.word, affected };
  }
  let backup = null;
  if (engine !== 'redis') backup = await backupDatabase(engine, name, 'przed-zapytaniem');
  const r = await E.query(name, sql, { mode: 'write' });
  J.add(who, 'bazy', `Zapytanie w ${NAMES[engine]} ${name}: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`, backup ? { type: 'baza-kopia', data: { engine, name, file: backup } } : null, `#/bazy/${engine}/${encodeURIComponent(name)}`);
  return { ...r, kind: c.kind, backup, ms: Date.now() - t0 };
}

/* ------------------------------------------------------ instalacja silników */

const APT_ENV = { ...process.env, DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'a' };
async function step(say, desc, cmd, args, opts = {}) {
  say(`▸ ${desc}\n`);
  const r = await spawnCollect(cmd, args, { onData: opts.quiet ? null : say, env: opts.env || process.env });
  if (!r.ok) throw new Error(`${desc} — nie udało się (kod ${r.code})`);
  return r;
}
export async function installEngine(engine, say) {
  if (installing) throw new Error('Inna instalacja już trwa.');
  installing = engine;
  try {
    const m = S.metrics();
    if (m.disk.free < 1.5 * 1024 ** 3) throw new Error('Za mało miejsca na dysku (potrzeba ok. 1,5 GB wolnego).');
    if (engine === 'postgres') {
      if (!PG.installed()) await step(say, 'instaluję PostgreSQL (apt)', 'apt-get', ['install', '-y', '--no-install-recommends', 'postgresql'], { env: APT_ENV });
      const conf = `/etc/postgresql/${PG.majorVersion()}/main/conf.d/panel.conf`;
      if (!fs.existsSync(conf)) { fs.mkdirSync(path.dirname(conf), { recursive: true }); fs.writeFileSync(conf, "listen_addresses = 'localhost'\n"); }
      await step(say, 'uruchamiam PostgreSQL', 'systemctl', ['enable', '--now', 'postgresql']);
      await step(say, 'przeładowuję ustawienia', 'systemctl', ['restart', 'postgresql']);
      say('▸ zakładam konto panelu\n');
      await PG.setup();
      say(`✓ PostgreSQL ${await PG.version()} gotowy — działa tylko lokalnie, trafia do nocnych kopii\n`);
      return true;
    }
    if (engine === 'mongo') {
      if (!MG.installed()) {
        const key = '/usr/share/keyrings/mongodb-server-8.0.gpg';
        if (!fs.existsSync(key)) await step(say, 'pobieram klucz repozytorium MongoDB', 'bash', ['-c', 'set -o pipefail; curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --batch --yes --dearmor -o "$1"', 'x', key]);
        fs.writeFileSync('/etc/apt/sources.list.d/mongodb-org-8.0.list', `deb [ arch=amd64,arm64 signed-by=${key} ] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/8.0 main\n`);
        await step(say, 'odświeżam listę pakietów', 'apt-get', ['update', '-o', 'Dir::Etc::sourcelist=sources.list.d/mongodb-org-8.0.list', '-o', 'Dir::Etc::sourceparts=-', '-o', 'APT::Get::List-Cleanup=0'], { env: APT_ENV, quiet: true });
        await step(say, 'instaluję MongoDB (apt) — to potrwa chwilę', 'apt-get', ['install', '-y', 'mongodb-org'], { env: APT_ENV });
      }
      let conf = readText('/etc/mongod.conf');
      conf = conf.replace(/bindIp:\s*\S+/, 'bindIp: 127.0.0.1');
      if (!/cacheSizeGB/.test(conf)) conf = conf.replace(/storage:\n/, 'storage:\n  wiredTiger:\n    engineConfig:\n      cacheSizeGB: 0.25\n');
      conf = conf.replace(/\n#?security:.*(\n  authorization:.*)?/, '');
      fs.writeFileSync('/etc/mongod.conf', conf);
      await step(say, 'uruchamiam MongoDB', 'systemctl', ['enable', '--now', 'mongod']);
      await step(say, 'czekam, aż MongoDB wstanie', 'bash', ['-c', 'for i in $(seq 1 60); do mongosh --quiet --eval "db.runCommand({ping:1}).ok" >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1']);
      say('▸ zakładam konto panelu\n');
      const pass = password(32);
      const tmp = path.join(DATA_DIR, `mongo-setup-${Date.now()}.js`);
      fs.writeFileSync(tmp, `const a = db.getSiblingDB('admin'); if (a.getUser('panel_admin')) a.updateUser('panel_admin', { pwd: ${JSON.stringify(pass)} }); else a.createUser({ user: 'panel_admin', pwd: ${JSON.stringify(pass)}, roles: ['root'] });\n`, { mode: 0o600 });
      try { await step(say, 'konto panel_admin', 'mongosh', ['--quiet', '--file', tmp], { quiet: true }); } finally { fs.rmSync(tmp, { force: true }); }
      MG.saveCred('panel_admin', pass);
      fs.writeFileSync('/etc/mongod.conf', readText('/etc/mongod.conf').replace(/\n*$/, '\n') + 'security:\n  authorization: enabled\n');
      await step(say, 'włączam logowanie do bazy', 'systemctl', ['restart', 'mongod']);
      await step(say, 'sprawdzam połączenie', 'bash', ['-c', 'for i in $(seq 1 60); do (echo > /dev/tcp/127.0.0.1/27017) 2>/dev/null && exit 0; sleep 1; done; exit 1']);
      MG.close();
      say(`✓ MongoDB ${await MG.version()} gotowy — działa tylko lokalnie, z logowaniem, trafia do nocnych kopii\n`);
      return true;
    }
    throw new Error('Ten silnik nie wymaga instalacji.');
  } finally { installing = null; }
}
export async function engineAction(engine, act) {
  const u = engine === 'postgres' ? 'postgresql' : UNITS[engine];
  if (!u) throw new Error('Nieznany silnik.');
  if (engine === 'mariadb' && act === 'stop') throw new Error('MariaDB obsługuje strony i panel gier — nie zatrzymuję jej z panelu (możesz ją uruchomić ponownie).');
  if (engine === 'redis' && act === 'stop') throw new Error('Redisa używa panel gier — nie zatrzymuję go (możesz go uruchomić ponownie).');
  const map = { start: ['enable', '--now'], stop: ['disable', '--now'], restart: ['restart'] }[act];
  if (!map) throw new Error('Nieznana akcja.');
  const r = await run('systemctl', [...map, u], { timeout: 90000 });
  if (!r.ok) throw new Error(r.err.trim() || 'Nie udało się.');
  if (engine === 'postgres') PG.close(); if (engine === 'mongo') MG.close(); if (engine === 'mariadb') M.close();
  return { ok: true };
}

/* ------------------------------------------- autopilot: domowe IP w kontach */

/** Gdy zmieni się adres serwera w domu, przepisuje konta ustawione „ten serwer i dom”. */
export async function followHome(onChange = () => {}) {
  const hip = await homeIp();
  if (!hip) return;
  for (const r of db.prepare("SELECT * FROM bazy_konta WHERE mode='dom'").all()) {
    if (r.ip === hip) continue;
    try {
      if (r.engine === 'mariadb') { const u = (await M.users()).find((x) => x.user === r.user); if (!u) continue; await M.setHosts(r.user, [...u.hosts.filter((h) => h !== r.ip), hip]); }
      else if (r.engine === 'postgres' && PG.ready()) await PG.setHosts(r.user, ['localhost', hip]);
      else if (r.engine === 'mongo' && MG.ready()) await MG.setHosts(r.user, ['localhost', hip]);
      db.prepare('UPDATE bazy_konta SET ip=? WHERE engine=? AND user=?').run(hip, r.engine, r.user);
      onChange(`Konto bazy ${r.user}: nowy adres domu ${r.ip || '—'} → ${hip}`);
    } catch (e) { onChange(`Konto bazy ${r.user}: nie udało się przepisać adresu domu (${e.message})`, true); }
  }
}
/** Sprawy do „Do Ciebie”: konta z dostępem do wszystkiego z internetu. */
export async function todos() {
  const out = [];
  try {
    const fw = await fwInfo();
    for (const u of await M.users()) {
      if (u.system || u.locked || !u.hosts.some((h) => h.includes('%')) || u.global !== 'pelne' || fw.active) continue;
      out.push({ level: 'warn', text: `Konto bazy ${u.user} ma dostęp do wszystkich baz z całego internetu`, desc: 'Ogranicz je do tego serwera albo włącz zaporę.', link: '#/bazy/konta', cta: 'Pokaż' });
    }
  } catch {}
  return out;
}
export const resetUsage = () => usage.reset();
