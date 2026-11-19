// Hosting dla znajomych: konto z pakietem (miejsce, strony, bazy). Znajomy sam zakłada strony pod
// *.<login>.<domena> (albo na własnej domenie, jeśli pakiet na to pozwala) i widzi tylko swoje rzeczy.
// Jego PHP działa jako osobny użytkownik systemu (h-<login>) w osobnej puli FPM, zamknięty w folderze strony.
import fs from 'node:fs';
import path from 'node:path';
import * as C from './create.mjs';
import * as APP from './apps.mjs';
import * as T from './sitetools.mjs';
import { C as CFG } from './config.mjs';
import { run } from './util.mjs';

let db, notify = async () => {}, OV = null;
export const PACKS = {
  maly: { name: 'Mały', disk: 1024, sites: 2, dbs: 1, domains: false },
  sredni: { name: 'Średni', disk: 3072, sites: 5, dbs: 3, domains: true },
};
const TEMPLATES = ['pusta', 'php', 'wordpress'];
export function init(database, opts = {}) {
  db = database;
  if (opts.notify) notify = opts.notify;
  OV = opts.ovh || null;
  db.exec('CREATE TABLE IF NOT EXISTS hosting(login TEXT PRIMARY KEY, pakiet TEXT, disk INTEGER, sites INTEGER, dbs INTEGER, domains INTEGER, unix TEXT, created INTEGER, by TEXT, warned INTEGER)');
  const cols = new Set(db.prepare('PRAGMA table_info(zaproszenia)').all().map((c) => c.name));
  if (!cols.has('pakiet')) db.exec('ALTER TABLE zaproszenia ADD COLUMN pakiet TEXT');
}

/** Pakiet z formularza: „maly”, „sredni” albo „wlasny” z własnymi liczbami. */
export function packFrom(b) {
  const id = String(b?.pakiet || 'maly');
  if (PACKS[id]) return { pakiet: id, ...PACKS[id] };
  if (id !== 'wlasny') throw new Error('Wybierz pakiet.');
  const n = (v, lo, hi, what) => { const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`${what}: ${lo}–${hi}.`); return x; };
  return { pakiet: 'wlasny', name: 'Własny', disk: n(b.disk, 100, 102400, 'Miejsce (MB)'), sites: n(b.sites, 1, 50, 'Strony'), dbs: n(b.dbs, 0, 50, 'Bazy'), domains: !!b.domains };
}
const unixOf = (login) => 'h-' + login.replace(/[^a-z0-9]/g, '').slice(0, 28);
const nsOf = (login) => login.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'konto';
const domain = () => CFG().domena || '';
export function row(login) { return db.prepare('SELECT * FROM hosting WHERE login=?').get(login); }

async function ensureUnix(name) {
  if ((await run('getent', ['passwd', name])).ok) return;
  const r = await run('useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', '--comment', 'konto hostingu (panel serwera)', name]);
  if (!r.ok) throw new Error(`Nie udało się założyć użytkownika systemu ${name}: ${r.err.trim()}`);
}
/** Po przyjęciu zaproszenia: pakiet + użytkownik systemu. */
export async function createAccount(login, pack, by) {
  const unix = unixOf(login);
  await ensureUnix(unix);
  db.prepare('INSERT OR REPLACE INTO hosting(login,pakiet,disk,sites,dbs,domains,unix,created,by,warned) VALUES(?,?,?,?,?,?,?,?,?,0)').run(login, pack.pakiet, pack.disk, pack.sites, pack.dbs, pack.domains ? 1 : 0, unix, Date.now(), by || '');
}
export function setPack(login, b) {
  if (!row(login)) throw new Error('To konto nie ma hostingu.');
  const p = packFrom(b);
  db.prepare('UPDATE hosting SET pakiet=?, disk=?, sites=?, dbs=?, domains=?, warned=0 WHERE login=?').run(p.pakiet, p.disk, p.sites, p.dbs, p.domains ? 1 : 0, login);
  usageCache.delete(login);
  return limits(login);
}
export function limits(login) {
  const r = row(login);
  if (!r) return null;
  return { pakiet: r.pakiet, name: PACKS[r.pakiet]?.name || 'Własny', disk: r.disk, sites: r.sites, dbs: r.dbs, domains: !!r.domains, unix: r.unix, ns: `${nsOf(login)}.${domain()}` };
}

