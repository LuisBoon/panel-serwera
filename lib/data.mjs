// Bazy danych (MariaDB, SQLite, dane w plikach) i kopie zapasowe.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { run, cached, readText, exists, stat, stamp } from './util.mjs';
import { C } from './config.mjs';

/* ------------------------------------------------------------------ bazy */

const NAME_RE = /^[A-Za-z0-9_]+$/;
const TABLE_RE = /^[A-Za-z0-9_$-]+$/;
const SECRET_COL = /pass|hash|token|secret|salt|otp|totp|2fa|session|cookie|api_?key|private|vapid|auth_key|p256dh|endpoint/i;
const SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'sys', 'mysql']);

// Bazy SQLite i katalogi danych aplikacji, które panel zna z nazwy.
// (lista z konfiguracji + bazy, które ma każdy serwer)
export const sqliteDbs = () => [...(C().bazySqlite || []), { id: 'fail2ban', name: 'Ochrona logowania (fail2ban)', path: '/var/lib/fail2ban/fail2ban.sqlite3', service: 'fail2ban' }];
export const dataDirs = () => C().katalogiDanych || [];
export const SQLITE_DBS = new Proxy([], { get: (_, k) => { const a = sqliteDbs(); const v = a[k]; return typeof v === 'function' ? v.bind(a) : v; } });
export const DATA_DIRS = new Proxy([], { get: (_, k) => { const a = dataDirs(); const v = a[k]; return typeof v === 'function' ? v.bind(a) : v; } });

async function sql(query, db) {
  const args = ['-N', '-B', '--default-character-set=utf8mb4', '-e', query];
  if (db) args.unshift(db);
  const r = await run('mysql', args, { timeout: 30000 });
  if (!r.ok) throw new Error('MariaDB: ' + r.err.trim());
  return r.out.split('\n').filter((l) => l !== '').map((l) => l.split('\t'));
}

function unescapeBatch(v) {
  if (v === 'NULL') return null;
  return v.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', 0: '\0', '\\': '\\' }[c] ?? c));
}

async function dirSize(p) {
  const r = await run('du', ['-sb', p], { timeout: 60000 });
  return Number((r.out.split('\t')[0] || '').trim()) || 0;
}

export const databases = cached(15000, async () => {
  const maria = [];
  try {
    const names = (await sql('SHOW DATABASES')).map((r) => r[0]);
    const stats = new Map((await sql("SELECT table_schema, COALESCE(SUM(data_length+index_length),0), COUNT(*), UNIX_TIMESTAMP(MAX(COALESCE(update_time, create_time))) FROM information_schema.tables GROUP BY table_schema")).map((r) => [r[0], r]));
    for (const n of names) {
      const st = stats.get(n);
      maria.push({ type: 'mariadb', id: n, name: n, size: st ? Number(st[1]) : 0, tables: st ? Number(st[2]) : 0, changed: st && st[3] !== 'NULL' ? Number(st[3]) * 1000 : null, system: SYSTEM_DBS.has(n) });
    }
  } catch (e) { maria.push({ type: 'mariadb', id: '', name: 'MariaDB niedostępna', error: e.message }); }
  const lite = [];
  for (const d of SQLITE_DBS) {
    const s = stat(d.path);
    if (!s) continue;
    const wal = stat(d.path + '-wal');
    let tables = 0;
    try { const db = new DatabaseSync(d.path, { readOnly: true }); tables = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c; db.close(); } catch {}
    lite.push({ type: 'sqlite', id: d.id, name: d.name, path: d.path, size: s.size + (wal ? wal.size : 0), tables, changed: Math.max(s.mtimeMs, wal ? wal.mtimeMs : 0), service: d.service });
  }
  const files = [];
  for (const d of DATA_DIRS) {
    const s = stat(d.path);
    if (!s) continue;
    files.push({ type: 'pliki', id: d.id, name: d.name, path: d.path, size: await dirSize(d.path), changed: s.mtimeMs, service: d.service });
  }
  return { maria, lite, files };
});

function findDb(type, id) {
  if (type === 'sqlite') { const d = SQLITE_DBS.find((x) => x.id === id); if (!d) throw new Error('Nie ma takiej bazy.'); return d; }
  if (type === 'pliki') { const d = DATA_DIRS.find((x) => x.id === id); if (!d) throw new Error('Nie ma takiego katalogu.'); return d; }
  if (type === 'mariadb') { if (!NAME_RE.test(id)) throw new Error('Nieprawidłowa nazwa bazy.'); return { id }; }
  throw new Error('Nieznany rodzaj bazy.');
}

