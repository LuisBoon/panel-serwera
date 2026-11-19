// Próbne przywracanie kopii: raz w tygodniu (i na żądanie) panel odtwarza najnowszą nocną kopię
// w osobnym miejscu — bazy do tymczasowej bazy MariaDB, archiwa do tymczasowego folderu — i sprawdza,
// czy da się z niej wstać. Prawdziwe strony i bazy nie są ruszane; po próbie wszystko jest sprzątane.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as D from './data.mjs';
import { C } from './config.mjs';
import { run } from './util.mjs';

let db, TMP;
const TMP_DB = /^panel_proba_[0-9a-f]{6}$/;
const SKIP_DB = new Set(['mysql', 'sys', 'performance_schema', 'information_schema']);
const DEF = { on: true, day: 0, hour: 5 }; // niedziela 05:00 — po nocnej kopii, przed testem chmury (05:30)

export function init(database, dataDir) {
  db = database;
  TMP = path.join(dataDir, 'tmp');
  db.exec('CREATE TABLE IF NOT EXISTS proba_kopii(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, took INTEGER, level TEXT, kopia INTEGER, full INTEGER, title TEXT, items TEXT)');
  // po przerwanej próbie (restart panelu w trakcie) mogły zostać tymczasowe foldery i bazy
  try { for (const f of fs.readdirSync(TMP)) if (f.startsWith('proba-')) fs.rmSync(path.join(TMP, f), { recursive: true, force: true }); } catch {}
  dropLeftoverDbs().catch(() => {});
}

export function settings() {
  let v = {};
  try { v = JSON.parse(db.prepare("SELECT v FROM ustawienia WHERE k='proba'").get()?.v || '{}'); } catch {}
  return { ...DEF, ...v };
}
export function saveSettings({ on, day, hour }) {
  const next = { ...settings() };
  if (on != null) next.on = !!on;
  if (day != null) { const d = Number(day); if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error('Nieprawidłowy dzień tygodnia.'); next.day = d; }
  if (hour != null) { const x = Number(hour); if (!Number.isInteger(x) || x < 0 || x > 23) throw new Error('Godzina: 0–23.'); next.hour = x; }
  db.prepare("INSERT OR REPLACE INTO ustawienia(k,v) VALUES('proba',?)").run(JSON.stringify(next));
  return next;
}
function nextRun(s = settings()) {
  if (!s.on) return null;
  const d = new Date(); d.setHours(s.hour, 0, 0, 0);
  d.setDate(d.getDate() + ((s.day - d.getDay() + 7) % 7));
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 7);
  return d.getTime();
}
const row = (r) => r && { id: r.id, ts: r.ts, took: r.took, level: r.level, backup: r.kopia, full: !!r.full, title: r.title, items: JSON.parse(r.items || '[]') };
export function last() { return row(db.prepare('SELECT * FROM proba_kopii ORDER BY id DESC LIMIT 1').get()); }
export function status() {
  const hist = db.prepare('SELECT id,ts,level,kopia,full,title FROM proba_kopii ORDER BY id DESC LIMIT 8').all().map((r) => ({ id: r.id, ts: r.ts, level: r.level, backup: r.kopia, full: !!r.full, title: r.title }));
  return { settings: settings(), next: nextRun(), last: last(), history: hist };
}
/** Czy zaplanowana próba ma się teraz wykonać (zasada autopilota sprawdza co minutę). */
export function isDue(now = new Date()) {
  const s = settings();
  if (!s.on || now.getDay() !== s.day || now.getHours() < s.hour) return false;
  const slot = new Date(now); slot.setHours(s.hour, 0, 0, 0);
  const l = db.prepare('SELECT ts FROM proba_kopii ORDER BY id DESC LIMIT 1').get();
  return !l || l.ts < slot.getTime();
}

/* ------------------------------------------------------------- pomocnicze */