/* ------------------------------------------------------------ zużycie */

const mine = (login) => C.list().filter((r) => r.login === login);
const usageCache = new Map();
export async function usage(login, force = false) {
  const c = usageCache.get(login);
  if (!force && c && Date.now() - c.at < 5 * 60e3) return c.v;
  const rows = mine(login);
  const dirs = rows.map((r) => r.dir).filter((d) => d && fs.existsSync(d));
  let files = 0;
  if (dirs.length) { const r = await run('du', ['-sbc', ...dirs], { timeout: 120000 }); files = Number((r.out.trim().split('\n').pop() || '').split(/\s/)[0]) || 0; }
  const dbs = rows.filter((r) => r.db).map((r) => r.db);
  let dbBytes = 0;
  if (dbs.length) { const q = await run('mysql', ['-N', '-B', '-e', `SELECT COALESCE(SUM(data_length+index_length),0) FROM information_schema.tables WHERE table_schema IN (${dbs.map((d) => `'${d.replace(/[^A-Za-z0-9_]/g, '')}'`).join(',')})`]); dbBytes = Number(q.out.trim()) || 0; }
  const v = { bytes: files + dbBytes, files, dbBytes, sites: rows.filter((r) => r.host).length, dbs: dbs.length };
  usageCache.set(login, { at: Date.now(), v });
  return v;
}
export async function over(login) {
  const l = limits(login);
  if (!l) return false;
  return (await usage(login)).bytes > l.disk * 1048576;
}

/** Wszystko, co widzi znajomy na swoim pulpicie. */
export async function overview(login, force = false) {
  const l = limits(login);
  if (!l) throw new Error('To konto nie ma hostingu.');
  const u = await usage(login, force);
  const rows = mine(login);
  return {
    limits: l, usage: u,
    sites: rows.filter((r) => r.host).map((r) => ({ host: r.host, kind: r.kind, db: r.db, ssl: r.ssl, created: r.created })),
    dbs: rows.filter((r) => r.db).map((r) => ({ db: r.db, user: r.dbuser, site: r.host || null, slug: r.slug, created: r.created })),
    templates: TEMPLATES.map((t) => ({ id: t, name: C.TEMPLATES[t].name, db: !!C.TEMPLATES[t].db })),
  };
}

/* ------------------------------------------------------------ strony */

function apex(host) { const p = host.split('.'); return p.slice(-2).join('.'); }
function checkHost(login, host, l) {
  host = String(host || '').trim().toLowerCase();
  const ns = `${nsOf(login)}.${domain()}`;
  if (host === ns || host.endsWith('.' + ns)) return host;
  if (l.domains && domain() && apex(host) !== apex(domain())) return host; // własna domena znajomego
  throw new Error(l.domains ? `Adres musi kończyć się na .${ns} albo być Twoją domeną.` : `Adres musi kończyć się na .${ns} (np. sklep.${ns}).`);
}
const sockOf = (key) => `/run/php/panel-${key}.sock`;
async function phpDefault() {
  try { const v = fs.readdirSync('/etc/php').filter((x) => /^\d\.\d$/.test(x) && fs.existsSync(`/usr/sbin/php-fpm${x}`)).sort().pop(); return v || null; } catch { return null; }
}
async function lockDown(dir, unix) {
  await run('chown', ['-R', `${unix}:www-data`, dir]);
  await run('find', [dir, '-type', 'd', '-exec', 'chmod', '2750', '{}', '+']);
  await run('find', [dir, '-type', 'f', '-exec', 'chmod', '0640', '{}', '+']);
}

