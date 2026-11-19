// PostgreSQL (instalowany z panelu): panel łączy się kontem panel_admin (hasło w katalogu danych panelu),
// dostęp z zewnątrz to linie w pg_hba.conf w bloku panelu + listen_addresses w conf.d/panel.conf.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../util.mjs';
import { cell, isSecret, firstWord, password } from './common.mjs';

let ADMIN_FILE = '/var/lib/panel-serwera/postgres-admin.json';
let pgLib = null;
const pools = new Map();
export const SYSTEM_DBS = new Set(['postgres']);
export function init(dataDir) { ADMIN_FILE = path.join(dataDir, 'postgres-admin.json'); }

export function installed() { try { return fs.readdirSync('/usr/lib/postgresql').some((v) => fs.existsSync(`/usr/lib/postgresql/${v}/bin/postgres`)); } catch { return false; } }
export function majorVersion() { try { return fs.readdirSync('/etc/postgresql').sort().pop() || ''; } catch { return ''; } }
const confDir = () => `/etc/postgresql/${majorVersion()}/main`;
function cred() { try { return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')); } catch { return null; } }
export const ready = () => installed() && !!cred();

async function lib() { if (!pgLib) pgLib = (await import('pg')).default; return pgLib; }
async function pool(dbn = 'postgres') {
  let p = pools.get(dbn);
  if (p) return p;
  const c = cred();
  if (!c) throw new Error('PostgreSQL nie jest jeszcze przygotowany — zainstaluj go w zakładce „Silniki”.');
  const { Pool } = await lib();
  p = new Pool({ host: '127.0.0.1', port: 5432, user: c.user, password: c.pass, database: dbn, max: 2, idleTimeoutMillis: 20000, connectionTimeoutMillis: 5000 });
  p.on('error', () => {});
  pools.set(dbn, p);
  return p;
}
export async function q(dbn, sql, params) { return (await pool(dbn)).query(sql, params); }
export const id = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
export function close() { for (const p of pools.values()) p.end().catch(() => {}); pools.clear(); }

/** Jako użytkownik postgres (logowanie „peer” przez gniazdo). */
async function asPostgres(sql) {
  const r = await run('runuser', ['-u', 'postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1', '-qAt'], { input: sql, timeout: 60000 });
  if (!r.ok) throw new Error('PostgreSQL: ' + (r.err || r.out).trim().split('\n').pop());
  return r.out;
}
/** Po instalacji: konto panelu i bezpieczne ustawienia. */
export async function setup() {
  const pass = password(32);
  const exists = (await asPostgres("SELECT 1 FROM pg_roles WHERE rolname='panel_admin'")).trim() === '1';
  await asPostgres(`${exists ? 'ALTER' : 'CREATE'} ROLE panel_admin LOGIN SUPERUSER PASSWORD ${lit(pass)};`);
  fs.writeFileSync(ADMIN_FILE, JSON.stringify({ user: 'panel_admin', pass }), { mode: 0o600 });
  close();
}

export async function version() { try { return String((await q('postgres', 'SHOW server_version')).rows[0].server_version).split(' ')[0]; } catch { return majorVersion(); } }

/* ---------------------------------------------------------------- bazy */

export async function list() {
  const r = await q('postgres', `SELECT d.datname n, pg_database_size(d.datname) s, r.rolname o FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE NOT d.datistemplate ORDER BY 1`);
  const out = [];
  for (const x of r.rows) {
    let tables = 0;
    try { tables = Number((await q(x.n, `SELECT count(*) c FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')`)).rows[0].c); } catch {}
    out.push({ name: x.n, size: Number(x.s), tables, changed: null, system: SYSTEM_DBS.has(x.n), owner: x.o });
  }
  return out;
}
export async function exists(dbn) { return (await q('postgres', 'SELECT 1 FROM pg_database WHERE datname=$1', [dbn])).rowCount > 0; }
export async function createDb(dbn, owner) {
  await q('postgres', `CREATE DATABASE ${id(dbn)} OWNER ${id(owner)} ENCODING 'UTF8' TEMPLATE template0`);
  await q('postgres', `REVOKE CONNECT ON DATABASE ${id(dbn)} FROM PUBLIC`);
}
export async function dropDb(dbn) {
  if (SYSTEM_DBS.has(dbn)) throw new Error('Bazy systemowej nie da się usunąć.');
  pools.get(dbn)?.end().catch(() => {}); pools.delete(dbn);
  await q('postgres', `DROP DATABASE ${id(dbn)} WITH (FORCE)`);
}
export const dumpArgs = (dbn, table) => ['runuser', ['-u', 'postgres', '--', 'pg_dump', '--clean', '--if-exists', ...(table ? ['-t', table] : []), dbn]];
export const loadArgs = (dbn) => ['runuser', ['-u', 'postgres', '--', 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-d', dbn]];

/* --------------------------------------------------------------- konta */

export async function users() {
  const roles = (await q('postgres', `SELECT rolname u, rolsuper s, rolcanlogin l FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1`)).rows;
  const dbs = await list();
  const hba = hbaEntries();
  const out = [];
  for (const r of roles) {
    const mine = [];
    for (const d of dbs) {
      if (d.owner === r.u) { mine.push({ db: d.name, rights: 'pelne' }); continue; }
      try {
        const c = (await q('postgres', `SELECT has_database_privilege($1, $2, 'CONNECT') c`, [r.u, d.name])).rows[0].c;
        if (c && !d.system) {
          const w = (await q(d.name, `SELECT bool_or(has_table_privilege($1, c.oid, 'INSERT')) w FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname='public'`, [r.u])).rows[0].w;
          mine.push({ db: d.name, rights: w ? 'pelne' : 'odczyt' });
        }
      } catch {}
    }
    const hosts = ['localhost', ...hba.filter((h) => h.user === r.u).map((h) => h.ip)];
    out.push({ engine: 'postgres', user: r.u, hosts, locked: !r.l, global: r.s ? 'pelne' : null, grantOption: r.s, dbs: mine, system: r.u === 'postgres' || r.u === 'panel_admin' });
  }
  return out;
}
export async function userExists(u) { return (await q('postgres', 'SELECT 1 FROM pg_roles WHERE rolname=$1', [u])).rowCount > 0; }
export async function createUser(u, pass) {
  if (await userExists(u)) throw new Error(`Konto ${u} już istnieje.`);
  await q('postgres', `CREATE ROLE ${id(u)} LOGIN PASSWORD ${lit(pass)}`);
}
function guard(u) { if (u === 'postgres' || u === 'panel_admin') throw new Error('To konto systemowe — panel go nie zmienia.'); }
export async function setPassword(u, pass) { guard(u); await q('postgres', `ALTER ROLE ${id(u)} PASSWORD ${lit(pass)}`); }
export async function setLocked(u, on) { guard(u); await q('postgres', `ALTER ROLE ${id(u)} ${on ? 'NOLOGIN' : 'LOGIN'}`); }
export async function dropUser(u) {
  guard(u);
  for (const d of await list()) { try { await q(d.name, `REASSIGN OWNED BY ${id(u)} TO panel_admin; DROP OWNED BY ${id(u)}`); } catch {} }
  await q('postgres', `DROP ROLE ${id(u)}`);
  await setHba(u, []);
}
export async function setRights(u, list) {
  guard(u);
  const dbs = await list0();
  for (const d of dbs) {
    if (d.system) continue;
    const w = list.find((x) => x.db === d.name);
    if (d.owner === u) continue; // właściciel ma zawsze pełne prawa
    await q('postgres', `REVOKE CONNECT ON DATABASE ${id(d.name)} FROM ${id(u)}`).catch(() => {});
    await q(d.name, `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${id(u)}; REVOKE ALL ON SCHEMA public FROM ${id(u)}`).catch(() => {});
    if (!w) continue;
    await q('postgres', `GRANT CONNECT ON DATABASE ${id(d.name)} TO ${id(u)}`);
    if (w.rights === 'odczyt') await q(d.name, `GRANT USAGE ON SCHEMA public TO ${id(u)}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${id(u)}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${id(u)}`);
    else await q(d.name, `GRANT USAGE, CREATE ON SCHEMA public TO ${id(u)}; GRANT ALL ON ALL TABLES IN SCHEMA public TO ${id(u)}; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${id(u)}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${id(u)}`);
  }
}
const list0 = list;

/* --------------------------------------------- dostęp z zewnątrz (pg_hba) */

const B0 = '# >>> panel-serwera (nie edytuj ręcznie)', B1 = '# <<< panel-serwera';
function hbaFile() { return path.join(confDir(), 'pg_hba.conf'); }
export function hbaEntries() {
  let t = ''; try { t = fs.readFileSync(hbaFile(), 'utf8'); } catch { return []; }
  const i = t.indexOf(B0), j = t.indexOf(B1);
  if (i < 0 || j < i) return [];
  return t.slice(i + B0.length, j).split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p[0] === 'host').map((p) => ({ user: p[2], ip: p[3].replace(/\/32$/, '') }));
}
/** Ustawia adresy, z których konto może się łączyć z zewnątrz (pusta lista = tylko ten serwer). */
export async function setHba(u, ips) {
  const cur = hbaEntries().filter((e) => e.user !== u).concat(ips.map((ip) => ({ user: u, ip })));
  let t = fs.readFileSync(hbaFile(), 'utf8');
  const i = t.indexOf(B0), j = t.indexOf(B1);
  if (i >= 0 && j > i) t = t.slice(0, i).replace(/\n+$/, '\n') + t.slice(j + B1.length).replace(/^\n/, '');
  if (cur.length) t = t.replace(/\n*$/, '\n') + [B0, ...cur.map((e) => `host    all    ${e.user}    ${e.ip}/32    scram-sha-256`), B1].join('\n') + '\n';
  fs.writeFileSync(hbaFile(), t);
  const listen = path.join(confDir(), 'conf.d', 'panel.conf');
  const want = cur.length ? "listen_addresses = '*'\n" : "listen_addresses = 'localhost'\n";
  const was = fs.existsSync(listen) ? fs.readFileSync(listen, 'utf8') : "listen_addresses = 'localhost'\n";
  fs.mkdirSync(path.dirname(listen), { recursive: true });
  fs.writeFileSync(listen, want);
  if (was !== want) await run('systemctl', ['restart', 'postgresql'], { timeout: 60000 });
  else await run('systemctl', ['reload', 'postgresql'], { timeout: 30000 });
}
export async function setHosts(u, hosts) { guard(u); await setHba(u, hosts.filter((h) => !['localhost', '127.0.0.1', '::1'].includes(h))); }

/* ---------------------------------------------------------------- dane */

function splitT(t) { const i = t.indexOf('.'); return i > 0 ? [t.slice(0, i), t.slice(i + 1)] : ['public', t]; }
const T = (t) => { const [s, n] = splitT(t); return `${id(s)}.${id(n)}`; };
export async function tables(dbn) {
  const r = await q(dbn, `SELECT n.nspname s, c.relname n, c.relkind k, GREATEST(c.reltuples,0)::bigint r, pg_total_relation_size(c.oid) sz FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','v','m','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' ORDER BY 1,2`);
  return r.rows.map((x) => ({ name: x.s === 'public' ? x.n : `${x.s}.${x.n}`, rows: Number(x.r), size: Number(x.sz), approx: true, view: x.k !== 'r' && x.k !== 'p' }));
}
export async function columns(dbn, table) {
  const [s, n] = splitT(table);
  const r = await q(dbn, `SELECT a.attname n, format_type(a.atttypid, a.atttypmod) t, NOT a.attnotnull nl, COALESCE(i.indisprimary,false) pk, pg_get_expr(d.adbin, d.adrelid) def, a.attidentity ident
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace
    LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE ns.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [s, n]);
  return r.rows.map((c) => ({ name: c.n, type: c.t, base: c.t, nullable: c.nl, pk: c.pk, auto: !!c.ident || /nextval\(/.test(c.def || ''), secret: isSecret(c.n), binary: /bytea/.test(c.t) }));
}
export async function rows(dbn, table, { od = 0, szukaj = '', limit = 50 } = {}) {
  const t = (await tables(dbn)).find((x) => x.name === table);
  if (!t) throw new Error('Nie ma takiej tabeli.');
  const cols = await columns(dbn, table);
  const pk = cols.filter((c) => c.pk);
  const where = szukaj ? 'WHERE x::text ILIKE $1' : '';
  const params = szukaj ? ['%' + szukaj + '%'] : [];
  const order = pk.length ? 'ORDER BY ' + pk.map((c) => id(c.name)).join(',') : '';
  const data = (await q(dbn, `SELECT x.* FROM ${T(table)} x ${where} ${order} LIMIT ${Number(limit)} OFFSET ${Number(od)}`, params)).rows;
  const total = szukaj ? Number((await q(dbn, `SELECT count(*) c FROM ${T(table)} x ${where}`, params)).rows[0].c) : t.rows;
  const str = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : typeof v === 'object' && !(v instanceof Uint8Array) ? JSON.stringify(v) : String(v));
  return {
    cols, total, approx: !szukaj, offset: od, limit, view: t.view, editable: !t.view && pk.length > 0,
    rows: data.map((r) => cols.map((c) => cell(r[c.name], c.name))),
    keys: data.map((r) => Object.fromEntries(pk.map((c) => [c.name, str(r[c.name])]))),
    full: data.map((r) => Object.fromEntries(cols.filter((c) => !c.secret && !c.binary).map((c) => [c.name, str(r[c.name])]))),
  };
}
function vals(cols, values, insert) {
  const out = {};
  for (const [k, v] of Object.entries(values || {})) {
    const c = cols.find((x) => x.name === k);
    if (!c) throw new Error(`Nie ma kolumny ${k}.`);
    if (c.binary || (v && v.keep)) continue;
    if (v && v.null) { if (!c.nullable && !(insert && c.auto)) throw new Error(`Kolumna ${k} nie może być pusta (NULL).`); out[k] = null; continue; }
    if (insert && c.auto && (v?.v ?? '') === '') continue;
    out[k] = String(v?.v ?? '');
  }
  return out;
}
function where(pk, key, start = 1) {
  if (!pk.length) throw new Error('Ta tabela nie ma klucza głównego — edycja wierszy jest wyłączona (użyj zapytania SQL).');
  return { sql: pk.map((c, i) => `${id(c.name)}::text = $${start + i}`).join(' AND '), params: pk.map((c) => key[c.name]) };
}
export async function rowAction(dbn, table, action, key, values) {
  const cols = await columns(dbn, table);
  if (!cols.length) throw new Error('Nie ma takiej tabeli.');
  const pk = cols.filter((c) => c.pk);
  if (action === 'insert') {
    const v = vals(cols, values, true);
    const ks = Object.keys(v);
    const r = await q(dbn, ks.length ? `INSERT INTO ${T(table)} (${ks.map(id).join(',')}) VALUES (${ks.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *` : `INSERT INTO ${T(table)} DEFAULT VALUES RETURNING *`, ks.map((k) => v[k]));
    return { undo: { op: 'delete', key: Object.fromEntries(pk.map((c) => [c.name, String(r.rows[0][c.name])])) }, text: 'dodano wiersz' };
  }
  const w = where(pk, key);
  const old = (await q(dbn, `SELECT * FROM ${T(table)} WHERE ${w.sql} LIMIT 2`, w.params)).rows;
  if (old.length !== 1) throw new Error('Nie znalazłem tego wiersza — może ktoś go właśnie zmienił. Odśwież.');
  const before = Object.fromEntries(Object.entries(old[0]).map(([k, v]) => [k, v == null ? null : v instanceof Date ? v.toISOString() : typeof v === 'object' && !(v instanceof Uint8Array) ? JSON.stringify(v) : String(v)]));
  if (action === 'update') {
    const v = vals(cols, values, false);
    const ks = Object.keys(v);
    if (!ks.length) throw new Error('Nic się nie zmieniło.');
    const w2 = where(pk, key, ks.length + 1);
    await q(dbn, `UPDATE ${T(table)} SET ${ks.map((k, i) => `${id(k)} = $${i + 1}`).join(', ')} WHERE ${w2.sql}`, [...ks.map((k) => v[k]), ...w2.params]);
    return { undo: { op: 'update', key: Object.fromEntries(pk.map((c) => [c.name, c.name in v ? v[c.name] : key[c.name]])), row: Object.fromEntries(ks.map((k) => [k, before[k]])) }, text: `zmieniono ${ks.join(', ')}` };
  }
  if (action === 'delete') {
    await q(dbn, `DELETE FROM ${T(table)} WHERE ${w.sql}`, w.params);
    return { undo: { op: 'insert', row: before }, text: 'usunięto wiersz' };
  }
  throw new Error('Nieznana akcja.');
}
export async function rowUndo(dbn, table, u) {
  const cols = await columns(dbn, table);
  const pk = cols.filter((c) => c.pk);
  if (u.op === 'delete') { const w = where(pk, u.key); await q(dbn, `DELETE FROM ${T(table)} WHERE ${w.sql}`, w.params); return; }
  const ks = Object.keys(u.row || {});
  if (u.op === 'insert') { await q(dbn, `INSERT INTO ${T(table)} (${ks.map(id).join(',')}) VALUES (${ks.map((_, i) => '$' + (i + 1)).join(',')})`, ks.map((k) => u.row[k])); return; }
  const w = where(pk, u.key, ks.length + 1);
  await q(dbn, `UPDATE ${T(table)} SET ${ks.map((k, i) => `${id(k)} = $${i + 1}`).join(', ')} WHERE ${w.sql}`, [...ks.map((k) => u.row[k]), ...w.params]);
}

/* ------------------------------------------------------------ zapytania */

const READ = new Set(['SELECT', 'SHOW', 'EXPLAIN', 'WITH', 'VALUES', 'TABLE']);
const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
export function classify(sql) {
  const w = firstWord(sql);
  if (!w) return { kind: 'blocked', msg: 'Wpisz zapytanie.' };
  if (/^\s*(DROP\s+DATABASE|CREATE\s+(ROLE|USER)|ALTER\s+(ROLE|USER)|DROP\s+(ROLE|USER))\b/i.test(sql)) return { kind: 'blocked', msg: 'Bazy i konta zmieniaj przyciskami panelu — tam panel robi kopię i pilnuje dostępu.' };
  if (/\b(pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export)\s*\(|^\s*COPY\b[\s\S]*\b(TO|FROM)\s+(PROGRAM|')/i.test(sql)) return { kind: 'blocked', msg: 'Zapis i odczyt plików serwera przez SQL jest wyłączony.' };
  if (/^\s*(ALTER\s+SYSTEM|CREATE\s+EXTENSION|LOAD)\b/i.test(sql)) return { kind: 'blocked', msg: 'Tego polecenia nie uruchamiam z panelu — użyj terminala.' };
  if (READ.has(w)) return { kind: 'read', word: w };
  if (DML.has(w)) return { kind: 'dml', word: w };
  return { kind: 'ddl', word: w };
}
export async function query(dbn, sql, { mode = 'read', max = 500 } = {}) {
  const c = await (await pool(dbn || 'postgres')).connect();
  try {
    await c.query(mode === 'read' ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
    await c.query("SET LOCAL statement_timeout = '30s'");
    let r;
    try { r = await c.query({ text: sql, rowMode: 'array' }); }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    const last = Array.isArray(r) ? r[r.length - 1] : r;
    await c.query(mode === 'write' ? 'COMMIT' : 'ROLLBACK');
    if (mode === 'preview') return { affected: last.rowCount ?? 0 };
    if (!last.fields?.length) return { affected: last.rowCount ?? 0, info: last.command || '' };
    const cols = last.fields.map((f) => f.name);
    return { cols, rows: last.rows.slice(0, max).map((row) => row.map((v, i) => cell(v instanceof Date ? v.toISOString() : v, cols[i], 2000))), truncated: last.rows.length > max };
  } finally { c.release(); }
}
