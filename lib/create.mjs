// Tworzenie z panelu: strony (puste, PHP, z ZIP-a), aplikacje Node.js, przekierowania, bazy danych.
// Każda rzecz trafia do rejestru (tabela `utworzone`), żeby dało się ją potem pokazać, naprawić i usunąć.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { run, stamp, exists, readText } from './util.mjs';
import { siteConfigs, sites, metrics } from './system.mjs';
import { C as CFG } from './config.mjs';

const AV = '/etc/apache2/sites-available';
const ACME = '/var/www/panel-acme';
const ACCESS_DIR = '/root/panel-dostepy';
const APPS_LIST = path.join(process.env.DATA_DIR || '/var/lib/panel-serwera', 'kopie-aplikacji.txt');
const TRASH = path.join(CFG().kopie.katalog, 'usuniete');
const HOST_RE = /^(?=.{4,190}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TARGET_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/?=&#+-]*)?$/;

export const TEMPLATES = {
  pusta: { name: 'Pusta strona', folder: true, db: false, vhost: true },
  php: { name: 'Strona PHP + baza', folder: true, db: true, vhost: true },
  zip: { name: 'Strona z pliku ZIP', folder: true, db: false, vhost: true },
  node: { name: 'Aplikacja Node.js', folder: false, db: false, vhost: true, app: true },
  przekierowanie: { name: 'Przekierowanie', folder: false, db: false, vhost: true, redirect: true },
  wordpress: { name: 'WordPress', folder: true, db: true, vhost: true, cms: 'wordpress' },
  baza: { name: 'Baza danych', folder: false, db: true, vhost: false },
  kontener: { name: 'Aplikacja ze sklepu', folder: false, db: false, vhost: true, container: true, hidden: true },
};

let db = null;
export function init(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS utworzone(slug TEXT PRIMARY KEY, host TEXT, kind TEXT, dir TEXT, app_dir TEXT, data_dir TEXT,
    db TEXT, dbuser TEXT, unit TEXT, port INTEGER, target TEXT, ssl TEXT, ssl_msg TEXT, ssl_try INTEGER, created INTEGER, login TEXT)`);
  try { fs.mkdirSync(ACME + '/.well-known/acme-challenge', { recursive: true }); } catch (e) { console.warn('panel-serwera: brak', ACME, '—', e.code); }
}
export const list = () => db.prepare('SELECT * FROM utworzone ORDER BY created DESC').all();
const row = (slug) => db.prepare('SELECT * FROM utworzone WHERE slug=?').get(slug);

/* ---------------------------------------------------------- sprawdzanie */

export function baseDomains() {
  const set = new Set();
  for (const s of siteConfigs()) {
    const parts = s.name.split('.');
    if (parts.length >= 2) set.add(parts.slice(-2).join('.'));
  }
  const main = CFG().domena;
  if (main) set.add(main);
  return [...set].sort((a, b) => (a === main ? -1 : b === main ? 1 : a.localeCompare(b)));
}

export function slugFor(host) {
  const h = String(host || '').toLowerCase();
  const main = CFG().domena ? '.' + CFG().domena : null;
  const s = (main && h.endsWith(main) ? h.slice(0, -main.length) : h).replace(/\./g, '-');
  return s.slice(0, 40).replace(/-+$/, '');
}

const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);
export async function dnsCheck(host) {
  const ip = metrics().ip;
  try {
    const ips = await resolver.resolve4(host);
    return { ok: ips.includes(ip), ips, ip };
  } catch (e) {
    return { ok: false, ips: [], ip, error: e.code === 'ENOTFOUND' || e.code === 'ENODATA' ? 'brak wpisu' : e.code };
  }
}

async function unitExists(name) {
  const r = await run('systemctl', ['list-unit-files', '--no-legend', name + '.service']);
  return r.out.trim().length > 0 || exists(`/etc/systemd/system/${name}.service`);
}
async function dbExists(name) {
  const r = await run('mysql', ['-N', '-B', '-e', `SHOW DATABASES LIKE '${name}'`]);
  return r.out.trim() === name;
}

/** Czy adres i nazwa są wolne; zwraca też stan DNS. */
export async function check({ template, host, name }) {
  const t = TEMPLATES[template];
  if (!t) return { ok: false, problems: ['Nieznany szablon.'] };
  const problems = [];
  host = String(host || '').trim().toLowerCase();
  let slug = t.vhost ? slugFor(host) : String(name || '').trim().toLowerCase();
  if (t.vhost) {
    if (!HOST_RE.test(host)) problems.push(`Nieprawidłowy adres (np. sklep.${CFG().domena || 'example.pl'}).`);
    else if (siteConfigs().some((s) => s.name === host || s.aliases.includes(host))) problems.push('Ten adres już jest na serwerze.');
  }
  if (!SLUG_RE.test(slug)) problems.push('Nazwa: małe litery, cyfry i myślniki (do 40 znaków).');
  else {
    if (row(slug)) problems.push(`Nazwa „${slug}” jest już zajęta w panelu.`);
    if (t.folder && exists('/var/www/' + slug)) problems.push(`Folder /var/www/${slug} już istnieje.`);
    if (t.app && (exists('/opt/' + slug) || await unitExists(slug))) problems.push(`Aplikacja „${slug}” już istnieje.`);
    if ((t.db || template === 'baza') && await dbExists(slug.replace(/-/g, '_'))) problems.push(`Baza „${slug.replace(/-/g, '_')}” już istnieje.`);
  }
  const d = t.vhost && HOST_RE.test(host) ? await dnsCheck(host) : null;
  return { ok: problems.length === 0, problems, slug, host, dns: d, template };
}

/* ------------------------------------------------------------ szablony */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function soonPage(host) {
  return `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(host)} — wkrótce</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f1418; color: #e8edf2; }
  main { text-align: center; padding: 24px; }
  h1 { font-size: clamp(28px, 6vw, 48px); margin: 0 0 10px; letter-spacing: -0.02em; }
  p { margin: 0; color: #9fb0bf; font-size: 17px; }
  @media (prefers-color-scheme: light) { body { background: #f4f6f8; color: #14202b; } p { color: #4d5d6b; } }
</style></head>
<body><main><h1>${esc(host)}</h1><p>Strona wkrótce się pojawi.</p></main></body></html>
`;
}

function phpIndex(host, hasDb) {
  return `<?php
// Strona startowa utworzona przez panel serwera — podmień ją na swoją.
$db = ${hasDb ? "is_file(__DIR__ . '/config.php') ? require __DIR__ . '/config.php' : null" : 'null'};
$dbStatus = 'brak bazy';
if ($db) {
  mysqli_report(MYSQLI_REPORT_OFF);
  $c = @new mysqli($db['host'], $db['user'], $db['pass'], $db['name']);
  $dbStatus = $c->connect_errno ? 'błąd połączenia' : 'połączono z bazą ' . htmlspecialchars($db['name']);
}
?><!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(host)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0f1418;color:#e8edf2}main{text-align:center;padding:24px}h1{margin:0 0 10px}p{margin:4px 0;color:#9fb0bf}</style></head>
<body><main><h1>${esc(host)} działa</h1><p>PHP <?= PHP_VERSION ?> · <?= $dbStatus ?></p><p>Pliki strony: /var/www/…/ — dane bazy w config.php</p></main></body></html>
`;
}

function nodeStarter(host) {
  return `// Aplikacja ${host} — szablon z panelu serwera. Podmień na swoją; port dostajesz w zmiennej PORT.
// Restart po zmianach: panel → Usługi → ta aplikacja → Restart. Dane zapisuj w process.env.DATA_DIR.
import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === '/zdrowie') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>${esc(host)}</title><h1>${esc(host)} działa</h1><p>Node.js ' + process.version + '</p>');
}).listen(PORT, '127.0.0.1', () => console.log('${host}: słucham na 127.0.0.1:' + PORT));
`;
}

function vhostBody(r, { ssl }) {
  const logs = `    ErrorLog \${APACHE_LOG_DIR}/${r.slug}_error.log\n    CustomLog \${APACHE_LOG_DIR}/${r.slug}_access.log combined`;
  const acme = `    Alias /.well-known/acme-challenge/ ${ACME}/.well-known/acme-challenge/\n    <Directory ${ACME}>\n        Require all granted\n    </Directory>`;
  let content = '';
  if (r.dir) {
    content = `    DocumentRoot ${r.dir}\n    <Directory ${r.dir}>\n        Options -Indexes +FollowSymLinks\n        AllowOverride All\n        Require all granted\n    </Directory>`;
  } else if (r.port) {
    content = `    ProxyPreserveHost On\n    RewriteEngine on\n    RewriteCond %{HTTP:Upgrade} websocket [NC]\n    RewriteRule ^/(.*) ws://127.0.0.1:${r.port}/$1 [P,L]\n    ProxyPass /.well-known/acme-challenge/ !\n    ProxyPass / http://127.0.0.1:${r.port}/\n    ProxyPassReverse / http://127.0.0.1:${r.port}/`;
  } else if (r.target) {
    content = `    RewriteEngine on\n    RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/\n    RewriteRule ^/?(.*)$ ${r.target}$1 [R=301,L,NE]`;
  }
  const head = `# Utworzone przez panel serwera (${stamp()}) — ${TEMPLATES[r.kind]?.name || r.kind}. Usuwaj z panelu: Utwórz → Utworzone.`;
  // dodatki z karty strony (hasło, przerwa techniczna) — w bloku, który naprawdę serwuje stronę
  const extras = `    # panel-serwera: hasło na stronę / przerwa techniczna\n    IncludeOptional /etc/apache2/panel-serwera/${r.host.toLowerCase().replace(/[^a-z0-9.-]/g, '').replace(/\./g, '_')}/*.conf`;
  content = content ? `${extras}\n${content}` : extras;
  const http80 = ssl
    ? `${head}\n<VirtualHost *:80>\n    ServerName ${r.host}\n${acme}\n    RewriteEngine on\n    RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/\n    RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]\n${logs}\n</VirtualHost>\n`
    : `${head}\n<VirtualHost *:80>\n    ServerName ${r.host}\n${acme}\n${content}\n${logs}\n</VirtualHost>\n`;
  const https = ssl
    ? `${head}\n<IfModule mod_ssl.c>\n<VirtualHost *:443>\n    ServerName ${r.host}\n${content}\n${logs}\n    SSLCertificateFile /etc/letsencrypt/live/${r.host}/fullchain.pem\n    SSLCertificateKeyFile /etc/letsencrypt/live/${r.host}/privkey.pem\n    Include /etc/letsencrypt/options-ssl-apache.conf\n</VirtualHost>\n</IfModule>\n`
    : null;
  return { http80, https };
}