const mysql = (sql, dbName) => run('mysql', ['-N', '-B', '--default-character-set=utf8mb4', ...(dbName ? [dbName] : []), '-e', sql], { timeout: 120000 });
async function dropLeftoverDbs() {
  const r = await mysql("SHOW DATABASES LIKE 'panel\\_proba\\_%'");
  if (!r.ok) return;
  for (const n of r.out.split('\n').map((x) => x.trim()).filter((x) => TMP_DB.test(x))) await mysql(`DROP DATABASE \`${n}\``);
}
const sec = (ms) => ms < 60e3 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60e3)} min`;
const nf = (n) => Number(n).toLocaleString('pl-PL');
const gb = (n) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(n / 1048576))} MB`;
function freeBytes(dir) { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } }
function sha1File(f) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1'); let n = 0;
    fs.createReadStream(f).on('data', (c) => { n += c.length; h.update(c); }).on('error', reject).on('end', () => resolve({ hash: h.digest('hex'), size: n }));
  });
}
function isSqlite(f) {
  try { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); return b.toString('latin1') === 'SQLite format 3\0'; } catch { return false; }
}
async function sqliteCheck(f) {
  const r = await run('sqlite3', ['-readonly', f, 'PRAGMA integrity_check;', "SELECT count(*) FROM sqlite_master WHERE type='table';"], { timeout: 300000 });
  const lines = r.out.trim().split('\n');
  return { ok: r.ok && lines[0] === 'ok', tables: Number(lines[lines.length - 1]) || 0, msg: r.ok ? lines.slice(0, 3).join('; ') : (r.err || '').trim().split('\n')[0] };
}

/* ------------------------------------------------------------------ próba */

/** Bazy MariaDB: każdy zrzut wczytany do osobnej, tymczasowej bazy; liczba tabel musi się zgadzać ze zrzutem. */
async function checkMaria(files, say) {
  const list = files.filter((f) => f.kind === 'db' && /^[A-Za-z0-9_]+_\d{4}-\d{2}-\d{2}_\d{4}\.sql\.gz$/.test(f.name) && !/^(pg|mongo|sqlite)-/.test(f.name))
    .map((f) => ({ ...f, db: f.name.replace(/_\d{4}-\d{2}-\d{2}_\d{4}\.sql\.gz$/, '') })).filter((f) => !SKIP_DB.has(f.db));
  if (!list.length) return null;
  const t0 = Date.now();
  const alive = await mysql('SELECT 1');
  const parts = [];
  for (const f of list) {
    say(`▸ baza ${f.db}: wczytuję zrzut do tymczasowej bazy…\n`);
    const p = { name: f.db, k: 'ok', text: '' };
    parts.push(p);
    if (!(await run('gzip', ['-t', f.path], { timeout: 600000 })).ok) { p.k = 'bad'; p.text = 'plik kopii jest uszkodzony (gzip)'; continue; }
    const head = await run('bash', ['-c', 'gunzip -c "$1" | tail -n 1; gunzip -c "$1" | grep -c "^CREATE TABLE"', 'x', f.path], { timeout: 600000 });
    const [lastLine = '', created = '0'] = head.out.trim().split('\n');
    if (!/Dump completed/.test(lastLine)) { p.k = 'bad'; p.text = 'zrzut jest ucięty — brak końcówki „Dump completed”'; continue; }
    const want = Number(created) || 0;
    if (!alive.ok) { p.k = 'warn'; p.text = `plik cały (${want} tabel), ale MariaDB nie działa — nie wczytałem`; continue; }
    const tmp = 'panel_proba_' + crypto.randomBytes(3).toString('hex');
    try {
      const c = await mysql(`CREATE DATABASE \`${tmp}\` CHARACTER SET utf8mb4`);
      if (!c.ok) { p.k = 'warn'; p.text = 'nie mogę założyć tymczasowej bazy: ' + c.err.trim().split('\n')[0]; continue; }
      // zrzut jednej bazy nie ma USE/CREATE DATABASE, ale gdyby miał — wycinamy, żeby nic nie trafiło do prawdziwej bazy
      const imp = await run('bash', ['-c', 'set -o pipefail; gunzip -c "$1" | sed -E "/^(USE|CREATE DATABASE|DROP DATABASE)[[:space:]]/Id" | mysql --default-character-set=utf8mb4 "$2"', 'x', f.path, tmp], { timeout: 1800000 });
      if (!imp.ok) { p.k = 'bad'; p.text = 'nie wczytuje się: ' + (imp.err.trim().split('\n').find((l) => /ERROR/.test(l)) || imp.err.trim().split('\n')[0] || 'błąd').slice(0, 200); continue; }
      const tabs = (await mysql(`SELECT table_name FROM information_schema.tables WHERE table_schema='${tmp}' AND table_type='BASE TABLE'`)).out.split('\n').map((x) => x.trim()).filter(Boolean);
      let rows = 0;
      for (let i = 0; i < tabs.length; i += 50) {
        const sql = tabs.slice(i, i + 50).map((t) => `SELECT COUNT(*) c FROM \`${t.replace(/`/g, '``')}\``).join(' UNION ALL ');
        const r = await mysql(`SELECT SUM(c) FROM (${sql}) x`, tmp);
        rows += Number(r.out.trim()) || 0;
      }
      if (tabs.length !== want) { p.k = 'bad'; p.text = `wczytało się ${tabs.length} z ${want} tabel`; continue; }
      p.tables = tabs.length; p.rows = rows;
      p.text = want ? `${want} ${want === 1 ? 'tabela' : 'tabel'}, ${nf(rows)} wierszy` : 'pusta baza (0 tabel)';
    } finally {
      await mysql(`DROP DATABASE IF EXISTS \`${tmp}\``);
    }
  }
  const bad = parts.filter((x) => x.k === 'bad'), warn = parts.filter((x) => x.k === 'warn');
  const okN = parts.length - bad.length - warn.length;
  const tables = parts.reduce((a, x) => a + (x.tables || 0), 0), rows = parts.reduce((a, x) => a + (x.rows || 0), 0);
  return {
    k: bad.length ? 'bad' : warn.length ? 'warn' : 'ok', title: `Bazy MariaDB — ${okN} z ${parts.length}`,
    detail: bad.length ? bad.map((x) => `${x.name}: ${x.text}`).join(' · ') : warn.length ? warn.map((x) => `${x.name}: ${x.text}`).join(' · ')
      : `wczytane do tymczasowej bazy, liczba tabel się zgadza · ${nf(tables)} tabel, ${nf(rows)} wierszy · ${sec(Date.now() - t0)}`,
    parts,
  };
}

