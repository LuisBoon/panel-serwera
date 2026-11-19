// SQLite: bazy aplikacji (np. GibCord — tylko do odczytu, bo pisze do nich działająca aplikacja)
// i bazy założone w panelu (/var/lib/bazy-sqlite/<nazwa>.sqlite — pełna edycja).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { run } from '../util.mjs';
import { cell, isSecret, firstWord } from './common.mjs';
import { SQLITE_DBS } from '../data.mjs';

export const DIR = process.env.BAZY_SQLITE || '/var/lib/bazy-sqlite';
export const installed = () => true;

export function list() {
  const out = [];
  for (const d of SQLITE_DBS) {
    let s; try { s = fs.statSync(d.path); } catch { continue; }
    let wal = 0; try { wal = fs.statSync(d.path + '-wal').size; } catch {}
    out.push({ name: d.id, label: d.name, path: d.path, size: s.size + wal, tables: count(d.path), changed: s.mtimeMs, system: false, app: true, service: d.service });
  }
  let files = []; try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sqlite')); } catch {}
  for (const f of files.sort()) {
    const p = path.join(DIR, f); const s = fs.statSync(p);
    out.push({ name: f.replace(/\.sqlite$/, ''), label: f.replace(/\.sqlite$/, ''), path: p, size: s.size, tables: count(p), changed: s.mtimeMs, system: false, app: false });
  }
  return out;
}
function count(p) { try { const d = new DatabaseSync(p, { readOnly: true }); try { return d.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().c; } finally { d.close(); } } catch { return 0; } }
function find(name) { const d = list().find((x) => x.name === name); if (!d) throw new Error('Nie ma takiej bazy.'); return d; }
export const exists = (name) => list().some((x) => x.name === name);
export const pathOf = (name) => find(name).path;
export function createDb(name) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o755 });
  const p = path.join(DIR, name + '.sqlite');
  if (fs.existsSync(p)) throw new Error('Taka baza już istnieje.');
  const d = new DatabaseSync(p); d.exec('PRAGMA journal_mode=WAL'); d.close();
  try { fs.chownSync(p, 33, 33); fs.chownSync(DIR, 33, 33); } catch {}
  return p;
}
export function dropDb(name) {
  const d = find(name);
  if (d.app) throw new Error('To baza działającej aplikacji — nie usuwam jej z panelu.');
  for (const s of ['', '-wal', '-shm']) fs.rmSync(d.path + s, { force: true });
}
function open(name, write) {
  const d = find(name);
  if (write && d.app) throw new Error(`To baza aplikacji (${d.label}) — panel pokazuje ją tylko do odczytu, żeby nie zepsuć działającej usługi.`);
  return new DatabaseSync(d.path, { readOnly: !write });
}
const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';