/** Zapisuje konfigurację, sprawdza ją i przeładowuje Apache — przy błędzie przywraca poprzedni stan. */
async function applyVhost(r, ssl, say) {
  const { http80, https } = vhostBody(r, { ssl });
  const f80 = path.join(AV, `${r.host}.conf`), f443 = path.join(AV, `${r.host}-le-ssl.conf`);
  const old80 = exists(f80) ? readText(f80) : null, old443 = exists(f443) ? readText(f443) : null;
  fs.writeFileSync(f80, http80);
  if (https) fs.writeFileSync(f443, https);
  await run('a2ensite', ['-q', `${r.host}`]);
  if (https) await run('a2ensite', ['-q', `${r.host}-le-ssl`]);
  const t = await run('apache2ctl', ['configtest']);
  if (!t.ok) {
    say?.('✗ konfiguracja Apache ma błąd — cofam\n' + t.err + '\n');
    if (old80 != null) fs.writeFileSync(f80, old80); else { await run('a2dissite', ['-q', r.host]); fs.rmSync(f80, { force: true }); }
    if (https) { if (old443 != null) fs.writeFileSync(f443, old443); else { await run('a2dissite', ['-q', `${r.host}-le-ssl`]); fs.rmSync(f443, { force: true }); } }
    throw new Error('Konfiguracja Apache nie przeszła testu — nic nie zmieniłem.');
  }
  const rl = await run('systemctl', ['reload', 'apache2']);
  if (!rl.ok) throw new Error('Nie udało się przeładować Apache: ' + rl.err);
  sites.reset();
}