/** Szybkie sprawdzenie przed zadaniem w tle — żeby błąd było widać od razu. */
export async function precheck(login, b) {
  const l = limits(login);
  if (!l) throw new Error('To konto nie ma hostingu.');
  if (!TEMPLATES.includes(String(b.template || 'pusta'))) throw new Error('Możesz założyć: pustą stronę, stronę PHP z bazą albo WordPressa.');
  checkHost(login, b.host, l);
  const u = await usage(login);
  if (u.sites >= l.sites) throw new Error(`Masz już ${u.sites} z ${l.sites} stron w pakiecie — poproś o więcej.`);
  if (u.bytes > l.disk * 1048576) throw new Error('Przekroczony limit miejsca — usuń coś albo poproś o więcej.');
}
export async function createSite(login, b, who, say) {
  const l = limits(login);
  if (!l) throw new Error('To konto nie ma hostingu.');
  const template = String(b.template || 'pusta');
  if (!TEMPLATES.includes(template)) throw new Error('Możesz założyć: pustą stronę, stronę PHP z bazą albo WordPressa.');
  const host = checkHost(login, b.host, l);
  const u = await usage(login, true);
  if (u.sites >= l.sites) throw new Error(`Masz już ${u.sites} z ${l.sites} stron w pakiecie — poproś o więcej.`);
  if (u.bytes > l.disk * 1048576) throw new Error('Przekroczony limit miejsca — usuń coś albo poproś o więcej.');
  const wantDb = template === 'wordpress' || (template === 'php' && b.db !== false);
  if (wantDb && u.dbs >= l.dbs) throw new Error(`Masz już ${u.dbs} z ${l.dbs} baz w pakiecie${template === 'php' ? ' — załóż stronę PHP bez bazy albo poproś o więcej' : ''}.`);
  const v = await phpDefault();
  if (!v) throw new Error('Na serwerze nie ma PHP-FPM — poproś właściciela o instalację.');
  await ensureUnix(l.unix);
  if (OV?.manages(host)) { try { await OV.ensure(host, say); } catch (e) { say(`  OVH: ${e.message}\n`); } }
  const prepare = async (r, say2) => {
    if (!r.dir) return;
    const key = T.keyOf(r.host);
    say2(`▸ osobna pula PHP ${v} (użytkownik ${l.unix}, tylko folder strony)\n`);
    await lockDown(r.dir, l.unix);
    const pool = `/etc/php/${v}/fpm/pool.d/panel-${key}.conf`;
    fs.writeFileSync(pool, APP.poolConf(r.host, key, sockOf(key), { user: l.unix, dir: r.dir }));
    const t = await run(`/usr/sbin/php-fpm${v}`, ['-t']);
    if (!t.ok) { fs.rmSync(pool, { force: true }); throw new Error('Pula PHP-FPM nie przeszła testu.'); }
    await run('systemctl', ['reload', `php${v}-fpm`]);
    const inc = path.join('/etc/apache2/panel-serwera', key);
    fs.mkdirSync(inc, { recursive: true });
    fs.writeFileSync(path.join(inc, 'php.conf'), `# PHP ${v} w osobnym procesie jako ${l.unix} (hosting znajomego)\n<FilesMatch "\\.(php|phtml)$">\n    SetHandler "proxy:unix:${sockOf(key)}|fcgi://localhost"\n</FilesMatch>\n`);
    if (!fs.existsSync('/etc/apache2/mods-enabled/proxy_fcgi.load')) await run('a2enmod', ['-q', 'proxy_fcgi', 'setenvif']);
    APP.recordIsolated(r.host, v, { user: l.unix, dir: r.dir });
  };
  const made = await C.create({ template, host, db: wantDb, startPage: true, iso: l.unix, owner: login, prepare }, who, say);
  if (made.dir) await lockDown(made.dir, l.unix); // WordPress i config.php po instalacji mają innego właściciela
  usageCache.delete(login);
  return made;
}
export async function removeSite(login, host, who, say) {
  const r = mine(login).find((x) => x.host === host);
  if (!r) throw new Error('To nie jest Twoja strona.');
  const out = await C.remove(r.slug, say);
  usageCache.delete(login);
  return out;
}