export function tables(name) {
  const d = open(name, false);
  try {
    return d.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => {
      let rows = null; try { rows = d.prepare(`SELECT count(*) c FROM ${qi(t.name)}`).get().c; } catch {}
      return { name: t.name, rows, size: null, approx: false, view: t.type === 'view' };
    });
  } finally { d.close(); }
}
function columnsOf(d, table) {
  return d.prepare(`PRAGMA table_info(${qi(table)})`).all().map((c) => ({ name: c.name, type: c.type, base: String(c.type).toLowerCase(), nullable: !c.notnull && !c.pk, pk: c.pk > 0, auto: c.pk > 0 && /int/i.test(c.type), secret: isSecret(c.name), binary: /blob/i.test(c.type) }));
}
export function rows(name, table, { od = 0, szukaj = '', limit = 50 } = {}) {
  const meta = find(name);
  const d = open(name, false);
  try {
    const t = d.prepare("SELECT type FROM sqlite_master WHERE name=? AND type IN ('table','view')").get(table);
    if (!t) throw new Error('Nie ma takiej tabeli.');
    const cols = columnsOf(d, table);
    const pk = cols.filter((c) => c.pk);
    const tc = cols.filter((c) => !c.binary);
    const where = szukaj && tc.length ? `WHERE (${tc.map((c) => `COALESCE(${qi(c.name)},'')`).join(" || ' ' || ")}) LIKE ?` : '';
    const params = where ? ['%' + szukaj + '%'] : [];
    const keyCols = pk.length ? pk.map((c) => c.name) : ['rowid'];
    const data = d.prepare(`SELECT ${pk.length ? '' : 'rowid AS "__rowid", '}* FROM ${qi(table)} ${where} ORDER BY ${keyCols.map((k) => (k === 'rowid' ? 'rowid' : qi(k))).join(',')} LIMIT ${Number(limit)} OFFSET ${Number(od)}`).all(...params);
    const total = d.prepare(`SELECT count(*) c FROM ${qi(table)} ${where}`).get(...params).c;
    return {
      cols, total, approx: false, offset: od, limit, view: t.type === 'view', readonlyApp: meta.app,
      editable: !meta.app && t.type === 'table',
      rows: data.map((r) => cols.map((c) => cell(r[c.name], c.name))),
      keys: data.map((r) => (pk.length ? Object.fromEntries(pk.map((c) => [c.name, r[c.name] == null ? null : String(r[c.name])])) : { rowid: String(r.__rowid) })),
      full: data.map((r) => Object.fromEntries(cols.filter((c) => !c.secret && !c.binary).map((c) => [c.name, r[c.name] == null ? null : String(r[c.name])]))),
    };
  } finally { d.close(); }
}
function whereKey(key) {
  const ks = Object.keys(key || {});
  if (!ks.length) throw new Error('Brak klucza wiersza.');
  return { sql: ks.map((k) => `${k === 'rowid' ? 'rowid' : qi(k)} IS ?`).join(' AND '), params: ks.map((k) => key[k]) };
}
export function rowAction(name, table, action, key, values) {
  const d = open(name, true);
  try {
    const cols = columnsOf(d, table);
    if (!cols.length) throw new Error('Nie ma takiej tabeli.');
    const v = {};
    for (const [k, x] of Object.entries(values || {})) {
      const c = cols.find((y) => y.name === k); if (!c) throw new Error(`Nie ma kolumny ${k}.`);
      if (c.binary || x?.keep) continue;
      if (action === 'insert' && c.auto && !x?.null && (x?.v ?? '') === '') continue;
      v[k] = x?.null ? null : String(x?.v ?? '');
    }
    if (action === 'insert') {
      const ks = Object.keys(v);
      const r = ks.length ? d.prepare(`INSERT INTO ${qi(table)} (${ks.map(qi).join(',')}) VALUES (${ks.map(() => '?').join(',')})`).run(...ks.map((k) => v[k])) : d.prepare(`INSERT INTO ${qi(table)} DEFAULT VALUES`).run();
      const pk = cols.filter((c) => c.pk);
      const nk = pk.length ? Object.fromEntries(pk.map((c) => [c.name, c.name in v ? v[c.name] : String(r.lastInsertRowid)])) : { rowid: String(r.lastInsertRowid) };
      return { undo: { op: 'delete', key: nk }, text: 'dodano wiersz' };
    }
    const w = whereKey(key);
    const old = d.prepare(`SELECT * FROM ${qi(table)} WHERE ${w.sql}`).all(...w.params);
    if (old.length !== 1) throw new Error('Nie znalazłem tego wiersza. Odśwież.');
    const before = Object.fromEntries(Object.entries(old[0]).map(([k, x]) => [k, x == null ? null : x instanceof Uint8Array ? { b64: Buffer.from(x).toString('base64') } : String(x)]));
    if (action === 'update') {
      const ks = Object.keys(v); if (!ks.length) throw new Error('Nic się nie zmieniło.');
      d.prepare(`UPDATE ${qi(table)} SET ${ks.map((k) => `${qi(k)} = ?`).join(', ')} WHERE ${w.sql}`).run(...ks.map((k) => v[k]), ...w.params);
      const nk = Object.fromEntries(Object.keys(key).map((k) => [k, k in v ? v[k] : key[k]]));
      return { undo: { op: 'update', key: nk, row: Object.fromEntries(ks.map((k) => [k, before[k]])) }, text: `zmieniono ${ks.join(', ')}` };
    }
    if (action === 'delete') { d.prepare(`DELETE FROM ${qi(table)} WHERE ${w.sql}`).run(...w.params); return { undo: { op: 'insert', row: before }, text: 'usunięto wiersz' }; }
    throw new Error('Nieznana akcja.');
  } finally { d.close(); }
}
export function rowUndo(name, table, u) {
  const d = open(name, true);
  try {
    const val = (x) => (x && typeof x === 'object' && x.b64 != null ? Buffer.from(x.b64, 'base64') : x);
    if (u.op === 'delete') { const w = whereKey(u.key); d.prepare(`DELETE FROM ${qi(table)} WHERE ${w.sql}`).run(...w.params); return; }
    const ks = Object.keys(u.row || {});
    if (u.op === 'insert') { d.prepare(`INSERT INTO ${qi(table)} (${ks.map(qi).join(',')}) VALUES (${ks.map(() => '?').join(',')})`).run(...ks.map((k) => val(u.row[k]))); return; }
    const w = whereKey(u.key);
    d.prepare(`UPDATE ${qi(table)} SET ${ks.map((k) => `${qi(k)} = ?`).join(', ')} WHERE ${w.sql}`).run(...ks.map((k) => val(u.row[k])), ...w.params);
  } finally { d.close(); }
}
const READ = new Set(['SELECT', 'EXPLAIN', 'WITH', 'VALUES', 'PRAGMA']);
export function classify(sql) {
  const w = firstWord(sql);
  if (!w) return { kind: 'blocked', msg: 'Wpisz zapytanie.' };
  if (/^\s*(ATTACH|DETACH|VACUUM\s+INTO)\b|load_extension\s*\(/i.test(sql)) return { kind: 'blocked', msg: 'Tego polecenia nie uruchamiam z panelu — użyj terminala.' };
  if (READ.has(w) && !(w === 'PRAGMA' && /=/.test(sql))) return { kind: 'read', word: w };
  if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(w)) return { kind: 'dml', word: w };
  return { kind: 'ddl', word: w };
}
export function query(name, sql, { mode = 'read', max = 500 } = {}) {
  const d = open(name, mode !== 'read');
  try {
    if (mode === 'preview') { d.exec('BEGIN'); try { const r = d.prepare(sql).run(); return { affected: Number(r.changes) }; } finally { d.exec('ROLLBACK'); } }
    const st = d.prepare(sql);
    let cols = []; try { cols = (st.columns?.() || []).map((c) => c.name); } catch {}
    if (!cols.length) { const r = st.run(); return { affected: Number(r.changes) }; }
    const all = st.all();
    return { cols, rows: all.slice(0, max).map((r) => cols.map((c) => cell(r[c], c, 2000))), truncated: all.length > max };
  } finally { d.close(); }
}
export const dumpArgs = (name) => ['sqlite3', [pathOf(name), '.dump']];
export const loadArgs = (name) => ['sqlite3', [pathOf(name)]];
export async function backupTo(name, file) { const r = await run('sqlite3', [pathOf(name), `.backup '${file.replace(/'/g, "''")}'`], { timeout: 120000 }); if (!r.ok) throw new Error(r.err); }