/** Bazy innych silników: SQLite odtwarzana z .dump i sprawdzana; PostgreSQL i MongoDB — cały plik i znacznik końca. */
async function checkEngines(files, work, say) {
  const out = [];
  for (const f of files.filter((x) => x.kind === 'db' && /^(pg|mongo|sqlite)-/.test(x.name) && !/przed-/.test(x.name))) {
    const kind = f.name.split('-')[0];
    const name = f.name.replace(/^(pg|mongo|sqlite)-/, '').replace(/_\d{4}-\d{2}-\d{2}_\d{4}.*$/, '');
    say(`▸ ${f.label}…\n`);
    const gz = await run('gzip', ['-t', f.path], { timeout: 600000 });
    if (!gz.ok) { out.push({ k: 'bad', title: f.label, detail: 'plik kopii jest uszkodzony (gzip)' }); continue; }
    if (kind === 'sqlite') {
      const dbf = path.join(work, `sqlite-${name}.db`);
      const r = await run('bash', ['-c', 'set -o pipefail; gunzip -c "$1" | sqlite3 "$2"', 'x', f.path, dbf], { timeout: 600000 });
      const c = r.ok ? await sqliteCheck(dbf) : { ok: false, msg: r.err.trim().split('\n')[0] };
      out.push(c.ok ? { k: 'ok', title: f.label, detail: `odtworzona w tymczasowym pliku, spójna · ${c.tables} tabel` } : { k: 'bad', title: f.label, detail: 'nie odtwarza się: ' + c.msg });
      fs.rmSync(dbf, { force: true });
    } else if (kind === 'pg') {
      const t = await run('bash', ['-c', 'gunzip -c "$1" | tail -n 5', 'x', f.path], { timeout: 600000 });
      out.push(/database dump complete/i.test(t.out) ? { k: 'ok', title: f.label, detail: 'plik cały, zrzut kompletny (bez wczytywania)' } : { k: 'bad', title: f.label, detail: 'zrzut jest ucięty' });
    } else out.push({ k: 'ok', title: f.label, detail: 'archiwum całe (sumy kontrolne gzip się zgadzają)' });
  }
  return out;
}

