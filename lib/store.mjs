// Sklep z aplikacjami (wariant A · Półki, Docker): gotowe aplikacje jednym kliknięciem.
// Każda w osobnym projekcie docker compose (/opt/aplikacje/<id>), dane w /var/lib/aplikacje/<id>, port tylko na
// 127.0.0.1 — z internetu widać ją wyłącznie przez Apache z certyfikatem (kreator stron, rodzaj „kontener”).
// Kopie: katalog aplikacji i danych trafia do nocnej kopii (lista kopie-aplikacji.txt).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, spawnCollect, readText, exists } from './util.mjs';
import * as C from './create.mjs';
import * as S from './system.mjs';
import * as J from './journal.mjs';
import { C as CFG, DATA_DIR } from './config.mjs';

const DOCKER = process.env.DOCKER_BIN || '/usr/bin/docker';
const APPS = process.env.SKLEP_APPS || '/opt/aplikacje';
const DATA = process.env.SKLEP_DATA || '/var/lib/aplikacje';
const LIST = path.join(DATA_DIR, 'kopie-aplikacji.txt');
const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
let db, OV = null;

export function init(database, { ovh } = {}) {
  db = database; OV = ovh || null;
  db.exec('CREATE TABLE IF NOT EXISTS sklep(id TEXT PRIMARY KEY, app TEXT, host TEXT, port INTEGER, slug TEXT, created INTEGER, by TEXT, notes TEXT)');
}
const pw = (n = 18) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, 'x');
const MEM = (mb) => `${mb}m`;