/** Odtwarza konfigurację Apache utworzonej strony (np. po ręcznym grzebaniu albo w testach). */
export async function rewriteVhost(slug, ssl, say) { const r = row(slug); if (!r?.host) throw new Error('Nie ma takiej strony.'); return applyVhost(r, ssl, say); }

/** Próbuje pobrać certyfikat; zwraca stan SSL. Wołane przy tworzeniu i potem przez autopilota. */
export async function trySsl(slug, say = () => {}) {
  const r = row(slug);
  if (!r || !r.host) return null;
  const d = await dnsCheck(r.host);
  if (!d.ok) {
    db.prepare('UPDATE utworzone SET ssl=?, ssl_msg=?, ssl_try=? WHERE slug=?').run('czeka-dns', d.ips.length ? `adres wskazuje na ${d.ips.join(', ')}, a powinien na ${d.ip}` : `brak wpisu DNS — dodaj rekord A: ${r.host} → ${d.ip}`, Date.now(), slug);
    say(`▸ DNS dla ${r.host}: jeszcze nie wskazuje na serwer — certyfikat pobiorę sam, gdy tylko zacznie\n`);
    return 'czeka-dns';
  }
  say(`▸ pobieram certyfikat SSL dla ${r.host}\n`);
  const c = await run('certbot', ['certonly', '--webroot', '-w', ACME, '-d', r.host, '--non-interactive', '--agree-tos', '--keep-until-expiring', '--deploy-hook', 'systemctl reload apache2'], { timeout: 180000 });
  if (!c.ok) {
    const msg = (c.err || c.out).split('\n').filter((l) => /error|detail|problem/i.test(l)).slice(0, 3).join(' ').slice(0, 300) || 'certbot nie pobrał certyfikatu';
    db.prepare('UPDATE utworzone SET ssl=?, ssl_msg=?, ssl_try=? WHERE slug=?').run('blad', msg, Date.now(), slug);
    say(`✗ certyfikat: ${msg}\n`);
    return 'blad';
  }
  await applyVhost(r, true, say);
  db.prepare('UPDATE utworzone SET ssl=?, ssl_msg=?, ssl_try=? WHERE slug=?').run('gotowe', '', Date.now(), slug);
  if (r.kind === 'wordpress' && r.dir && exists(WP_CLI)) {
    // WordPress zainstalowany przed certyfikatem ma adres http:// — przestawiamy na https://
    const w = await run('runuser', ['-u', 'www-data', '--', 'php', WP_CLI, 'search-replace', `http://${r.host}`, `https://${r.host}`, `--path=${r.dir}`, '--all-tables', '--quiet'], { timeout: 120000, env: { ...process.env, HOME: '/tmp', WP_CLI_CACHE_DIR: '/tmp/wp-cli-cache' } });
    say(w.ok ? '▸ WordPress przestawiony na https\n' : '✗ nie udało się przestawić WordPressa na https — zrób to w Ustawieniach WordPressa\n');
  }
  say(`✓ https://${r.host}/ działa z certyfikatem\n`);
  return 'gotowe';
}

