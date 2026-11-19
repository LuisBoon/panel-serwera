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
import YAML from 'yaml';

const DOCKER = process.env.DOCKER_BIN || '/usr/bin/docker';
const APPS = process.env.SKLEP_APPS || '/opt/aplikacje';
const DATA = process.env.SKLEP_DATA || '/var/lib/aplikacje';
const LIST = path.join(DATA_DIR, 'kopie-aplikacji.txt');
const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
let db, OV = null;

export function init(database, { ovh } = {}) {
  db = database; OV = ovh || null;
  db.exec('CREATE TABLE IF NOT EXISTS sklep(id TEXT PRIMARY KEY, app TEXT, host TEXT, port INTEGER, slug TEXT, created INTEGER, by TEXT, notes TEXT)');
  // 1.7: własne aplikacje i serwery gier
  const cols = new Set(db.prepare('PRAGMA table_info(sklep)').all().map((c) => c.name));
  if (!cols.has('kind')) db.exec("ALTER TABLE sklep ADD COLUMN kind TEXT NOT NULL DEFAULT 'sklep'");
  if (!cols.has('meta')) db.exec("ALTER TABLE sklep ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'");
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

/* Serwery gier: port gry wystawiony na świat (Docker sam go otwiera), bez strony i certyfikatu. */
export const GAMES = [
  { id: 'minecraft', name: 'Minecraft Java', icon: 'kilof', cat: 'Gry', desc: 'Serwer Paper dla Minecraft: Java Edition — do ok. 10 graczy, wtyczki działają.', ram: 2048, url: 'https://docker-minecraft-server.readthedocs.io', ports: [[25565, 'tcp']],
    fields: [{ id: 'motd', label: 'Opis serwera (widać go na liście serwerów)', def: 'Serwer znajomych', max: 60 }],
    compose: (x) => `services:
  serwer:
    image: itzg/minecraft-server:latest
    restart: unless-stopped
    mem_limit: 2048m
    tty: true
    stdin_open: true
    environment:
      EULA: "TRUE"
      TYPE: PAPER
      MEMORY: 1536M
      TZ: Europe/Warsaw
      MOTD: ${JSON.stringify(x.f.motd)}
    volumes:
      - ${x.data}/swiat:/data
    ports:
      - "${x.gp[0]}:25565"
`, notes: (x) => `Adres w grze: ${x.addr}${x.gp[0] === 25565 ? '' : ':' + x.gp[0]}\nPierwsze uruchomienie (pobranie Paper i wygenerowanie świata) trwa kilka minut. Konsola: Logi przy serwerze.` },
  { id: 'minecraft-bedrock', name: 'Minecraft Bedrock', icon: 'kilof', cat: 'Gry', desc: 'Serwer dla Minecraft na telefon, konsolę i Windows (Bedrock).', ram: 1024, url: 'https://github.com/itzg/docker-minecraft-bedrock-server', ports: [[19132, 'udp']],
    fields: [{ id: 'nazwa', label: 'Nazwa serwera', def: 'Serwer znajomych', max: 40 }],
    compose: (x) => `services:
  serwer:
    image: itzg/minecraft-bedrock-server:latest
    restart: unless-stopped
    mem_limit: 1024m
    tty: true
    stdin_open: true
    environment:
      EULA: "TRUE"
      SERVER_NAME: ${JSON.stringify(x.f.nazwa)}
      TZ: Europe/Warsaw
    volumes:
      - ${x.data}/swiat:/data
    ports:
      - "${x.gp[0]}:19132/udp"
`, notes: (x) => `W grze: Serwery → Dodaj serwer → adres ${x.addr}, port ${x.gp[0]}.` },
  { id: 'terraria', name: 'Terraria', icon: 'miecz', cat: 'Gry', desc: 'Serwer TShock dla Terrarii — do 8 graczy, świat tworzy się sam.', ram: 512, url: 'https://github.com/ryansheehan/terraria', ports: [[7777, 'tcp']],
    compose: (x) => `services:
  serwer:
    image: ryshe/terraria:latest
    restart: unless-stopped
    mem_limit: 768m
    tty: true
    stdin_open: true
    command: ["-autocreate", "2", "-world", "/root/.local/share/Terraria/Worlds/swiat.wld"]
    volumes:
      - ${x.data}/swiaty:/root/.local/share/Terraria/Worlds
    ports:
      - "${x.gp[0]}:7777"
`, notes: (x) => `W grze: Multiplayer → Join via IP → ${x.addr}, port ${x.gp[0]}.` },
  { id: 'valheim', name: 'Valheim', icon: 'topor', cat: 'Gry', desc: 'Serwer dedykowany Valheim z kopiami świata.', ram: 4096, url: 'https://github.com/lloesche/valheim-server-docker', ports: [[2456, 'udp'], [2457, 'udp']],
    fields: [{ id: 'nazwa', label: 'Nazwa serwera', def: 'Serwer znajomych', max: 40 }, { id: 'haslo', label: 'Hasło do serwera (min. 5 znaków)', def: '', min: 5, max: 40 }],
    compose: (x) => `services:
  serwer:
    image: lloesche/valheim-server:latest
    restart: unless-stopped
    mem_limit: 4608m
    environment:
      SERVER_NAME: ${JSON.stringify(x.f.nazwa)}
      WORLD_NAME: swiat
      SERVER_PASS: ${JSON.stringify(x.f.haslo)}
      TZ: Europe/Warsaw
    volumes:
      - ${x.data}/config:/config
      - ${x.data}/gra:/opt/valheim
    ports:
      - "${x.gp[0]}:2456/udp"
      - "${x.gp[1]}:2457/udp"
`, notes: (x) => `W grze: Dołącz → Dodaj serwer → ${x.addr}:${x.gp[0]}. Hasło: ${x.f.haslo}` },
];
const nameOf = (r) => { if (r.kind === 'wlasna') { try { return JSON.parse(r.meta || '{}').name || r.id; } catch { return r.id; } } return (CATALOG.find((x) => x.id === r.app) || GAMES.find((x) => x.id === r.app))?.name || r.app; };
const iconOf = (r) => r.kind === 'wlasna' ? 'kontener' : (CATALOG.find((x) => x.id === r.app) || GAMES.find((x) => x.id === r.app))?.icon || 'kontener';
const availMb = () => Math.round((S.metrics().mem?.available || 0) / 1048576);

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
    let meta = {}; try { meta = JSON.parse(r.meta || '{}'); } catch {}
    return { ...r, meta: undefined, kind: r.kind || 'sklep', name: nameOf(r), icon: iconOf(r), state, containers, notes: r.notes || '', addr: meta.addr || null, gamePorts: meta.ports || null, image: meta.image || null };
  }));
}
export async function catalog() {
  const m = S.metrics();
  const avail = Math.round((m.mem?.available || 0) / 1048576);
  const inst = db.prepare('SELECT app, COUNT(*) n FROM sklep GROUP BY app').all();
  const fit = (ram) => ram < avail * 0.6 ? 'ok' : ram < avail ? 'warn' : 'bad';
  return { docker: await dockerState(), freeMb: avail, totalMb: Math.round((m.mem?.total || 0) / 1048576), domain: CFG().domena || '', addr: gameAddr(),
    apps: [...CATALOG.map((a) => ({ id: a.id, name: a.name, icon: a.icon, cat: a.cat, desc: a.desc, ram: a.ram, sub: a.sub, url: a.url, installed: inst.find((x) => x.app === a.id)?.n || 0, fit: fit(a.ram) })),
      ...GAMES.map((a) => ({ id: a.id, name: a.name, icon: a.icon, cat: a.cat, desc: a.desc, ram: a.ram, url: a.url, game: true, ports: a.ports, fields: a.fields || [], installed: inst.find((x) => x.app === a.id)?.n || 0, fit: fit(a.ram) }))],
    installed: await list() };
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
  const name = nameOf(r);
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
    if (r.slug) say('▸ archiwum danych i usunięcie adresu\n');
    if (r.slug && C.list().find((x) => x.slug === r.slug)) await C.remove(r.slug, say);
    fs.rmSync(dirOf(id), { recursive: true, force: true });
    fs.rmSync(dataOf(id), { recursive: true, force: true });
    backupLine(id, false);
    db.prepare('DELETE FROM sklep WHERE id=?').run(id);
    J.add(who, 'strony', `Usunięto ${name}${r.host ? ` (${r.host})` : ''}`, null, '#/sklep');
    say('✓ usunięto\n'); return { ok: true };
  }
  throw new Error('Nieznana czynność.');
}
export async function logs(id) {
  rowOf(id);
  const r = await run(DOCKER, ['compose', '-p', `sklep-${id}`, '-f', path.join(dirOf(id), 'compose.yml'), 'logs', '--no-color', '--tail', '200'], { timeout: 30000 });
  return (r.out + r.err).slice(-60000);
}

