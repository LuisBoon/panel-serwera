// Narzędzia jednej strony: pliki (przeglądanie, edycja, wgrywanie), wersje (zrzut przed każdą zmianą
// i przywracanie), aktualizacja z GitHuba (klucz tylko do odczytu + webhook), hasło na stronę i przerwa techniczna.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, spawnCollect, readText, exists, stamp } from './util.mjs';
import * as S from './system.mjs';
import * as C from './create.mjs';

let db, DATA_DIR, PUBLIC_URL;
const AV = '/etc/apache2/sites-available';
const INC = '/etc/apache2/panel-serwera';
const ROOT_OK = /^\/(var\/www|opt|srv)\/[^/]+/;
const ROOT_DENY = /^\/(opt\/panel-serwera|var\/www\/panel-acme)(\/|$)/;
const EXCLUDE = ['node_modules', '.git', 'uploads', 'cache', 'tmp', 'logs', '*.log', 'sessions', '.cache', 'storage/logs', 'storage/framework/cache', 'storage/framework/sessions'];
const SECRET = /(^\.env|config\.php$|wp-config|settings\.(php|py)$|secret|\.key$|\.pem$|credentials|passw|\.htpasswd$|id_(rsa|ed25519))/i;
const MAX_TEXT = 2 * 1024 * 1024;
const KEEP_VERSIONS = 10;
const KEEP_FILE_VERSIONS = 10;

export function init(database, dataDir, publicUrl) {
  db = database; DATA_DIR = dataDir; PUBLIC_URL = publicUrl;
  db.exec(`
    CREATE TABLE IF NOT EXISTS wersje(id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT, ts INTEGER, label TEXT, source TEXT, who TEXT, size INTEGER, file TEXT);
    CREATE TABLE IF NOT EXISTS git(site TEXT PRIMARY KEY, repo TEXT, branch TEXT, subdir TEXT, auto INTEGER, del INTEGER, secret TEXT, sha TEXT, msg TEXT, last INTEGER, status TEXT, err TEXT, hook TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS dodatki(site TEXT PRIMARY KEY, pass_on INTEGER, pass_user TEXT, maint_on INTEGER, maint_token TEXT, maint_text TEXT);
    CREATE TABLE IF NOT EXISTS kopie_testowe(site TEXT PRIMARY KEY, host TEXT, slug TEXT, db TEXT, testdb TEXT, files TEXT, created INTEGER, who TEXT, login TEXT, pass TEXT);
  `);
  for (const d of ['wersje', 'wersje-plikow', 'kosz', 'git']) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true, mode: 0o700 });
  setInterval(cleanTrash, 6 * 3600e3).unref();
}

/* ---------------------------------------------------------------- strona */

export const keyOf = (name) => String(name).toLowerCase().replace(/[^a-z0-9.-]/g, '').replace(/\./g, '_').slice(0, 80);

/** Informacje o stronie z konfiguracji Apache + rejestru panelu. */
export function siteInfo(name) {
  const s = S.siteConfigs().find((x) => x.name === name);
  if (!s) throw new Error('Nie ma takiej strony.');
  const made = C.list().find((r) => r.host === name);
  const roots = [];
  const add = (p, label) => { if (p && ROOT_OK.test(p) && !ROOT_DENY.test(p) && exists(p) && !roots.some((r) => r.path === p)) roots.push({ path: p, label }); };
  add(s.dir || s.root, 'pliki strony');
  if (s.root && s.dir && s.root !== s.dir) add(s.root, 'katalog publiczny');
  if (made?.app_dir) add(made.app_dir, 'kod aplikacji');
  const unit = made?.unit || null;
  return { name, key: keyOf(name), roots, root: roots[0]?.path || null, proxies: s.proxies, https: s.https, files: s.files, unit, made: made || null, kind: made?.kind || (s.proxies.length ? 'aplikacja' : s.root ? 'strona' : 'inna') };
}

/* ---------------------------------------------------------------- ścieżki */

