// MariaDB: połączenie przez gniazdo jako root (logowanie unix_socket), bazy, konta i prawa, dane, zapytania.
import mysql from 'mysql2/promise';
import { cell, isSecret, firstWord, checkName, HOST_RE } from './common.mjs';

const SOCKET = process.env.MARIADB_SOCKET || '/run/mysqld/mysqld.sock';
export const SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'sys', 'mysql']);
export const SYSTEM_USERS = new Set(['mariadb.sys', 'mysql', 'root', 'debian-sys-maint']);
let pool = null;
function P() {
  if (!pool) pool = mysql.createPool({ socketPath: SOCKET, user: 'root', charset: 'utf8mb4', connectionLimit: 4, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 });
  return pool;
}
export async function q(sql, params) { const [rows] = await P().query(sql, params); return rows; }
export const id = (s) => mysql.escapeId(String(s), true);
const lit = (s) => mysql.escape(String(s));
export const acct = (u, h) => `${lit(u)}@${lit(h)}`;
/** Nazwa bazy jako wzorzec w GRANT: _ i % to znaki specjalne, więc trzeba je poprzedzić \. */
const grantDb = (name) => '`' + String(name).replace(/`/g, '``').replace(/([_%\\])/g, '\\$1') + '`';
const unesc = (s) => String(s).replace(/\\(.)/g, '$1');

export async function version() { try { return String((await q('SELECT VERSION() v'))[0].v).replace(/-MariaDB.*$/, '').replace(/-0\+deb.*$/, ''); } catch { return ''; } }

/* ---------------------------------------------------------------- bazy */

export async function list() {
  const names = (await q('SHOW DATABASES')).map((r) => r.Database);
  const st = await q(`SELECT table_schema s, COALESCE(SUM(data_length+index_length),0) size, COUNT(*) n, UNIX_TIMESTAMP(MAX(COALESCE(update_time, create_time))) ch FROM information_schema.tables GROUP BY table_schema`);
  const m = new Map(st.map((r) => [r.s, r]));
  return names.map((n) => { const r = m.get(n); return { name: n, size: r ? Number(r.size) : 0, tables: r ? Number(r.n) : 0, changed: r?.ch ? Number(r.ch) * 1000 : null, system: SYSTEM_DBS.has(n) }; });
}
export async function exists(dbn) { return (await q('SHOW DATABASES LIKE ?', [dbn.replace(/([_%\\])/g, '\\$1')])).length > 0; }
export async function createDb(dbn) { await q(`CREATE DATABASE ${id(dbn)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); }
export async function dropDb(dbn) {
  if (SYSTEM_DBS.has(dbn)) throw new Error('Bazy systemowej nie da się usunąć.');
  await q(`DROP DATABASE ${id(dbn)}`);
}
export const dumpArgs = (dbn, table) => ['mysqldump', ['--single-transaction', '--quick', '--routines', '--events', '--default-character-set=utf8mb4', dbn, ...(table ? [table] : [])]];
export const loadArgs = (dbn) => ['mysql', ['--default-character-set=utf8mb4', dbn]];

/* --------------------------------------------------------------- konta */

const FULL = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER'];
function rightsOf(privs) {
  const p = privs.split(',').map((x) => x.trim().toUpperCase());
  if (p.includes('ALL PRIVILEGES') || p.includes('ALL')) return 'pelne';
  if (FULL.every((x) => p.includes(x))) return 'pelne';
  if (p.includes('SELECT') && p.every((x) => ['SELECT', 'SHOW VIEW', 'EXECUTE'].includes(x))) return 'odczyt';
  return 'inne';
}
/** Rozbiór SHOW GRANTS: prawa globalne, do baz (z surowym wzorcem do REVOKE) i do pojedynczych tabel. */
export function parseGrants(lines) {
  const out = { global: null, grantOption: false, dbs: [] };
  for (const l of lines) {
    if (/^GRANT PROXY/i.test(l)) continue;
    const m = l.match(/^GRANT (.+?) ON (\*\.\*|`((?:[^`]|``)+)`\.(\*|`(?:[^`]|``)+`)) TO .+?$/i);
    if (!m) continue;
    const go = /WITH GRANT OPTION/i.test(l);
    if (m[2] === '*.*') {
      if (!/^USAGE$/i.test(m[1].trim())) { out.global = rightsOf(m[1]); out.grantOption = out.grantOption || go; }
      else if (go) out.grantOption = true;
      continue;
    }
    const raw = m[3].replace(/``/g, '`');
    const name = unesc(raw);
    const tableLevel = m[4] !== '*';
    const ex = out.dbs.find((d) => d.raw === raw);
    const r = tableLevel ? 'inne' : rightsOf(m[1]);
    if (ex) { if (ex.rights !== r) ex.rights = 'inne'; } else out.dbs.push({ db: name, raw, rights: r, pattern: /(?<!\\)[%_]/.test(raw) });
    if (go) out.grantOption = true;
  }
  return out;
}
async function grantsFor(u, h) { return (await q(`SHOW GRANTS FOR ${acct(u, h)}`)).map((g) => String(Object.values(g)[0])); }
async function createFor(u, h) { return String(Object.values((await q(`SHOW CREATE USER ${acct(u, h)}`))[0])[0]); }
async function hostsOf(u) { return (await q('SELECT Host h FROM mysql.global_priv WHERE User=? ORDER BY Host', [u])).map((r) => r.h); }

export async function users() {
  const rows = await q(`SELECT User u, Host h, JSON_VALUE(Priv,'$.account_locked') locked, JSON_VALUE(Priv,'$.plugin') plugin FROM mysql.global_priv ORDER BY User, Host`);
  const by = new Map();
  for (const r of rows) {
    let g = { global: null, grantOption: false, dbs: [] };
    try { g = parseGrants(await grantsFor(r.u, r.h)); } catch {}
    let x = by.get(r.u);
    if (!x) by.set(r.u, x = { engine: 'mariadb', user: r.u, hosts: [], lockedAll: true, lockedAny: false, global: null, grantOption: false, dbs: [], plugin: r.plugin || '', system: SYSTEM_USERS.has(r.u) });
    const locked = r.locked === true || r.locked === 'true' || r.locked === 1 || r.locked === '1';
    x.hosts.push(r.h);
    x.lockedAll = x.lockedAll && locked; x.lockedAny = x.lockedAny || locked;
    if (g.global && (!x.global || g.global === 'pelne')) x.global = g.global;
    x.grantOption = x.grantOption || g.grantOption;
    for (const d of g.dbs) if (!x.dbs.find((y) => y.raw === d.raw)) x.dbs.push(d);
  }
  return [...by.values()].map((x) => ({ ...x, locked: x.lockedAll }));
}
export async function userExists(u) { return (await hostsOf(u)).length > 0; }

function checkHost(h) { if (!HOST_RE.test(h)) throw new Error('Nieprawidłowy adres.'); return h; }
async function grant(u, h, dbn, rights) {
  await q(`GRANT ${rights === 'odczyt' ? 'SELECT, SHOW VIEW' : 'ALL PRIVILEGES'} ON ${grantDb(dbn)}.* TO ${acct(u, h)}`);
}
export async function createUser(u, pass, hosts, dbs = []) {
  if (await userExists(u)) throw new Error(`Konto ${u} już istnieje.`);
  const done = [];
  try {
    for (const h of hosts) { await q(`CREATE USER ${acct(u, checkHost(h))} IDENTIFIED BY ?`, [pass]); done.push(h); }
    for (const h of hosts) for (const d of dbs) await grant(u, h, d.db, d.rights);
  } catch (e) { for (const h of done) await q(`DROP USER IF EXISTS ${acct(u, h)}`).catch(() => {}); throw e; }
}
/** Pełny przepis na odtworzenie konta (do cofania usunięcia i zmian). */
export async function snapshotUser(u) {
  const out = [];
  for (const h of await hostsOf(u)) out.push({ host: h, create: await createFor(u, h), grants: (await grantsFor(u, h)).map((l) => l.replace(/ IDENTIFIED BY PASSWORD '[^']*'/, '')) });
  return out;
}
export async function restoreUser(u, snap) {
  for (const h of await hostsOf(u)) await q(`DROP USER ${acct(u, h)}`);
  for (const s of snap) {
    await q(s.create);
    for (const g of s.grants) { if (/^GRANT USAGE ON \*\.\* TO/i.test(g) && !/WITH/i.test(g)) continue; await q(g); }
  }
}
function assertManaged(x) {
  if (SYSTEM_USERS.has(x)) throw new Error('To konto systemowe MariaDB — panel go nie zmienia.');
}
export async function setPassword(u, pass) {
  assertManaged(u);
  const hs = await hostsOf(u); if (!hs.length) throw new Error('Nie ma takiego konta.');
  for (const h of hs) await q(`ALTER USER ${acct(u, h)} IDENTIFIED BY ?`, [pass]);
}
export async function setLocked(u, on) {
  assertManaged(u);
  const hs = await hostsOf(u); if (!hs.length) throw new Error('Nie ma takiego konta.');
  for (const h of hs) await q(`ALTER USER ${acct(u, h)} ACCOUNT ${on ? 'LOCK' : 'UNLOCK'}`);
}
export async function dropUser(u) {
  assertManaged(u);
  const hs = await hostsOf(u); if (!hs.length) throw new Error('Nie ma takiego konta.');
  for (const h of hs) await q(`DROP USER ${acct(u, h)}`);
}
/** Ustawia, skąd konto może się łączyć: dodaje nowe adresy (z tym samym hasłem i prawami), potem usuwa zbędne. */
export async function setHosts(u, want) {
  assertManaged(u);
  want = [...new Set(want.map(checkHost))];
  if (!want.length) throw new Error('Konto musi mieć choć jeden adres.');
  const cur = await hostsOf(u);
  if (!cur.length) throw new Error('Nie ma takiego konta.');
  const tpl = cur.includes('localhost') ? 'localhost' : cur[0];
  const create = await createFor(u, tpl);
  if (!/IDENTIFIED BY PASSWORD '\*[0-9A-F]{40}'/i.test(create) && !/IDENTIFIED VIA/i.test(create)) throw new Error('To konto loguje się w nietypowy sposób — zmień je w terminalu.');
  const grants = (await grantsFor(u, tpl)).map((l) => l.replace(/ IDENTIFIED BY PASSWORD '[^']*'/, ''));
  const tplAcct = new RegExp('`' + u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`@`' + tpl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`');
  for (const h of want) {
    if (cur.includes(h)) continue;
    await q(create.replace(tplAcct, acct(u, h)));
    for (const g of grants) { if (/^GRANT USAGE ON \*\.\* TO/i.test(g) && !/WITH/i.test(g)) continue; await q(g.replace(tplAcct, acct(u, h))); }
  }
  for (const h of cur) if (!want.includes(h)) await q(`DROP USER ${acct(u, h)}`);
}
/** Prawa do baz: lista [{db, rights}] zastępuje dotychczasowe; global: 'zostaw' albo 'usun' (odbiera prawa do wszystkich baz). */
export async function setRights(u, list, { global = 'zostaw' } = {}) {
  assertManaged(u);
  const hs = await hostsOf(u); if (!hs.length) throw new Error('Nie ma takiego konta.');
  for (const h of hs) {
    const g = parseGrants(await grantsFor(u, h));
    if (global === 'usun' && g.global) {
      await q(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${acct(u, h)}`);
      for (const d of list) await grant(u, h, d.db, d.rights);
      continue;
    }
    for (const d of g.dbs) {
      const w = list.find((x) => x.db === d.db);
      if (w && w.rights === d.rights) continue;
      if (w && d.rights === 'inne' && w.rights === 'inne') continue;
      await q(`REVOKE ALL PRIVILEGES ON \`${d.raw.replace(/`/g, '``')}\`.* FROM ${acct(u, h)}`).catch(() => {});
      await q(`REVOKE GRANT OPTION ON \`${d.raw.replace(/`/g, '``')}\`.* FROM ${acct(u, h)}`).catch(() => {});
    }
    for (const w of list) {
      if (w.rights === 'inne') continue;
      const ex = g.dbs.find((x) => x.db === w.db);
      if (ex && ex.rights === w.rights) continue;
      await grant(u, h, w.db, w.rights);
    }
  }
}

/* ---------------------------------------------------------------- dane */

export async function tables(dbn) {
  const t = await q(`SELECT table_name n, table_rows r, COALESCE(data_length+index_length,0) s, engine e, table_type tt FROM information_schema.tables WHERE table_schema=? ORDER BY table_name`, [dbn]);
  return t.map((x) => ({ name: x.n, rows: x.r == null ? null : Number(x.r), size: Number(x.s), approx: x.e === 'InnoDB', view: x.tt === 'VIEW' }));
}
export async function columns(dbn, table) {
  return (await q(`SELECT column_name n, data_type t, column_type ct, is_nullable nl, column_key k, extra x, column_default d FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`, [dbn, table]))
    .map((c) => ({ name: c.n, type: c.ct, base: String(c.t).toLowerCase(), nullable: c.nl === 'YES', pk: c.k === 'PRI', auto: /auto_increment/i.test(c.x || ''), def: c.d, secret: isSecret(c.n), binary: /blob|binary|geometry|point/i.test(c.t) }));
}
export async function rows(dbn, table, { od = 0, szukaj = '', limit = 50 } = {}) {
  const t = (await tables(dbn)).find((x) => x.name === table);
  if (!t) throw new Error('Nie ma takiej tabeli.');
  const cols = await columns(dbn, table);
  const pk = cols.filter((c) => c.pk);
  let where = ''; const params = [];
  if (szukaj) {
    const tc = cols.filter((c) => !c.binary).slice(0, 40);
    if (tc.length) { where = `WHERE CONCAT_WS(' ', ${tc.map((c) => id(c.name)).join(',')}) LIKE ?`; params.push('%' + szukaj + '%'); }
  }
  const order = pk.length ? 'ORDER BY ' + pk.map((c) => id(c.name)).join(',') : '';
  const data = await q(`SELECT * FROM ${id(dbn)}.${id(table)} ${where} ${order} LIMIT ? OFFSET ?`, [...params, limit, od]);
  const total = szukaj ? Number((await q(`SELECT COUNT(*) c FROM ${id(dbn)}.${id(table)} ${where}`, params))[0].c) : t.rows;
  return {
    cols: cols.map(({ def, ...c }) => c), total, approx: !szukaj && t.approx, offset: od, limit, view: t.view,
    editable: !t.view && pk.length > 0 && !pk.some((c) => c.binary),
    rows: data.map((r) => cols.map((c) => cell(r[c.name], c.name))),
    keys: data.map((r) => Object.fromEntries(pk.map((c) => [c.name, r[c.name]]))),
    full: data.map((r) => Object.fromEntries(cols.filter((c) => !c.secret && !c.binary).map((c) => [c.name, r[c.name] == null ? null : String(r[c.name])]))),
  };
}
function valuesFor(cols, values, { insert = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(values || {})) {
    const c = cols.find((x) => x.name === k);
    if (!c) throw new Error(`Nie ma kolumny ${k}.`);
    if (c.binary) continue;
    if (v && v.keep) continue; // pole ukryte zostawione bez zmian
    if (v && v.null) { if (!c.nullable && !(insert && c.auto)) throw new Error(`Kolumna ${k} nie może być pusta (NULL).`); out[k] = null; continue; }
    if (insert && c.auto && (v?.v ?? '') === '') continue;
    out[k] = String(v?.v ?? '');
  }
  return out;
}
function whereKey(pk, key) {
  if (!pk.length) throw new Error('Ta tabela nie ma klucza głównego — edycja wierszy jest wyłączona (użyj zapytania SQL).');
  for (const c of pk) if (!(c.name in (key || {}))) throw new Error('Brak klucza wiersza.');
  return { sql: pk.map((c) => `${id(c.name)} <=> ?`).join(' AND '), params: pk.map((c) => key[c.name]) };
}
/** Zmiana jednego wiersza. Zwraca przepis na cofnięcie. */
export async function rowAction(dbn, table, action, key, values) {
  const cols = await columns(dbn, table);
  if (!cols.length) throw new Error('Nie ma takiej tabeli.');
  const pk = cols.filter((c) => c.pk);
  const T = `${id(dbn)}.${id(table)}`;
  if (action === 'insert') {
    const v = valuesFor(cols, values, { insert: true });
    const r = await q(`INSERT INTO ${T} SET ?`, [v]);
    const newKey = Object.fromEntries(pk.map((c) => [c.name, c.auto && r.insertId ? String(r.insertId) : v[c.name]]));
    return { undo: { op: 'delete', key: newKey }, text: `dodano wiersz` };
  }
  const w = whereKey(pk, key);
  const old = (await q(`SELECT * FROM ${T} WHERE ${w.sql} LIMIT 2`, w.params));
  if (old.length !== 1) throw new Error('Nie znalazłem tego wiersza — może ktoś go właśnie zmienił. Odśwież.');
  const before = Object.fromEntries(Object.entries(old[0]).map(([k, v]) => [k, v == null ? null : (v instanceof Uint8Array ? { b64: Buffer.from(v).toString('base64') } : String(v))]));
  if (action === 'update') {
    const v = valuesFor(cols, values);
    if (!Object.keys(v).length) throw new Error('Nic się nie zmieniło.');
    await q(`UPDATE ${T} SET ? WHERE ${w.sql} LIMIT 1`, [v, ...w.params]);
    const newKey = Object.fromEntries(pk.map((c) => [c.name, c.name in v ? v[c.name] : key[c.name]]));
    return { undo: { op: 'update', key: newKey, row: Object.fromEntries(Object.keys(v).map((k) => [k, before[k]])) }, text: `zmieniono ${Object.keys(v).join(', ')}` };
  }
  if (action === 'delete') {
    await q(`DELETE FROM ${T} WHERE ${w.sql} LIMIT 1`, w.params);
    return { undo: { op: 'insert', row: before }, text: 'usunięto wiersz' };
  }
  throw new Error('Nieznana akcja.');
}
/** Cofnięcie zmiany wiersza (przepis z rowAction). */
export async function rowUndo(dbn, table, u) {
  const cols = await columns(dbn, table);
  const pk = cols.filter((c) => c.pk);
  const T = `${id(dbn)}.${id(table)}`;
  const val = (v) => (v && typeof v === 'object' && v.b64 != null ? Buffer.from(v.b64, 'base64') : v);
  const row = Object.fromEntries(Object.entries(u.row || {}).map(([k, v]) => [k, val(v)]));
  if (u.op === 'delete') { const w = whereKey(pk, u.key); await q(`DELETE FROM ${T} WHERE ${w.sql} LIMIT 1`, w.params); }
  else if (u.op === 'insert') await q(`INSERT INTO ${T} SET ?`, [row]);
  else if (u.op === 'update') { const w = whereKey(pk, u.key); await q(`UPDATE ${T} SET ? WHERE ${w.sql} LIMIT 1`, [row, ...w.params]); }
}

/* ------------------------------------------------------------ zapytania */

const READ = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'VALUES', 'TABLE', 'HELP', 'ANALYZE']);
const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
const BLOCK = [
  [/\bINTO\s+(OUT|DUMP)FILE\b|\bLOAD_FILE\s*\(|\bLOAD\s+(DATA|XML)\b/i, 'Zapis i odczyt plików serwera przez SQL jest wyłączony.'],
  [/^\s*DROP\s+(DATABASE|SCHEMA)\b/i, 'Bazę usuń przyciskiem „Usuń bazę” — panel zrobi przed tym kopię.'],
  [/^\s*(SHUTDOWN|INSTALL|UNINSTALL)\b|\bSET\s+GLOBAL\b|^\s*KILL\b/i, 'Tego polecenia nie uruchamiam z panelu — użyj terminala.'],
  [/^\s*(CREATE|DROP|ALTER|RENAME)\s+USER\b|^\s*(GRANT|REVOKE)\b|^\s*SET\s+PASSWORD\b/i, 'Konta i prawa zmieniaj w zakładce „Konta” — tam panel pilnuje adresów i haseł.'],
];
export function classify(sql) {
  const w = firstWord(sql);
  for (const [re, msg] of BLOCK) if (re.test(sql)) return { kind: 'blocked', msg };
  if (w === 'ANALYZE' && !/^\s*ANALYZE\s+(FORMAT\s*=\s*\w+\s+)?SELECT\b/i.test(sql.replace(/^(\s|\/\*[\s\S]*?\*\/)*/, ''))) return { kind: 'ddl', word: w };
  if (READ.has(w)) return { kind: 'read', word: w };
  if (DML.has(w)) return { kind: 'dml', word: w };
  if (!w) return { kind: 'blocked', msg: 'Wpisz zapytanie.' };
  return { kind: 'ddl', word: w };
}
function result(rows, fields, max) {
  if (!Array.isArray(rows) || !fields) return { affected: rows?.affectedRows ?? 0, insertId: rows?.insertId || null, info: rows?.info || '' };
  const cols = fields.map((f) => f.name);
  const truncated = rows.length > max;
  return { cols, rows: rows.slice(0, max).map((r) => r.map((v, i) => cell(v, cols[i], 2000))), truncated };
}
/** Zapytanie. Tylko odczyt: sesja READ ONLY + limit wierszy i czasu. Zapis: najpierw próba w transakcji (ile wierszy zmieni). */
export async function query(dbn, sql, { mode = 'read', max = 500 } = {}) {
  const c = await P().getConnection();
  try {
    if (dbn) await c.query(`USE ${id(dbn)}`);
    await c.query('SET SESSION max_statement_time=30');
    if (mode === 'read') {
      await c.query('SET SESSION TRANSACTION READ ONLY');
      await c.query(`SET SESSION sql_select_limit=${max + 1}`);
      const [rows, fields] = await c.query({ sql, rowsAsArray: true });
      return result(rows, fields, max);
    }
    if (mode === 'preview') {
      await c.query('START TRANSACTION');
      try { const [r] = await c.query(sql); return { affected: r?.affectedRows ?? 0 }; }
      finally { await c.query('ROLLBACK').catch(() => {}); }
    }
    await c.query(`SET SESSION sql_select_limit=${max + 1}`);
    const [rows, fields] = await c.query({ sql, rowsAsArray: true });
    return result(rows, fields, max);
  } finally {
    await c.query('SET SESSION TRANSACTION READ WRITE').catch(() => {});
    await c.query('SET SESSION sql_select_limit=DEFAULT, max_statement_time=0').catch(() => {});
    c.release();
  }
}
export function close() { pool?.end().catch(() => {}); pool = null; }
export { checkName };
