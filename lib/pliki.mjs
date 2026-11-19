// Strażnik plików stron: co godzinę porównuje pliki wykonywalne stron (.php, .js, .htaccess…) z tym, co widział
// ostatnio. Zmiany zrobione przez panel albo GitHub są „znane” (panel zapowiada je przez expect()); każda inna
// zmiana trafia do Ciebie z podglądem i decyzją: usuń, przywróć z nocnej kopii albo „to ja — zostaw”.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import * as S from './system.mjs';
import * as D from './data.mjs';
import { run, stamp } from './util.mjs';

let db, QDIR, TMP;
const EXT = /\.(php\d?|phtml|phar|inc|js|mjs)$|(^|\/)(\.htaccess|\.user\.ini)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', '.svn', '.cache']);
const CACHE_DIR = /(^|\/)(cache|caches|templates_c|tmp|temp|sessions|wp-content\/cache)\//i;
const UPLOAD_DIR = /(^|\/)(uploads?|images?|img|media|files|pliki|zdjecia)\//i;
const MAX_FILES = 60000;
const RULES = [
  [/\beval\s*\(\s*(base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev|hex2bin)\s*\(/i, 'eval(…) na zaszyfrowanym kodzie'],
  [/\b(assert|eval|system|exec|shell_exec|passthru|popen|proc_open|create_function)\s*\(\s*(@\s*)?\$_(GET|POST|REQUEST|COOKIE|SERVER|FILES)\b/i, 'wykonuje to, co przyjdzie z zewnątrz'],
  [/preg_replace\s*\(\s*(['"]).{1,200}\/[a-z]*e[a-z]*\1/i, 'preg_replace z flagą /e (wykonanie kodu)'],
  [/\$_(GET|POST|REQUEST|COOKIE)\s*\[[^\]]{1,40}\]\s*\)\s*\(/i, 'wywołuje funkcję o nazwie z zapytania'],
  [/\b(FilesMan|WSOsetcookie|c99shell|r57shell|b374k|IndoXploit|AnonymousFox|Alfa-?Shell)\b/i, 'znana nazwa powłoki hakerskiej'],
  [/base64_decode\s*\(\s*['"][A-Za-z0-9+/=]{600,}/, 'długi zaszyfrowany blok kodu'],
  [/(\\x[0-9a-f]{2}){60,}/i, 'kod ukryty w zapisie szesnastkowym'],
  [/\bauto_prepend_file\b/i, 'dokleja kod do każdej strony (auto_prepend_file)'],
  [/(AddHandler|SetHandler|AddType)\s+[^\n]*(php|x-httpd)/i, 'każe wykonywać inne pliki jako PHP'],
];

export function init(database, dataDir) {
  db = database;
  QDIR = path.join(dataDir, 'kwarantanna');
  TMP = path.join(dataDir, 'tmp');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pliki_straz(site TEXT, path TEXT, size INTEGER, mtime INTEGER, ctime INTEGER, hash TEXT, PRIMARY KEY(site, path));
    CREATE TABLE IF NOT EXISTS pliki_strony(site TEXT PRIMARY KEY, root TEXT, files INTEGER, scanned INTEGER, base INTEGER);
    CREATE TABLE IF NOT EXISTS pliki_zmiany(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, site TEXT, root TEXT, path TEXT, kind TEXT, size INTEGER, hash TEXT, why TEXT, bad TEXT, status TEXT, by TEXT, done INTEGER, qpath TEXT);
    CREATE TABLE IF NOT EXISTS pliki_oczekiwane(site TEXT, start INTEGER, end INTEGER, by TEXT, why TEXT);
  `);
}

export function settings() {
  let v = {};
  try { v = JSON.parse(db.prepare("SELECT v FROM ustawienia WHERE k='pliki'").get()?.v || '{}'); } catch {}
  return { on: v.on !== false, off: Array.isArray(v.off) ? v.off : [] };
}
export function saveSettings({ on, site, watch }) {
  const s = settings();
  if (on != null) s.on = !!on;
  if (site) { s.off = s.off.filter((x) => x !== site); if (watch === false) s.off.push(site); }
  db.prepare("INSERT OR REPLACE INTO ustawienia(k,v) VALUES('pliki',?)").run(JSON.stringify(s));
  return s;
}

/** Panel zapowiada zmianę plików strony (zapis w menedżerze plików, wdrożenie z GitHuba…) — takie zmiany nie alarmują. */
export function expect(site, by, why, ms = 20 * 60e3) {
  if (!db || !site) return;
  const now = Date.now();
  db.prepare('INSERT INTO pliki_oczekiwane(site,start,end,by,why) VALUES(?,?,?,?,?)').run(site, now - 5000, now + ms, String(by || ''), String(why || ''));
  db.prepare('DELETE FROM pliki_oczekiwane WHERE end < ?').run(now - 3 * 864e5);
}
/** Dłuższe zadanie (wdrożenie) kończy się później, niż zakładało okno — przedłużamy je do teraz. */
export function expectDone(site) {
  if (!db || !site) return;
  db.prepare('UPDATE pliki_oczekiwane SET end=max(end, ?) WHERE site=? AND start > ?').run(Date.now() + 60e3, site, Date.now() - 3 * 3600e3);
}

/** Strony z katalogiem na dysku (bez samych przekierowań i aplikacji za proxy bez plików). */
function watchedSites() {
  const off = new Set(settings().off);
  // test: PLIKI_SITES="nazwa=/katalog;nazwa2=/katalog2" zamiast stron z Apache
  const conf = process.env.PLIKI_SITES ? process.env.PLIKI_SITES.split(';').filter(Boolean).map((x) => { const [name, root] = x.split('='); return { name, root }; }) : S.siteConfigs();
  // dwie nazwy na ten sam katalog (np. stary i nowy adres) liczymy raz — pod nazwą, która nie jest przekierowaniem
  const list = conf.filter((s) => s.root && s.root.startsWith('/') && fs.existsSync(s.root)).map((s) => ({ name: s.name, root: fs.realpathSync(s.root), proxy: !!s.proxies?.length }));
  const byRoot = new Map();
  for (const x of list) { if (!byRoot.has(x.root)) byRoot.set(x.root, []); byRoot.get(x.root).push(x); }
  return [...byRoot.values()].map((l) => { const main = l.find((x) => x.proxy) || l[0]; return { name: main.name, names: l.map((x) => x.name), root: main.root, watch: !l.some((x) => off.has(x.name)) }; });
}

function walk(root) {
  const out = [];
  const go = (dir, rel) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (out.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) go(path.join(dir, e.name), r); }
      else if (e.isFile() && EXT.test(r)) out.push(r);
    }
  };
  go(root, '');
  return out;
}
function sha1(f) { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } }
/** Czy treść wygląda groźnie — zwraca opis albo ''. */
export function suspicious(rel, content) {
  const ext = path.extname(rel).toLowerCase();
  if (/^\.(php\d?|phtml|phar)$/.test(ext) && UPLOAD_DIR.test(rel)) {
    const r = RULES.find(([re]) => re.test(content));
    return r ? `${r[1]} — w folderze na przesyłane pliki` : 'plik PHP w folderze na przesyłane pliki';
  }
  for (const [re, why] of RULES) if (re.test(content)) return why;
  return '';
}
function readHead(f, max = 2 * 1024 * 1024) {
  try { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); return b.toString('latin1'); } catch { return ''; }
}

/** Skanuje jedną stronę. Pierwszy raz tylko zapamiętuje stan (bez alarmów). Zwraca nowe, nieznane zmiany. */
function scanSite(site, root, names = [site]) {
  const now = Date.now();
  const known = new Map(db.prepare('SELECT path,size,mtime,ctime,hash FROM pliki_straz WHERE site=?').all(site).map((r) => [r.path, r]));
  const info = db.prepare('SELECT * FROM pliki_strony WHERE site=?').get(site);
  const first = !info || info.root !== root;
  if (first && info) { db.prepare('DELETE FROM pliki_straz WHERE site=?').run(site); known.clear(); }
  const windows = db.prepare(`SELECT start,end,by,why FROM pliki_oczekiwane WHERE site IN (${names.map(() => '?').join(',')}) AND end > ?`).all(...names, (info?.scanned || now) - 3 * 3600e3);
  const expected = (t) => windows.find((w) => t >= w.start && t <= w.end);
  const files = walk(root);
  const put = db.prepare('INSERT OR REPLACE INTO pliki_straz(site,path,size,mtime,ctime,hash) VALUES(?,?,?,?,?,?)');
  const addChange = db.prepare('INSERT INTO pliki_zmiany(ts,site,root,path,kind,size,hash,why,bad,status,by) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const fresh = [];
  const changes = [];
  db.exec('BEGIN');
  try {
    for (const rel of files) {
      const f = path.join(root, rel);
      let st; try { st = fs.lstatSync(f); } catch { continue; }
      const k = known.get(rel);
      known.delete(rel);
      if (k && k.size === st.size && k.mtime === Math.round(st.mtimeMs) && k.ctime === Math.round(st.ctimeMs)) continue;
      const hash = sha1(f);
      put.run(site, rel, st.size, Math.round(st.mtimeMs), Math.round(st.ctimeMs), hash);
      if (first || (k && k.hash === hash)) continue;
      changes.push({ rel, kind: k ? 'zmieniony' : 'nowy', size: st.size, hash, t: Math.max(st.mtimeMs, st.ctimeMs), content: readHead(f) });
    }
    for (const rel of known.keys()) {
      db.prepare('DELETE FROM pliki_straz WHERE site=? AND path=?').run(site, rel);
      if (!first) changes.push({ rel, kind: 'usuniety', size: 0, hash: '', t: now, content: '' });
    }
    // wiele plików jednej wtyczki/motywu naraz, bez niczego groźnego — to zwykle jej aktualizacja
    const groups = new Map();
    for (const c of changes) { const m = c.rel.match(/^(.*?wp-content\/(plugins|themes)\/[^/]+)\//) || c.rel.match(/^(wp-admin|wp-includes)\//); if (m) { const g = m[1].startsWith('wp-') && !m[1].includes('/') ? 'wordpress' : m[1]; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); } }
    const wpCore = changes.some((c) => /(^|\/)wp-includes\/version\.php$/.test(c.rel));
    for (const c of changes) {
      const bad = c.kind === 'usuniety' ? '' : suspicious(c.rel, c.content);
      const w = expected(c.t);
      let status = 'nowa', by = '', why = '';
      if (!bad && w) { status = 'znana'; by = w.by; why = w.why; }
      else if (!bad && CACHE_DIR.test(c.rel)) { status = 'znana'; why = 'pliki tymczasowe (cache)'; }
      else if (!bad && wpCore && (/^(wp-admin|wp-includes)\//.test(c.rel) || /^wp-[a-z-]+\.php$/.test(c.rel))) { status = 'znana'; why = 'aktualizacja WordPressa'; }
      else if (!bad) { const g = [...groups.entries()].find(([, l]) => l.includes(c)); if (g && g[0] !== 'wordpress' && g[1].length >= 3 && g[1].every((x) => !suspicious(x.rel, x.content))) { status = 'znana'; why = `aktualizacja ${g[0].includes('/themes/') ? 'motywu' : 'wtyczki'} ${g[0].split('/').pop()}`; } }
      const id = addChange.run(now, site, root, c.rel, c.kind, c.size, c.hash, why, bad, status, by).lastInsertRowid;
      if (status === 'nowa') fresh.push({ id: Number(id), site, path: c.rel, kind: c.kind, bad });
    }
    db.prepare('INSERT OR REPLACE INTO pliki_strony(site,root,files,scanned,base) VALUES(?,?,?,?,?)').run(site, root, files.length, now, first ? now : (info?.base || now));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  db.prepare('DELETE FROM pliki_zmiany WHERE ts < ? AND status <> ?').run(now - 90 * 864e5, 'nowa');
  return fresh;
}

let busy = false;
/** Skan wszystkich pilnowanych stron. Zwraca nowe, nieznane zmiany (do alarmu). */
export async function scan({ only } = {}) {
  if (busy) return [];
  busy = true;
  try {
    const s = settings();
    if (!s.on && !only) return [];
    const out = [];
    const sites = watchedSites().filter((x) => x.watch && (!only || x.names.includes(only)));
    for (const x of sites) { out.push(...scanSite(x.name, x.root, x.names)); await new Promise((r) => setImmediate(r)); }
    // strony, których już nie ma albo przestały być pilnowane — zapominamy ich stan
    const names = new Set(sites.map((x) => x.name));
    if (!only) for (const r of db.prepare('SELECT site FROM pliki_strony').all()) if (!names.has(r.site)) { db.prepare('DELETE FROM pliki_strony WHERE site=?').run(r.site); db.prepare('DELETE FROM pliki_straz WHERE site=?').run(r.site); }
    return out;
  } finally { busy = false; }
}

const rowOut = (r) => ({ id: r.id, ts: r.ts, site: r.site, path: r.path, kind: r.kind, size: r.size, why: r.why, bad: r.bad, status: r.status, by: r.by, done: r.done });
export function status() {
  const s = settings();
  const st = new Map(db.prepare('SELECT * FROM pliki_strony').all().map((r) => [r.site, r]));
  const sites = watchedSites().map((x) => {
    const r = st.get(x.name);
    const lastC = db.prepare("SELECT ts,status,by,why FROM pliki_zmiany WHERE site=? ORDER BY id DESC LIMIT 1").get(x.name);
    return { name: x.name, also: x.names.filter((n) => n !== x.name), root: x.root, watch: x.watch, files: r?.files ?? null, scanned: r?.scanned || null, since: r?.base || null, last: lastC || null };
  });
  const open = db.prepare("SELECT * FROM pliki_zmiany WHERE status='nowa' ORDER BY (bad<>'') DESC, id DESC LIMIT 200").all().map(rowOut);
  const history = db.prepare("SELECT * FROM pliki_zmiany WHERE status<>'nowa' ORDER BY id DESC LIMIT 40").all().map(rowOut);
  return { settings: s, sites, open, history };
}
export function openCounts() {
  const r = db.prepare("SELECT count(*) n, sum(bad<>'') b FROM pliki_zmiany WHERE status='nowa'").get();
  return { open: r.n || 0, bad: r.b || 0 };
}

function change(id) {
  const r = db.prepare('SELECT * FROM pliki_zmiany WHERE id=?').get(Number(id));
  if (!r) throw new Error('Nie ma takiej zmiany.');
  return r;
}
function inside(root, rel) {
  const f = path.resolve(root, rel);
  if (!f.startsWith(root + '/')) throw new Error('Nieprawidłowa ścieżka.');
  return f;
}
/** Najnowsze archiwum kodu stron z nocnej kopii, w którym jest ten plik. */
async function fromBackup(f) {
  if (!f.startsWith('/var/www/')) return null;
  const member = f.slice(1);
  const g = D.backupFiles().groups.map((x) => x.files.find((y) => /^www_\d{4}-\d{2}-\d{2}_\d{4}\.tar\.gz$/.test(y.name))).filter(Boolean);
  for (const a of g.slice(0, 3)) {
    const buf = await new Promise((resolve) => execFile('tar', ['-xzOf', a.path, '--', member], { timeout: 300000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, out) => resolve(err ? null : out)));
    if (buf) return { buf, from: a.name, time: a.time };
  }
  return null;
}

/** Podgląd: nowy plik — początek treści; zmieniony — różnice względem nocnej kopii (jeśli jest). */
export async function preview(id) {
  const r = change(id);
  const f = inside(r.root, r.path);
  const lines = (txt) => txt.split('\n').slice(0, 80).map((l) => l.slice(0, 220));
  if (r.kind === 'usuniety') { const b = await fromBackup(f); return { kind: 'usuniety', note: b ? `Plik jest w kopii z ${new Date(b.time).toLocaleString('pl-PL')} — można go przywrócić.` : 'Pliku nie ma w nocnych kopiach.', lines: b ? lines(b.buf.toString('utf8')) : [] }; }
  const now = readHead(f, 200 * 1024);
  if (r.kind === 'zmieniony') {
    const b = await fromBackup(f);
    if (b) {
      fs.mkdirSync(TMP, { recursive: true });
      const old = path.join(TMP, `pliki-${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(old, b.buf, { mode: 0o600 });
      const d = await run('diff', ['-u', '--label', 'kopia', '--label', 'teraz', old, f], { timeout: 20000 });
      fs.rmSync(old, { force: true });
      const diff = d.out.split('\n').slice(2, 160).map((l) => l.slice(0, 220));
      return { kind: 'diff', note: `Różnice względem kopii z ${new Date(b.time).toLocaleString('pl-PL')}`, lines: diff.length ? diff : ['(bez różnic względem kopii)'] };
    }
  }
  return { kind: 'tresc', note: r.kind === 'nowy' ? 'Początek nowego pliku' : 'Początek pliku (w kopii nie ma poprzedniej wersji)', lines: lines(now), bad: r.bad };
}

/** Decyzja: zostaw (to ja) / usun (do kwarantanny) / przywroc (z nocnej kopii). */
export async function act(id, action, who) {
  const r = change(id);
  if (r.status !== 'nowa') throw new Error('Ta zmiana jest już załatwiona.');
  const f = inside(r.root, r.path);
  const mark = (status, extra = {}) => db.prepare('UPDATE pliki_zmiany SET status=?, by=?, done=?, qpath=? WHERE id=?').run(status, who, Date.now(), extra.qpath || null, r.id);
  if (action === 'zostaw') { mark('zaakceptowana'); return { message: 'Zostawione — więcej nie będę o to pytać.' }; }
  const quarantine = () => {
    if (!fs.existsSync(f)) return null;
    const q = path.join(QDIR, `${stamp()}-${String(Date.now()).slice(-5)}_${r.site}`, r.path);
    fs.mkdirSync(path.dirname(q), { recursive: true, mode: 0o700 });
    try { fs.renameSync(f, q); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(f, q); fs.rmSync(f); }
    fs.chmodSync(q, 0o600);
    return q;
  };
  if (action === 'usun') {
    const q = quarantine();
    db.prepare('DELETE FROM pliki_straz WHERE site=? AND path=?').run(r.site, r.path);
    mark('usunieta', { qpath: q });
    return { message: q ? 'Plik przeniesiony do kwarantanny panelu (można go odzyskać z Dziennika zmian).' : 'Pliku już nie było.', qpath: q, file: f, site: r.site };
  }
  if (action === 'przywroc') {
    const b = await fromBackup(f);
    if (!b) throw new Error('Tego pliku nie ma w nocnych kopiach — możesz go tylko usunąć albo zostawić.');
    const st = fs.existsSync(f) ? fs.statSync(f) : fs.statSync(path.dirname(f));
    const q = quarantine();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, b.buf, { mode: 0o644 });
    try { fs.chownSync(f, st.uid, st.gid); } catch {}
    const ns = fs.statSync(f);
    db.prepare('INSERT OR REPLACE INTO pliki_straz(site,path,size,mtime,ctime,hash) VALUES(?,?,?,?,?,?)').run(r.site, r.path, ns.size, Math.round(ns.mtimeMs), Math.round(ns.ctimeMs), sha1(f));
    mark('przywrocona', { qpath: q });
    return { message: `Przywrócone z kopii ${b.from}.`, qpath: q, file: f, site: r.site };
  }
  throw new Error('Nieznana decyzja.');
}
/** Cofnięcie z Dziennika zmian: plik z kwarantanny wraca na miejsce. */
export function undoQuarantine(qpath, file) {
  if (!qpath || !qpath.startsWith(QDIR + '/') || !fs.existsSync(qpath)) throw new Error('Pliku nie ma już w kwarantannie.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, qpath + '.przywrocony-' + Date.now());
  fs.copyFileSync(qpath, file);
  fs.rmSync(qpath);
  try { const p = fs.statSync(path.dirname(file)); fs.chownSync(file, p.uid, p.gid); } catch {}
  fs.chmodSync(file, 0o644);
}
