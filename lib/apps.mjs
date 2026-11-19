// Aplikacje Node (usługi systemd z kodem w /opt) i ustawienia stron:
// - aplikacja: stan, zmienne (.env w drop-inie systemd z automatycznym wycofaniem), logi na żywo,
//   wersje (migawka kodu) i aktualizacja z ZIP-a / git pull z wycofaniem, gdy aplikacja nie wstanie;
// - ustawienia strony: limity PHP, osobny proces PHP w wybranej wersji (FPM), przekierowania, edytor vhosta.
import fs from 'node:fs';
import path from 'node:path';
import { run, spawnCollect, readText, exists, stamp, sleep } from './util.mjs';
import * as S from './system.mjs';
import * as T from './sitetools.mjs';
import * as J from './journal.mjs';
import { isSecret } from './db/common.mjs';

let DATA_DIR = '/var/lib/panel-serwera', db;
const UNIT_RE = /^[a-z0-9@._-]{1,80}$/i;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DROPIN = 'panel-zmienne.conf';
const INC = '/etc/apache2/panel-serwera';
const AV = '/etc/apache2/sites-available';

export function init(database, dataDir) {
  db = database; DATA_DIR = dataDir;
  db.exec('CREATE TABLE IF NOT EXISTS ustawienia_stron(site TEXT PRIMARY KEY, v TEXT)');
  J.afterRestore('systemd', async (unit) => { await run('systemctl', ['daemon-reload']); if (unit) await run('systemctl', ['restart', unit], { timeout: 90000 }); });
  J.afterRestore('apache', async () => { const t = await run('apache2ctl', ['configtest']); if (t.ok) await run('systemctl', ['reload', 'apache2']); S.sites.reset(); });
  J.afterRestore('fpm', async (v) => { if (/^\d\.\d$/.test(v)) await run('systemctl', ['reload', `php${v}-fpm`]); });
}

/* ------------------------------------------------------------ aplikacja */