/* ------------------------------------------------------------- katalog */
// ram: ile zwykle zajmuje (MB); limit: twardy limit kontenerów (MB) — chroni resztę serwera.
export const CATALOG = [
  { id: 'nextcloud', name: 'Nextcloud', icon: 'pliki', cat: 'Pliki i zdjęcia', desc: 'Pliki, zdjęcia, kontakty i kalendarz — jak Dysk Google, na Twoim serwerze.', ram: 450, sub: 'chmura', url: 'https://nextcloud.com',
    secrets: ['db', 'root', 'admin'], uid: { pliki: 33 },
    compose: (x) => `services:
  db:
    image: mariadb:11
    restart: unless-stopped
    command: --transaction-isolation=READ-COMMITTED --binlog-format=ROW
    mem_limit: ${MEM(512)}
    environment:
      MARIADB_ROOT_PASSWORD: "${x.s.root}"
      MARIADB_DATABASE: nextcloud
      MARIADB_USER: nextcloud
      MARIADB_PASSWORD: "${x.s.db}"
    volumes:
      - ${x.data}/baza:/var/lib/mysql
  app:
    image: nextcloud:apache
    restart: unless-stopped
    depends_on: [db]
    mem_limit: ${MEM(1024)}
    environment:
      MYSQL_HOST: db
      MYSQL_DATABASE: nextcloud
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: "${x.s.db}"
      NEXTCLOUD_ADMIN_USER: admin
      NEXTCLOUD_ADMIN_PASSWORD: "${x.s.admin}"
      NEXTCLOUD_TRUSTED_DOMAINS: "${x.host}"
      OVERWRITEPROTOCOL: https
      OVERWRITECLIURL: "https://${x.host}"
      TRUSTED_PROXIES: "172.16.0.0/12 192.168.0.0/16 10.0.0.0/8"
      APACHE_DISABLE_REWRITE_IP: "1"
    volumes:
      - ${x.data}/pliki:/var/www/html
    ports:
      - "127.0.0.1:${x.port}:80"
`, notes: (x) => `Logowanie: admin / ${x.s.admin}\nPierwsze uruchomienie trwa kilka minut (Nextcloud instaluje się w tle).` },
  { id: 'vaultwarden', name: 'Vaultwarden', icon: 'klucz', cat: 'Hasła', desc: 'Menedżer haseł zgodny z aplikacjami Bitwarden (telefon, komputer, przeglądarka).', ram: 30, sub: 'hasla', url: 'https://github.com/dani-garcia/vaultwarden',
    secrets: ['admin'],
    compose: (x) => `services:
  app:
    image: vaultwarden/server:latest
    restart: unless-stopped
    mem_limit: ${MEM(256)}
    environment:
      DOMAIN: "https://${x.host}"
      SIGNUPS_ALLOWED: "true"
      ADMIN_TOKEN: "${x.s.admin}"
    volumes:
      - ${x.data}/dane:/data
    ports:
      - "127.0.0.1:${x.port}:80"
`, notes: (x) => `Załóż swoje konto na https://${x.host}/ — potem wyłącz rejestrację w panelu administratora: https://${x.host}/admin (token: ${x.s.admin}).` },
  { id: 'uptime-kuma', name: 'Uptime Kuma', icon: 'aktywnosc', cat: 'Monitoring', desc: 'Pilnuje, czy strony i usługi działają, i powiadamia, gdy coś padnie.', ram: 120, sub: 'status-stron', url: 'https://uptime.kuma.pet',
    compose: (x) => `services:
  app:
    image: louislam/uptime-kuma:2
    restart: unless-stopped
    mem_limit: ${MEM(512)}
    volumes:
      - ${x.data}/dane:/app/data
    ports:
      - "127.0.0.1:${x.port}:3001"
`, notes: (x) => `Otwórz https://${x.host}/ i załóż konto administratora (pierwsza osoba, która wejdzie).` },
  { id: 'gitea', name: 'Gitea', icon: 'git', cat: 'Kod', desc: 'Własny GitHub: repozytoria, zgłoszenia i przeglądy kodu.', ram: 150, sub: 'git', url: 'https://about.gitea.com', uid: { dane: 1000 },
    compose: (x) => `services:
  app:
    image: gitea/gitea:latest
    restart: unless-stopped
    mem_limit: ${MEM(512)}
    environment:
      USER_UID: "1000"
      USER_GID: "1000"
      GITEA__server__ROOT_URL: "https://${x.host}/"
      GITEA__server__DOMAIN: "${x.host}"
      GITEA__server__DISABLE_SSH: "true"
      GITEA__database__DB_TYPE: sqlite3
    volumes:
      - ${x.data}/dane:/data
    ports:
      - "127.0.0.1:${x.port}:3000"
`, notes: (x) => `Otwórz https://${x.host}/ — przy pierwszym wejściu Gitea zapyta o konto administratora (ustawienia bazy zostaw domyślne).` },
  { id: 'n8n', name: 'n8n', icon: 'automatyzacja', cat: 'Praca', desc: 'Automatyzacje między aplikacjami — jak Zapier, na Twoim serwerze.', ram: 250, sub: 'automaty', url: 'https://n8n.io', uid: { dane: 1000 },
    compose: (x) => `services:
  app:
    image: n8nio/n8n:latest
    restart: unless-stopped
    mem_limit: ${MEM(1024)}
    environment:
      N8N_HOST: "${x.host}"
      N8N_PROTOCOL: https
      N8N_PORT: "5678"
      WEBHOOK_URL: "https://${x.host}/"
      N8N_PROXY_HOPS: "1"
      GENERIC_TIMEZONE: Europe/Warsaw
      TZ: Europe/Warsaw
    volumes:
      - ${x.data}/dane:/home/node/.n8n
    ports:
      - "127.0.0.1:${x.port}:5678"
`, notes: (x) => `Otwórz https://${x.host}/ i załóż konto właściciela.` },
  { id: 'umami', name: 'Umami', icon: 'statystyki', cat: 'Monitoring', desc: 'Statystyki odwiedzin bez ciasteczek, dla wielu stron naraz.', ram: 200, sub: 'statystyki', url: 'https://umami.is',
    secrets: ['db', 'app'],
    compose: (x) => `services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    mem_limit: ${MEM(256)}
    environment:
      POSTGRES_DB: umami
      POSTGRES_USER: umami
      POSTGRES_PASSWORD: "${x.s.db}"
    volumes:
      - ${x.data}/baza:/var/lib/postgresql/data
  app:
    image: ghcr.io/umami-software/umami:latest
    restart: unless-stopped
    depends_on: [db]
    mem_limit: ${MEM(512)}
    environment:
      DATABASE_URL: "postgresql://umami:${x.s.db}@db:5432/umami"
      APP_SECRET: "${x.s.app}"
    ports:
      - "127.0.0.1:${x.port}:3000"
`, notes: (x) => `Logowanie: admin / umami — zmień hasło od razu po wejściu (Ustawienia → Profil).` },
  { id: 'paperless', name: 'Paperless-ngx', icon: 'dokumenty', cat: 'Pliki i zdjęcia', desc: 'Skany i dokumenty z rozpoznawaniem tekstu i wyszukiwarką.', ram: 600, sub: 'dokumenty', url: 'https://docs.paperless-ngx.com',
    secrets: ['key', 'admin'], uid: { dane: 1000, media: 1000, przyjmij: 1000 },
    compose: (x) => `services:
  broker:
    image: redis:7-alpine
    restart: unless-stopped
    mem_limit: ${MEM(128)}
  app:
    image: ghcr.io/paperless-ngx/paperless-ngx:latest
    restart: unless-stopped
    depends_on: [broker]
    mem_limit: ${MEM(1536)}
    environment:
      PAPERLESS_REDIS: redis://broker:6379
      PAPERLESS_URL: "https://${x.host}"
      PAPERLESS_SECRET_KEY: "${x.s.key}"
      PAPERLESS_ADMIN_USER: admin
      PAPERLESS_ADMIN_PASSWORD: "${x.s.admin}"
      PAPERLESS_TIME_ZONE: Europe/Warsaw
      PAPERLESS_OCR_LANGUAGES: pol
      PAPERLESS_OCR_LANGUAGE: pol+eng
    volumes:
      - ${x.data}/dane:/usr/src/paperless/data
      - ${x.data}/media:/usr/src/paperless/media
      - ${x.data}/przyjmij:/usr/src/paperless/consume
    ports:
      - "127.0.0.1:${x.port}:8000"
`, notes: (x) => `Logowanie: admin / ${x.s.admin}. Pliki wrzucone do ${x.data}/przyjmij (np. przez SFTP) same trafią do Paperless.` },
];
const app = (id) => { const a = CATALOG.find((x) => x.id === id); if (!a) throw new Error('Nie ma takiej aplikacji.'); return a; };