export async function dbTables(type, id) {
  const d = findDb(type, id);
  if (type === 'mariadb') {
    const rows = await sql(`SELECT table_name, COALESCE(table_rows,0), COALESCE(data_length+index_length,0), COALESCE(engine,'') FROM information_schema.tables WHERE table_schema='${id}' ORDER BY table_name`);
    return rows.map((r) => ({ name: r[0], rows: Number(r[1]), size: Number(r[2]), engine: r[3], approx: r[3] === 'InnoDB' }));
  }
  if (type === 'sqlite') {
    const db = new DatabaseSync(d.path, { readOnly: true });
    try {
      const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return t.map((x) => {
        let rows = null;
        try { rows = db.prepare(`SELECT count(*) c FROM "${x.name.replace(/"/g, '""')}"`).get().c; } catch {}
        return { name: x.name, rows, size: null };
      });
    } finally { db.close(); }
  }
  throw new Error('Ten rodzaj nie ma tabel.');
}

function cell(v, col) {
  if (v === null || v === undefined) return null;
  if (SECRET_COL.test(col) && String(v).length) return '•••••• ukryte';
  if (v instanceof Uint8Array) return `[dane binarne, ${v.length} B]`;
  const s = String(v);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

export async function dbRows(type, id, table, offset = 0) {
  offset = Math.max(0, Number(offset) || 0);
  const tables = await dbTables(type, id);
  const t = tables.find((x) => x.name === table);
  if (!t) throw new Error('Nie ma takiej tabeli.');
  const LIMIT = 50;
  if (type === 'mariadb') {
    if (!TABLE_RE.test(table)) throw new Error('Nieprawidłowa nazwa tabeli.');
    const args = ['-B', '--default-character-set=utf8mb4', '-e', `SELECT * FROM \`${id}\`.\`${table}\` LIMIT ${LIMIT} OFFSET ${offset}`];
    const r = await run('mysql', args, { timeout: 30000 });
    if (!r.ok) throw new Error(r.err);
    const lines = r.out.split('\n').filter((l) => l !== '');
    const cols = (lines.shift() || '').split('\t');
    return { cols, rows: lines.map((l) => l.split('\t').map((v, i) => cell(unescapeBatch(v), cols[i]))), offset, limit: LIMIT, total: t.rows };
  }
  const d = findDb(type, id);
  const db = new DatabaseSync(d.path, { readOnly: true });
  try {
    const q = db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ${LIMIT} OFFSET ${offset}`);
    const rows = q.all();
    const cols = rows.length ? Object.keys(rows[0]) : (q.columns?.() || []).map((c) => c.name);
    return { cols, rows: rows.map((r) => cols.map((c) => cell(r[c], c))), offset, limit: LIMIT, total: t.rows };
  } finally { db.close(); }
}

/** Strumień do pobrania: zrzut bazy MariaDB (gzip), kopia SQLite (gzip) albo katalog (tar.gz). */
export async function dbDump(type, id, tmpDir) {
  const d = findDb(type, id);
  const when = stamp();
  if (type === 'mariadb') {
    const names = (await sql('SHOW DATABASES')).map((r) => r[0]);
    if (!names.includes(id)) throw new Error('Nie ma takiej bazy.');
    const dump = spawn('mysqldump', ['--single-transaction', '--quick', '--routines', '--events', '--default-character-set=utf8mb4', id], { stdio: ['ignore', 'pipe', 'ignore'] });
    const gz = spawn('gzip', ['-6'], { stdio: ['pipe', 'pipe', 'ignore'] });
    dump.stdout.pipe(gz.stdin);
    return { name: `${id}_${when}.sql.gz`, stream: gz.stdout, type: 'application/gzip' };
  }
  if (type === 'sqlite') {
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `zrzut-${process.pid}-${Date.now()}.sqlite`);
    const r = await run('sqlite3', [d.path, `.backup '${tmp}'`], { timeout: 120000 });
    if (!r.ok) throw new Error('Nie udało się skopiować bazy: ' + r.err);
    const gz = spawn('gzip', ['-6', '-c', tmp], { stdio: ['ignore', 'pipe', 'ignore'] });
    gz.on('close', () => fs.rm(tmp, { force: true }, () => {}));
    return { name: `${d.id}_${when}.sqlite.gz`, stream: gz.stdout, type: 'application/gzip' };
  }
  const tar = spawn('tar', ['czf', '-', '-C', path.dirname(d.path), path.basename(d.path)], { stdio: ['ignore', 'pipe', 'ignore'] });
  return { name: `${d.id}_${when}.tar.gz`, stream: tar.stdout, type: 'application/gzip' };
}

/* ----------------------------------------------------------------- kopie */

export const BACKUP_DIR = C().kopie.katalog;
// Baza i usługa GibCorda — gdy GibCord jest na tym serwerze (zmienne tylko do testów na atrapie)
const GC_DB = process.env.GIBCORD_DB || C().gibcord?.baza || '';
const GC_UNIT = process.env.GIBCORD_UNIT || C().gibcord?.usluga || '';
export const BACKUP_SCRIPT = C().kopie.skrypt;
export const BACKUP_LOG = C().kopie.log;
const MANUAL_RE = /^dc-(backup|web-backup|server-backup|code-backup)-\d{8}-\d{6}[^/]*$/;

export function backupRuns(limit = 30) {
  const lines = readText(BACKUP_LOG).split('\n');
  const runs = [];
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (.*)$/);
    if (!m) continue;
    const [, ts, msg] = m;
    if (msg.includes('=== start backupu ===')) { cur = { start: Date.parse(ts.replace(' ', 'T')), status: 'running', lines: [], error: '', size: '', free: '' }; runs.push(cur); continue; }
    if (!cur) continue;
    cur.lines.push(msg);
    if (msg.startsWith('BLAD')) { cur.status = 'error'; cur.error = msg.replace(/^BLAD:\s*/, ''); }
    else if (msg.startsWith('OSTRZEZENIE') && cur.status !== 'error') cur.warn = (cur.warn || 0) + 1;
    const sz = msg.match(/rozmiar backupu: (\S+) \| wolne na dysku: (\d+) MB/);
    if (sz) { cur.size = sz[1]; cur.free = Number(sz[2]) * 1024 * 1024; }
    if (msg.includes('=== koniec backupu ===')) { if (cur.status === 'running') cur.status = 'ok'; cur.end = Date.parse(ts.replace(' ', 'T')); cur = null; }
  }
  // przebieg zakończony błędem w połowie nie ma linii „koniec”
  for (const r of runs) if (r.status === 'running' && r !== runs[runs.length - 1]) r.status = 'error';
  return runs.slice(-limit).reverse();
}

export function backupSettings() {
  const txt = readText(BACKUP_SCRIPT);
  const num = (k) => Number((txt.match(new RegExp(`^${k}=(\\d+)`, 'm')) || [])[1]) || null;
  const cron = readText(C().kopie.cron);
  const when = (cron.match(new RegExp(`^(\\d+)\\s+(\\d+)\\s+\\*\\s+\\*\\s+\\*\\s+root\\s+${BACKUP_SCRIPT.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`, 'm')) || []);
  return {
    keepDb: num('KEEP_DB'), keepCode: num('KEEP_CODE'), keepMedia: num('KEEP_MEDIA'), minFreeMb: num('MIN_FREE_MB'),
    hour: when[2] != null ? Number(when[2]) : null, minute: when[1] != null ? Number(when[1]) : null,
    mediaDirs: [...txt.matchAll(/^\s+(\/var\/www\/[^\s)]+)$/gm)].map((m) => m[1]),
  };
}

export function saveBackupSettings({ keepDb, keepCode, keepMedia, minFreeMb }) {
  const v = { KEEP_DB: [keepDb, 1, 90], KEEP_CODE: [keepCode, 1, 90], KEEP_MEDIA: [keepMedia, 1, 10], MIN_FREE_MB: [minFreeMb, 500, 20000] };
  let txt = readText(BACKUP_SCRIPT);
  if (!txt) throw new Error('Nie znalazłem skryptu kopii.');
  for (const [k, [val, lo, hi]] of Object.entries(v)) {
    if (val == null) continue;
    const n = Number(val);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${k}: dozwolone ${lo}–${hi}.`);
    txt = txt.replace(new RegExp(`^${k}=\\d+`, 'm'), `${k}=${n}`);
  }
  fs.copyFileSync(BACKUP_SCRIPT, BACKUP_SCRIPT + '.poprzedni');
  fs.writeFileSync(BACKUP_SCRIPT, txt, { mode: 0o755 });
  return backupSettings();
}

function fileEntry(p, kind, label) {
  const s = stat(p);
  if (!s) return null;
  return { path: p, name: path.basename(p), kind, label, size: s.isDirectory() ? null : s.size, dir: s.isDirectory(), time: s.mtimeMs };
}

export function backupFiles() {
  const nightly = new Map(); // klucz: data_godzina
  const add = (key, e) => { if (!e) return; if (!nightly.has(key)) nightly.set(key, []); nightly.get(key).push(e); };
  for (const sub of ['bazy', 'kod']) {
    let list = [];
    try { list = fs.readdirSync(path.join(BACKUP_DIR, sub)); } catch {}
    for (const f of list) {
      const m = f.match(/^(.+?)_(\d{4}-\d{2}-\d{2}_\d{4})(.*)\.(sql\.gz|tar\.gz|archive\.gz)$/);
      if (!m) continue;
      const [, what, when, extra] = m;
      const dbLabel = what === 'mongo-wszystkie' ? 'MongoDB (wszystkie bazy)' : what.startsWith('pg-') ? `baza PostgreSQL ${what.slice(3)}` : what.startsWith('mongo-') ? `baza MongoDB ${what.slice(6)}` : what.startsWith('sqlite-') ? `baza SQLite ${what.slice(7)}` : `baza ${what}`;
      const label = sub === 'bazy' ? `${dbLabel}${extra ? ' ' + extra.replace(/^-/, '').replace(/-/g, ' ') : ''}` : ({ www: 'kod stron', konfiguracja: 'konfiguracja serwera' }[what] || `${what} (kod + dane)`);
      add(when, fileEntry(path.join(BACKUP_DIR, sub, f), sub === 'bazy' ? 'db' : 'code', label));
    }
  }
  const groups = [...nightly.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([when, files]) => ({
    when, time: Date.parse(when.replace('_', 'T').replace(/(\d{2})(\d{2})$/, '$1:$2')),
    files: files.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)),
    size: files.reduce((a, f) => a + (f.size || 0), 0),
  }));
  const snaps = [];
  try {
    for (const d of fs.readdirSync(path.join(BACKUP_DIR, 'media')).sort().reverse()) {
      const p = path.join(BACKUP_DIR, 'media', d);
      let sub = [];
      try { sub = fs.readdirSync(p); } catch {}
      snaps.push({ path: p, name: d, parts: sub, time: stat(p)?.mtimeMs || 0 });
    }
  } catch {}
  const manual = [];
  for (const f of GC_DB ? fs.readdirSync('/root') : []) {
    if (!MANUAL_RE.test(f)) continue;
    const kind = f.startsWith('dc-backup-') ? 'gibcord-db' : f.startsWith('dc-web-') ? 'gibcord-web' : f.startsWith('dc-server-') ? 'gibcord-server' : 'gibcord-code';
    const label = { 'gibcord-db': 'baza GibCorda', 'gibcord-web': 'strona GibCorda', 'gibcord-server': 'serwer GibCorda', 'gibcord-code': 'kod GibCorda' }[kind];
    const m = f.match(/^dc-[a-z-]+?-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-?(.*?)(\.sqlite|\.mjs|\.json)?$/);
    const note = m ? m[7].replace(/-/g, ' ') : '';
    const e = fileEntry('/root/' + f, kind, label + (note ? ` · ${note}` : ''));
    if (e) { if (m) e.time = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime(); manual.push(e); }
  }
  manual.sort((a, b) => b.time - a.time || a.kind.localeCompare(b.kind));
  const trash = [];
  try {
    for (const f of fs.readdirSync(path.join(BACKUP_DIR, 'usuniete'))) {
      const e = fileEntry(path.join(BACKUP_DIR, 'usuniete', f), 'trash', f.endsWith('.sql.gz') ? 'baza przed usunięciem' : 'pliki przed usunięciem');
      if (e) trash.push(e);
    }
  } catch {}
  trash.sort((a, b) => b.time - a.time);
  return { groups, snaps, manual, trash };
}