/* ------------------------------------------------------------ serwery gier */

function gameAddr() { return CFG().domena || S.metrics().ip || 'adres-serwera'; }
async function usedPorts() {
  const out = new Set();
  for (const p of ['-ltnH', '-lunH']) { const r = await run('ss', [p], { timeout: 10000 }); for (const m of r.out.matchAll(/:(\d+)\s/g)) out.add(Number(m[1])); }
  for (const r of db.prepare("SELECT meta FROM sklep WHERE kind='gra'").all()) { try { for (const x of JSON.parse(r.meta).ports || []) out.add(Number(x)); } catch {} }
  return out;
}
export async function installGame({ app: appId, fields = {} }, who, say) {
  const g = GAMES.find((x) => x.id === appId);
  if (!g) throw new Error('Nie ma takiej gry.');
  const st = await dockerState();
  if (!st.running) throw new Error('Najpierw zainstaluj Dockera (przycisk na górze sklepu).');
  if (g.ram > availMb()) throw new Error(`${g.name} potrzebuje ok. ${(g.ram / 1024).toFixed(1).replace('.', ',')} GB pamięci, a wolne jest ${(availMb() / 1024).toFixed(1).replace('.', ',')} GB — strony by na tym ucierpiały.`);
  const f = {};
  for (const x of g.fields || []) {
    const v = String(fields[x.id] ?? x.def ?? '').trim().replace(/[\r\n"\\]/g, '');
    if (x.min && v.length < x.min) throw new Error(`${x.label}: co najmniej ${x.min} znaków.`);
    f[x.id] = v.slice(0, x.max || 60) || x.def;
  }
  let id = g.id; for (let i = 2; db.prepare('SELECT 1 FROM sklep WHERE id=?').get(id) || exists(dirOf(id)); i++) id = `${g.id}-${i}`;
  const used = await usedPorts();
  const gp = g.ports.map(([p]) => { let x = p; while (used.has(x) && x < p + 50) x++; used.add(x); return x; });
  const x = { id, data: dataOf(id), gp, f, addr: gameAddr() };
  const done = [];
  try {
    say(`▸ przygotowuję ${g.name} (${dirOf(id)}, świat w ${dataOf(id)}, port ${gp.map((p, i) => `${p}/${g.ports[i][1]}`).join(', ')})\n`);
    fs.mkdirSync(dirOf(id), { recursive: true, mode: 0o700 }); done.push(() => fs.rmSync(dirOf(id), { recursive: true, force: true }));
    fs.mkdirSync(dataOf(id), { recursive: true, mode: 0o750 }); done.push(() => fs.rmSync(dataOf(id), { recursive: true, force: true }));
    fs.writeFileSync(path.join(dirOf(id), 'compose.yml'), `# ${g.name} — serwer gry ze sklepu panelu serwera (${new Date().toISOString().slice(0, 10)}).\n${g.compose(x)}`, { mode: 0o600 });
    say('▸ pobieram obraz (pierwszy raz może potrwać kilka minut)\n');
    let r = await compose(id, ['pull', '--quiet']);
    if (!r.ok) throw new Error('Nie udało się pobrać obrazu: ' + (r.err || r.out).trim().split('\n').slice(-2).join(' ').slice(0, 300));
    say('▸ uruchamiam\n');
    r = await compose(id, ['up', '-d']);
    done.push(() => compose(id, ['down', '--remove-orphans']));
    if (!r.ok) throw new Error('Serwer nie wstał: ' + (r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 300));
    await new Promise((ok) => setTimeout(ok, 5000));
    const ps = await run(DOCKER, ['compose', '-p', `sklep-${id}`, 'ps', '--format', '{{.State}}'], { timeout: 30000 });
    if (!/running/.test(ps.out)) throw new Error('Kontener gry się wyłączył — szczegóły w logach (Logi → docker).');
    backupLine(id, true);
    const notes = g.notes(x);
    db.prepare('INSERT INTO sklep(id,app,host,port,slug,created,by,notes,kind,meta) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, g.id, '', gp[0], null, Date.now(), who?.login || '', notes, 'gra', JSON.stringify({ ports: gp, protos: g.ports.map((p) => p[1]), addr: `${x.addr}${gp[0] === g.ports[0][0] && g.id === 'minecraft' ? '' : ':' + gp[0]}` }));
    J.add(who, 'strony', `Zainstalowano serwer gry ${g.name} (port ${gp.join(', ')})`, null, '#/sklep');
    say(`✓ ${g.name} działa\n${notes}\n`);
    return { ok: true, result: { id, notes } };
  } catch (e) {
    say(`✗ ${e.message} — sprzątam\n`);
    for (const fn of done.reverse()) { try { await fn(); } catch {} }
    throw e;
  }
}

/* ---------------------------------------------------------- własne aplikacje */

const IMAGE_RE = /^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/;
/** Czy obraz istnieje (Docker Hub: rozmiar i data aktualizacji). */
export async function imageInfo(image) {
  image = String(image || '').trim();
  if (!IMAGE_RE.test(image)) return { ok: false, text: 'To nie wygląda na nazwę obrazu (np. louislam/uptime-kuma:2 albo ghcr.io/firma/aplikacja).' };
  const [ref, tag = 'latest'] = image.split('@')[0].split(/:(?=[^/]+$)/);
  const parts = ref.split('/');
  if (parts.length === 1 || !/[.:]/.test(parts[0]) || parts[0] === 'docker.io') {
    const p = parts[0] === 'docker.io' ? parts.slice(1) : parts;
    const [ns, repo] = p.length === 1 ? ['library', p[0]] : [p[0], p.slice(1).join('/')];
    try {
      const r = await fetch(`https://hub.docker.com/v2/namespaces/${ns}/repositories/${repo}/tags/${encodeURIComponent(tag)}`, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'panel-serwera' } });
      if (r.status === 404) return { ok: false, text: `Nie ma takiego obrazu albo tagu „${tag}” w Docker Hub.` };
      const j = await r.json();
      const days = j.last_updated ? Math.floor((Date.now() - Date.parse(j.last_updated)) / 864e5) : null;
      return { ok: true, size: j.full_size || null, text: `znaleziony · ${j.full_size ? Math.round(j.full_size / 1048576) + ' MB' : '?'}${days != null ? ` · aktualizowany ${days === 0 ? 'dziś' : days + ' dni temu'}` : ''}` };
    } catch { return { ok: null, text: 'Nie udało się sprawdzić w Docker Hub — sprawdzę przy instalacji.' }; }
  }
  if ((await dockerState()).running) { const r = await run(DOCKER, ['manifest', 'inspect', image], { timeout: 30000 }); return r.ok ? { ok: true, text: 'znaleziony' } : { ok: false, text: 'Rejestr nie zna takiego obrazu (albo jest prywatny).' }; }
  return { ok: null, text: 'Ten rejestr sprawdzę przy instalacji.' };
}

/** Wklejony docker-compose: poprawia to, co groźne, odrzuca to, czego nie da się bezpiecznie uruchomić. */
export function sanitizeCompose(text, { data, port, host }) {
  let doc;
  try { doc = YAML.parse(String(text || '')); } catch (e) { throw new Error('To nie jest poprawny plik YAML: ' + String(e.message).split('\n')[0]); }
  if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') throw new Error('W pliku nie ma sekcji „services”.');
  const checks = [];
  const ok = (title, text) => checks.push({ k: 'ok', title, text });
  const warn = (title, text) => checks.push({ k: 'warn', title, text });
  for (const k of Object.keys(doc)) if (!['services', 'volumes', 'networks', 'name', 'version'].includes(k) && !k.startsWith('x-')) throw new Error(`Sekcja „${k}” nie jest obsługiwana — zostaw services (i ewentualnie volumes, networks).`);
  delete doc.name; delete doc.version;
  for (const [n, net] of Object.entries(doc.networks || {})) if (net?.external || net?.driver === 'host') throw new Error(`Sieć „${n}”: tylko własne sieci aplikacji (bez external i host).`);
  const names = Object.keys(doc.services);
  if (!names.length || names.length > 8) throw new Error('Plik musi mieć od 1 do 8 usług.');
  const safe = (x) => String(x).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  const mapHost = (src, n) => {
    src = String(src);
    if (src === '/var/run/docker.sock' || src.endsWith('docker.sock')) throw new Error(`Usługa ${n}: dostęp do Dockera (docker.sock) to pełna władza nad serwerem — tego nie instaluję.`);
    if (src.startsWith('~')) throw new Error(`Usługa ${n}: folder ${src} — kontener może korzystać tylko z własnego folderu danych.`);
    if (src.startsWith('./') || src === '.' || src.startsWith('../')) { if (src.includes('..')) throw new Error(`Usługa ${n}: ścieżka ${src} wychodzi poza folder aplikacji.`); return path.join(data, src.replace(/^\.\/?/, '') || 'dane'); }
    if (src.startsWith('/')) { const r = path.resolve(src); if (r === data || r.startsWith(data + '/')) return r; throw new Error(`Usługa ${n}: folder ${src} z serwera — kontener może korzystać tylko z własnego folderu danych (${data}).`); }
    return path.join(data, safe(src)); // nazwany wolumen → folder (trafia do kopii)
  };
  let web = null, named = false;
  for (const n of names) {
    const s = doc.services[n];
    if (!s || typeof s !== 'object') throw new Error(`Usługa ${n} jest pusta.`);
    if (s.build) throw new Error(`Usługa ${n}: budowanie z kodu (build) nie jest obsługiwane — podaj gotowy obraz (image).`);
    if (!s.image || !IMAGE_RE.test(String(s.image))) throw new Error(`Usługa ${n}: brak albo zła nazwa obrazu (image).`);
    for (const k of ['env_file', 'extends', 'secrets', 'configs', 'volumes_from']) if (s[k]) throw new Error(`Usługa ${n}: „${k}” nie jest obsługiwane — wpisz ustawienia wprost (environment).`);
    for (const k of ['network_mode', 'pid', 'ipc', 'userns_mode', 'uts', 'cgroup']) if (s[k] && /^(host|container:|service:)/.test(String(s[k]))) throw new Error(`Usługa ${n}: ${k}: ${s[k]} — kontener widziałby cały serwer. Tego nie instaluję.`);
    if (s.devices) throw new Error(`Usługa ${n}: dostęp do urządzeń serwera (devices) — tego nie instaluję.`);
    if (s.privileged) { delete s.privileged; warn('Usunięte privileged: true', `${n}: daje kontenerowi pełną władzę nad serwerem — zostaw tylko, jeśli wiesz po co (wtedy instaluj ręcznie).`); }
    for (const k of ['cap_add', 'security_opt', 'sysctls']) if (s[k]) { delete s[k]; warn(`Usunięte ${k}`, `${n}: dodatkowe uprawnienia jądra — bez nich zwykle też działa.`); }
    delete s.container_name;
    if (Array.isArray(s.volumes)) s.volumes = s.volumes.map((v) => {
      if (typeof v === 'object' && v) { if (v.type === 'tmpfs') return v; if (v.source) { if (v.type !== 'bind' && !String(v.source).includes('/')) named = true; v.source = mapHost(v.source, n); v.type = 'bind'; } return v; }
      const parts = String(v).split(':');
      if (parts.length === 1) return String(v); // anonimowy — znika z kontenerem
      if (!parts[0].includes('/') && !parts[0].startsWith('.')) named = true;
      return [mapHost(parts[0], n), ...parts.slice(1)].join(':');
    });
    if (Array.isArray(s.ports)) {
      const keep = [];
      for (const p of s.ports) {
        const str = typeof p === 'object' && p ? `${p.published ? p.published + ':' : ''}${p.target}${p.protocol === 'udp' ? '/udp' : ''}` : String(p);
        const m = str.match(/^(?:(?:\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]+\]):)?(?:(\d+)(?:-\d+)?:)?(\d+)(?:-\d+)?(?:\/(tcp|udp))?$/);
        if (!m) throw new Error(`Usługa ${n}: nie rozumiem portu „${str}”.`);
        if (m[3] === 'udp') { warn('Usunięty port UDP', `${n}: ${str} — aplikacja jest wystawiana tylko przez https.`); continue; }
        if (!web) { web = { svc: n, cport: Number(m[2]) }; keep.push(`127.0.0.1:${port}:${m[2]}`); ok(`Port przestawiony na 127.0.0.1:${port}`, `z internetu tylko przez https na ${host || 'adresie aplikacji'}`); }
        else warn('Usunięty dodatkowy port', `${n}: ${str} — z zewnątrz widać jeden port, przez https.`);
      }
      if (keep.length) s.ports = keep; else delete s.ports;
    }
    const lim = s.mem_limit || s.deploy?.resources?.limits?.memory;
    if (!lim) { s.mem_limit = '512m'; ok('Dodany limit pamięci 512 MB', `${n}: żeby nie zjadła pamięci stronom`); }
    if (!s.restart) s.restart = 'unless-stopped';
  }
  if (!web) throw new Error('Żadna usługa nie wystawia portu (ports) — nie wiem, gdzie aplikacja odpowiada.');
  if (named) ok('Wolumeny zamienione na foldery', `dane w ${data} — trafiają do nocnej kopii`);
  delete doc.volumes;
  return { text: YAML.stringify(doc), checks, cport: web.cport };
}