/* ---------------------------------------------------------------- docker */

export async function dockerState() {
  if (!exists(DOCKER)) return { installed: false, running: false };
  const v = await run(DOCKER, ['version', '--format', '{{.Server.Version}}'], { timeout: 20000 });
  const c = await run(DOCKER, ['compose', 'version', '--short'], { timeout: 20000 });
  return { installed: true, running: v.ok, version: v.out.trim() || null, compose: c.ok ? c.out.trim() : null };
}
const osInfo = () => { const t = readText('/etc/os-release'); const g = (k) => (t.match(new RegExp(`^${k}="?([^"\\n]*)`, 'm')) || [])[1] || ''; return { id: g('ID'), codename: g('VERSION_CODENAME') }; };
/** Instalacja Dockera z oficjalnego repozytorium (docker-ce + compose). */
export async function installDocker(who, say) {
  const os = osInfo();
  if (!['debian', 'ubuntu'].includes(os.id) || !os.codename) throw new Error('Docker instaluję tylko na Debianie i Ubuntu.');
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  const fwdBefore = readText('/proc/sys/net/ipv4/ip_forward').trim() === '1';
  const polBefore = ((await run('iptables', ['-S', 'FORWARD'])).out.match(/^-P FORWARD (\w+)/m) || [])[1] || 'ACCEPT';
  say('▸ repozytorium Dockera\n');
  fs.mkdirSync('/etc/apt/keyrings', { recursive: true, mode: 0o755 });
  let r = await run('curl', ['-fsSL', '--max-time', '60', '-o', '/etc/apt/keyrings/docker.asc', `https://download.docker.com/linux/${os.id}/gpg`], { timeout: 90000 });
  if (!r.ok) throw new Error('Nie udało się pobrać klucza repozytorium Dockera.');
  fs.chmodSync('/etc/apt/keyrings/docker.asc', 0o644);
  const arch = (await run('dpkg', ['--print-architecture'])).out.trim() || 'amd64';
  fs.writeFileSync('/etc/apt/sources.list.d/docker.list', `deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${os.id} ${os.codename} stable\n`);
  // logi kontenerów z limitem — bez tego potrafią zapchać dysk
  fs.mkdirSync('/etc/docker', { recursive: true });
  if (!exists('/etc/docker/daemon.json')) fs.writeFileSync('/etc/docker/daemon.json', JSON.stringify({ 'log-driver': 'json-file', 'log-opts': { 'max-size': '10m', 'max-file': '3' } }, null, 2) + '\n');
  say('▸ instaluję docker-ce i compose (kilka minut)\n');
  r = await spawnCollect('apt-get', ['update'], { env });
  r = await spawnCollect('apt-get', ['install', '-y', '-q', 'docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-compose-plugin'], { env, onData: () => {} });
  if (!r.ok) throw new Error('Instalacja Dockera nie wyszła.');
  // Docker ustawia FORWARD na DROP — gdy serwer przekazuje ruch (np. Tailscale), przywracamy poprzednią politykę
  if (fwdBefore && polBefore === 'ACCEPT') {
    const help = (await run('dockerd', ['--help'])).out;
    if (/ip-forward-no-drop/.test(help)) {
      const conf = JSON.parse(readText('/etc/docker/daemon.json') || '{}'); conf['ip-forward-no-drop'] = true;
      fs.writeFileSync('/etc/docker/daemon.json', JSON.stringify(conf, null, 2) + '\n');
      await run('systemctl', ['restart', 'docker'], { timeout: 120000 });
    }
    await run('iptables', ['-P', 'FORWARD', 'ACCEPT']);
    say('  przekazywanie ruchu (np. Tailscale) zostawione bez zmian\n');
  }
  const st = await dockerState();
  if (!st.running) throw new Error('Docker się zainstalował, ale nie działa — zajrzyj do Logów (docker).');
  J.add(who, 'system', `Zainstalowano Dockera ${st.version} (sklep z aplikacjami)`);
  say(`✓ Docker ${st.version} działa\n`);
  return { ok: true, result: st };
}