/** Sprawdza, czy ścieżka jest kopią, którą panel może pobrać/usunąć. Zwraca ścieżkę rzeczywistą. */
export function safeBackupPath(p) {
  let real;
  try { real = fs.realpathSync(String(p || '')); } catch { throw new Error('Nie ma takiego pliku.'); }
  const inBackups = real.startsWith(BACKUP_DIR + '/') && !real.slice(BACKUP_DIR.length).includes('/..');
  const manual = path.dirname(real) === '/root' && MANUAL_RE.test(path.basename(real));
  if (!inBackups && !manual) throw new Error('Ten plik nie jest kopią zapasową.');
  return real;
}

export function backupDownload(p) {
  const real = safeBackupPath(p);
  const s = stat(real);
  if (s.isDirectory()) {
    const tar = spawn('tar', ['czf', '-', '-C', path.dirname(real), path.basename(real)], { stdio: ['ignore', 'pipe', 'ignore'] });
    return { name: path.basename(real) + '.tar.gz', stream: tar.stdout, type: 'application/gzip' };
  }
  return { name: path.basename(real), stream: fs.createReadStream(real), size: s.size, type: 'application/octet-stream' };
}

export function backupDelete(p) {
  const real = safeBackupPath(p);
  if (real === BACKUP_DIR || ['bazy', 'kod', 'media'].some((d) => real === path.join(BACKUP_DIR, d))) throw new Error('Nie można usunąć całego katalogu kopii.');
  fs.rmSync(real, { recursive: true, force: true });
  return real;
}