function within(root, rel) {
  const clean = path.posix.normalize('/' + String(rel || '').replace(/\\/g, '/')).replace(/^\/+/, '');
  if (clean.split('/').includes('..')) throw new Error('Nieprawidłowa ścieżka.');
  const full = path.join(root, clean);
  const realRoot = fs.realpathSync(root);
  // istniejąca część ścieżki nie może prowadzić poza katalog strony (np. dowiązaniem)
  let probe = full;
  while (!exists(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('Ta ścieżka wychodzi poza katalog strony.');
  return { full, rel: clean };
}
function rootOf(info, which) {
  const r = info.roots.find((x) => x.path === which) || info.roots[0];
  if (!r) throw new Error('Ta strona nie ma katalogu z plikami (np. samo przekierowanie).');
  return r.path;
}
function isText(buf) { return !buf.subarray(0, 8000).includes(0); }
function ownerLike(p) { try { const st = fs.statSync(p); return { uid: st.uid, gid: st.gid }; } catch { return { uid: 33, gid: 33 }; } }

/* ----------------------------------------------------------------- pliki */

export function listDir(name, which, rel) {
  const info = siteInfo(name);
  const root = rootOf(info, which);
  const { full, rel: r } = within(root, rel);
  const st = fs.statSync(full);
  if (!st.isDirectory()) throw new Error('To nie jest folder.');
  const items = fs.readdirSync(full, { withFileTypes: true }).slice(0, 3000).map((d) => {
    let s = null; try { s = fs.statSync(path.join(full, d.name)); } catch {}
    const dir = s ? s.isDirectory() : d.isDirectory();
    return { name: d.name, dir, size: s && !dir ? s.size : null, mtime: s ? s.mtimeMs : null, link: d.isSymbolicLink(), secret: !dir && SECRET.test(d.name) };
  }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'pl'));
  return { site: name, root, roots: info.roots, rel: r, items };
}

export function readFile(name, which, rel) {
  const info = siteInfo(name);
  const { full, rel: r } = within(rootOf(info, which), rel);
  const st = fs.statSync(full);
  if (!st.isFile()) throw new Error('To nie jest plik.');
  const out = { site: name, rel: r, size: st.size, mtime: st.mtimeMs, secret: SECRET.test(path.basename(r)), text: null, binary: false, tooBig: false };
  if (st.size > MAX_TEXT) { out.tooBig = true; return out; }
  const buf = fs.readFileSync(full);
  if (!isText(buf)) { out.binary = true; return out; }
  out.text = buf.toString('utf8');
  out.history = fileHistory(info.key, r);
  return out;
}

function fileVersionsDir(key, rel) { return path.join(DATA_DIR, 'wersje-plikow', key, rel.replace(/\//g, '%')); }
function fileHistory(key, rel) {
  const d = fileVersionsDir(key, rel);
  try { return fs.readdirSync(d).sort().reverse().map((f) => ({ id: f, ts: Number(f.split('-')[0]), size: fs.statSync(path.join(d, f)).size })); } catch { return []; }
}
function keepFileVersion(key, rel, full) {
  if (!exists(full)) return;
  const d = fileVersionsDir(key, rel);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.copyFileSync(full, path.join(d, `${Date.now()}-${crypto.randomBytes(2).toString('hex')}`));
  const all = fs.readdirSync(d).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_FILE_VERSIONS))) fs.rmSync(path.join(d, f), { force: true });
}
/** Zapis atomowy z zachowaniem właściciela i uprawnień. */
function atomicWrite(full, data, like) {
  const st = exists(full) ? fs.statSync(full) : null;
  const own = st ? { uid: st.uid, gid: st.gid } : ownerLike(like || path.dirname(full));
  const tmp = path.join(path.dirname(full), `.panel-${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data, { mode: st ? st.mode & 0o7777 : 0o644 });
  try { fs.chownSync(tmp, own.uid, own.gid); } catch {}
  fs.renameSync(tmp, full);
}

export function writeFile(name, which, rel, text, expectMtime) {
  const info = siteInfo(name);
  const { full, rel: r } = within(rootOf(info, which), rel);
  if (exists(full)) {
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error('To nie jest plik.');
    if (expectMtime && Math.abs(st.mtimeMs - Number(expectMtime)) > 1) { const e = new Error('Ten plik zmienił się w międzyczasie (ktoś inny albo aplikacja go zapisała). Otwórz go ponownie.'); e.status = 409; throw e; }
    keepFileVersion(info.key, r, full);
  }
  if (Buffer.byteLength(String(text)) > MAX_TEXT) throw new Error('Plik jest za duży do edycji w przeglądarce.');
  if (!exists(path.dirname(full))) throw new Error('Nie ma takiego folderu.');
  atomicWrite(full, String(text));
  return { ok: true, mtime: fs.statSync(full).mtimeMs };
}

export function restoreFileVersion(name, which, rel, id) {
  const info = siteInfo(name);
  const { full, rel: r } = within(rootOf(info, which), rel);
  if (!/^\d+-[0-9a-f]{4}$/.test(id)) throw new Error('Nieprawidłowa wersja.');
  const src = path.join(fileVersionsDir(info.key, r), id);
  if (!exists(src)) throw new Error('Nie ma takiej wersji.');
  const data = fs.readFileSync(src);
  keepFileVersion(info.key, r, full);
  atomicWrite(full, data);
  return { ok: true };
}

export function fileVersionText(name, which, rel, id) {
  const info = siteInfo(name);
  const { rel: r } = within(rootOf(info, which), rel);
  if (!/^\d+-[0-9a-f]{4}$/.test(id)) throw new Error('Nieprawidłowa wersja.');
  const src = path.join(fileVersionsDir(info.key, r), id);
  const buf = fs.readFileSync(src);
  return isText(buf) ? buf.toString('utf8') : null;
}

const NAME_RE = /^[^/\\\0]{1,200}$/;
export function makeDir(name, which, rel, dirName) {
  if (!NAME_RE.test(dirName) || dirName === '.' || dirName === '..') throw new Error('Nieprawidłowa nazwa.');
  const info = siteInfo(name);
  const { full } = within(rootOf(info, which), path.posix.join(rel || '', dirName));
  if (exists(full)) throw new Error('Taki plik albo folder już jest.');
  const own = ownerLike(path.dirname(full));
  fs.mkdirSync(full, { mode: 0o755 });
  try { fs.chownSync(full, own.uid, own.gid); } catch {}
  return { ok: true };
}
export function newFile(name, which, rel, fileName) {
  if (!NAME_RE.test(fileName) || fileName === '.' || fileName === '..') throw new Error('Nieprawidłowa nazwa.');
  const info = siteInfo(name);
  const { full } = within(rootOf(info, which), path.posix.join(rel || '', fileName));
  if (exists(full)) throw new Error('Taki plik już jest.');
  atomicWrite(full, '');
  return { ok: true };
}
export function renameItem(name, which, rel, newName) {
  if (!NAME_RE.test(newName) || newName === '.' || newName === '..') throw new Error('Nieprawidłowa nazwa.');
  const info = siteInfo(name);
  const root = rootOf(info, which);
  const a = within(root, rel);
  if (!a.rel) throw new Error('Nie można zmienić nazwy katalogu strony.');
  const b = within(root, path.posix.join(path.posix.dirname(a.rel), newName));
  if (exists(b.full)) throw new Error('Taka nazwa jest już zajęta.');
  fs.renameSync(a.full, b.full);
  return { ok: true };
}
/** Usuwanie = przeniesienie do kosza panelu (14 dni). */
export function trashItem(name, which, rel) {
  const info = siteInfo(name);
  const { full, rel: r } = within(rootOf(info, which), rel);
  if (!r) throw new Error('Nie można usunąć całego katalogu strony.');
  if (!exists(full)) throw new Error('Nie ma takiego pliku.');
  const dest = path.join(DATA_DIR, 'kosz', info.key, `${stamp()}-${crypto.randomBytes(2).toString('hex')}`, r);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(full, dest); }
  catch { fs.cpSync(full, dest, { recursive: true }); fs.rmSync(full, { recursive: true, force: true }); }
  return { ok: true, kept: dest };
}
function cleanTrash() {
  const base = path.join(DATA_DIR, 'kosz');
  try {
    for (const site of fs.readdirSync(base)) for (const d of fs.readdirSync(path.join(base, site))) {
      const p = path.join(base, site, d);
      if (Date.now() - fs.statSync(p).mtimeMs > 14 * 864e5) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {}
}

/** Wgrywanie pliku: strumień zapytania → plik tymczasowy → zamiana. */
export async function upload(name, which, rel, fileName, req, max = 200 * 1024 * 1024) {
  if (!NAME_RE.test(fileName) || fileName === '.' || fileName === '..') throw new Error('Nieprawidłowa nazwa pliku.');
  const info = siteInfo(name);
  const root = rootOf(info, which);
  const dir = within(root, rel);
  if (!fs.statSync(dir.full).isDirectory()) throw new Error('To nie jest folder.');
  const { full, rel: r } = within(root, path.posix.join(dir.rel, fileName));
  const tmp = path.join(path.dirname(full), `.panel-${crypto.randomBytes(4).toString('hex')}.tmp`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp, { mode: 0o644 });
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); out.destroy(); reject(Object.assign(new Error('Plik jest za duży.'), { status: 413 })); } });
    req.pipe(out);
    out.on('finish', resolve); out.on('error', reject); req.on('error', reject);
  }).catch((e) => { fs.rmSync(tmp, { force: true }); throw e; });
  if (exists(full)) { if (fs.statSync(full).size <= MAX_TEXT) keepFileVersion(info.key, r, full); }
  const own = exists(full) ? ownerLike(full) : ownerLike(path.dirname(full));
  try { fs.chownSync(tmp, own.uid, own.gid); } catch {}
  fs.renameSync(tmp, full);
  return { ok: true, rel: r };
}

export function downloadFile(name, which, rel) {
  const info = siteInfo(name);
  const { full } = within(rootOf(info, which), rel);
  const st = fs.statSync(full);
  if (!st.isFile()) throw new Error('To nie jest plik.');
  return { name: path.basename(full), size: st.size, type: 'application/octet-stream', stream: fs.createReadStream(full) };
}
export async function downloadZip(name, which, rel) {
  const info = siteInfo(name);
  const { full } = within(rootOf(info, which), rel);
  const tmp = path.join(DATA_DIR, 'tmp', `pliki-${crypto.randomBytes(4).toString('hex')}.zip`);
  const r = await run('zip', ['-q', '-r', '-y', tmp, '.', '-x', 'node_modules/*', '.git/*'], { cwd: full, timeout: 600000 });
  if (!r.ok && !exists(tmp)) throw new Error('Nie udało się spakować: ' + r.err.slice(0, 200));
  const st = fs.statSync(tmp);
  const stream = fs.createReadStream(tmp);
  stream.on('close', () => fs.rm(tmp, { force: true }, () => {}));
  return { name: `${info.key}${rel ? '-' + path.basename(full) : ''}.zip`, size: st.size, type: 'application/zip', stream };
}

/* ---------------------------------------------------------------- wersje */

async function dirSize(dir) {
  const args = ['-sb', ...EXCLUDE.map((e) => `--exclude=${e}`), dir];
  const r = await run('du', args, { timeout: 120000 });
  return Number(r.out.split(/\s+/)[0]) || 0;
}
export function versions(name) {
  return db.prepare('SELECT id, ts, label, source, who, size FROM wersje WHERE site=? ORDER BY ts DESC').all(name);
}
/** Zrzut katalogu strony (bez ciężkich i zmiennych folderów: uploads, node_modules, cache, logi). */
export async function snapshot(name, label, source, who) {
  const info = siteInfo(name);
  if (!info.root) return null;
  const size = await dirSize(info.root);
  if (size > 400 * 1024 * 1024) throw new Error(`Strona ma ${Math.round(size / 1048576)} MB kodu — za dużo na wersje (limit 400 MB).`);
  const dir = path.join(DATA_DIR, 'wersje', info.key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${stamp()}-${crypto.randomBytes(3).toString('hex')}.tar.gz`);
  const r = await run('tar', ['-czf', file, '-C', info.root, ...EXCLUDE.map((e) => `--exclude=./${e}`), ...EXCLUDE.map((e) => `--exclude=${e}`), '.'], { timeout: 600000 });
  if (!r.ok && r.code !== 1) { fs.rmSync(file, { force: true }); throw new Error('Nie udało się zapisać wersji: ' + r.err.slice(0, 200)); }
  const id = db.prepare('INSERT INTO wersje(site,ts,label,source,who,size,file) VALUES(?,?,?,?,?,?,?)').run(name, Date.now(), String(label).slice(0, 200), source, who, fs.statSync(file).size, file).lastInsertRowid;
  const old = db.prepare('SELECT id, file FROM wersje WHERE site=? ORDER BY ts DESC LIMIT -1 OFFSET ?').all(name, KEEP_VERSIONS);
  for (const o of old) { fs.rmSync(o.file, { force: true }); db.prepare('DELETE FROM wersje WHERE id=?').run(o.id); }
  return Number(id);
}
export async function restoreVersion(name, id, who, say = () => {}) {
  const info = siteInfo(name);
  const v = db.prepare('SELECT * FROM wersje WHERE id=? AND site=?').get(Number(id), name);
  if (!v || !exists(v.file)) throw new Error('Nie ma takiej wersji.');
  say('▸ zapisuję obecny stan (żeby dało się wrócić)\n');
  await snapshot(name, 'Przed przywróceniem wersji z ' + new Date(v.ts).toLocaleString('pl-PL'), 'panel', who);
  const tmp = path.join(DATA_DIR, 'tmp', 'przywracanie-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(tmp, { recursive: true });
  try {
    say('▸ rozpakowuję wersję\n');
    const x = await run('tar', ['-xzpf', v.file, '-C', tmp], { timeout: 600000 });
    if (!x.ok) throw new Error('Nie udało się rozpakować: ' + x.err.slice(0, 200));
    say('▸ podmieniam pliki (uploads, node_modules, cache i logi zostają bez zmian)\n');
    const r = await run('rsync', ['-a', '--delete', ...EXCLUDE.map((e) => `--exclude=${e}`), tmp + '/', info.root + '/'], { timeout: 600000 });
    if (!r.ok) throw new Error('rsync: ' + r.err.slice(0, 200));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (info.unit) { say(`▸ uruchamiam ponownie ${info.unit}\n`); await run('systemctl', ['restart', info.unit]); }
  say('✓ przywrócono\n');
  return true;
}

/* ---------------------------------------------------------------- GitHub */

const REPO_RE = /^(https:\/\/(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?(\.git)?\/?|git@(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org):[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?(\.git)?)$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
function gitDir(key) { return path.join(DATA_DIR, 'git', key); }
function gitEnv(key) {
  const k = path.join(gitDir(key), 'klucz');
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `ssh -i ${k} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(DATA_DIR, 'git', 'known_hosts')} -o BatchMode=yes` };
}
async function ensureKey(key) {
  const d = gitDir(key);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const k = path.join(d, 'klucz');
  if (!exists(k)) { const r = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `panel-serwera ${key}`, '-f', k]); if (!r.ok) throw new Error('ssh-keygen: ' + r.err); }
  return readText(k + '.pub').trim();
}
export async function gitInfo(name) {
  const info = siteInfo(name);
  const g = db.prepare('SELECT * FROM git WHERE site=?').get(name);
  const pub = exists(path.join(gitDir(info.key), 'klucz.pub')) ? readText(path.join(gitDir(info.key), 'klucz.pub')).trim() : null;
  return g ? { repo: g.repo, branch: g.branch, subdir: g.subdir, auto: !!g.auto, del: !!g.del, sha: g.sha, msg: g.msg, last: g.last, status: g.status, err: g.err, hookUrl: `${PUBLIC_URL}hook/git/${g.hook}`, secret: g.secret, publicKey: pub } : { publicKey: pub };
}
export async function gitKey(name) { return ensureKey(siteInfo(name).key); }
export async function gitSetup(name, b) {
  const info = siteInfo(name);
  if (!info.root) throw new Error('Ta strona nie ma katalogu z plikami.');
  const repo = String(b.repo || '').trim();
  if (!REPO_RE.test(repo)) throw new Error('Podaj adres repozytorium, np. https://github.com/uzytkownik/strona albo git@github.com:uzytkownik/strona.git');
  const branch = String(b.branch || 'main').trim();
  if (!BRANCH_RE.test(branch) || branch.includes('..')) throw new Error('Nieprawidłowa nazwa gałęzi.');
  const subdir = String(b.subdir || '').trim().replace(/^\/+|\/+$/g, '');
  if (subdir && (subdir.split('/').includes('..') || !/^[A-Za-z0-9._\/-]+$/.test(subdir))) throw new Error('Nieprawidłowy folder w repozytorium.');
  await ensureKey(info.key);
  const ls = await run('git', ['ls-remote', '--heads', repo, branch], { env: gitEnv(info.key), timeout: 30000 });
  if (!ls.ok) {
    const ssh = repo.startsWith('git@');
    throw new Error(ssh || /Authentication|denied|not found|could not read/i.test(ls.err)
      ? 'Nie mam dostępu do repozytorium. Jeśli jest prywatne: dodaj klucz panelu w GitHub → repozytorium → Settings → Deploy keys (bez prawa zapisu) i użyj adresu git@github.com:… — potem spróbuj jeszcze raz.'
      : 'Nie udało się połączyć z repozytorium: ' + ls.err.split('\n')[0]);
  }
  if (!ls.out.trim()) throw new Error(`W repozytorium nie ma gałęzi „${branch}”.`);
  const old = db.prepare('SELECT * FROM git WHERE site=?').get(name);
  db.prepare('INSERT OR REPLACE INTO git(site,repo,branch,subdir,auto,del,secret,sha,msg,last,status,err,hook) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(name, repo, branch, subdir, b.auto === false ? 0 : 1, b.del ? 1 : 0, old?.secret || crypto.randomBytes(20).toString('hex'), old?.repo === repo ? old.sha : null, old?.repo === repo ? old.msg : null, old?.last || null, old?.status || 'nowe', null, old?.hook || crypto.randomBytes(12).toString('hex'));
  if (old?.repo && old.repo !== repo) fs.rmSync(path.join(gitDir(info.key), 'repo'), { recursive: true, force: true });
  return gitInfo(name);
}
export function gitRemove(name) {
  const info = siteInfo(name);
  db.prepare('DELETE FROM git WHERE site=?').run(name);
  fs.rmSync(path.join(gitDir(info.key), 'repo'), { recursive: true, force: true });
  return { ok: true };
}
export const siteByHook = (hook) => db.prepare('SELECT * FROM git WHERE hook=?').get(String(hook));

/** Pobiera najnowszą wersję z repozytorium i wgrywa ją na stronę (po zrzucie obecnej). */
export async function deploy(name, who, say = () => {}, { force = false } = {}) {
  const info = siteInfo(name);
  const g = db.prepare('SELECT * FROM git WHERE site=?').get(name);
  if (!g) throw new Error('Ta strona nie jest połączona z repozytorium.');
  const env = gitEnv(info.key);
  const repoDir = path.join(gitDir(info.key), 'repo');
  const set = (status, err = null, extra = {}) => db.prepare('UPDATE git SET status=?, err=?, last=?, sha=COALESCE(?, sha), msg=COALESCE(?, msg) WHERE site=?').run(status, err, Date.now(), extra.sha || null, extra.msg || null, name);
  try {
    if (!exists(path.join(repoDir, '.git'))) {
      say(`▸ pobieram repozytorium ${g.repo} (${g.branch})\n`);
      const r = await spawnCollect('git', ['clone', '--depth', '1', '--branch', g.branch, '--single-branch', g.repo, repoDir], { env, onData: () => {} });
      if (!r.ok) throw new Error('git clone: ' + r.out.split('\n').filter(Boolean).slice(-2).join(' '));
    } else {
      say('▸ sprawdzam nowe zmiany\n');
      const f = await run('git', ['-C', repoDir, 'fetch', '--depth', '1', 'origin', g.branch], { env, timeout: 120000 });
      if (!f.ok) throw new Error('git fetch: ' + f.err.split('\n')[0]);
      await run('git', ['-C', repoDir, 'reset', '--hard', 'FETCH_HEAD']);
      await run('git', ['-C', repoDir, 'clean', '-fdx']);
    }
    const sha = (await run('git', ['-C', repoDir, 'rev-parse', 'HEAD'])).out.trim();
    const msg = (await run('git', ['-C', repoDir, 'log', '-1', '--format=%s'])).out.trim().slice(0, 160);
    if (sha === g.sha && !force) { say(`✓ nic nowego — strona ma już „${msg}” (${sha.slice(0, 7)})\n`); set('ok', null, { sha, msg }); return { ok: true, same: true }; }
    const src = path.join(repoDir, g.subdir || '');
    if (!exists(src)) throw new Error(`W repozytorium nie ma folderu „${g.subdir}”.`);
    say('▸ zapisuję obecną wersję strony (do cofnięcia)\n');
    await snapshot(name, `Przed wgraniem „${msg}”`, 'github', who);
    const own = ownerLike(info.root);
    say(`▸ wgrywam „${msg}” (${sha.slice(0, 7)})${g.del ? ' — usuwam pliki, których nie ma w repozytorium' : ''}\n`);
    const args = ['-a', '--chown', `${own.uid}:${own.gid}`, '--exclude', '.git', '--exclude', '.github'];
    if (g.del) args.push('--delete', ...EXCLUDE.map((e) => `--exclude=${e}`), '--exclude', '.env', '--exclude', 'config.php');
    const r = await run('rsync', [...args, src.replace(/\/?$/, '/'), info.root + '/'], { timeout: 600000 });
    if (!r.ok) throw new Error('rsync: ' + r.err.slice(0, 200));
    if (info.unit) {
      if (exists(path.join(info.root, 'package.json')) && !exists(path.join(info.root, 'node_modules')) || (await changedPkg(repoDir))) {
        say('▸ instaluję zależności (npm)\n');
        await spawnCollect('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: info.root, onData: () => {} });
      }
      say(`▸ uruchamiam ponownie ${info.unit}\n`);
      await run('systemctl', ['restart', info.unit]);
    }
    await snapshot(name, `„${msg}” (${sha.slice(0, 7)})`, 'github', who).catch(() => {});
    set('ok', null, { sha, msg });
    say('✓ strona zaktualizowana\n');
    return { ok: true, sha, msg };
  } catch (e) {
    set('blad', e.message);
    throw e;
  }
}
async function changedPkg(repoDir) {
  const r = await run('git', ['-C', repoDir, 'diff', '--name-only', 'HEAD~1', 'HEAD']);
  return /package(-lock)?\.json/.test(r.out);
}
/** Sprawdza podpis webhooka (GitHub: X-Hub-Signature-256, GitLab: X-Gitlab-Token). */
export function verifyHook(g, headers, raw) {
  const sig = String(headers['x-hub-signature-256'] || '');
  if (sig.startsWith('sha256=')) {
    const want = 'sha256=' + crypto.createHmac('sha256', g.secret).update(raw).digest('hex');
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  }
  const tok = String(headers['x-gitlab-token'] || '');
  return !!tok && tok.length === g.secret.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(g.secret));
}

/* ----------------------------------------------- hasło i przerwa techniczna */

function extras(name) { return db.prepare('SELECT * FROM dodatki WHERE site=?').get(name) || { site: name, pass_on: 0, pass_user: '', maint_on: 0, maint_token: '', maint_text: '' }; }
function saveExtras(x) { db.prepare('INSERT OR REPLACE INTO dodatki(site,pass_on,pass_user,maint_on,maint_token,maint_text) VALUES(?,?,?,?,?,?)').run(x.site, x.pass_on ? 1 : 0, x.pass_user || '', x.maint_on ? 1 : 0, x.maint_token || '', x.maint_text || ''); }

export function extrasInfo(name) {
  const x = extras(name);
  let https = true; try { https = siteInfo(name).https; } catch {}
  return { password: { on: !!x.pass_on, user: x.pass_user }, maintenance: { on: !!x.maint_on, text: x.maint_text, preview: x.maint_on ? `${https ? "https" : "http"}://${name}/?panel_podglad=${x.maint_token}` : null } };
}

/** Dopisuje do vhostów strony linię IncludeOptional z dodatkami panelu (raz). Hasło tylko na HTTPS, jeśli strona go ma. */
function vhostFilesWithInclude(info) {
  const out = [];
  const line = `    # panel-serwera: hasło na stronę / przerwa techniczna\n    IncludeOptional ${INC}/${info.key}/*.conf`;
  for (const f of info.files) {
    const p = path.join(AV, f.file);
    const txt = readText(p);
    if (!txt) continue;
    if (txt.includes(`${INC}/${info.key}/`)) { out.push({ p, old: null }); continue; }
    let changed = false;
    const lines = txt.split('\n');
    const res = [];
    let inHost = false, hostPort = null, blockHasName = false;
    for (const l of lines) {
      res.push(l);
      const m = l.match(/^\s*<VirtualHost\s+[^>]*:(\d+)\s*>/i);
      if (m) { inHost = true; hostPort = Number(m[1]); blockHasName = false; continue; }
      if (inHost && /^\s*ServerName\s+(\S+)/i.test(l)) {
        const sn = l.trim().split(/\s+/)[1].toLowerCase();
        const target = info.https ? 443 : 80;
        if (sn === info.name.toLowerCase() && hostPort === target && !blockHasName) { res.push(line); changed = true; }
        blockHasName = true;
      }
      if (/^\s*<\/VirtualHost>/i.test(l)) inHost = false;
    }
    if (changed) out.push({ p, old: txt, neu: res.join('\n') });
  }
  return out;
}
async function applyApache(info, writeFiles) {
  fs.mkdirSync(path.join(INC, info.key), { recursive: true });
  const vh = vhostFilesWithInclude(info);
  if (!vh.some((v) => v.old === null || v.neu)) throw new Error('Nie znalazłem w konfiguracji Apache bloku tej strony (ServerName) — nie dodam zabezpieczenia.');
  const backup = new Map();
  for (const f of fs.readdirSync(path.join(INC, info.key))) backup.set(f, readText(path.join(INC, info.key, f)));
  for (const v of vh) if (v.neu) fs.writeFileSync(v.p, v.neu);
  writeFiles();
  const t = await run('apache2ctl', ['configtest']);
  if (!t.ok) {
    for (const v of vh) if (v.neu) fs.writeFileSync(v.p, v.old);
    for (const f of fs.readdirSync(path.join(INC, info.key))) if (!backup.has(f)) fs.rmSync(path.join(INC, info.key, f), { force: true });
    for (const [f, c] of backup) fs.writeFileSync(path.join(INC, info.key, f), c);
    throw new Error('Konfiguracja Apache nie przeszła testu — nic nie zmieniłem. ' + t.err.split('\n').filter((l) => /error|Syntax/i.test(l)).slice(0, 2).join(' '));
  }
  const r = await run('systemctl', ['reload', 'apache2']);
  if (!r.ok) throw new Error('Nie udało się przeładować Apache: ' + r.err);
  S.sites.reset();
}

/** Zapis plików w katalogu dodatków strony z testem konfiguracji Apache i przeładowaniem (dla innych modułów). */
export async function applyExtras(name, writeFiles) { return applyApache(siteInfo(name), writeFiles); }

export async function setPassword(name, { on, user, pass }) {
  const info = siteInfo(name);
  const x = extras(name);
  const dir = path.join(INC, info.key);
  if (on) {
    const u = String(user || '').trim();
    if (!/^[A-Za-z0-9._-]{2,32}$/.test(u)) throw new Error('Login: 2–32 znaki (litery, cyfry, kropka, myślnik).');
    const pw = String(pass || '');
    if (pw.length < 6 && !(x.pass_on && !pw)) throw new Error('Hasło musi mieć co najmniej 6 znaków.');
    await applyApache(info, () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ochrona.conf'), `# Hasło na stronę (panel serwera). Wyłączasz w panelu: Strony → ${name} → Ochrona.
<Location />
    AuthType Basic
    AuthName "Strona chroniona hasłem"
    AuthUserFile ${dir}/hasla
    Require valid-user
</Location>
<Location /.well-known/acme-challenge/>
    Require all granted
</Location>
`);
    });
    if (pw) {
      const r = await run('htpasswd', ['-i', '-B', '-c', path.join(dir, 'hasla'), u], { input: pw + '\n' });
      if (!r.ok) throw new Error('htpasswd: ' + r.err);
      fs.chmodSync(path.join(dir, 'hasla'), 0o640);
      try { fs.chownSync(path.join(dir, 'hasla'), 0, 33); } catch {}
    }
    x.pass_on = 1; x.pass_user = u;
  } else {
    await applyApache(info, () => { fs.rmSync(path.join(dir, 'ochrona.conf'), { force: true }); });
    fs.rmSync(path.join(dir, 'hasla'), { force: true });
    x.pass_on = 0;
  }
  saveExtras(x);
  return extrasInfo(name);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function setMaintenance(name, { on, text }) {
  const info = siteInfo(name);
  const x = extras(name);
  const dir = path.join(INC, info.key);
  if (on) {
    const token = x.maint_token || crypto.randomBytes(12).toString('hex');
    const msg = String(text || x.maint_text || 'Trwają prace na stronie. Wracamy za chwilę.').slice(0, 300);
    await applyApache(info, () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'przerwa.html'), `<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Przerwa techniczna — ${esc(name)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,sans-serif;background:#f6f7f9;color:#1f2328}main{max-width:520px;padding:32px;text-align:center}h1{font-size:28px;margin:0 0 12px}p{color:#57606a;line-height:1.5;margin:0}</style>
<main><h1>Przerwa techniczna</h1><p>${esc(msg)}</p></main></html>
`);
      fs.writeFileSync(path.join(dir, 'przerwa.conf'), `# Przerwa techniczna (panel serwera). Podgląd dla właściciela: ?panel_podglad=… ustawia ciasteczko.
Alias /panel-przerwa.html ${dir}/przerwa.html
<Directory ${dir}>
    Require all granted
</Directory>
<IfModule mod_proxy.c>
    ProxyPass /panel-przerwa.html !
</IfModule>
ErrorDocument 503 /panel-przerwa.html
RewriteEngine On
RewriteCond %{QUERY_STRING} (^|&)panel_podglad=${token}(&|$)
RewriteRule ^ %{REQUEST_URI}? [CO=panel_podglad:${token}:%{HTTP_HOST}:10080:/:secure:httponly,R=302,L]
RewriteCond %{REQUEST_URI} !^/\\.well-known/
RewriteCond %{REQUEST_URI} !^/panel-przerwa\\.html$
RewriteCond %{HTTP_COOKIE} !(^|;\\s*)panel_podglad=${token}
RewriteRule ^ - [R=503,L]
`);
    });
    x.maint_on = 1; x.maint_token = token; x.maint_text = msg;
  } else {
    await applyApache(info, () => { fs.rmSync(path.join(dir, 'przerwa.conf'), { force: true }); fs.rmSync(path.join(dir, 'przerwa.html'), { force: true }); });
    x.maint_on = 0;
  }
  saveExtras(x);
  return extrasInfo(name);
}

/* ------------------------------------------------------------ kopia testowa */
// Klon strony pod adresem test-…: pliki + własna kopia bazy (konfiguracja kopii wskazuje na nią),
// od razu za hasłem. „Opublikuj” przenosi pliki z kopii na prawdziwą stronę (po zapisaniu wersji).

const SYS_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys', 'phpmyadmin']);
const CONFIG_FILE = /(config|settings|database|\.env|db|wp-config|connect)[^/]*\.(php|json|ini|ya?ml|env|js)$|(^|\/)\.env$/i;
let OVref = null;
export function useOvh(ov) { OVref = ov; }

function stagingRow(name) {
  db.exec('CREATE TABLE IF NOT EXISTS kopie_testowe(site TEXT PRIMARY KEY, host TEXT, slug TEXT, db TEXT, testdb TEXT, files TEXT, created INTEGER, who TEXT, login TEXT, pass TEXT)');
  return db.prepare('SELECT * FROM kopie_testowe WHERE site=?').get(name);
}
export function stagingInfo(name) {
  const r = stagingRow(name);
  if (!r) return null;
  return { host: r.host, slug: r.slug, db: r.db, testdb: r.testdb, files: JSON.parse(r.files || '[]'), created: r.created, who: r.who, login: r.login, pass: r.pass, url: `http://${r.host}/` };
}
function testHost(name) {
  const parts = name.split('.');
  const zone = parts.slice(-2).join('.');
  const first = parts.length > 2 ? parts.slice(0, -2).join('-') : parts[0];
  return `test-${first}.${zone}`.toLowerCase();
}
async function mysqlLines(sql) { const r = await run('mysql', ['-N', '-B', '-e', sql], { timeout: 60000 }); if (!r.ok) throw new Error('MariaDB: ' + r.err.split('\n')[0]); return r.out.split('\n').filter(Boolean); }

/** Bazy, których nazwy stoją w plikach konfiguracyjnych strony jako wartość: w cudzysłowie albo po „=”. */
async function dbsUsedBy(root) {
  const all = (await mysqlLines('SHOW DATABASES')).filter((d) => !SYS_DBS.has(d) && /^[A-Za-z0-9_]+$/.test(d));
  const found = [];
  for (const d of all) {
    const pat = `(['"\`])${d}\\1|=[[:space:]]*['"]?${d}([^A-Za-z0-9_]|$)`;
    const g = await run('grep', ['-rlE', '--exclude-dir=node_modules', '--exclude-dir=vendor', '--exclude-dir=.git', '--exclude-dir=uploads', '--include=*.php', '--include=*.json', '--include=*.ini', '--include=*.yml', '--include=*.yaml', '--include=*.js', '--include=.env', '--include=*.env', '-e', pat, root], { timeout: 30000 });
    const files = g.out.split('\n').filter(Boolean).map((f) => path.relative(root, f)).filter((f) => CONFIG_FILE.test(f));
    if (!files.length) continue;
    // ważniejsza baza: ta, która stoi obok słowa db/database/name
    const ctx = await run('grep', ['-rhE', '-i', `(db|database|dbname|name).{0,40}(['"\`])${d}\\2|DB_DATABASE[[:space:]]*=[[:space:]]*['"]?${d}`, ...files.map((f) => path.join(root, f))]);
    found.push({ db: d, files, score: ctx.out.trim() ? 2 : 1 });
  }
  return found.sort((a, b) => b.score - a.score);
}
// podmieniamy tylko wartość przy kluczu nazwy bazy (name, database, dbname, DB_NAME, DB_DATABASE, dbname= w DSN) — nie login
const rewriteDb = (text, from, to) => text.replace(new RegExp(`((?:db_?name|database|dbname|db_database|\\bdb|\\bname)['"]?\\s*(?:=>|=|:|,)\\s*['"]?)${from}(?![A-Za-z0-9_])`, 'gi'), `$1${to}`);

export async function stagingCreate(name, who, C, say = () => {}) {
  const info = siteInfo(name);
  if (!info.root || info.proxies.length) throw new Error('Kopię testową da się zrobić dla zwykłych stron i stron PHP (nie dla aplikacji przez proxy).');
  if (stagingRow(name)) throw new Error('Ta strona ma już kopię testową — usuń ją albo opublikuj.');
  const host = testHost(name);
  const size = await dirSize(info.root);
  if (size > 2 * 1024 ** 3) throw new Error(`Strona ma ${(size / 1024 ** 3).toFixed(1)} GB — za dużo na kopię testową.`);
  const chk = await C.check({ template: 'pusta', host });
  if (!chk.ok) throw new Error(chk.problems.join(' '));
  if (!chk.dns?.ok && OVref?.manages(host)) { try { await OVref.ensure(host, say); } catch (e) { say(`✗ OVH: ${e.message}\n`); } }
  say(`▸ zakładam ${host}\n`);
  const made = await C.create({ template: 'pusta', host, startPage: false }, { login: who }, say);
  const dest = made.dir;
  let testdb = null, dbName = null, rewritten = [];
  try {
    say(`▸ kopiuję pliki (${Math.round(size / 1048576)} MB)\n`);
    const own = ownerLike(info.root);
    const r = await run('rsync', ['-a', '--delete', '--chown', `${own.uid}:${own.gid}`, '--exclude', 'cache', '--exclude', 'sessions', '--exclude', '*.log', info.root + '/', dest + '/'], { timeout: 900000 });
    if (!r.ok) throw new Error('rsync: ' + r.err.slice(0, 200));
    const used = await dbsUsedBy(info.root);
    if (used.length > 1) say(`  (w konfiguracji są nazwy kilku baz: ${used.map((x) => x.db).join(', ')} — kopiuję ${used[0].db})\n`);
    if (used.length) {
      ({ db: dbName, files: rewritten } = used[0]);
      testdb = `${dbName}_test`.slice(0, 64);
      if ((await mysqlLines(`SHOW DATABASES LIKE '${testdb}'`)).length) throw new Error(`Baza ${testdb} już istnieje — nie nadpisuję jej.`);
      say(`▸ kopiuję bazę ${dbName} → ${testdb}\n`);
      await mysqlLines(`CREATE DATABASE \`${testdb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      const cp = await run('bash', ['-c', 'set -o pipefail; mysqldump --single-transaction --routines --triggers "$1" | mysql "$2"', 'x', dbName, testdb], { timeout: 900000 });
      if (!cp.ok) throw new Error('Kopiowanie bazy nie wyszło: ' + cp.err.slice(0, 200));
      for (const line of await mysqlLines(`SELECT CONCAT(User, '|', Host) FROM mysql.db WHERE Db='${dbName.replace(/_/g, '\\\\_')}' OR Db='${dbName}'`)) {
        const [u, hst] = line.split('|');
        if (/^[A-Za-z0-9_.-]+$/.test(u) && /^[A-Za-z0-9_.%:-]+$/.test(hst)) await mysqlLines(`GRANT ALL PRIVILEGES ON \`${testdb}\`.* TO '${u}'@'${hst}'`);
      }
      say(`▸ kopia łączy się z ${testdb} zamiast ${dbName} (zmieniam: ${rewritten.join(', ')})\n`);
      for (const f of rewritten) { const p = path.join(dest, f); atomicWrite(p, rewriteDb(readText(p), dbName, testdb)); }
    }
    say('▸ zakładam hasło na kopię (żeby nie trafiła do Google i obcych)\n');
    const pass = crypto.randomBytes(6).toString('base64url');
    await setPassword(host, { on: true, user: 'test', pass });
    db.prepare('INSERT OR REPLACE INTO kopie_testowe(site,host,slug,db,testdb,files,created,who,login,pass) VALUES(?,?,?,?,?,?,?,?,?,?)').run(name, host, made.slug, dbName, testdb, JSON.stringify(rewritten), Date.now(), who, 'test', pass);
    say(`✓ kopia testowa gotowa: ${host} (login: test, hasło: ${pass})\n`);
    return stagingInfo(name);
  } catch (e) {
    say(`✗ ${e.message} — sprzątam\n`);
    if (testdb) await run('mysql', ['-e', `DROP DATABASE IF EXISTS \`${testdb}\``]);
    try { await C.remove(made.slug, () => {}); } catch {}
    throw e;
  }
}

export async function stagingPublish(name, who, say = () => {}) {
  const info = siteInfo(name);
  const r = stagingInfo(name);
  if (!r) throw new Error('Ta strona nie ma kopii testowej.');
  const t = siteInfo(r.host);
  say('▸ zapisuję obecną wersję prawdziwej strony (do cofnięcia)\n');
  await snapshot(name, 'Przed opublikowaniem kopii testowej', 'panel', who);
  const own = ownerLike(info.root);
  const ex = [...EXCLUDE.map((e) => `--exclude=${e}`), ...r.files.map((f) => `--exclude=/${f}`), '--exclude=/.htpasswd'];
  say(`▸ przenoszę pliki z ${r.host}${r.files.length ? ` (bez ${r.files.join(', ')} — tam jest adres bazy testowej)` : ''}\n`);
  const x = await run('rsync', ['-a', '--delete', '--chown', `${own.uid}:${own.gid}`, ...ex, t.root + '/', info.root + '/'], { timeout: 900000 });
  if (!x.ok) throw new Error('rsync: ' + x.err.slice(0, 200));
  await snapshot(name, 'Opublikowano kopię testową', 'panel', who).catch(() => {});
  say(`✓ opublikowano${r.testdb ? ` — baza została bez zmian (zmiany w ${r.testdb} nie są przenoszone)` : ''}\n`);
  return true;
}

export async function stagingRemove(name, C, say = () => {}) {
  const r = stagingInfo(name);
  if (!r) throw new Error('Ta strona nie ma kopii testowej.');
  if (r.testdb && /^[A-Za-z0-9_]+$/.test(r.testdb)) {
    const trash = path.join((await import('./config.mjs')).C().kopie.katalog, 'usuniete');
    fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
    say(`▸ zrzut ${r.testdb} do kosza i usunięcie bazy\n`);
    await run('bash', ['-c', 'set -o pipefail; mysqldump --single-transaction "$1" | gzip > "$2"', 'x', r.testdb, path.join(trash, `${r.testdb}_${stamp()}.sql.gz`)], { timeout: 600000 });
    for (const line of await mysqlLines(`SELECT CONCAT(User, '|', Host) FROM mysql.db WHERE Db='${r.testdb.replace(/_/g, '\\\\_')}' OR Db='${r.testdb}'`).catch(() => [])) {
      const [u, hst] = line.split('|');
      if (/^[A-Za-z0-9_.-]+$/.test(u) && /^[A-Za-z0-9_.%:-]+$/.test(hst)) await run('mysql', ['-e', `REVOKE ALL PRIVILEGES ON \`${r.testdb}\`.* FROM '${u}'@'${hst}'`]);
    }
    await run('mysql', ['-e', `DROP DATABASE IF EXISTS \`${r.testdb}\``]);
  }
  try { await setPassword(r.host, { on: false }); } catch {}
  fs.rmSync(path.join(INC, keyOf(r.host)), { recursive: true, force: true });
  if (C.list().some((x) => x.slug === r.slug)) await C.remove(r.slug, say);
  if (OVref?.manages(r.host)) { try { await OVref.remove(r.host, say); } catch {} }
  db.prepare('DELETE FROM kopie_testowe WHERE site=?').run(name);
  db.prepare('DELETE FROM dodatki WHERE site=?').run(r.host);
  say('✓ kopia testowa usunięta\n');
  return true;
}
