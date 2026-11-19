// MongoDB (instalowany z panelu): logowanie włączone, panel ma konto panel_admin (hasło w katalogu danych panelu).
// Dostęp z zewnątrz: bindIp + authenticationRestrictions (konto działa tylko z podanych adresów).
import fs from 'node:fs';
import path from 'node:path';
import { cell, isSecret } from './common.mjs';

let ADMIN_FILE = '/var/lib/panel-serwera/mongo-admin.json';
export let BACKUP_CONF = '/var/lib/panel-serwera/mongo-kopie.yml';
let mongoLib = null, client = null;
export const SYSTEM_DBS = new Set(['admin', 'local', 'config']);
export function init(dataDir) { ADMIN_FILE = path.join(dataDir, 'mongo-admin.json'); BACKUP_CONF = path.join(dataDir, 'mongo-kopie.yml'); }
export const installed = () => fs.existsSync('/usr/bin/mongod');
function cred() { try { return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')); } catch { return null; } }
export const ready = () => installed() && !!cred();
export function saveCred(user, pass) {
  fs.writeFileSync(ADMIN_FILE, JSON.stringify({ user, pass }), { mode: 0o600 });
  fs.writeFileSync(BACKUP_CONF, `uri: mongodb://${user}:${encodeURIComponent(pass)}@127.0.0.1:27017/?authSource=admin\n`, { mode: 0o600 });
}

async function C() {
  if (client) return client;
  const c = cred();
  if (!c) throw new Error('MongoDB nie jest jeszcze przygotowany — zainstaluj go w zakładce „Silniki”.');
  if (!mongoLib) mongoLib = await import('mongodb');
  client = new mongoLib.MongoClient(`mongodb://127.0.0.1:27017/?authSource=admin`, { auth: { username: c.user, password: c.pass }, serverSelectionTimeoutMS: 4000, maxPoolSize: 3 });
  await client.connect();
  return client;
}
export function close() { client?.close().catch(() => {}); client = null; }
const admin = async () => (await C()).db('admin');

export async function version() { try { return (await (await admin()).command({ buildInfo: 1 })).version; } catch { return ''; } }

/* ---------------------------------------------------------------- bazy */

export async function list() {
  const r = await (await admin()).command({ listDatabases: 1 });
  const out = [];
  for (const d of r.databases) {
    let n = 0; try { n = (await (await C()).db(d.name).listCollections({}, { nameOnly: true }).toArray()).length; } catch {}
    out.push({ name: d.name, size: Number(d.sizeOnDisk || 0), tables: n, changed: null, system: SYSTEM_DBS.has(d.name) });
  }
  return out;
}
export async function exists(dbn) { return (await list()).some((d) => d.name === dbn); }
export async function createDb(dbn) { await (await C()).db(dbn).createCollection('start'); }
export async function dropDb(dbn) { if (SYSTEM_DBS.has(dbn)) throw new Error('Bazy systemowej nie da się usunąć.'); await (await C()).db(dbn).dropDatabase(); }
export const dumpArgs = (dbn, coll) => ['mongodump', [`--config=${BACKUP_CONF}`, `--db=${dbn}`, ...(coll ? [`--collection=${coll}`] : []), '--archive', '--quiet']];
export const loadArgs = (dbn) => ['mongorestore', [`--config=${BACKUP_CONF}`, '--archive', '--drop', `--nsInclude=${dbn}.*`, '--quiet']];

/* --------------------------------------------------------------- konta */

export async function users() {
  const r = await (await admin()).command({ usersInfo: { forAllDBs: true } });
  return r.users.map((u) => {
    const dbs = [];
    let global = null;
    for (const role of u.roles || []) {
      if (/^(root|readWriteAnyDatabase|dbAdminAnyDatabase|userAdminAnyDatabase)$/.test(role.role)) global = 'pelne';
      else if (role.role === 'readAnyDatabase' && !global) global = 'odczyt';
      else if (role.role === 'readWrite' || role.role === 'dbOwner') dbs.push({ db: role.db, rights: 'pelne' });
      else if (role.role === 'read') dbs.push({ db: role.db, rights: 'odczyt' });
    }
    const ips = (u.authenticationRestrictions || []).flat().flatMap((x) => x.clientSource || []).map((s) => s.replace(/\/32$/, ''));
    return { engine: 'mongo', user: u.user, authDb: u.db, hosts: ips.length ? ips.filter((x) => x !== '192.0.2.1') : ['localhost'], restricted: ips.length > 0, locked: ips.length === 1 && ips[0] === '192.0.2.1', global, grantOption: false, dbs, system: u.user === 'panel_admin' };
  });
}
const userDb = async (u) => { const x = (await users()).find((y) => y.user === u); if (!x) throw new Error('Nie ma takiego konta.'); if (x.system) throw new Error('To konto systemowe — panel go nie zmienia.'); return x.authDb; };
export async function userExists(u) { return (await users()).some((x) => x.user === u); }
/** Konto: uwierzytelnianie w admin; hosts = adresy (localhost zawsze), z których wolno się logować. */
export async function createUser(u, pass, hosts, dbs) {
  if (await userExists(u)) throw new Error(`Konto ${u} już istnieje.`);
  await (await admin()).command({ createUser: u, pwd: pass, roles: dbs.map((d) => ({ role: d.rights === 'odczyt' ? 'read' : 'readWrite', db: d.db })), authenticationRestrictions: [{ clientSource: srcs(hosts) }] });
}
function srcs(hosts) { return [...new Set(['127.0.0.1', '::1', ...hosts.filter((h) => h && h !== 'localhost' && h !== '%')])]; }
export async function setPassword(u, pass) { const d = await userDb(u); await (await C()).db(d).command({ updateUser: u, pwd: pass }); }
export async function setLocked(u, on) {
  // MongoDB nie ma blokady konta — blokujemy, zostawiając logowanie tylko z adresu, z którego nikt się nie połączy
  const d = await userDb(u);
  const cur = (await users()).find((x) => x.user === u);
  await (await C()).db(d).command({ updateUser: u, authenticationRestrictions: on ? [{ clientSource: ['192.0.2.1'] }] : [{ clientSource: srcs(cur.hosts.filter((h) => h !== '192.0.2.1')) }] });
}
export async function dropUser(u) { const d = await userDb(u); await (await C()).db(d).command({ dropUser: u }); }
export async function setHosts(u, hosts) { const d = await userDb(u); await (await C()).db(d).command({ updateUser: u, authenticationRestrictions: [{ clientSource: srcs(hosts) }] }); }
export async function setRights(u, list) { const d = await userDb(u); await (await C()).db(d).command({ updateUser: u, roles: list.filter((x) => x.rights !== 'inne').map((x) => ({ role: x.rights === 'odczyt' ? 'read' : 'readWrite', db: x.db })) }); }

/* ---------------------------------------------------------------- dane */

export async function tables(dbn) {
  const d = (await C()).db(dbn);
  const cols = await d.listCollections({}, { nameOnly: true }).toArray();
  const out = [];
  for (const c of cols.sort((a, b) => a.name.localeCompare(b.name))) {
    let n = null; try { n = await d.collection(c.name).estimatedDocumentCount(); } catch {}
    out.push({ name: c.name, rows: n, size: null, approx: true, view: c.type === 'view' });
  }
  return out;
}
const { EJSON } = await import('bson').catch(() => ({ EJSON: null }));
function toText(doc) { try { return EJSON ? EJSON.stringify(doc, { relaxed: true }) : JSON.stringify(doc); } catch { return String(doc); } }
function parseFilter(s) {
  const t = String(s || '').trim();
  if (!t) return {};
  if (t.startsWith('{')) { try { return EJSON ? EJSON.parse(t, { relaxed: true }) : JSON.parse(t); } catch { throw new Error('Filtr to JSON, np. {"name":"Jan"}'); } }
  return null; // zwykły tekst — szukamy po całym dokumencie
}
export async function rows(dbn, coll, { od = 0, szukaj = '', limit = 50 } = {}) {
  const c = (await C()).db(dbn).collection(coll);
  let filter = parseFilter(szukaj);
  let docs, total;
  if (filter === null) {
    // tekst: przeglądamy do 2000 dokumentów i filtrujemy po zapisie JSON
    const all = await c.find({}).limit(2000).toArray();
    const hit = all.filter((d) => toText(d).toLowerCase().includes(szukaj.toLowerCase()));
    total = hit.length; docs = hit.slice(od, od + limit);
  } else {
    docs = await c.find(filter).skip(od).limit(limit).toArray();
    total = Object.keys(filter).length ? await c.countDocuments(filter) : await c.estimatedDocumentCount();
  }
  const keys = new Set(['_id']);
  for (const d of docs) for (const k of Object.keys(d)) if (keys.size < 30) keys.add(k);
  const cols = [...keys].map((k) => ({ name: k, type: '', pk: k === '_id', nullable: true, secret: isSecret(k) }));
  return {
    cols, total, approx: false, offset: od, limit, view: false, editable: true, mongo: true,
    rows: docs.map((d) => cols.map((c) => (d[c.name] === undefined ? null : cell(typeof d[c.name] === 'object' && d[c.name] !== null && d[c.name]._bsontype !== 'ObjectId' ? toText(d[c.name]) : String(d[c.name]), c.name)))),
    keys: docs.map((d) => ({ _id: toText({ _id: d._id }) })),
    docs: docs.map((d) => { const x = { ...d }; for (const k of Object.keys(x)) if (isSecret(k)) delete x[k]; return toText(x); }),
  };
}
function idOf(key) { const p = EJSON ? EJSON.parse(String(key._id), { relaxed: true }) : JSON.parse(String(key._id)); return p._id; }
/** Dokument: wstawienie / podmiana (zachowujemy ukryte pola) / usunięcie. values.doc = tekst JSON. */
export async function rowAction(dbn, coll, action, key, values) {
  const c = (await C()).db(dbn).collection(coll);
  const parse = (t) => { try { return EJSON ? EJSON.parse(String(t), { relaxed: true }) : JSON.parse(String(t)); } catch { throw new Error('Dokument musi być poprawnym JSON-em.'); } };
  if (action === 'insert') { const d = parse(values?.doc); const r = await c.insertOne(d); return { undo: { op: 'delete', key: { _id: toText({ _id: r.insertedId }) } }, text: 'dodano dokument' }; }
  const _id = idOf(key);
  const old = await c.findOne({ _id });
  if (!old) throw new Error('Nie znalazłem tego dokumentu. Odśwież.');
  if (action === 'update') {
    const d = parse(values?.doc); delete d._id;
    for (const k of Object.keys(old)) if (isSecret(k) && !(k in d)) d[k] = old[k];
    await c.replaceOne({ _id }, d);
    return { undo: { op: 'replace', key, doc: toText(old) }, text: 'zmieniono dokument' };
  }
  if (action === 'delete') { await c.deleteOne({ _id }); return { undo: { op: 'insert', doc: toText(old) }, text: 'usunięto dokument' }; }
  throw new Error('Nieznana akcja.');
}
export async function rowUndo(dbn, coll, u) {
  const c = (await C()).db(dbn).collection(coll);
  const parse = (t) => (EJSON ? EJSON.parse(String(t), { relaxed: true }) : JSON.parse(String(t)));
  if (u.op === 'delete') await c.deleteOne({ _id: idOf(u.key) });
  else if (u.op === 'insert') await c.insertOne(parse(u.doc));
  else if (u.op === 'replace') { const d = parse(u.doc); await c.replaceOne({ _id: d._id }, d); }
}

/* ------------------------------------------------------------ zapytania */

// Zapytanie to polecenie bazy w JSON, np. {"find":"gracze","filter":{"poziom":{"$gt":5}}}
const READ_CMDS = new Set(['find', 'aggregate', 'count', 'distinct', 'listCollections', 'dbStats', 'collStats', 'listIndexes', 'explain']);
const BLOCKED = new Set(['dropDatabase', 'createUser', 'updateUser', 'dropUser', 'dropAllUsersFromDatabase', 'grantRolesToUser', 'revokeRolesFromUser', 'shutdown', 'setParameter', 'fsync']);
function parseCmd(text) {
  let cmd;
  try { cmd = EJSON ? EJSON.parse(String(text), { relaxed: true }) : JSON.parse(String(text)); } catch { throw new Error('Zapytanie MongoDB wpisz jako JSON, np. {"find":"kolekcja","filter":{}}'); }
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) throw new Error('Zapytanie MongoDB wpisz jako JSON, np. {"find":"kolekcja","filter":{}}');
  return cmd;
}
export function classify(text) {
  let cmd; try { cmd = parseCmd(text); } catch (e) { return { kind: 'blocked', msg: e.message }; }
  const w = Object.keys(cmd)[0] || '';
  if (BLOCKED.has(w)) return { kind: 'blocked', msg: 'Bazy i konta zmieniaj przyciskami panelu.' };
  if (w === 'aggregate' && JSON.stringify(cmd.pipeline || []).match(/"\$(out|merge)"/)) return { kind: 'dml', word: w };
  if (READ_CMDS.has(w)) return { kind: 'read', word: w };
  if (['insert', 'update', 'delete', 'findAndModify'].includes(w)) return { kind: 'dml', word: w };
  return { kind: 'ddl', word: w };
}
export async function query(dbn, text, { mode = 'read', max = 500 } = {}) {
  const cmd = parseCmd(text);
  const w = Object.keys(cmd)[0];
  if (mode === 'preview') {
    if (w === 'delete' || w === 'update') {
      const c = (await C()).db(dbn).collection(cmd[w]);
      let n = 0;
      for (const s of cmd.deletes || cmd.updates || []) n += await c.countDocuments(s.q || {});
      return { affected: n };
    }
    return { affected: null };
  }
  if (w === 'find' && cmd.limit == null) cmd.limit = max + 1;
  const r = await (await C()).db(dbn).command(cmd);
  const docs = r.cursor ? r.cursor.firstBatch : null;
  if (docs) {
    const keys = new Set(); for (const d of docs) for (const k of Object.keys(d)) if (keys.size < 30) keys.add(k);
    const cols = [...keys];
    return { cols, rows: docs.slice(0, max).map((d) => cols.map((k) => (d[k] === undefined ? null : cell(typeof d[k] === 'object' && d[k] !== null ? toText(d[k]) : d[k], k, 2000)))), truncated: docs.length > max };
  }
  return { cols: ['wynik'], rows: [[cell(toText(r), 'wynik', 4000)]], affected: r.n ?? null };
}