/* ------------------------------------------------------------- bazy */

export async function createDb(login, name, who, say) {
  const l = limits(login);
  if (!l) throw new Error('To konto nie ma hostingu.');
  const u = await usage(login, true);
  if (u.dbs >= l.dbs) throw new Error(`Masz już ${u.dbs} z ${l.dbs} baz w pakiecie — poproś o więcej.`);
  const n = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  if (!n) throw new Error('Nazwa bazy: litery i cyfry.');
  const slug = `h-${nsOf(login)}-${n}`.slice(0, 40).replace(/-+$/, '');
  const made = await C.create({ template: 'baza', name: slug, owner: login }, who, say);
  usageCache.delete(login);
  return made;
}
export async function removeDb(login, dbName, who, say) {
  const r = mine(login).find((x) => x.db === dbName && x.kind === 'baza');
  if (!r) throw new Error(mine(login).some((x) => x.db === dbName) ? 'Ta baza należy do strony — usuniesz ją razem ze stroną.' : 'To nie jest Twoja baza.');
  const out = await C.remove(r.slug, say);
  usageCache.delete(login);
  return out;
}
/** Dane dostępu do bazy (plik zapisany przy tworzeniu). */
export function dbAccess(login, dbName) {
  const r = mine(login).find((x) => x.db === dbName);
  if (!r) throw new Error('To nie jest Twoja baza.');
  let txt = ''; try { txt = C.credentials(r.slug) || ''; } catch {}
  return { db: r.db, user: r.dbuser, host: 'localhost', text: String(txt).replace(/^.*\n/, '') || null };
}

/* -------------------------------------------------- konto: usunięcie, prośby */

export async function removeAccount(login, who, say) {
  for (const r of mine(login)) { say(`▸ usuwam ${r.host || r.db}\n`); await C.remove(r.slug, say); }
  const l = limits(login);
  if (l) { await run('userdel', [l.unix]); db.prepare('DELETE FROM hosting WHERE login=?').run(login); }
  usageCache.delete(login);
}
export async function askMore(login, name, text) {
  const l = limits(login), u = await usage(login);
  const gb = (b) => (b / 1073741824).toFixed(1).replace('.', ',');
  await notify(`${name || login} prosi o więcej w hostingu`, `${String(text || '').slice(0, 400) || '(bez wiadomości)'}\nTeraz: ${gb(u.bytes)} z ${gb(l.disk * 1048576)} GB · ${u.sites} z ${l.sites} stron · ${u.dbs} z ${l.dbs} baz (pakiet ${l.name}).`, 'info', { link: '#/konto' });
}
/** Raz na dobę: kto przekroczył miejsce — wiadomość do właściciela. */
export async function checkLimits() {
  for (const r of db.prepare('SELECT * FROM hosting').all()) {
    const u = await usage(r.login, true);
    if (u.bytes > r.disk * 1048576 && (!r.warned || Date.now() - r.warned > 864e5)) {
      db.prepare('UPDATE hosting SET warned=? WHERE login=?').run(Date.now(), r.login);
      await notify(`${r.login}: przekroczony limit miejsca`, `Zajmuje ${(u.bytes / 1048576).toFixed(0)} MB z ${r.disk} MB. Wgrywanie plików i nowe strony są zablokowane, dopóki nie zwolni miejsca albo nie zmienisz pakietu.`, 'warn', { link: '#/konto' });
    }
  }
}
export async function summary() {
  const out = [];
  for (const r of db.prepare('SELECT * FROM hosting').all()) out.push({ login: r.login, limits: limits(r.login), usage: await usage(r.login) });
  return out;
}