/* -------------------------------------------------------------- aplikacje */

const dirOf = (id) => path.join(APPS, id), dataOf = (id) => path.join(DATA, id);
const compose = (id, args, opts = {}) => spawnCollect(DOCKER, ['compose', '-p', `sklep-${id}`, '-f', path.join(dirOf(id), 'compose.yml'), ...args], opts);
function backupLine(id, on) {
  const line = `sklep-${id} ${dirOf(id).slice(1)} ${dataOf(id).slice(1)}`;
  const cur = readText(LIST).split('\n').filter((l) => l && !l.startsWith(`sklep-${id} `));
  if (on) cur.push(line);
  fs.writeFileSync(LIST, cur.join('\n') + '\n');
}
async function waitHttp(port, ms, say) {
  const t0 = Date.now(); let n = 0;
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000), redirect: 'manual' }); if (r.status < 500) return true; } catch {}
    if (++n % 10 === 0) say(`  czekam, aż aplikacja wstanie (${Math.round((Date.now() - t0) / 1000)} s)\n`);
    await new Promise((ok) => setTimeout(ok, 3000));
  }
  return false;
}
export async function list() {
  const rows = db.prepare('SELECT * FROM sklep ORDER BY created').all();
  const st = await dockerState();
  return Promise.all(rows.map(async (r) => {
    let state = 'nieznany', containers = [];
    if (st.running) {
      const ps = await run(DOCKER, ['compose', '-p', `sklep-${r.id}`, 'ps', '-a', '--format', 'json'], { timeout: 30000 });
      try { containers = ps.out.trim().split('\n').filter(Boolean).flatMap((l) => { const j = JSON.parse(l); return Array.isArray(j) ? j : [j]; }).map((c) => ({ name: c.Service, state: c.State, health: c.Health || '' })); } catch {}
      state = !containers.length ? 'zatrzymana' : containers.every((c) => c.state === 'running') ? 'dziala' : containers.some((c) => c.state === 'restarting') ? 'restartuje' : 'zatrzymana';
    }
    const a = CATALOG.find((x) => x.id === r.app);
    return { ...r, name: a?.name || r.app, icon: a?.icon || 'kontener', state, containers, notes: r.notes || '' };
  }));
}
export async function catalog() {
  const m = S.metrics();
  const avail = Math.round((m.mem?.available || 0) / 1048576);
  const inst = db.prepare('SELECT app, COUNT(*) n FROM sklep GROUP BY app').all();
  return { docker: await dockerState(), freeMb: avail, domain: CFG().domena || '', apps: CATALOG.map((a) => ({ id: a.id, name: a.name, icon: a.icon, cat: a.cat, desc: a.desc, ram: a.ram, sub: a.sub, url: a.url, installed: inst.find((x) => x.app === a.id)?.n || 0, fit: a.ram < avail * 0.6 ? 'ok' : a.ram < avail ? 'warn' : 'bad' })), installed: await list() };
}

