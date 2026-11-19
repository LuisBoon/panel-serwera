// Ustawienia panelu i pierwsze uruchomienie: adres panelu z certyfikatem (vhost Apache + Let's Encrypt),
// zapis konfiguracji z formularza, sprawdzanie i instalacja nowej wersji z GitHuba.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { run, readText } from './util.mjs';
import * as S from './system.mjs';
import { C, save, MODULES } from './config.mjs';

export const REPO = process.env.PANEL_REPO || 'LuisBoon/panel-serwera';
const AV = '/etc/apache2/sites-available';
const ACME = '/var/www/panel-acme';
const HOST_RE = /^(?=.{4,190}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/* ---------------------------------------------------------- adres panelu */

const vhost80 = (d, redirect) => `# Panel serwera — port 80: weryfikacja Let's Encrypt${redirect ? ' i przekierowanie na https' : ' i panel do czasu certyfikatu'} (utworzone przez panel)
<VirtualHost *:80>
    ServerName ${d}
    DocumentRoot ${ACME}
    <Directory ${ACME}>
        Require all granted
        Options -Indexes
    </Directory>
${redirect ? `    RewriteEngine on
    RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/
    RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]` : `    ProxyPass /.well-known/acme-challenge/ !
    ProxyPass / http://127.0.0.1:${process.env.PORT || 8099}/
    ProxyPassReverse / http://127.0.0.1:${process.env.PORT || 8099}/
    RequestHeader set X-Panel-Base "/"`}
    ErrorLog \${APACHE_LOG_DIR}/panel_error.log
    CustomLog \${APACHE_LOG_DIR}/panel_access.log combined
</VirtualHost>
`;
const vhost443 = (d) => `# Panel serwera — https://${d}/ (proxy do panelu na 127.0.0.1). Utworzone przez panel.
<IfModule mod_ssl.c>
<VirtualHost *:443>
    ServerName ${d}
    ProxyPass / http://127.0.0.1:${process.env.PORT || 8099}/
    ProxyPassReverse / http://127.0.0.1:${process.env.PORT || 8099}/
    RequestHeader set X-Panel-Base "/"
    Header always set Strict-Transport-Security "max-age=31536000"
    ErrorLog \${APACHE_LOG_DIR}/panel_error.log
    CustomLog \${APACHE_LOG_DIR}/panel_access.log combined
    SSLCertificateFile /etc/letsencrypt/live/${d}/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/${d}/privkey.pem
    Include /etc/letsencrypt/options-ssl-apache.conf
</VirtualHost>
</IfModule>
`;
export async function dnsInfo(d) {
  const ip = S.metrics().ip;
  let ips = [];
  try { ips = await dns.resolve4(d); } catch {}
  return { ip, ips, ok: ips.includes(ip) };
}
/** Ustawia adres panelu: vhost, certyfikat, przekierowanie na https. */
export async function setupPanelDomain(domain, email, say) {
  const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!HOST_RE.test(d)) throw new Error('Wpisz adres, np. panel.mojserwer.pl.');
  const di = await dnsInfo(d);
  if (!di.ok) throw new Error(di.ips.length ? `${d} wskazuje na ${di.ips.join(', ')}, a ten serwer to ${di.ip}. Popraw rekord A u operatora domeny i spróbuj za kilka minut.` : `${d} nie ma jeszcze rekordu A. Dodaj u operatora domeny: ${d} → ${di.ip} i spróbuj za kilka minut.`);
  say(`✓ DNS: ${d} → ${di.ip}\n`);
  fs.mkdirSync(path.join(ACME, '.well-known/acme-challenge'), { recursive: true });
  await run('a2enmod', ['-q', 'proxy', 'proxy_http', 'headers', 'rewrite', 'ssl']);
  const f80 = path.join(AV, `${d}.conf`), f443 = path.join(AV, `${d}-le-ssl.conf`);
  const old80 = readText(f80, null), old443 = readText(f443, null);
  const restore = async () => {
    if (old80 == null) { await run('a2dissite', ['-q', d]); fs.rmSync(f80, { force: true }); } else fs.writeFileSync(f80, old80);
    if (old443 == null) { await run('a2dissite', ['-q', `${d}-le-ssl`]); fs.rmSync(f443, { force: true }); } else fs.writeFileSync(f443, old443);
    await run('systemctl', ['reload', 'apache2']);
  };
  const apply = async () => {
    const t = await run('apache2ctl', ['configtest']);
    if (!t.ok) { await restore(); throw new Error('Konfiguracja Apache nie przeszła testu — nic nie zmieniłem. ' + t.err.split('\n').filter((l) => /error/i.test(l)).slice(0, 2).join(' ')); }
    await run('systemctl', ['reload', 'apache2']);
  };
  say('▸ konfiguracja Apache (port 80)\n');
  fs.writeFileSync(f80, vhost80(d, false));
  await run('a2ensite', ['-q', d]);
  await apply();
  say('▸ pobieram certyfikat Let\'s Encrypt\n');
  const em = String(email || '').trim();
  const c = await run('certbot', ['certonly', '--webroot', '-w', ACME, '-d', d, '--non-interactive', '--agree-tos', '--keep-until-expiring', ...(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(em) ? ['-m', em] : ['--register-unsafely-without-email']), '--deploy-hook', 'systemctl reload apache2'], { timeout: 240000 });
  if (!c.ok) throw new Error('Certyfikat się nie pobrał: ' + (c.err || c.out).split('\n').filter((l) => /error|detail|problem/i.test(l)).slice(0, 3).join(' ').slice(0, 300) + ' Panel działa pod http://' + d + '/ — spróbuj ponownie za chwilę.');
  say('▸ https i przekierowanie\n');
  fs.writeFileSync(f443, vhost443(d));
  fs.writeFileSync(f80, vhost80(d, true));
  await run('a2ensite', ['-q', `${d}-le-ssl`]);
  await apply();
  save({ adres: d });
  say(`✓ Panel działa pod https://${d}/\n`);
  return `https://${d}/`;
}