async function unitOnPort(port) {
  const r = await run('ss', ['-Hltnp', `sport = :${port}`]);
  const pid = Number((r.out.match(/pid=(\d+)/) || [])[1]);
  if (!pid) return null;
  return (readText(`/proc/${pid}/cgroup`).match(/\/([^/]+)\.service/) || [])[1] || null;
}
/** Usługa systemd stojąca za stroną (z rejestru panelu albo po porcie z ProxyPass). */
export async function unitFor(site) {
  const info = T.siteInfo(site);
  if (info.unit) return info.unit;
  for (const p of info.proxies) { const m = String(p).match(/:(\d+)/); if (m) { const u = await unitOnPort(Number(m[1])); if (u) return u; } }
  // aplikacja może być zatrzymana — szukamy usługi z PORT= równym portowi z ProxyPass
  const ports = info.proxies.map((p) => (String(p).match(/:(\d+)/) || [])[1]).filter(Boolean);
  for (const f of fs.readdirSync('/etc/systemd/system').filter((x) => x.endsWith('.service'))) {
    const t = readText(path.join('/etc/systemd/system', f));
    if (ports.some((pt) => new RegExp(`PORT=${pt}\\b`).test(t))) return f.replace(/\.service$/, '');
  }
  return null;
}
async function show(unit) {
  const r = await run('systemctl', ['show', unit, '-p', 'ActiveState,SubState,MemoryCurrent,ActiveEnterTimestamp,WorkingDirectory,ExecStart,Environment,EnvironmentFiles,NRestarts,MainPID,FragmentPath,DropInPaths,User', '--timestamp=unix']);
  const o = {};
  for (const l of r.out.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
  return o;
}
/** Zmienne środowiskowe usługi: rozbiór wartości Environment= z systemctl show (z cudzysłowami). */
function parseEnvLine(s) {
  const out = []; const re = /(?:"((?:[^"\\]|\\.)*)"|(\S+))/g; let m;
  while ((m = re.exec(s))) { const tok = m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2]; const i = tok.indexOf('='); if (i > 0) out.push([tok.slice(0, i), tok.slice(i + 1)]); }
  return out;
}
function appDir(wd) {
  // katalog aplikacji: najwyższy katalog w /opt z package.json albo .git (np. /opt/dc zamiast /opt/dc/server)
  let d = wd;
  const m = String(wd || '').match(/^(\/opt\/[^/]+)/);
  if (m && (exists(path.join(m[1], '.git')) || exists(path.join(m[1], 'package.json')) || !exists(path.join(wd, 'package.json')))) d = m[1];
  return d;
}
export async function appInfo(site) {
  const unit = await unitFor(site);
  if (!unit) return null;
  const o = await show(unit);
  const env = parseEnvLine(o.Environment || '');
  const dropin = path.join('/etc/systemd/system', `${unit}.service.d`, DROPIN);
  const wd = o.WorkingDirectory || '';
  const dir = appDir(wd);
  let version = '';
  for (const p of [path.join(wd, 'package.json'), path.join(dir, 'package.json')]) { try { const j = JSON.parse(readText(p)); if (j.version) { version = j.version; break; } } catch {} }
  const port = Number((env.find(([k]) => k === 'PORT') || [])[1]) || null;
  const mem = Number(o.MemoryCurrent);
  const node = (await run('node', ['--version'])).out.trim();
  return {
    unit, dir, wd, exec: (o.ExecStart.match(/argv\[\]=([^;]+)/) || [])[1]?.trim() || '', user: o.User || 'root',
    state: o.ActiveState, active: o.ActiveState === 'active', since: Number(String(o.ActiveEnterTimestamp || '').replace('@', '')) * 1000 || null,
    mem: Number.isFinite(mem) && mem < 2 ** 60 ? mem : null, restarts: Number(o.NRestarts) || 0, version, node, port,
    git: exists(path.join(dir, '.git')),
    env: env.map(([k, v]) => ({ key: k, value: isSecret(k) ? null : v, secret: isSecret(k), panel: readText(dropin).includes(`"${k}=`) })),
    envFiles: o.EnvironmentFiles ? o.EnvironmentFiles.split(/\s+/).filter((x) => x.startsWith('/')).map((x) => x.replace(/\s*\(.*$/, '')) : [],
    versions: listVersions(unit),
  };
}
export async function revealEnv(site, key) {
  const unit = await unitFor(site);
  const o = await show(unit);
  const v = parseEnvLine(o.Environment || '').find(([k]) => k === key);
  if (!v) throw new Error('Nie ma takiej zmiennej.');
  return v[1];
}
async function listensAs(unit, port) {
  const r = await run('ss', ['-Hltnp', `sport = :${port}`]);
  for (const m of r.out.matchAll(/pid=(\d+)/g)) if (readText(`/proc/${m[1]}/cgroup`).includes(`/${unit}.service`)) return true;
  return false;
}
/** Czy usługa naprawdę wstała: aktywna, słucha na swoim porcie i nie restartuje się w kółko. */
async function waitActive(unit, port, ms = 30000) {
  const t0 = Date.now();
  const restarts0 = Number((await show(unit)).NRestarts) || 0;
  await sleep(2500);
  while (Date.now() - t0 < ms) {
    const o = await show(unit);
    if (o.ActiveState === 'failed' || (Number(o.NRestarts) || 0) > restarts0) return false;
    if (o.ActiveState === 'active' && (!port || await listensAs(unit, port))) {
      await sleep(3000);
      const o2 = await show(unit);
      return o2.ActiveState === 'active' && (Number(o2.NRestarts) || 0) === restarts0;
    }
    await sleep(1500);
  }
  return false;
}
const q = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\n/g, ' ') + '"';
/** Zapis zmiennych: drop-in z nadpisaniami. changes: [{key, value|null(usuń), keep}] — wartości ukryte bez zmian, jeśli keep. */
export async function setEnv(site, changes, who, say = () => {}) {
  const unit = await unitFor(site);
  if (!unit || !UNIT_RE.test(unit)) throw new Error('Ta strona nie ma aplikacji.');
  const o = await show(unit);
  const cur = new Map(parseEnvLine(o.Environment || ''));
  const want = new Map(cur);
  for (const c of changes || []) {
    const k = String(c.key || '').trim();
    if (!ENV_KEY.test(k)) throw new Error(`Nieprawidłowa nazwa zmiennej: ${k || '(pusta)'} — litery, cyfry i _.`);
    if (c.keep) continue;
    if (c.value == null) want.delete(k); else want.set(k, String(c.value).slice(0, 4000));
  }
  const dir = path.join('/etc/systemd/system', `${unit}.service.d`);
  const file = path.join(dir, DROPIN);
  const before = J.fileBefore(file, [`systemd:${unit}`]);
  // drop-in nadpisuje: ustawiamy wszystko, co ma być (usunięte ze wzorca dostają pustą wartość)
  const lines = [...want].map(([k, v]) => `Environment=${q(`${k}=${v}`)}`);
  for (const k of cur.keys()) if (!want.has(k)) lines.push(`Environment=${q(`${k}=`)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `# Zmienne ustawione w panelu serwera (Strony → ${site} → Zmienne). Nadpisują te z pliku usługi.\n[Service]\n${lines.join('\n')}\n`, { mode: 0o600 });
  await run('systemctl', ['daemon-reload']);
  say(`▸ uruchamiam ponownie ${unit}\n`);
  await run('systemctl', ['restart', unit], { timeout: 90000 });
  const port = Number(want.get('PORT')) || null;
  if (!(await waitActive(unit, port))) {
    say('✗ aplikacja nie wstała w 30 s — przywracam poprzednie zmienne\n');
    if (before.content == null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, Buffer.from(before.content, 'base64'), { mode: 0o600 });
    await run('systemctl', ['daemon-reload']);
    await run('systemctl', ['restart', unit], { timeout: 90000 });
    throw new Error('Aplikacja nie wstała z nowymi zmiennymi — przywróciłem poprzednie. Sprawdź log.');
  }
  S.services.reset();
  const names = (changes || []).filter((c) => !c.keep).map((c) => c.key);
  J.add(who, 'aplikacja', `${site}: zmienne ${names.join(', ')}`, { type: 'plik', data: before }, `#/strona/${encodeURIComponent(site)}/zmienne`);
  return { ok: true };
}
export async function logs(site, { cursor = '', lines = 150 } = {}) {
  const unit = await unitFor(site);
  if (!unit) throw new Error('Ta strona nie ma aplikacji.');
  const args = ['-u', unit, '--no-pager', '-o', 'json', '--output-fields=MESSAGE,PRIORITY,__REALTIME_TIMESTAMP'];
  if (cursor) args.push('--after-cursor', cursor); else args.push('-n', String(Math.min(500, lines)));
  const r = await run('journalctl', args, { timeout: 15000 });
  const out = []; let last = cursor;
  for (const l of r.out.split('\n')) {
    if (!l.trim()) continue;
    try {
      const j = JSON.parse(l);
      let msg = j.MESSAGE; if (Array.isArray(msg)) msg = Buffer.from(msg).toString('utf8');
      out.push({ ts: Math.round(Number(j.__REALTIME_TIMESTAMP) / 1000), msg: String(msg ?? '').slice(0, 2000), err: Number(j.PRIORITY) <= 3 }); last = j.__CURSOR;
    } catch {}
  }
  return { unit, lines: out, cursor: last };
}

/* ------------------------------------------------- wersje i aktualizacje */

const VERS = () => path.join(DATA_DIR, 'wersje-aplikacji');
const EXCL = ['--exclude=./node_modules', '--exclude=*/node_modules', '--exclude=./.git', '--exclude=*.log', '--exclude=./data', '--exclude=./uploads', '--exclude=*.sqlite', '--exclude=*.sqlite-wal', '--exclude=*.sqlite-shm'];
function listVersions(unit) {
  const d = path.join(VERS(), unit);
  let f = []; try { f = fs.readdirSync(d).filter((x) => x.endsWith('.tar.gz')); } catch {}
  return f.sort().reverse().map((x) => { const st = fs.statSync(path.join(d, x)); const label = readText(path.join(d, x.replace(/\.tar\.gz$/, '.txt'))).trim(); return { id: x.replace(/\.tar\.gz$/, ''), size: st.size, time: st.mtimeMs, label }; });
}
async function snapshot(unit, dir, label, say = () => {}) {
  const d = path.join(VERS(), unit);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const id = `${stamp()}-${Date.now() % 100000}`;
  say(`▸ zapisuję obecną wersję (${label})\n`);
  const r = await run('tar', ['czf', path.join(d, id + '.tar.gz'), ...EXCL, '-C', dir, '.'], { timeout: 300000 });
  if (!r.ok) throw new Error('Nie udało się zapisać wersji: ' + r.err.trim().split('\n').pop());
  fs.writeFileSync(path.join(d, id + '.txt'), label + '\n');
  const all = listVersions(unit);
  for (const v of all.slice(10)) { fs.rmSync(path.join(d, v.id + '.tar.gz'), { force: true }); fs.rmSync(path.join(d, v.id + '.txt'), { force: true }); }
  return id;
}
async function npmIfNeeded(dir, beforePkg, say) {
  for (const sub of ['', 'server']) {
    const p = path.join(dir, sub, 'package.json');
    if (!exists(p)) continue;
    const pkg = readText(p);
    if (beforePkg.get(p) === pkg && exists(path.join(dir, sub, 'node_modules'))) continue;
    if (!/"dependencies"/.test(pkg)) continue;
    say(`▸ instaluję zależności (npm) w ${path.join(dir, sub)}\n`);
    const r = await spawnCollect('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: path.join(dir, sub), onData: (s) => say(s) });
    if (!r.ok) throw new Error('npm install nie powiódł się.');
  }
}
const pkgs = (dir) => new Map(['', 'server'].map((sub) => path.join(dir, sub, 'package.json')).filter(exists).map((p) => [p, readText(p)]));
async function restartAndCheck(info, say) {
  say(`▸ uruchamiam ponownie ${info.unit}\n`);
  await run('systemctl', ['restart', info.unit], { timeout: 90000 });
  return waitActive(info.unit, info.port);
}
async function restoreSnap(info, id, say) {
  const f = path.join(VERS(), info.unit, id + '.tar.gz');
  if (!exists(f)) throw new Error('Nie ma takiej wersji.');
  say(`▸ przywracam wersję ${id}\n`);
  const r = await run('tar', ['xzf', f, '-C', info.dir], { timeout: 300000 });
  if (!r.ok) throw new Error('Rozpakowanie nie wyszło: ' + r.err.trim());
}
/** Aktualizacja: ZIP (plik w tmp) albo git pull. Gdy aplikacja nie wstanie — wraca do zapisanej wersji. */
export async function update(site, { zip, git }, who, say) {
  const info = await appInfo(site);
  if (!info) throw new Error('Ta strona nie ma aplikacji.');
  if (!info.dir.startsWith('/opt/') && !info.dir.startsWith('/var/www/')) throw new Error('Aplikacja leży w nietypowym miejscu — zaktualizuj ją w terminalu.');
  const before = pkgs(info.dir);
  const snap = await snapshot(info.unit, info.dir, git ? 'przed git pull' : 'przed wgraniem ZIP-a', say);
  try {
    if (git) {
      if (!info.git) throw new Error('Ten katalog nie jest repozytorium git.');
      const r = await spawnCollect('git', ['-C', info.dir, 'pull', '--ff-only'], { onData: say });
      if (!r.ok) throw new Error('git pull się nie udał (może są lokalne zmiany).');
    } else {
      const tmp = fs.mkdtempSync(path.join(DATA_DIR, 'tmp', 'app-'));
      try {
        const u = await run('unzip', ['-q', '-o', zip, '-d', tmp], { timeout: 300000 });
        if (!u.ok) throw new Error('To nie jest poprawny plik ZIP.');
        // ZIP z jednym folderem w środku — bierzemy jego zawartość
        let src = tmp; const top = fs.readdirSync(tmp);
        if (top.length === 1 && fs.statSync(path.join(tmp, top[0])).isDirectory()) src = path.join(tmp, top[0]);
        say('▸ podmieniam pliki (bez node_modules, danych i .env)\n');
        const r = await spawnCollect('rsync', ['-a', '--exclude=node_modules', '--exclude=.git', '--exclude=.env', '--exclude=data', '--exclude=*.sqlite*', src + '/', info.dir + '/']);
        if (!r.ok) throw new Error('Kopiowanie plików nie wyszło.');
        await run('chown', ['-R', `--reference=${info.dir}`, info.dir]);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
    await npmIfNeeded(info.dir, before, say);
    if (!(await restartAndCheck(info, say))) throw new Error('Aplikacja nie wstała po aktualizacji.');
  } catch (e) {
    say(`✗ ${e.message}\n▸ wracam do poprzedniej wersji\n`);
    await restoreSnap(info, snap, say);
    await npmIfNeeded(info.dir, pkgs(info.dir), say).catch(() => {});
    const ok = await restartAndCheck(info, say);
    say(ok ? '✓ poprzednia wersja działa\n' : '✗ poprzednia wersja też nie wstała — zajrzyj do logu\n');
    throw new Error(e.message + ' Przywróciłem poprzednią wersję.');
  }
  const v = (await appInfo(site)).version;
  J.add(who, 'aplikacja', `${site}: aktualizacja ${git ? 'z GitHuba' : 'z ZIP-a'}${v ? ' → ' + v : ''}`, null, `#/strona/${encodeURIComponent(site)}/aplikacja`);
  say(`✓ zaktualizowano${v ? ' — wersja ' + v : ''}\n`);
  return true;
}
export async function rollback(site, id, who, say) {
  const info = await appInfo(site);
  if (!info) throw new Error('Ta strona nie ma aplikacji.');
  const v = id || info.versions[0]?.id;
  if (!v) throw new Error('Nie ma zapisanej wcześniejszej wersji.');
  const before = pkgs(info.dir);
  await snapshot(info.unit, info.dir, 'przed powrotem do wersji ' + v, say);
  await restoreSnap(info, v, say);
  await npmIfNeeded(info.dir, before, say);
  const ok = await restartAndCheck(info, say);
  J.add(who, 'aplikacja', `${site}: powrót do wersji z ${v.slice(0, 15).replace('_', ' ')}`, null, `#/strona/${encodeURIComponent(site)}/aplikacja`);
  say(ok ? '✓ działa\n' : '✗ aplikacja nie wstała — zajrzyj do logu\n');
  return ok;
}

/* -------------------------------------------------------- ustawienia strony */

function settingsOf(site) { const r = db.prepare('SELECT v FROM ustawienia_stron WHERE site=?').get(site); try { return r ? JSON.parse(r.v) : {}; } catch { return {}; } }
function saveSettings(site, v) { db.prepare('INSERT OR REPLACE INTO ustawienia_stron(site,v) VALUES(?,?)').run(site, JSON.stringify(v)); }
export function phpVersions() {
  const out = [];
  let dirs = []; try { dirs = fs.readdirSync('/etc/php').filter((x) => /^\d\.\d$/.test(x)); } catch {}
  for (const v of dirs.sort()) { const fpm = exists(`/usr/sbin/php-fpm${v}`); if (fpm || Number(v) >= 8.1) out.push({ v, fpm }); }
  return out;
}
const modPhp = () => (readText('/etc/apache2/mods-enabled/php8.3.load') ? '8.3' : (fs.readdirSync('/etc/apache2/mods-enabled').find((f) => /^php\d\.\d\.load$/.test(f)) || '').replace(/^php|\.load$/g, '') || null);
export function siteSettings(site) {
  const info = T.siteInfo(site);
  const s = settingsOf(site);
  const php = info.kind !== 'aplikacja' && !!info.root && !info.proxies.length;
  return {
    php, phpDefault: modPhp(), versions: phpVersions(),
    phpVersion: s.phpVersion || null, upload: s.upload || null, memory: s.memory || null, time: s.time || null,
    redirects: s.redirects || [], vhostFiles: info.files.map((f) => f.file),
  };
}
const SIZE_RE = /^(\d{1,4})M$/;
function checkSize(v, max) { if (v == null || v === '') return null; const m = SIZE_RE.exec(String(v)); if (!m || Number(m[1]) < 1 || Number(m[1]) > max) throw new Error(`Nieprawidłowy limit (1–${max} MB).`); return String(v); }
function checkPath(p) { const s = String(p || '').trim(); if (!/^\/[A-Za-z0-9._~\/%-]*$/.test(s) || s.length > 300) throw new Error(`Nieprawidłowa ścieżka: ${s || '(pusta)'} — zacznij od /.`); return s; }
function checkTarget(t) { const s = String(t || '').trim(); if (!/^(\/[A-Za-z0-9._~\/%?=&#-]*|https?:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/%?=&#-]*)?)$/i.test(s) || s.length > 400) throw new Error(`Nieprawidłowy adres docelowy: ${s || '(pusty)'}.`); return s; }

/** Zapis ustawień: pliki w katalogu dodatków strony + pula FPM, z testem i wycofaniem. */
export async function saveSiteSettings(site, b, who, say = () => {}) {
  const info = T.siteInfo(site);
  const cur = settingsOf(site);
  const next = { ...cur };
  const st = siteSettings(site);
  if (st.php) {
    next.upload = checkSize(b.upload, 2048); next.memory = checkSize(b.memory, 2048);
    next.time = b.time == null || b.time === '' ? null : (Number.isInteger(Number(b.time)) && Number(b.time) >= 10 && Number(b.time) <= 3600 ? Number(b.time) : (() => { throw new Error('Czas: 10–3600 sekund.'); })());
    const v = b.phpVersion || null;
    if (v && !/^\d\.\d$/.test(v)) throw new Error('Nieznana wersja PHP.');
    next.phpVersion = v && v !== st.phpDefault ? v : (v === st.phpDefault && b.fpm ? v : null);
  }
  next.redirects = (Array.isArray(b.redirects) ? b.redirects : []).slice(0, 100).map((r) => ({ from: checkPath(r.from), to: checkTarget(r.to), code: [301, 302].includes(Number(r.code)) ? Number(r.code) : 301 }));
  const dir = path.join(INC, info.key);
  const phpFile = path.join(dir, 'php.conf'), redFile = path.join(dir, 'przekierowania.conf');
  const pool = next.phpVersion ? `/etc/php/${next.phpVersion}/fpm/pool.d/panel-${info.key}.conf` : null;
  const oldPool = cur.phpVersion ? `/etc/php/${cur.phpVersion}/fpm/pool.d/panel-${info.key}.conf` : null;
  const undo = [J.fileBefore(phpFile, ['apache']), J.fileBefore(redFile, ['apache'])];
  if (pool) undo.push(J.fileBefore(pool, [`fpm:${next.phpVersion}`]));
  if (oldPool && oldPool !== pool) undo.push(J.fileBefore(oldPool, [`fpm:${cur.phpVersion}`]));
  // wersja PHP przez FPM: potrzebny moduł proxy_fcgi i zainstalowane php-fpm
  if (pool) {
    if (!exists(`/usr/sbin/php-fpm${next.phpVersion}`)) throw new Error(`PHP ${next.phpVersion} nie jest zainstalowane — kliknij „Zainstaluj PHP ${next.phpVersion}”.`);
    if (!exists('/etc/apache2/mods-enabled/proxy_fcgi.load')) { say('▸ włączam moduł proxy_fcgi w Apache\n'); await run('a2enmod', ['-q', 'proxy_fcgi', 'setenvif']); }
  }
  const lim = [next.upload && ['upload_max_filesize', next.upload], next.upload && ['post_max_size', next.upload], next.memory && ['memory_limit', next.memory], next.time && ['max_execution_time', String(next.time)]].filter(Boolean);
  const sock = `/run/php/panel-${info.key}.sock`;
  const writeAll = () => {
    fs.mkdirSync(dir, { recursive: true });
    if (!st.php || (!pool && !lim.length)) fs.rmSync(phpFile, { force: true });
    else if (pool) fs.writeFileSync(phpFile, `# PHP ${next.phpVersion} w osobnym procesie (panel serwera → Ustawienia strony)\n<FilesMatch "\\.php$">\n    SetHandler "proxy:unix:${sock}|fcgi://localhost"\n</FilesMatch>\n`);
    else fs.writeFileSync(phpFile, `# Limity PHP (panel serwera → Ustawienia strony)\n<IfModule php_module>\n${lim.map(([k, v]) => `    php_admin_value ${k} ${v}`).join('\n')}\n</IfModule>\n`);
    if (pool) fs.writeFileSync(pool, `; Pula PHP dla ${site} — utworzona przez panel serwera\n[panel-${info.key}]\nuser = www-data\ngroup = www-data\nlisten = ${sock}\nlisten.owner = www-data\nlisten.group = www-data\npm = ondemand\npm.max_children = 8\npm.process_idle_timeout = 30s\n${lim.map(([k, v]) => `php_admin_value[${k}] = ${v}`).join('\n')}\n`);
    if (oldPool && oldPool !== pool) fs.rmSync(oldPool, { force: true });
    const proxied = info.proxies.length > 0;
    if (next.redirects.length) fs.writeFileSync(redFile, `# Przekierowania (panel serwera → Ustawienia strony)\n${next.redirects.map((r) => `${proxied ? `ProxyPass ${r.from} !\n` : ''}Redirect ${r.code} ${r.from} ${r.to}`).join('\n')}\n`);
    else fs.rmSync(redFile, { force: true });
  };
  const restore = async () => { for (const u of undo) { if (u.content == null) fs.rmSync(u.path, { force: true }); else fs.writeFileSync(u.path, Buffer.from(u.content, 'base64')); } };
  // najpierw pula FPM (test składni), potem Apache (applyApache sprawdza configtest i sam wycofuje swoje pliki)
  if (pool || (oldPool && oldPool !== pool)) {
    writeAll();
    for (const v of new Set([next.phpVersion, cur.phpVersion].filter(Boolean))) {
      const t = await run(`/usr/sbin/php-fpm${v}`, ['-t']);
      if (!t.ok) { await restore(); throw new Error('Konfiguracja PHP-FPM nie przeszła testu — nic nie zmieniłem.'); }
      await run('systemctl', ['enable', '--now', `php${v}-fpm`]);
      await run('systemctl', ['reload', `php${v}-fpm`]);
    }
  }
  try { await T.applyExtras(site, writeAll); }
  catch (e) { await restore(); for (const v of new Set([next.phpVersion, cur.phpVersion].filter(Boolean))) await run('systemctl', ['reload', `php${v}-fpm`]); throw e; }
  // czy strona dalej odpowiada?
  if (info.root) {
    await sleep(800);
    const r = await run('curl', ['-sk', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15', '--resolve', `${site}:443:127.0.0.1`, '--resolve', `${site}:80:127.0.0.1`, `${info.https ? 'https' : 'http'}://${site}/`]);
    const code = Number(r.out.trim());
    if (code >= 500 || !code) {
      say(`✗ strona po zmianie zwraca ${code || 'brak odpowiedzi'} — przywracam poprzednie ustawienia\n`);
      await restore();
      await T.applyExtras(site, () => {});
      for (const v of new Set([next.phpVersion, cur.phpVersion].filter(Boolean))) await run('systemctl', ['reload', `php${v}-fpm`]);
      throw new Error(`Po zmianie strona zwracała błąd ${code || '(brak odpowiedzi)'} — przywróciłem poprzednie ustawienia.`);
    }
  }
  saveSettings(site, next);
  J.add(who, 'strona', `${site}: ustawienia (${[next.phpVersion && 'PHP ' + next.phpVersion, next.upload && 'wgrywanie ' + next.upload, next.memory && 'pamięć ' + next.memory, next.time && 'czas ' + next.time + ' s', next.redirects.length && next.redirects.length + ' przekierowań'].filter(Boolean).join(', ') || 'domyślne'})`,
    { type: 'pliki', data: { files: undo } }, `#/strona/${encodeURIComponent(site)}/ustawienia`);
  return siteSettings(site);
}
export async function installPhp(v, say) {
  if (!/^\d\.\d$/.test(v)) throw new Error('Nieznana wersja PHP.');
  const pk = ['fpm', 'mysql', 'mbstring', 'xml', 'curl', 'gd', 'zip', 'intl', 'bcmath'].map((x) => `php${v}-${x}`);
  say(`▸ instaluję PHP ${v} (${pk.join(', ')})\n`);
  const r = await spawnCollect('apt-get', ['install', '-y', '--no-install-recommends', ...pk], { onData: say, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
  if (!r.ok) throw new Error('Instalacja nie wyszła.');
  await run('systemctl', ['enable', '--now', `php${v}-fpm`]);
  say(`✓ PHP ${v} gotowe — wybierz je w ustawieniach strony\n`);
  return true;
}

/* ------------------------------------------------------------ edytor vhosta */

export function vhostRead(site, file) {
  const info = T.siteInfo(site);
  if (!info.files.some((f) => f.file === file)) throw new Error('Ten plik nie należy do strony.');
  const p = path.join(AV, file);
  return { file, text: readText(p), mtime: fs.statSync(p).mtimeMs };
}
export async function vhostWrite(site, file, text, mtime, who) {
  const info = T.siteInfo(site);
  if (!info.files.some((f) => f.file === file)) throw new Error('Ten plik nie należy do strony.');
  const p = path.join(AV, file);
  if (mtime && Math.abs(fs.statSync(p).mtimeMs - Number(mtime)) > 1) throw Object.assign(new Error('Plik zmienił się w międzyczasie — odśwież i wprowadź zmiany jeszcze raz.'), { status: 409 });
  const before = J.fileBefore(p, ['apache']);
  const st0 = fs.statSync(p);
  fs.writeFileSync(p, String(text).replace(/\r\n/g, '\n'));
  const t = await run('apache2ctl', ['configtest']);
  if (!t.ok) {
    fs.writeFileSync(p, Buffer.from(before.content, 'base64'));
    fs.utimesSync(p, st0.atime, st0.mtime); // ta sama data — można od razu poprawić i zapisać jeszcze raz
    throw new Error('Apache odrzucił zmianę — przywróciłem poprzednią treść. ' + (t.err || t.out).split('\n').filter((l) => /error|Syntax|line/i.test(l)).slice(0, 3).join(' '));
  }
  await run('systemctl', ['reload', 'apache2']);
  S.sites.reset();
  J.add(who, 'strona', `${site}: zmieniono konfigurację Apache (${file})`, { type: 'plik', data: before }, `#/strona/${encodeURIComponent(site)}/ustawienia`);
  return vhostRead(site, file);
}