/** Archiwa kodu i danych: całe przeczytane (gzip sprawdza sumy), bazy SQLite ze środka rozpakowane i sprawdzone. */
async function checkArchives(files, work, say) {
  const out = [];
  for (const f of files.filter((x) => x.kind === 'code' && x.name.endsWith('.tar.gz'))) {
    say(`▸ ${f.label}: czytam całe archiwum…\n`);
    const t0 = Date.now();
    const ls = await run('tar', ['-tvzf', f.path], { timeout: 1800000, maxBuffer: 256 * 1024 * 1024 });
    if (!ls.ok) { out.push({ k: 'bad', title: archLabel(f), detail: 'archiwum jest uszkodzone: ' + (ls.err.trim().split('\n').pop() || '').slice(0, 160) }); continue; }
    const entries = ls.out.split('\n').filter(Boolean).map((l) => { const m = l.match(/^(\S)\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.*)$/); return m ? { type: m[1], size: Number(m[2]), name: m[3].replace(/ -> .*$/, '') } : null; }).filter(Boolean);
    const filesN = entries.filter((e) => e.type === '-').length;
    const cands = entries.filter((e) => e.type === '-' && e.size > 0 && /\.(sqlite3?|db)$/i.test(e.name) && !/node_modules\//.test(e.name)).slice(0, 12);
    const notes = [];
    let bad = '';
    const need = cands.reduce((a, e) => a + e.size, 0);
    if (cands.length && need + 300 * 1048576 > freeBytes(work)) notes.push(`bazy w środku pominięte — za mało miejsca (${gb(need)})`);
    else if (cands.length) {
      const dir = path.join(work, 'tar-' + crypto.randomBytes(3).toString('hex'));
      fs.mkdirSync(dir);
      const x = await run('tar', ['-xzf', f.path, '-C', dir, '--', ...cands.map((e) => e.name)], { timeout: 1800000 });
      if (!x.ok) notes.push('nie udało się rozpakować baz ze środka');
      for (const e of cands) {
        const p = path.join(dir, e.name);
        if (!fs.existsSync(p) || !isSqlite(p)) continue;
        const c = await sqliteCheck(p);
        if (c.ok) notes.push(`baza ${path.basename(e.name)} spójna (${c.tables} tabel)`);
        else bad = `baza ${path.basename(e.name)} jest uszkodzona: ${c.msg}`;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    out.push(bad ? { k: 'bad', title: archLabel(f), detail: bad } : { k: 'ok', title: archLabel(f), detail: [`archiwum całe, ${nf(filesN)} plików, sumy się zgadzają`, ...notes].join(' · ') + ` · ${sec(Date.now() - t0)}` });
  }
  return out;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** „gibcord (kod + dane)” → „GibCord (kod + dane)” — nazwy aplikacji z konfiguracji panelu, jeśli są. */
function archLabel(f) {
  const what = f.name.replace(/_\d{4}-\d{2}-\d{2}_\d{4}.*$/, '');
  const apps = C().aplikacje || {};
  const a = apps[what] || Object.values(apps).find((x) => String(x?.[0] || '').toLowerCase().replace(/\s+/g, '-') === what);
  const name = a?.[0] || (what === 'gibcord' && C().gibcord ? 'GibCord' : null);
  return name ? f.label.replace(what, name) : cap(f.label);
}

function walk(dir, acc, limit) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    if (acc.length >= limit) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc, limit);
    else if (e.isFile()) acc.push(p);
  }
}
/** Migawka przesłanych plików: próbka (albo wszystko) przeczytana do końca; pliki niezmienione od kopii muszą mieć tę samą treść co oryginał. */
async function checkMedia(snaps, full, say) {
  const snap = snaps[0];
  if (!snap) return null;
  const live = new Map(D.backupSettings().mediaDirs.map((d) => [d.replace(/^\/var\/www\//, '').replace(/\//g, '_'), d]));
  const all = [];
  walk(snap.path, all, 2_000_000);
  if (!all.length) return { k: 'ok', title: `Migawka plików ${snap.name}`, detail: 'pusta — nic do sprawdzenia' };
  const pick = full ? all : all.sort(() => Math.random() - 0.5).slice(0, 300);
  say(`▸ migawka ${snap.name}: czytam ${full ? 'wszystkie' : 'losowe'} ${nf(pick.length)} z ${nf(all.length)} plików…\n`);
  const t0 = Date.now();
  let size = 0, same = 0, compared = 0;
  const broken = [];
  for (const [i, f] of pick.entries()) {
    try {
      const st = fs.statSync(f);
      const r = await sha1File(f);
      size += r.size;
      if (r.size !== st.size) { broken.push(path.relative(snap.path, f) + ' (ucięty)'); continue; }
      const rel = path.relative(snap.path, f);
      const [part, ...rest] = rel.split(path.sep);
      const orig = live.get(part) && path.join(live.get(part), ...rest);
      const os = orig && fs.statSync(orig, { throwIfNoEntry: false });
      if (os && os.size === st.size && Math.abs(os.mtimeMs - st.mtimeMs) < 1000) {
        compared++;
        if ((await sha1File(orig)).hash === r.hash) same++;
        else broken.push(rel + ' (inna treść niż oryginał)');
      }
    } catch (e) { broken.push(path.relative(snap.path, f) + ` (${e.code || 'błąd odczytu'})`); }
    if (full && i && i % 2000 === 0) say(`  … ${nf(i)} z ${nf(pick.length)}\n`);
  }
  const what = full ? `wszystkie ${nf(pick.length)} plików (${gb(size)})` : `próbka ${nf(pick.length)} z ${nf(all.length)} plików`;
  if (broken.length) return { k: 'bad', title: `Migawka plików ${snap.name}`, detail: `${broken.length} uszkodzonych: ${broken.slice(0, 3).join(', ')}${broken.length > 3 ? '…' : ''}` };
  return { k: 'ok', title: `Migawka plików ${snap.name}`, detail: `${what} — wszystkie czytelne${compared ? `, ${nf(same)} porównanych z oryginałem` : ''} · ${sec(Date.now() - t0)}` };
}

/** Cała próba. Zwraca wynik (zapisany w historii); rzuca tylko, gdy nie ma czego sprawdzać. */
export async function runTest(say, { full = false } = {}) {
  const t0 = Date.now();
  const all = D.backupFiles();
  const g = all.groups[0];
  if (!g) throw new Error('Nie ma jeszcze żadnej nocnej kopii do sprawdzenia.');
  fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
  if (freeBytes(TMP) < 500 * 1048576) throw new Error('Za mało miejsca na dysku na próbę (potrzeba co najmniej 0,5 GB wolnego).');
  say(`Kopia z ${new Date(g.time).toLocaleString('pl-PL')} · ${g.files.length} plików\nWszystko dzieje się w osobnej bazie i osobnym folderze — prawdziwe strony nic nie czują.\n\n`);
  const work = fs.mkdtempSync(path.join(TMP, 'proba-'));
  const items = [];
  const push = (x) => { if (!x) return; items.push(x); say(`${x.k === 'ok' ? '✓' : x.k === 'warn' ? '⚠' : '✗'} ${x.title} — ${x.detail}\n\n`); };
  try {
    push(await checkMaria(g.files, say));
    for (const x of await checkEngines(g.files, work, say)) push(x);
    for (const x of await checkArchives(g.files, work, say)) push(x);
    push(await checkMedia(all.snaps, full, say));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const level = items.some((x) => x.k === 'bad') ? 'bad' : items.some((x) => x.k === 'warn') ? 'warn' : 'ok';
  const day = new Date(g.time); const today = new Date();
  const fromNight = day.toDateString() === today.toDateString() && day.getHours() < 8;
  const which = fromNight ? 'Kopia z nocy' : `Kopia z ${day.getDate()}.${String(day.getMonth() + 1).padStart(2, '0')}`;
  const title = level === 'bad' ? `${which} nie odtwarza się w całości` : level === 'warn' ? `${which} działa, z uwagami` : `${which} działa`;
  const took = Date.now() - t0;
  const id = db.prepare('INSERT INTO proba_kopii(ts,took,level,kopia,full,title,items) VALUES(?,?,?,?,?,?,?)').run(Date.now(), took, level, g.time, full ? 1 : 0, title, JSON.stringify(items.map(({ parts, ...x }) => ({ ...x, ...(parts ? { parts } : {}) })))).lastInsertRowid;
  db.prepare('DELETE FROM proba_kopii WHERE id < ?').run(Number(id) - 60);
  say(`${level === 'bad' ? '✗' : '✓'} ${title} · trwało ${sec(took)}\n`);
  return { ...last(), id: Number(id) };
}