/** Plan przywrócenia: co trzeba wpisać, żeby potwierdzić, i jakie kroki wykonać. */
export async function restorePlan(p) {
  const real = safeBackupPath(p);
  const base = path.basename(real);
  let m = real.startsWith(BACKUP_DIR + '/bazy/') && base.match(/^([A-Za-z0-9_]+)_\d{4}-\d{2}-\d{2}_\d{4}.*\.sql\.gz$/);
  if (m) {
    const db = m[1];
    const names = (await sql('SHOW DATABASES')).map((r) => r[0]);
    if (!names.includes(db)) throw new Error(`Baza ${db} już nie istnieje — przywracanie z panelu niedostępne.`);
    if (SYSTEM_DBS.has(db)) throw new Error('Bazy systemowej MariaDB nie przywracam z panelu.');
    return { kind: 'mariadb', db, file: real, confirm: db, text: `Baza „${db}” zostanie nadpisana zawartością z kopii. Przed tym panel zrobi kopię obecnego stanu.` };
  }
  m = real.startsWith(BACKUP_DIR + '/bazy/') && base.match(/^(pg|mongo|sqlite)-([A-Za-z0-9_]+)_\d{4}-\d{2}-\d{2}_\d{4}.*\.(sql|archive)\.gz$/);
  if (m) {
    const engine = { pg: 'postgres', mongo: 'mongo', sqlite: 'sqlite' }[m[1]];
    if (m[2] === 'wszystkie') throw new Error('To kopia wszystkich baz MongoDB — przywróć wybraną bazę z jej karty (Bazy danych → baza → Kopie).');
    return { kind: 'engine', engine, db: m[2], file: real, confirm: m[2], text: `Baza „${m[2]}” zostanie nadpisana zawartością z kopii. Przed tym panel zrobi kopię obecnego stanu.` };
  }
  if (GC_DB && path.dirname(real) === '/root' && /^dc-backup-.*\.sqlite$/.test(base)) {
    return { kind: 'gibcord', file: real, confirm: 'gibcord', text: 'GibCord zostanie na chwilę zatrzymany, a jego baza zastąpiona tą kopią. Wszystko, co napisano po jej zrobieniu, zniknie. Obecna baza trafi do nowej kopii w /root.' };
  }
  throw new Error('Tę kopię można tylko pobrać — przywracanie z panelu działa dla baz MariaDB i bazy GibCorda.');
}

