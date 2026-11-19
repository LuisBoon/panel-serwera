// Stan serwera: zasoby, usługi, procesy testowe, strony, certyfikaty, harmonogram, dysk, logi.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { run, cached, readText, exists, stat } from './util.mjs';
import { C as CFG } from './config.mjs';

/* ------------------------------------------------------------------ zasoby */

function readCpu() {
  const f = readText('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  return { idle: f[3] + (f[4] || 0), total: f.reduce((a, b) => a + b, 0) };
}
function meminfo() {
  const m = {};
  for (const l of readText('/proc/meminfo').split('\n')) {
    const x = l.match(/^(\w+):\s+(\d+)/);
    if (x) m[x[1]] = Number(x[2]) * 1024;
  }
  return m;
}

let prevCpu = readCpu();
let cpuPct = 0;
const history = []; // co minutę: {t, cpu, mem}
let minuteAcc = [];
setInterval(() => {
  const c = readCpu();
  const dt = c.total - prevCpu.total;
  cpuPct = dt > 0 ? Math.max(0, Math.min(100, (1 - (c.idle - prevCpu.idle) / dt) * 100)) : 0;
  prevCpu = c;
  minuteAcc.push(cpuPct);
  if (minuteAcc.length >= 12) {
    const m = meminfo();
    history.push({ t: Date.now(), cpu: minuteAcc.reduce((a, b) => a + b, 0) / minuteAcc.length, mem: (m.MemTotal - m.MemAvailable) / m.MemTotal * 100 });
    if (history.length > 24 * 60) history.shift();
    minuteAcc = [];
  }
}, 5000).unref();

const OS_NAME = (readText('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)/m) || [])[1] || 'Linux';

function publicIp() {
  const priv = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !priv.test(a.address)) return a.address;
  }
  return '';
}

export function metrics() {
  const m = meminfo();
  const s = fs.statfsSync('/');
  const load = readText('/proc/loadavg').split(' ').slice(0, 3).map(Number);
  return {
    host: os.hostname(), os: OS_NAME, ip: publicIp(),
    uptime: Number(readText('/proc/uptime').split(' ')[0]) || 0,
    cpu: { pct: Math.round(cpuPct * 10) / 10, cores: os.cpus().length, load },
    mem: { total: m.MemTotal, available: m.MemAvailable, used: m.MemTotal - m.MemAvailable },
    swap: { total: m.SwapTotal || 0, used: (m.SwapTotal || 0) - (m.SwapFree || 0) },
    disk: { total: s.blocks * s.bsize, free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize },
    history: history.slice(-180),
  };
}

/* ------------------------------------------------------------------ usługi */

// znane usługi: wspólne dla każdego serwera + własne z konfiguracji (aplikacje)
const BASE_APPS = {
  'panel-serwera': ['Ten panel', 'panel do zarządzania serwerem', 'app'],
  'wings': ['Panel gier — Wings', 'serwery gier Pterodactyl', 'app'],
  'apache2': ['Serwer WWW', 'Apache — obsługuje wszystkie strony', 'srv'],
  'mariadb': ['Bazy MariaDB', 'bazy danych stron', 'srv'],
  'php8.3-fpm': ['PHP 8.3', 'strony napisane w PHP', 'srv'],
  'redis-server': ['Redis', 'szybka pamięć podręczna', 'srv'],
  'coturn': ['Rozmowy (TURN)', 'połączenia głosowe i wideo', 'srv'],
  'postgresql': ['PostgreSQL', 'bazy danych', 'srv'],
  'mongod': ['MongoDB', 'bazy dokumentów', 'srv'],
  'nginx': ['nginx', 'serwer WWW', 'srv'],
  'exim4': ['Poczta', 'wysyłanie maili z serwera', 'srv'],
  'spamd': ['Filtr spamu', 'SpamAssassin', 'srv'],
  'fail2ban': ['Ochrona logowania', 'blokuje adresy, które zgadują hasła', 'srv'],
  'tailscaled': ['Tailscale', 'prywatna sieć (VPN)', 'srv'],
  'unbound': ['DNS lokalny', 'Unbound', 'srv'],
  'ssh': ['SSH', 'zdalny dostęp do serwera', 'srv'],
  'cron': ['Harmonogram', 'zadania uruchamiane o stałych porach', 'srv'],
};
export const APPS = new Proxy({}, {
  get: (_, k) => ({ ...BASE_APPS, ...(CFG().aplikacje || {}) })[k],
  has: (_, k) => k in { ...BASE_APPS, ...(CFG().aplikacje || {}) },
  ownKeys: () => Reflect.ownKeys({ ...BASE_APPS, ...(CFG().aplikacje || {}) }),
  getOwnPropertyDescriptor: (_, k) => { const v = ({ ...BASE_APPS, ...(CFG().aplikacje || {}) })[k]; return v ? { value: v, enumerable: true, configurable: true } : undefined; },
});
// Tych usług nie wolno zatrzymać z panelu (odcięłoby dostęp do serwera albo do panelu).
export const NO_STOP = new Set(['ssh', 'sshd', 'tailscaled', 'panel-serwera', 'apache2', 'dbus', 'systemd-journald', 'systemd-logind', 'systemd-networkd', 'systemd-resolved', 'networking']);
const NOISE = /^(systemd-|getty@|serial-getty@|user@|user-runtime-dir@|modprobe@|dbus|polkit|apparmor|apt-|dpkg|e2scrub|fstrim|ifup@|keyboard-setup|kmod|lvm2|networking|plymouth|rc-local|setvtrgb|ssh-|console-|logrotate|man-db|ufw|udisks|upower|packagekit|ModemManager|motd|rsync|snapd|snap\.|unattended|wpa_|finalrd|cryptdisks|initrd|blk-|grub|emergency|rescue|quotaon|sysstat|ldconfig|kexec|fwupd|cloud-|qemu|open-vm|vgauth|avahi|phpsessionclean|certbot|exim4-base|apache-htcacheclean|gibcord-pobierz|php8\.3-fpm-|sendmail|nftables|iptables|netfilter|haveged|rng-tools|lm-sensors|irqbalance|mdmonitor|multipathd|accounts-daemon|alsa|bluetooth|cups|smartmontools|rtkit|chrony|ntp|e2fsck|dm-event|systemd)/;

const UNIT_RE = /^[A-Za-z0-9@._:-]+$/;

function parseShow(out) {
  const res = [];
  for (const block of out.split(/\n\n+/)) {
    const o = {};
    for (const l of block.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
    if (o.Id) res.push(o);
  }
  return res;
}

export const services = cached(4000, async () => {
  const r = await run('systemctl', ['list-units', '--type=service', '--all', '--output=json', '--no-pager']);
  let units = [];
  try { units = JSON.parse(r.out || '[]'); } catch { units = []; }
  units = units.filter((u) => u.load === 'loaded' && UNIT_RE.test(u.unit));
  // zatrzymane usługi dodane ręcznie systemd potrafi „wyładować” — dokładamy je z /etc/systemd/system
  const seen = new Set(units.map((u) => u.unit));
  try {
    for (const f of fs.readdirSync('/etc/systemd/system')) {
      if (f.endsWith('.service') && !f.includes('@') && UNIT_RE.test(f) && !seen.has(f)) units.push({ unit: f });
    }
  } catch {}
  if (!units.length) return [];
  const sh = await run('systemctl', ['show', '--timestamp=unix', '-p',
    'Id,ActiveState,SubState,MemoryCurrent,ActiveEnterTimestamp,UnitFileState,Description,MainPID,NRestarts,Result,FragmentPath',
    ...units.map((u) => u.unit)]);
  const list = [];
  for (const o of parseShow(sh.out)) {
    const id = o.Id.replace(/\.service$/, '');
    const known = APPS[id];
    const failed = o.ActiveState === 'failed';
    const active = o.ActiveState === 'active' || o.ActiveState === 'activating' || o.ActiveState === 'reloading';
    const enabled = o.UnitFileState === 'enabled';
    const custom = String(o.FragmentPath || '').startsWith('/etc/systemd/system/'); // usługi dodane ręcznie — pokazujemy też zatrzymane
    if (!known && !failed && (NOISE.test(id) || (!active && !enabled && !custom))) continue;
    if (!known && o.SubState === 'exited') continue; // jednorazowe skrypty startowe
    const mem = Number(o.MemoryCurrent);
    const since = Number(String(o.ActiveEnterTimestamp || '').replace('@', '')) || 0;
    list.push({
      unit: id,
      name: known ? known[0] : (o.Description || id),
      desc: known ? known[1] : id,
      group: known ? known[2] : 'other',
      state: o.ActiveState, sub: o.SubState,
      active, failed, enabled,
      mem: Number.isFinite(mem) && mem < 2 ** 60 ? mem : null,
      since: active && since ? since * 1000 : null,
      pid: Number(o.MainPID) || null,
      restarts: Number(o.NRestarts) || 0,
      result: o.Result || '',
      canStop: !NO_STOP.has(id) && !id.startsWith('systemd-'),
    });
  }
  const order = { app: 0, srv: 1, other: 2 };
  list.sort((a, b) => order[a.group] - order[b.group] || (b.mem || 0) - (a.mem || 0));
  return list;
});

export async function serviceAction(unit, action) {
  if (!UNIT_RE.test(unit)) throw new Error('Nieprawidłowa nazwa usługi.');
  if (!['restart', 'stop', 'start', 'reload'].includes(action)) throw new Error('Nieznana akcja.');
  const list = await services(true);
  const s = list.find((x) => x.unit === unit);
  if (!s) throw new Error('Nie ma takiej usługi na liście.');
  if (action === 'stop' && !s.canStop) throw new Error('Tej usługi nie można zatrzymać z panelu — straciłbyś dostęp. Można ją tylko uruchomić ponownie.');
  if (unit === 'apache2' && (action === 'restart' || action === 'reload')) {
    const t = await run('apache2ctl', ['configtest']);
    if (!t.ok) throw new Error('Konfiguracja Apache ma błąd, więc go nie restartuję (strony by nie wstały):\n' + t.err.trim());
  }
  if (unit === 'panel-serwera') {
    setTimeout(() => run('systemctl', [action === 'stop' ? 'restart' : action, 'panel-serwera']), 600);
    return { ok: true, out: 'Panel uruchomi się ponownie za chwilę.' };
  }
  const r = await run('systemctl', [action, unit + '.service'], { timeout: 90000 });
  services.reset();
  if (!r.ok) {
    const st = await run('systemctl', ['status', '--no-pager', '-n', '15', unit + '.service']);
    throw new Error(`systemctl ${action} ${unit} nie powiódł się.\n${r.err.trim()}\n\n${st.out.trim()}`);
  }
  return { ok: true, out: r.out };
}

/* ------------------------------------------------------- procesy testowe */

const TEST_ROOT = '/tmp/claude-0/';
let BOOT = 0;
try { BOOT = Number((readText('/proc/stat').match(/^btime (\d+)/m) || [])[1]) || 0; } catch {}

function procInfo(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (!cmd.length) return null;
    let cwd = '';
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
    const st = readText(`/proc/${pid}/stat`);
    const after = st.slice(st.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(after[1]);
    const startTicks = Number(after[19]);
    const rss = Number((readText(`/proc/${pid}/status`).match(/^VmRSS:\s+(\d+)/m) || [])[1] || 0) * 1024;
    return { pid, ppid, cmd, cwd, rss, start: (BOOT + startTicks / 100) * 1000 };
  } catch { return null; }
}

function isTestProc(p) {
  if (!p || p.pid === process.pid) return false;
  const exe = path.basename(p.cmd[0]);
  if (!/^(node|bash|sh|python3?|chromium|chrome|electron)$/.test(exe)) return false;
  const joined = p.cmd.join(' ');
  if (/\.local\/share\/claude|claude-code|\/claude\b/.test(joined)) return false;
  return joined.includes(TEST_ROOT) || p.cwd.startsWith(TEST_ROOT);
}

export async function testProcs() {
  const ports = new Map();
  const ss = await run('ss', ['-ltnpH']);
  for (const l of ss.out.split('\n')) {
    const port = (l.split(/\s+/)[3] || '').split(':').pop();
    for (const m of l.matchAll(/pid=(\d+)/g)) {
      const pid = Number(m[1]);
      if (!ports.has(pid)) ports.set(pid, new Set());
      ports.get(pid).add(Number(port));
    }
  }
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const p = procInfo(Number(d));
    if (!isTestProc(p)) continue;
    const where = (p.cmd.find((a) => a.includes(TEST_ROOT)) || p.cwd);
    const session = (where.match(/claude-0\/[^/]+\/([0-9a-f]{8})/) || [])[1] || '';
    out.push({
      pid: p.pid, ppid: p.ppid, rss: p.rss, start: p.start, session,
      ports: [...(ports.get(p.pid) || [])].sort((a, b) => a - b),
      what: p.cmd.map((a) => a.replace(/^\/tmp\/claude-0\/[^/]+\/[^/]+\/scratchpad\//, '…/')).join(' ').slice(0, 160),
    });
  }
  out.sort((a, b) => b.rss - a.rss);
  return out;
}

export async function killTestProcs(pids) {
  const killed = [];
  for (const pid of pids) {
    const p = procInfo(Number(pid));
    if (!isTestProc(p)) continue; // sprawdzamy ponownie, żeby nie zabić czegoś innego
    try { process.kill(p.pid, 'SIGTERM'); killed.push(p.pid); } catch {}
  }
  return killed;
}

/* ------------------------------------------------------------------ strony */

const AV = '/etc/apache2/sites-available';
const EN = '/etc/apache2/sites-enabled';

function parseConf(file) {
  const txt = readText(file).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const res = [];
  for (const m of txt.matchAll(/<VirtualHost\s+([^>]+)>([\s\S]*?)<\/VirtualHost>/gi)) {
    const body = m[2];
    const one = (k) => ((body.match(new RegExp(`^\\s*${k}\\s+(.+)$`, 'mi')) || [])[1] || '').trim().replace(/^"|"$/g, '');
    const all = (k) => [...body.matchAll(new RegExp(`^\\s*${k}\\s+(.+)$`, 'gmi'))].map((x) => x[1].trim());
    const fixLog = (p) => p.replace(/^"|"$/g, '').replace('${APACHE_LOG_DIR}', '/var/log/apache2');
    res.push({
      port: Number((m[1].match(/:(\d+)/) || [])[1] || 80),
      name: one('ServerName').toLowerCase(),
      aliases: all('ServerAlias').flatMap((s) => s.toLowerCase().split(/\s+/)),
      root: one('DocumentRoot'),
      proxies: all('ProxyPass').map((s) => s.split(/\s+/)[1]).filter((x) => x && x !== '!' && /^(https?|wss?):/.test(x)),
      logs: [...all('CustomLog').map((s) => s.split(/\s+/)[0]), ...all('ErrorLog').map((s) => s.split(/\s+/)[0])].map(fixLog),
      redirectsToHttps: /RewriteRule[^\n]*https:\/\//i.test(body) || /Redirect[^\n]*https:\/\//i.test(body),
    });
  }
  return res;
}

async function portUnits() {
  const map = new Map();
  const ss = await run('ss', ['-ltnpH']);
  for (const l of ss.out.split('\n')) {
    const port = Number((l.split(/\s+/)[3] || '').split(':').pop());
    const pid = Number((l.match(/pid=(\d+)/) || [])[1]);
    if (!port || !pid || map.has(port)) continue;
    const cg = readText(`/proc/${pid}/cgroup`);
    const unit = (cg.match(/\/([^/\n]+)\.service/) || [])[1];
    if (unit) map.set(port, unit);
  }
  return map;
}

function projectDir(root) {
  const m = String(root || '').match(/^(\/var\/www\/[^/]+)/);
  return m ? m[1] : root || '';
}

export function siteConfigs() {
  const enabled = new Set(fs.readdirSync(EN));
  const by = new Map();
  const files = fs.readdirSync(AV).filter((x) => x.endsWith('.conf')).sort();
  const parsed = new Map(files.map((f) => [f, parseConf(path.join(AV, f))]));
  // vhost bez ServerName (np. 000-default.conf na porcie 80) bierze nazwę z bliźniaczego pliku -le-ssl
  const baseName = new Map();
  for (const [f, vs] of parsed) { const n = vs.find((v) => v.name)?.name; if (n) baseName.set(f.replace(/(-le-ssl)?\.conf$/, ''), n); }
  for (const f of files) {
    for (const v of parsed.get(f)) {
      const base = f.replace(/(-le-ssl)?\.conf$/, '');
      const name = v.name || baseName.get(base) || base;
      if (!v.name && !baseName.has(base) && !enabled.has(f)) continue; // nieużywany szablon Debiana (default-ssl)
      let s = by.get(name);
      if (!s) by.set(name, s = { name, aliases: new Set(), files: new Map(), roots: new Set(), proxies: new Set(), logs: new Set(), ports: new Set(), redirectsToHttps: false });
      v.aliases.forEach((a) => a !== name && s.aliases.add(a));
      s.files.set(f, { file: f, enabled: enabled.has(f) });
      if (v.root) s.roots.add(v.root);
      v.proxies.forEach((p) => s.proxies.add(p));
      v.logs.forEach((p) => s.logs.add(p));
      s.ports.add(v.port);
      if (v.port === 80 && v.redirectsToHttps) s.redirectsToHttps = true;
    }
  }
  return [...by.values()].map((s) => ({
    name: s.name,
    aliases: [...s.aliases],
    files: [...s.files.values()],
    enabled: [...s.files.values()].some((f) => f.enabled),
    https: s.ports.has(443),
    root: [...s.roots][0] || '',
    dir: projectDir([...s.roots][0]),
    proxies: [...s.proxies],
    logs: [...s.logs].filter((p) => p.startsWith('/var/log/')),
  }));
}

async function checkHttp(host, https) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${https ? 'https' : 'http'}://${host}/`, {
      redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'panel-serwera/1 (sprawdzanie stanu)' },
    });
    try { await r.body?.cancel(); } catch {}
    return { code: r.status, ms: Date.now() - t0, location: r.headers.get('location') || '' };
  } catch (e) {
    return { code: 0, ms: Date.now() - t0, error: e.cause?.code || e.name || 'błąd' };
  }
}