/* ------------------------------------------------------------ zapis ustawień */

const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const hostOk = (v) => !v || HOST_RE.test(v);
export function view() {
  const c = C();
  return { ...c, smtp: c.smtp ? { ...c.smtp, pass: c.smtp.pass ? '••••••' : '' } : null, MODULES };
}
export function update(b) {
  const c = C();
  const patch = {};
  if ('nazwa' in b) { const n = str(b.nazwa, 40); if (!/^[\p{L}\p{N} ._-]{2,40}$/u.test(n)) throw new Error('Nazwa: 2–40 znaków (litery, cyfry, spacja, kropka, myślnik).'); patch.nazwa = n; }
  if ('domena' in b) { const d = str(b.domena, 190).toLowerCase(); if (!hostOk(d)) throw new Error('Nieprawidłowa domena.'); patch.domena = d; }
  if (b.moduly && typeof b.moduly === 'object') patch.moduly = Object.fromEntries(Object.keys(MODULES).map((k) => [k, k in b.moduly ? !!b.moduly[k] : !!c.moduly[k]]));
  if ('dom' in b) {
    if (!b.dom || !str(b.dom.host)) patch.dom = null;
    else { const h = str(b.dom.host).toLowerCase(); if (!HOST_RE.test(h)) throw new Error('Serwer w domu: wpisz nazwę, np. dom.example.pl (z dynamicznym DNS).'); patch.dom = { host: h, opis: str(b.dom.opis, 60) || 'serwer w domu', porty: str(b.dom.porty, 40) || '3306' }; }
  }
  if ('gry' in b) {
    if (!b.gry || !str(b.gry.panel)) patch.gry = null;
    else { const u = str(b.gry.panel).replace(/\/+$/, ''); if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u)) throw new Error('Panel gier: adres https://…'); patch.gry = { panel: u, baza: str(b.gry.baza, 64).replace(/[^A-Za-z0-9_]/g, '') || 'panel' }; }
  }
  if ('gibcord' in b) {
    if (!b.gibcord || !str(b.gibcord.url)) patch.gibcord = null;
    else {
      const g = b.gibcord;
      if (!/^https?:\/\/[^\s]+$/.test(str(g.url))) throw new Error('GibCord: adres API, np. http://127.0.0.1:8084');
      patch.gibcord = { ...(c.gibcord || {}), url: str(g.url).replace(/\/+$/, ''), tokenFile: str(g.tokenFile) || '/var/lib/dc/serwer-bot.token', usluga: str(g.usluga, 60), domena: str(g.domena, 190), baza: str(g.baza), smtp: str(g.smtp) };
    }
  }
  if ('smtp' in b) {
    if (!b.smtp || !str(b.smtp.host)) patch.smtp = null;
    else { const s = b.smtp; patch.smtp = { host: str(s.host, 190), port: Number(s.port) || 465, secure: s.secure !== false, user: str(s.user, 190), pass: s.pass && s.pass !== '••••••' ? String(s.pass) : c.smtp?.pass || '', from: str(s.from, 190) }; }
  }
  if ('kreator' in b) patch.kreator = !!b.kreator;
  return save(patch);
}

/* -------------------------------------------------------- nowe wersje panelu */

let latestCache = { at: 0, v: null };
export async function latest() {
  if (Date.now() - latestCache.at < 3600e3 && latestCache.v) return latestCache.v;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/vnd.github+json', 'user-agent': 'panel-serwera' } });
    if (!r.ok) throw new Error(`GitHub: ${r.status}`);
    const j = await r.json();
    latestCache = { at: Date.now(), v: { tag: j.tag_name, version: String(j.tag_name || '').replace(/^v/, ''), notes: String(j.body || '').slice(0, 4000), url: j.html_url, date: j.published_at } };
  } catch (e) { latestCache = { at: Date.now() - 3000e3, v: { error: e.message } }; }
  return latestCache.v;
}
export const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; } return false; };
/** Instalacja nowej wersji: osobna usługa systemd (panel w trakcie się zrestartuje). */
export async function runUpdate() {
  const cli = '/usr/local/bin/panel-serwera';
  if (!fs.existsSync(cli)) throw new Error('Brak polecenia panel-serwera — ten panel nie był instalowany instalatorem. Zaktualizuj go ręcznie (git pull).');
  const r = await run('systemd-run', ['--unit', `panel-aktualizacja-${Date.now()}`, '--collect', '--quiet', cli, 'aktualizuj', '--bez-pytan']);
  if (!r.ok) throw new Error('Nie udało się uruchomić aktualizacji: ' + r.err.trim());
  return { ok: true, log: '/var/log/panel-aktualizacja.log' };
}