export const gibcordUnit = () => GC_UNIT;
export function restoreSteps(plan) {
  const when = stamp();
  if (plan.kind === 'mariadb') {
    const safety = path.join(BACKUP_DIR, 'bazy', `${plan.db}_${when}-przed-przywroceniem.sql.gz`);
    return [
      ['bash', ['-c', 'set -o pipefail; mysqldump --single-transaction --quick --routines --events --default-character-set=utf8mb4 "$1" | gzip -9 > "$2"', 'x', plan.db, safety], `kopia obecnego stanu → ${safety}`],
      ['bash', ['-c', 'set -o pipefail; gunzip -c "$1" | mysql --default-character-set=utf8mb4 "$2"', 'x', plan.file, plan.db], `wczytuję kopię do bazy ${plan.db}`],
    ];
  }
  const live = GC_DB;
  const safety = `/root/dc-backup-${when.replace(/[-_]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$200')}-przed-przywroceniem.sqlite`;
  const owner = stat(live);
  const own = owner ? `${owner.uid}:${owner.gid}` : 'www-data:www-data';
  return [
    ['systemctl', ['stop', GC_UNIT], 'zatrzymuję GibCorda'],
    ['sqlite3', [live, `.backup '${safety}'`], `kopia obecnej bazy → ${safety}`],
    ['bash', ['-c', 'cp -f "$1" "$2.nowa" && rm -f "$2-wal" "$2-shm" && mv -f "$2.nowa" "$2" && chown "$3" "$2"', 'x', plan.file, live, own], 'podmieniam bazę'],
    ['systemctl', ['start', GC_UNIT], 'uruchamiam GibCorda'],
  ];
}