/** Własna aplikacja: z formularza (jeden obraz) albo z wklejonego compose. Tylko przez https, z limitem pamięci i kopiami. */
export async function installCustom(b, who, say) {
  const st = await dockerState();
  if (!st.running) throw new Error('Najpierw zainstaluj Dockera (przycisk na górze sklepu).');
  const label = String(b.name || '').trim().slice(0, 40);
  const base = (label || String(b.image || 'aplikacja').split('/').pop().split(':')[0]).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'aplikacja';
  const h = String(b.host || '').trim().toLowerCase();
  const chk = await C.check({ template: 'kontener', host: h, port: 9100 });
  if (!chk.ok) throw new Error(chk.problems.join(' '));
  let id = /^[a-z]/.test(base) ? base : 'a-' + base; for (let i = 2; db.prepare('SELECT 1 FROM sklep WHERE id=?').get(id) || exists(dirOf(id)); i++) id = `${base}-${i}`;
  if (!ID_RE.test(id)) throw new Error('Nieprawidłowa nazwa — użyj liter i cyfr.');
  const port = await C.nextPort();
  const data = dataOf(id);
  let text, image = null, meta;
  if (b.compose) {
    const r = sanitizeCompose(b.compose, { data, port, host: chk.host });
    text = r.text;
    for (const c of r.checks) say(`  ${c.k === 'ok' ? '✓' : '⚠'} ${c.title} — ${c.text}\n`);
    meta = { name: label || id, source: 'compose' };
  } else {
    image = String(b.image || '').trim();
    if (!IMAGE_RE.test(image)) throw new Error('Nieprawidłowa nazwa obrazu.');
    const cport = Number(b.cport);
    if (!Number.isInteger(cport) || cport < 1 || cport > 65535) throw new Error('Port w kontenerze: 1–65535.');
    const mem = Number(b.mem || 512);
    if (!Number.isInteger(mem) || mem < 64 || mem > 8192) throw new Error('Pamięć: 64–8192 MB.');
    if (mem > availMb()) throw new Error(`Wolne jest tylko ${availMb()} MB pamięci.`);
    const folder = String(b.folder || '').trim();
    if (folder && !/^\/[A-Za-z0-9._/-]{1,200}$/.test(folder)) throw new Error('Folder na dane: ścieżka w kontenerze, np. /data.');
    const env = {};
    for (const line of String(b.env || '').split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'))) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]{0,63})=(.*)$/);
      if (!m) throw new Error(`Zmienna „${line.slice(0, 40)}”: zapis NAZWA=wartość.`);
      env[m[1]] = m[2];
    }
    if (Object.keys(env).length > 60) throw new Error('Za dużo zmiennych (najwyżej 60).');
    const svc = { image, restart: 'unless-stopped', mem_limit: `${mem}m`, ...(Object.keys(env).length ? { environment: env } : {}), ...(folder ? { volumes: [`${data}/dane:${folder}`] } : {}), ports: [`127.0.0.1:${port}:${cport}`] };
    text = YAML.stringify({ services: { app: svc } });
    meta = { name: label || id, image, source: 'formularz' };
  }
  const done = [];
  try {
    say(`▸ przygotowuję ${meta.name} (${dirOf(id)}, dane w ${data}, port 127.0.0.1:${port})\n`);
    fs.mkdirSync(dirOf(id), { recursive: true, mode: 0o700 }); done.push(() => fs.rmSync(dirOf(id), { recursive: true, force: true }));
    fs.mkdirSync(data, { recursive: true, mode: 0o750 }); done.push(() => fs.rmSync(data, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dirOf(id), 'compose.yml'), `# ${meta.name} — własna aplikacja z panelu serwera (${new Date().toISOString().slice(0, 10)}).\n${text}`, { mode: 0o600 });
    say('▸ pobieram obrazy\n');
    let r = await compose(id, ['pull', '--quiet']);
    if (!r.ok) throw new Error('Nie udało się pobrać obrazu: ' + (r.err || r.out).trim().split('\n').slice(-2).join(' ').slice(0, 300));
    say('▸ uruchamiam\n');
    r = await compose(id, ['up', '-d']);
    done.push(() => compose(id, ['down', '--remove-orphans']));
    if (!r.ok) throw new Error('Kontenery nie wstały: ' + (r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 300));
    if (!(await waitHttp(port, 300e3, say))) throw new Error('Aplikacja nie odpowiada na porcie z pliku — sprawdź port i logi kontenera.');
    say('✓ aplikacja działa — teraz adres i certyfikat\n');
    const made = await C.create({ template: 'kontener', host: chk.host, port, appDir: dirOf(id), dataDir: data }, who, say);
    backupLine(id, true);
    db.prepare('INSERT INTO sklep(id,app,host,port,slug,created,by,notes,kind,meta) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, 'wlasna', chk.host, port, made.slug, Date.now(), who?.login || '', '', 'wlasna', JSON.stringify(meta));
    J.add(who, 'strony', `Zainstalowano własną aplikację ${meta.name} pod https://${chk.host}/`, null, '#/sklep');
    say(`✓ ${meta.name} gotowe: https://${chk.host}/\n`);
    return { ok: true, result: { id, host: chk.host, url: `https://${chk.host}/` } };
  } catch (e) {
    say(`✗ ${e.message} — sprzątam\n`);
    for (const fn of done.reverse()) { try { await fn(); } catch {} }
    throw e;
  }
}