/** Wolny port dla aplikacji (wspólny zakres z aplikacjami Node). */
export async function nextPort() { return freePort(await usedPorts()); }
function freePort(used) {
  for (let p = 9100; p < 9200; p++) if (!used.has(p)) return p;
  throw new Error('Brak wolnego portu w zakresie 9100–9199.');
}
async function usedPorts() {
  const s = new Set(list().map((r) => r.port).filter(Boolean));
  const ss = await run('ss', ['-ltnH']);
  for (const l of ss.out.split('\n')) { const p = Number((l.split(/\s+/)[3] || '').split(':').pop()); if (p) s.add(p); }
  return s;
}
const password = () => crypto.randomBytes(18).toString('base64url');

function addAppBackup(slug) {
  const line = `${slug} opt/${slug} var/lib/${slug}`;
  const cur = readText(APPS_LIST);
  if (!cur.split('\n').includes(line)) fs.writeFileSync(APPS_LIST, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + line + '\n');
}
function removeAppBackup(slug) {
  const cur = readText(APPS_LIST);
  if (cur) fs.writeFileSync(APPS_LIST, cur.split('\n').filter((l) => l && !l.startsWith(slug + ' ')).join('\n') + '\n');
}

/* ---------------------------------------------------------------- ZIP */

export async function zipInspect(file) {
  const r = await run('unzip', ['-Z1', file], { timeout: 60000 });
  if (!r.ok) throw new Error('To nie jest poprawny plik ZIP.');
  const entries = r.out.split('\n').filter(Boolean);
  if (!entries.length) throw new Error('Plik ZIP jest pusty.');
  if (entries.some((e) => e.startsWith('/') || e.split('/').includes('..'))) throw new Error('ZIP zawiera niebezpieczne ścieżki (../) — nie rozpakuję go.');
  const tops = new Set(entries.map((e) => e.split('/')[0]));
  const single = tops.size === 1 && entries.some((e) => e.includes('/')) ? [...tops][0] : null;
  const files = entries.filter((e) => !e.endsWith('/'));
  const hasIndex = files.some((e) => /^([^/]+\/)?index\.(html?|php)$/i.test(e));
  return { files: files.length, single, hasIndex };
}