function checkTls(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port: 443, servername: host, rejectUnauthorized: false, timeout: 6000 }, () => {
      const c = s.getPeerCertificate();
      const bad = c && c.subject ? tls.checkServerIdentity(host, c) : new Error('brak');
      resolve({ validTo: c?.valid_to ? new Date(c.valid_to).getTime() : null, issuer: c?.issuer?.O || c?.issuer?.CN || '', matches: !bad });
      s.end();
    });
    s.on('error', (e) => resolve({ error: e.code || e.message }));
    s.on('timeout', () => { s.destroy(); resolve({ error: 'timeout' }); });
  });
}

export function classify(code, error) {
  if (!code && error === 'ENOTFOUND') return 'nodns';
  if (!code) return 'down';
  if (code >= 500) return 'down';
  if (code >= 400) return 'warn';
  if (code >= 300) return 'redirect';
  return 'ok';
}

export const sites = cached(60000, async () => {
  const conf = siteConfigs();
  const units = await portUnits();
  const sizes = duSnapshot();
  return Promise.all(conf.map(async (s) => {
    const [http, cert] = s.enabled
      ? await Promise.all([checkHttp(s.name, s.https), s.https ? checkTls(s.name) : null])
      : [null, null];
    const svc = new Set();
    for (const p of s.proxies) { const port = Number((p.match(/:(\d+)/) || [])[1]); if (units.has(port)) svc.add(units.get(port)); }
    return {
      ...s, http, cert,
      status: s.enabled ? classify(http?.code, http?.error) : 'off',
      services: [...svc],
      size: sizes ? sizes.get(s.dir) ?? null : null,
    };
  }));
});