/** Instalacja aplikacji: pliki compose, kontenery, adres z certyfikatem, nocne kopie. */
export async function install({ app: appId, host }, who, say) {
  const a = app(appId);
  const st = await dockerState();
  if (!st.running) throw new Error('Najpierw zainstaluj Dockera (przycisk na górze sklepu).');
  const h = String(host || '').trim().toLowerCase();
  const chk = await C.check({ template: 'kontener', host: h, port: 9100 });
  if (!chk.ok) throw new Error(chk.problems.join(' '));
  let id = a.id; for (let i = 2; db.prepare('SELECT 1 FROM sklep WHERE id=?').get(id) || exists(dirOf(id)); i++) id = `${a.id}-${i}`;
  if (!ID_RE.test(id)) throw new Error('Nieprawidłowa nazwa.');
  const port = await C.nextPort();
  const s = Object.fromEntries((a.secrets || []).map((k) => [k, pw()]));
  const x = { id, host: chk.host, port, data: dataOf(id), s };
  const done = [];
  try {
    if (chk.host && !chk.dns?.ok && OV?.manages(chk.host)) { try { await OV.ensure(chk.host, say); } catch (e) { say(`  OVH: ${e.message} — dodaj rekord A ręcznie\n`); } }
    say(`▸ przygotowuję ${a.name} (${dirOf(id)}, dane w ${dataOf(id)}, port 127.0.0.1:${port})\n`);
    fs.mkdirSync(dirOf(id), { recursive: true, mode: 0o700 }); done.push(() => fs.rmSync(dirOf(id), { recursive: true, force: true }));
    fs.mkdirSync(dataOf(id), { recursive: true, mode: 0o750 }); done.push(() => fs.rmSync(dataOf(id), { recursive: true, force: true }));
    for (const [sub, uid] of Object.entries(a.uid || {})) { const p = path.join(dataOf(id), sub); fs.mkdirSync(p, { recursive: true }); fs.chownSync(p, uid, uid); }
    fs.writeFileSync(path.join(dirOf(id), 'compose.yml'), `# ${a.name} — zainstalowane ze sklepu panelu serwera (${new Date().toISOString().slice(0, 10)}). Hasła są tylko tutaj.\n${a.compose(x)}`, { mode: 0o600 });
    say('▸ pobieram obrazy (pierwszy raz może potrwać kilka minut)\n');
    let r = await compose(id, ['pull', '--quiet']);
    if (!r.ok) throw new Error('Nie udało się pobrać obrazów: ' + (r.err || r.out).trim().split('\n').slice(-2).join(' ').slice(0, 300));
    say('▸ uruchamiam\n');
    r = await compose(id, ['up', '-d']);
    done.push(() => compose(id, ['down', '--remove-orphans']));
    if (!r.ok) throw new Error('Kontenery nie wstały: ' + (r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 300));
    if (!(await waitHttp(port, a.id === 'nextcloud' || a.id === 'paperless' ? 600e3 : 240e3, say))) throw new Error('Aplikacja nie odpowiada — szczegóły w logach kontenerów (Logi → docker).');
    say('✓ aplikacja działa — teraz adres i certyfikat\n');
    const made = await C.create({ template: 'kontener', host: chk.host, port, appDir: dirOf(id), dataDir: dataOf(id) }, who, say);
    backupLine(id, true);
    const notes = a.notes ? a.notes(x) : '';
    db.prepare('INSERT INTO sklep(id,app,host,port,slug,created,by,notes) VALUES(?,?,?,?,?,?,?,?)').run(id, a.id, chk.host, port, made.slug, Date.now(), who?.login || '', notes);
    J.add(who, 'strony', `Zainstalowano ${a.name} pod https://${chk.host}/ (sklep z aplikacjami)`, null, '#/sklep');
    say(`✓ ${a.name} gotowe: https://${chk.host}/\n${notes ? notes + '\n' : ''}`);
    return { ok: true, result: { id, host: chk.host, url: `https://${chk.host}/`, notes, ssl: made.ssl } };
  } catch (e) {
    say(`✗ ${e.message} — sprzątam\n`);
    for (const f of done.reverse()) { try { await f(); } catch {} }
    throw e;
  }
}
const rowOf = (id) => { const r = db.prepare('SELECT * FROM sklep WHERE id=?').get(String(id)); if (!r) throw Object.assign(new Error('Nie ma takiej aplikacji.'), { status: 404 }); return r; };
export async function action(id, act, who, say) {
  const r = rowOf(id);
  const name = CATALOG.find((x) => x.id === r.app)?.name || r.app;
  if (act === 'aktualizuj') {
    say(`▸ pobieram nowe wersje ${name}\n`);
    let x = await compose(id, ['pull', '--quiet']); if (!x.ok) throw new Error('Pobranie nie wyszło: ' + String(x.out || '').trim().split('\n').slice(-2).join(' ').slice(0, 300));
    x = await compose(id, ['up', '-d', '--remove-orphans']); if (!x.ok) throw new Error('Uruchomienie nie wyszło: ' + String(x.out || '').trim().split('\n').slice(-2).join(' ').slice(0, 300));
    await run(DOCKER, ['image', 'prune', '-f'], { timeout: 120000 });
    J.add(who, 'strony', `Zaktualizowano ${name} (${r.host})`, null, '#/sklep');
    say('✓ zaktualizowano\n'); return { ok: true };
  }
  if (act === 'restart' || act === 'stop' || act === 'start') {
    const x = await compose(id, [act === 'stop' ? 'stop' : act === 'start' ? 'start' : 'restart']);
    if (!x.ok) throw new Error(String(x.out || '').trim().split('\n').slice(-2).join(' ').slice(0, 300));
    J.add(who, 'strony', `${{ restart: 'Uruchomiono ponownie', stop: 'Zatrzymano', start: 'Uruchomiono' }[act]} ${name} (${r.host})`, null, '#/sklep');
    return { ok: true };
  }
  if (act === 'usun') {
    say(`▸ zatrzymuję ${name}\n`);
    await compose(id, ['down', '--remove-orphans']);
    say('▸ archiwum danych i usunięcie adresu\n');
    if (C.list().find((x) => x.slug === r.slug)) await C.remove(r.slug, say);
    fs.rmSync(dirOf(id), { recursive: true, force: true });
    fs.rmSync(dataOf(id), { recursive: true, force: true });
    backupLine(id, false);
    db.prepare('DELETE FROM sklep WHERE id=?').run(id);
    J.add(who, 'strony', `Usunięto ${name} (${r.host}) — archiwum danych w koszu kopii`, null, '#/sklep');
    say('✓ usunięto\n'); return { ok: true };
  }
  throw new Error('Nieznana czynność.');
}
export async function logs(id) {
  rowOf(id);
  const r = await run(DOCKER, ['compose', '-p', `sklep-${id}`, '-f', path.join(dirOf(id), 'compose.yml'), 'logs', '--no-color', '--tail', '200'], { timeout: 30000 });
  return (r.out + r.err).slice(-60000);
}