async function unpackZip(file, dir, say) {
  const info = await zipInspect(file);
  const r = await run('unzip', ['-q', '-o', file, '-d', dir], { timeout: 300000 });
  if (!r.ok && r.code > 1) throw new Error('Rozpakowanie nie powiodło się: ' + r.err);
  if (info.single && fs.statSync(path.join(dir, info.single)).isDirectory()) {
    const inner = path.join(dir, info.single);
    for (const f of fs.readdirSync(inner)) fs.renameSync(path.join(inner, f), path.join(dir, f));
    fs.rmdirSync(inner);
  }
  say(`▸ rozpakowano ${info.files} plików${info.hasIndex ? '' : ' (uwaga: brak index.html/index.php)'}\n`);
}

/* ------------------------------------------------------------ tworzenie */

export async function create(opts, who, say) {
  const t = TEMPLATES[opts.template];
  const chk = await check(opts);
  if (!chk.ok) throw new Error(chk.problems.join(' '));
  const slug = chk.slug, host = t.vhost ? chk.host : null;
  // PHP ma bazę domyślnie (można odznaczyć), pusta/ZIP/Node — tylko gdy zaznaczono, „baza” — zawsze
  const withDb = opts.template === 'baza' || !!t.cms || (opts.template === 'php' ? opts.db !== false : !!opts.db && ['pusta', 'zip', 'node'].includes(opts.template));
  const r = { slug, host, kind: opts.template, dir: null, app_dir: null, data_dir: null, db: null, dbuser: null, unit: null, port: null, target: null };
  const done = []; // do sprzątnięcia, jeśli coś po drodze się nie uda
  let secret = null, cms = null;
  try {
    if (t.redirect) {
      let target = String(opts.target || '').trim();
      if (!/^https?:\/\//.test(target)) target = 'https://' + target;
      if (!/^https?:\/\/[^/]+\/.*$/.test(target)) target += '/';
      if (!TARGET_RE.test(target) || /[$%\s]/.test(target)) throw new Error('Nieprawidłowy adres docelowy przekierowania.');
      r.target = target;
    }
    if (t.folder) {
      r.dir = '/var/www/' + slug;
      say(`▸ tworzę folder ${r.dir}\n`);
      fs.mkdirSync(r.dir, { recursive: false });
      done.push(() => fs.rmSync(r.dir, { recursive: true, force: true }));
      if (opts.template === 'zip') {
        const zf = path.join(opts.tmpDir, `zip-${String(opts.zip || '').replace(/[^A-Za-z0-9_-]/g, '')}.zip`);
        if (!opts.zip || !exists(zf)) throw new Error('Najpierw wgraj plik ZIP.');
        await unpackZip(zf, r.dir, say);
        fs.rmSync(zf, { force: true });
      } else if (opts.template === 'php') {
        fs.writeFileSync(path.join(r.dir, 'index.php'), phpIndex(host, withDb));
      } else if (t.cms) {
        // CMS wgrywamy po założeniu bazy
      } else if (opts.startPage !== false) {
        fs.writeFileSync(path.join(r.dir, 'index.html'), soonPage(host));
      }
      await run('chown', ['-R', 'www-data:www-data', r.dir]);
    }
    if (withDb) {
      r.db = slug.replace(/-/g, '_').slice(0, 60);
      r.dbuser = r.db.slice(0, 32);
      secret = password();
      say(`▸ zakładam bazę ${r.db} i użytkownika ${r.dbuser}\n`);
      const q = `CREATE DATABASE \`${r.db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER '${r.dbuser}'@'localhost' IDENTIFIED BY '${secret}'; GRANT ALL PRIVILEGES ON \`${r.db}\`.* TO '${r.dbuser}'@'localhost'; FLUSH PRIVILEGES;`;
      const m = await run('mysql', ['-e', q]);
      if (!m.ok) throw new Error('MariaDB: ' + m.err.trim());
      done.push(() => run('mysql', ['-e', `DROP DATABASE IF EXISTS \`${r.db}\`; DROP USER IF EXISTS '${r.dbuser}'@'localhost';`]));
      fs.mkdirSync(ACCESS_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(ACCESS_DIR, `${slug}.txt`), `Baza danych dla ${host || slug} (utworzona ${stamp()})\nserwer: localhost\nbaza: ${r.db}\nużytkownik: ${r.dbuser}\nhasło: ${secret}\n`, { mode: 0o600 });
      if (r.dir && !t.cms) {
        fs.writeFileSync(path.join(r.dir, 'config.php'), `<?php\n// Dane bazy — utworzone przez panel serwera. Nie wrzucaj tego pliku nigdzie publicznie.\nreturn ['host' => 'localhost', 'name' => '${r.db}', 'user' => '${r.dbuser}', 'pass' => '${secret}'];\n`, { mode: 0o640 });
        await run('chown', ['www-data:www-data', path.join(r.dir, 'config.php')]);
      }
    }
    if (t.container) {
      // aplikacja ze sklepu: kontener już działa na 127.0.0.1:port — tu tylko adres, Apache i certyfikat
      r.port = Number(opts.port); r.app_dir = opts.appDir || null; r.data_dir = opts.dataDir || null;
      if (!Number.isInteger(r.port) || r.port < 1024 || r.port > 65535) throw new Error('Nieprawidłowy port aplikacji.');
    }
    if (t.app) {
      r.app_dir = '/opt/' + slug; r.data_dir = '/var/lib/' + slug; r.unit = slug;
      r.port = freePort(await usedPorts());
      say(`▸ tworzę aplikację w ${r.app_dir} (port ${r.port})\n`);
      fs.mkdirSync(r.app_dir);
      done.push(() => fs.rmSync(r.app_dir, { recursive: true, force: true }));
      fs.writeFileSync(path.join(r.app_dir, 'server.mjs'), nodeStarter(host));
      fs.writeFileSync(path.join(r.app_dir, 'package.json'), JSON.stringify({ name: slug, private: true, type: 'module', main: 'server.mjs' }, null, 2) + '\n');
      fs.mkdirSync(r.data_dir, { recursive: true });
      await run('chown', ['www-data:www-data', r.data_dir]);
      fs.writeFileSync(`/etc/systemd/system/${slug}.service`, `[Unit]\nDescription=${host} - aplikacja Node.js (utworzona przez panel serwera)\nAfter=network.target\n\n[Service]\nType=simple\nUser=www-data\nGroup=www-data\nWorkingDirectory=${r.app_dir}\nExecStart=/usr/bin/node server.mjs\nEnvironment=NODE_ENV=production PORT=${r.port} DATA_DIR=${r.data_dir}\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=multi-user.target\n`);
      done.push(async () => { await run('systemctl', ['disable', '--now', slug]); fs.rmSync(`/etc/systemd/system/${slug}.service`, { force: true }); await run('systemctl', ['daemon-reload']); });
      await run('systemctl', ['daemon-reload']);
      const st = await run('systemctl', ['enable', '--now', slug]);
      if (!st.ok) throw new Error('Usługa nie wystartowała: ' + st.err);
      addAppBackup(slug);
      say('▸ usługa uruchomiona i dopisana do nocnej kopii\n');
    }
    db.prepare(`INSERT INTO utworzone(slug,host,kind,dir,app_dir,data_dir,db,dbuser,unit,port,target,ssl,ssl_msg,ssl_try,created,login) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(slug, host, r.kind, r.dir, r.app_dir, r.data_dir, r.db, r.dbuser, r.unit, r.port, r.target, host ? 'czeka-dns' : null, '', 0, Date.now(), who.login);
    done.push(() => db.prepare('DELETE FROM utworzone WHERE slug=?').run(slug));
    if (host) {
      say(`▸ konfiguracja Apache dla ${host}\n`);
      await applyVhost({ ...r }, false, say);
      done.push(async () => { await run('a2dissite', ['-q', host]); fs.rmSync(path.join(AV, `${host}.conf`), { force: true }); await run('systemctl', ['reload', 'apache2']); });
      await trySsl(slug, say);
    }
    if (t.cms === 'wordpress') cms = await installWordPress(r, host, secret, row(slug)?.ssl === 'gotowe', say);
  } catch (e) {
    say(`✗ ${e.message}\n▸ cofam to, co zdążyłem zrobić\n`);
    for (const undo of done.reverse()) { try { await undo(); } catch {} }
    throw e;
  }
  say('✓ gotowe\n');
  return { slug, host, db: r.db, dbuser: r.dbuser, password: secret, port: r.port, dir: r.dir, app_dir: r.app_dir, ssl: row(slug)?.ssl, cms };
}

/* ------------------------------------------------------------ WordPress */

const WP_CLI = '/usr/local/bin/wp';
async function installWordPress(r, host, dbpass, https, say) {
  const tmp = fs.mkdtempSync('/tmp/panel-wp-');
  try {
    say('▸ pobieram WordPressa (wersja polska)\n');
    const d = await run('curl', ['-fsSL', '--max-time', '240', '-o', path.join(tmp, 'wp.tar.gz'), 'https://pl.wordpress.org/latest-pl_PL.tar.gz'], { timeout: 260000 });
    if (!d.ok) throw new Error('Nie udało się pobrać WordPressa: ' + d.err.trim());
    const x = await run('tar', ['xzf', path.join(tmp, 'wp.tar.gz'), '-C', tmp], { timeout: 120000 });
    if (!x.ok || !exists(path.join(tmp, 'wordpress', 'wp-config-sample.php'))) throw new Error('Paczka WordPressa jest uszkodzona.');
    for (const f of fs.readdirSync(r.dir)) fs.rmSync(path.join(r.dir, f), { recursive: true, force: true });
    const c = await run('cp', ['-a', path.join(tmp, 'wordpress') + '/.', r.dir + '/']);
    if (!c.ok) throw new Error('Kopiowanie plików WordPressa nie wyszło.');
    const salt = () => crypto.randomBytes(60).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
    let cfg = readText(path.join(r.dir, 'wp-config-sample.php'));
    const set = (k, v) => { cfg = cfg.replace(new RegExp(`define\\(\\s*'${k}',\\s*'[^']*'\\s*\\);`), `define( '${k}', '${v}' );`); };
    set('DB_NAME', r.db); set('DB_USER', r.dbuser); set('DB_PASSWORD', dbpass); set('DB_HOST', 'localhost');
    for (const k of ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT']) set(k, salt());
    cfg = cfg.replace(/<\?php\s*/, "<?php\n// Utworzone przez panel serwera.\ndefine( 'FS_METHOD', 'direct' );\n");
    fs.writeFileSync(path.join(r.dir, 'wp-config.php'), cfg, { mode: 0o640 });
    await run('chown', ['-R', 'www-data:www-data', r.dir]);
    if (!exists(WP_CLI)) {
      say('▸ pobieram narzędzie wp-cli\n');
      const w = await run('curl', ['-fsSL', '--max-time', '120', '-o', WP_CLI, 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar'], { timeout: 140000 });
      if (!w.ok) throw new Error('Nie udało się pobrać wp-cli.');
      fs.chmodSync(WP_CLI, 0o755);
    }
    const pass = password();
    const url = `${https ? 'https' : 'http'}://${host}`;
    say(`▸ instaluję WordPressa pod ${url}\n`);
    const env = { ...process.env, HOME: '/tmp', WP_CLI_CACHE_DIR: '/tmp/wp-cli-cache' };
    const i = await run('runuser', ['-u', 'www-data', '--', 'php', WP_CLI, 'core', 'install', `--path=${r.dir}`, `--url=${url}`, `--title=${host}`, '--admin_user=admin', `--admin_password=${pass}`, `--admin_email=admin@${host}`, '--skip-email'], { timeout: 180000, env });
    if (!i.ok) throw new Error('Instalacja WordPressa nie wyszła: ' + (i.err || i.out).trim().split('\n').pop());
    fs.appendFileSync(path.join(ACCESS_DIR, `${r.slug}.txt`), `\nWordPress: ${url}/wp-admin/\nlogin: admin\nhasło: ${pass}\n(zmień adres e-mail administratora w profilu WordPressa)\n`);
    say('✓ WordPress zainstalowany\n');
    return { kind: 'wordpress', url: `${url}/wp-admin/`, user: 'admin', pass };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/* ------------------------------------------------------------- usuwanie */

export async function remove(slug, say) {
  const r = row(slug);
  if (!r) throw new Error('Tego nie utworzył panel — nie usuwam.');
  const when = stamp();
  fs.mkdirSync(TRASH, { recursive: true, mode: 0o700 });
  const archive = path.join(TRASH, `${slug}_${when}.tar.gz`);
  const parts = [r.dir, r.app_dir, r.data_dir].filter((p) => p && exists(p)).map((p) => p.slice(1));
  if (r.db) {
    say(`▸ zrzut bazy ${r.db} przed usunięciem\n`);
    const d = await run('bash', ['-c', 'set -o pipefail; mysqldump --single-transaction "$1" | gzip > "$2"', 'x', r.db, path.join(TRASH, `${r.db}_${when}.sql.gz`)], { timeout: 300000 });
    if (!d.ok) throw new Error('Nie udało się zrobić zrzutu bazy — przerywam, nic nie usunąłem.');
  }
  if (parts.length) {
    say(`▸ archiwum plików → ${archive}\n`);
    const a = await run('tar', ['czf', archive, '--exclude=*/node_modules', '-C', '/', ...parts], { timeout: 600000 });
    if (!a.ok) throw new Error('Nie udało się zarchiwizować plików — przerywam, nic nie usunąłem.');
  }
  if (r.host) {
    say(`▸ wyłączam ${r.host}\n`);
    await run('a2dissite', ['-q', r.host, `${r.host}-le-ssl`]);
    fs.rmSync(path.join(AV, `${r.host}.conf`), { force: true });
    fs.rmSync(path.join(AV, `${r.host}-le-ssl.conf`), { force: true });
    const t = await run('apache2ctl', ['configtest']);
    if (t.ok) await run('systemctl', ['reload', 'apache2']);
    if (exists(`/etc/letsencrypt/renewal/${r.host}.conf`)) await run('certbot', ['delete', '--cert-name', r.host, '--non-interactive'], { timeout: 60000 });
    // dodatki panelu: hasło/przerwa/ustawienia strony i osobna pula PHP
    const key = r.host.toLowerCase().replace(/[^a-z0-9.-]/g, '').replace(/\./g, '_').slice(0, 80);
    fs.rmSync(path.join('/etc/apache2/panel-serwera', key), { recursive: true, force: true });
    for (const v of (() => { try { return fs.readdirSync('/etc/php'); } catch { return []; } })()) {
      const pool = `/etc/php/${v}/fpm/pool.d/panel-${key}.conf`;
      if (exists(pool)) { fs.rmSync(pool, { force: true }); await run('systemctl', ['reload', `php${v}-fpm`]); }
    }
  }
  if (r.unit) {
    say(`▸ zatrzymuję i usuwam usługę ${r.unit}\n`);
    await run('systemctl', ['disable', '--now', r.unit]);
    fs.rmSync(`/etc/systemd/system/${r.unit}.service`, { force: true });
    fs.rmSync(`/etc/systemd/system/${r.unit}.service.d`, { recursive: true, force: true });
    await run('systemctl', ['daemon-reload']);
    removeAppBackup(slug);
  }
  if (r.db) await run('mysql', ['-e', `DROP DATABASE IF EXISTS \`${r.db}\`; DROP USER IF EXISTS '${r.dbuser}'@'localhost';`]);
  for (const p of [r.dir, r.app_dir, r.data_dir]) if (p && /^\/(var\/www|opt|var\/lib)\/[a-z0-9-]+$/.test(p)) fs.rmSync(p, { recursive: true, force: true });
  fs.rmSync(path.join(ACCESS_DIR, `${slug}.txt`), { force: true });
  db.prepare('DELETE FROM utworzone WHERE slug=?').run(slug);
  sites.reset();
  say(`✓ usunięto — kopia na wszelki wypadek w ${TRASH}\n`);
  return { archive };
}

/** Po przeniesieniu strony z innego serwera: baza należy do strony (usunie się razem z nią). */
export function setDb(slug, dbName, dbUser) { db.prepare('UPDATE utworzone SET db=?, dbuser=? WHERE slug=?').run(dbName || null, dbUser || null, slug); }

export function credentials(slug) {
  if (!SLUG_RE.test(slug)) throw new Error('Nieprawidłowa nazwa.');
  const txt = readText(path.join(ACCESS_DIR, `${slug}.txt`));
  if (!txt) throw new Error('Brak zapisanych danych dostępowych.');
  return txt;
}