const SITE_RE = /^[a-z0-9.-]+$/;

export async function setSiteEnabled(name, on, protectedNames = []) {
  if (!SITE_RE.test(name)) throw new Error('Nieprawidłowa nazwa strony.');
  const s = siteConfigs().find((x) => x.name === name);
  if (!s) throw new Error('Nie ma takiej strony.');
  if (!on && protectedNames.some((p) => p === name || s.aliases.includes(p))) throw new Error('Tej strony nie można wyłączyć — przez nią działa panel.');
  const files = s.files.map((f) => f.file.replace(/\.conf$/, ''));
  const r = await run(on ? 'a2ensite' : 'a2dissite', ['-q', ...files]);
  if (!r.ok) throw new Error(r.err || 'a2ensite/a2dissite nie powiódł się');
  const t = await run('apache2ctl', ['configtest']);
  if (!t.ok) {
    await run(on ? 'a2dissite' : 'a2ensite', ['-q', ...files]);
    throw new Error('Po zmianie konfiguracja Apache miała błąd — cofnąłem zmianę.\n' + t.err.trim());
  }
  const rl = await run('systemctl', ['reload', 'apache2']);
  sites.reset();
  if (!rl.ok) throw new Error('Nie udało się przeładować Apache: ' + rl.err);
  return { ok: true };
}

/* ------------------------------------------------------------- certyfikaty */

export const certs = cached(10 * 60000, async () => {
  const list = [];
  const cb = await run('certbot', ['certificates'], { timeout: 60000 });
  for (const block of cb.out.split(/Certificate Name:/).slice(1)) {
    const name = block.split('\n')[0].trim();
    const domains = ((block.match(/Domains:\s*(.+)/) || [])[1] || '').trim().split(/\s+/);
    const exp = (block.match(/Expiry Date:\s*([0-9-]+ [0-9:]+)/) || [])[1];
    list.push({ tool: 'certbot', name, domains, validTo: exp ? Date.parse(exp.replace(' ', 'T') + 'Z') : null });
  }
  if (exists('/root/.acme.sh/acme.sh')) {
    const a = await run('/root/.acme.sh/acme.sh', ['--list', '--listraw'], { timeout: 30000 });
    for (const l of a.out.split('\n').slice(1)) {
      const f = l.split('|');
      if (!f[0]) continue;
      const domains = [f[0], ...((f[2] && f[2] !== 'no') ? f[2].split(',') : [])];
      const conf = readText(`/root/.acme.sh/${f[0]}_ecc/${f[0]}.conf`) || readText(`/root/.acme.sh/${f[0]}/${f[0]}.conf`);
      const next = Number((conf.match(/Le_NextRenewTime='?(\d+)/) || [])[1]) * 1000 || null;
      list.push({ tool: 'acme.sh', name: f[0], domains, validTo: null, nextRenew: next });
    }
  }
  return list;
});

export async function renewCert(name) {
  if (!SITE_RE.test(name)) throw new Error('Nieprawidłowa nazwa.');
  const c = (await certs()).find((x) => x.name === name);
  if (!c) throw new Error('Nie ma takiego certyfikatu.');
  return c.tool === 'certbot'
    ? ['certbot', ['renew', '--cert-name', name, '--no-random-sleep-on-renew']]
    : ['/root/.acme.sh/acme.sh', ['--renew', '-d', name, '--home', '/root/.acme.sh']];
}

/* ------------------------------------------------------------ harmonogram */

function humanCron(e) {
  const map = { '@reboot': 'przy starcie serwera', '@daily': 'codziennie o północy', '@hourly': 'co godzinę', '@weekly': 'co tydzień', '@monthly': 'co miesiąc' };
  if (map[e]) return map[e];
  const [mi, h, dom, mon, dow] = e.split(/\s+/);
  const p = (n) => String(n).padStart(2, '0');
  const days = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];
  if (mi === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'co minutę';
  let m;
  if ((m = mi.match(/^\*\/(\d+)$/)) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `co ${m[1]} min`;
  if (/^\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `co godzinę (o :${p(mi)})`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(h)) {
    const at = `${p(h)}:${p(mi)}`;
    if (dom === '*' && mon === '*' && dow === '*') return `codziennie o ${at}`;
    if (dom === '*' && mon === '*' && /^\d$/.test(dow)) return `co tydzień (${days[Number(dow)]}) o ${at}`;
    if (/^\d+$/.test(dom) && mon === '*' && dow === '*') return `co miesiąc (${dom}. dnia) o ${at}`;
  }
  return e;
}

export async function cronList() {
  const items = [];
  const add = (source, line, desc) => {
    line = line.trim();
    if (!line || line.startsWith('#') || /^[A-Z_]+=/.test(line)) return;
    let m = line.match(/^(@\w+)\s+(.+)$/) || line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
    if (!m) return;
    let [, when, rest] = m;
    let user = 'root';
    if (source !== 'crontab root') { const sp = rest.indexOf(' '); user = rest.slice(0, sp); rest = rest.slice(sp + 1); }
    items.push({ source, when, human: humanCron(when), user, cmd: rest, desc });
  };
  for (const f of fs.readdirSync('/etc/cron.d').filter((x) => !x.startsWith('.'))) {
    const txt = readText(path.join('/etc/cron.d', f));
    const desc = ((txt.match(/^#\s*(.+)$/m) || [])[1] || '').replace(/\s+-\s+dodane.*$/i, '');
    txt.split('\n').forEach((l) => add('/etc/cron.d/' + f, l, desc));
  }
  const ct = await run('crontab', ['-l']);
  ct.out.split('\n').forEach((l) => add('crontab root', l, ''));
  readText('/etc/crontab').split('\n').forEach((l) => add('/etc/crontab', l, 'zadania systemowe (run-parts)'));
  const periodic = {};
  for (const d of ['hourly', 'daily', 'weekly', 'monthly']) {
    try { periodic[d] = fs.readdirSync('/etc/cron.' + d).filter((x) => !x.startsWith('.') && x !== '.placeholder'); } catch { periodic[d] = []; }
  }
  const t = await run('systemctl', ['list-timers', '--all', '--output=json', '--no-pager']);
  let timers = [];
  try { timers = JSON.parse(t.out || '[]').map((x) => ({ unit: x.unit, activates: x.activates, next: x.next ? Math.round(x.next / 1000) : null, last: x.last ? Math.round(x.last / 1000) : null })); } catch {}
  return { items, periodic, timers };
}

/* -------------------------------------------------------------------- dysk */

let duMap = null, duAt = 0, duBusy = null;

export function duSnapshot() { return duMap; }
export function duInfo() { return { at: duAt, busy: !!duBusy }; }

export function refreshDu() {
  if (duBusy) return duBusy;
  duBusy = (async () => {
    const r = await run('nice', ['-n', '19', 'ionice', '-c3', 'du', '-x', '-d', '4', '--block-size=1', '/'], { timeout: 15 * 60000, maxBuffer: 128 * 1024 * 1024 });
    const m = new Map();
    for (const l of r.out.split('\n')) {
      const i = l.indexOf('\t');
      if (i > 0) m.set(l.slice(i + 1), Number(l.slice(0, i)));
    }
    if (m.size) { duMap = m; duAt = Date.now(); }
  })().finally(() => { duBusy = null; });
  return duBusy;
}

export function diskTree(dir = '/') {
  dir = path.posix.normalize('/' + String(dir || '/')).replace(/\/+$/, '') || '/';
  if (!duMap) return { dir, size: null, children: [], at: 0 };
  const depth = dir === '/' ? 0 : dir.split('/').length - 1;
  const children = [];
  for (const [p, size] of duMap) {
    if (p === dir) continue;
    const parent = path.posix.dirname(p);
    if (parent === dir) children.push({ path: p, name: path.posix.basename(p), size, more: depth + 1 < 4 });
  }
  children.sort((a, b) => b.size - a.size);
  return { dir, size: duMap.get(dir) ?? null, children: children.slice(0, 40), others: children.slice(40).reduce((a, c) => a + c.size, 0), at: duAt };
}

async function sizeOf(paths) {
  if (!paths.length) return 0;
  const r = await run('du', ['-sc', '--block-size=1', ...paths], { timeout: 120000 });
  const last = r.out.trim().split('\n').pop() || '';
  return Number(last.split('\t')[0]) || 0;
}

const BROWSER_TMP = /^(cdp[a-z0-9]*-|jg-chrome-|org\.chromium\.Chromium\.|scoped_dir|puppeteer_dev_)/;

async function browserLeftovers() {
  const running = (await run('pgrep', ['-x', 'chromium'])).ok || (await run('pgrep', ['-f', 'chrom'])).out.trim().length > 0;
  const minAge = running ? 15 * 60000 : 0;
  const res = [];
  const scan = (dir, re) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!re.test(f)) continue;
        const p = path.join(dir, f);
        const s = stat(p);
        if (s && Date.now() - s.mtimeMs >= minAge) res.push(p);
      }
    } catch {}
  };
  scan('/tmp', BROWSER_TMP);
  scan('/root/.config/chromium-headless', /^scoped_dir/);
  if (exists('/root/.cache/chromium-headless') && !running) res.push('/root/.cache/chromium-headless');
  return res;
}

function manualBackups(keep = 2) {
  const groups = { db: [], web: [], srv: [], code: [] };
  for (const f of fs.readdirSync('/root')) {
    if (/^dc-backup-\d{8}-\d{6}.*\.sqlite$/.test(f)) groups.db.push(f);
    else if (/^dc-web-backup-\d{8}-\d{6}/.test(f)) groups.web.push(f);
    else if (/^dc-server-backup-\d{8}-\d{6}.*\.mjs$/.test(f)) groups.srv.push(f);
    else if (/^dc-code-backup-\d{8}-\d{6}/.test(f)) groups.code.push(f);
  }
  const old = [];
  for (const g of Object.values(groups)) old.push(...g.sort().slice(0, Math.max(0, g.length - keep)).map((f) => '/root/' + f));
  return old;
}

export async function cleanupCandidates() {
  const browser = await browserLeftovers();
  const journal = await run('journalctl', ['--disk-usage']);
  const jm = journal.out.match(/take up ([\d.]+)([KMGT])/);
  const jBytes = jm ? Number(jm[1]) * { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[jm[2]] : 0;
  const debs = (() => { try { return fs.readdirSync('/var/cache/apt/archives').filter((f) => f.endsWith('.deb')).map((f) => '/var/cache/apt/archives/' + f); } catch { return []; } })();
  const caches = ['/root/.npm/_cacache', '/root/.cache/pip'].filter(exists);
  const manual = manualBackups(2);
  return [
    { id: 'przegladarka', name: 'Pozostałości przeglądarki testowej', desc: 'profile Chromium po testach i zrzutach ekranu (w /tmp)', size: await sizeOf(browser), count: browser.length },
    { id: 'apt', name: 'Pobrane paczki systemu', desc: 'apt trzyma pobrane instalatory po aktualizacjach', size: await sizeOf(debs), count: debs.length },
    { id: 'dziennik', name: 'Stare logi systemowe', desc: 'dziennik systemd ponad 100 MB', size: Math.max(0, jBytes - 100 * 1024 ** 2), count: 0 },
    { id: 'cache', name: 'Pamięć podręczna npm i pip', desc: 'odtworzy się sama przy następnej instalacji', size: await sizeOf(caches), count: caches.length },
    { id: 'kopie-reczne', name: 'Stare ręczne kopie komunikatora', desc: 'kopie w /root sprzed wdrożeń — zostają 2 najnowsze każdego rodzaju', size: await sizeOf(manual), count: manual.length },
  ];
}

export async function cleanup(id) {
  switch (id) {
    case 'przegladarka': { const l = await browserLeftovers(); for (const p of l) fs.rmSync(p, { recursive: true, force: true }); return `Usunięto ${l.length} folderów.`; }
    case 'apt': { const r = await run('apt-get', ['clean']); if (!r.ok) throw new Error(r.err); return 'Wyczyszczono pamięć apt.'; }
    case 'dziennik': { const r = await run('journalctl', ['--vacuum-size=100M']); return (r.err || r.out).trim().split('\n').pop(); }
    case 'cache': { await run('npm', ['cache', 'clean', '--force']); fs.rmSync('/root/.cache/pip', { recursive: true, force: true }); return 'Wyczyszczono pamięć npm i pip.'; }
    case 'kopie-reczne': { const l = manualBackups(2); for (const p of l) fs.rmSync(p, { recursive: true, force: true }); return `Usunięto ${l.length} starych kopii.`; }
    default: throw new Error('Nieznany rodzaj sprzątania.');
  }
}

/* -------------------------------------------------------------------- logi */

export async function logSources() {
  const list = [{ id: 'panel', name: 'Dziennik panelu — kto co zrobił', group: 'Panel' }, { id: 'j:', name: 'Cały system (journal)', group: 'System' }];
  for (const s of await services()) {
    if (s.group !== 'other') list.push({ id: 'j:' + s.unit, name: `${s.name} (${s.unit})`, group: 'Usługi' });
  }
  const files = [
    [CFG().kopie.log, 'Nocne kopie zapasowe'],
    ['/var/log/apache2/error.log', 'Apache — błędy'],
    ['/var/log/apache2/access.log', 'Apache — wejścia (domyślna strona)'],
    ...(CFG().logi || []),
    ['/var/log/fail2ban.log', 'Ochrona logowania (fail2ban)'],
    ['/var/log/letsencrypt/letsencrypt.log', 'Certyfikaty (certbot)'],
    ['/var/log/exim4/mainlog', 'Poczta (exim)'],
  ];
  for (const s of siteConfigs()) for (const l of s.logs) if (!files.some((f) => f[0] === l)) files.push([l, `${s.name} — ${/error/.test(l) ? 'błędy' : 'wejścia'}`]);
  for (const [p, name] of files) if (exists(p)) list.push({ id: 'f:' + p, name, group: p.includes('/apache2/') ? 'Strony' : 'Pliki' });
  return list;
}

export async function readLog(id, lines = 200, filter = '') {
  lines = Math.max(20, Math.min(2000, Number(lines) || 200));
  const want = filter ? Math.min(50000, lines * 50) : lines;
  const allowed = await logSources();
  if (!allowed.some((s) => s.id === id)) throw new Error('Nieznane źródło logów.');
  let text = '';
  if (id.startsWith('j:')) {
    const unit = id.slice(2);
    const args = ['--no-pager', '-o', 'short-iso', '-n', String(want)];
    if (unit) args.push('-u', unit + '.service');
    text = (await run('journalctl', args, { timeout: 30000 })).out;
  } else if (id.startsWith('f:')) {
    text = (await run('tail', ['-n', String(want), id.slice(2)], { timeout: 30000 })).out;
  }
  let arr = text.split('\n');
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  if (filter) { const f = filter.toLowerCase(); arr = arr.filter((l) => l.toLowerCase().includes(f)); }
  return arr.slice(-lines);
}
