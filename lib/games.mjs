// Serwery gier z Pterodactyla (adres panelu z konfiguracji): stan, zasoby, gracze i przyciski
// Start/Stop/Restart. Korzysta z klucza API konta w Pterodactylu (Account → API Credentials).
import net from 'node:net';
import { cached } from './util.mjs';
import { C as CFG } from './config.mjs';

let db;
const DEFAULT_URL0 = () => CFG().gry?.panel || '';
export function init(database) { db = database; }
function settings() {
  const r = db.prepare("SELECT v FROM ustawienia WHERE k='gry'").get();
  try { return r ? JSON.parse(r.v) : {}; } catch { return {}; }
}
function save(s) { db.prepare("INSERT OR REPLACE INTO ustawienia(k,v) VALUES('gry',?)").run(JSON.stringify(s)); list.reset(); }
export const ready = () => !!settings().key;

async function call(method, p, body, s = settings()) {
  const r = await fetch((s.url || DEFAULT_URL0()) + p, { method, signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${s.key}`, Accept: 'Application/vnd.pterodactyl.v1+json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return null;
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  if (!r.ok) {
    const e = j?.errors?.[0];
    if (r.status === 401 || r.status === 403) throw new Error('Pterodactyl nie przyjął klucza — sprawdź, czy jest aktualny i czy ma dozwolony adres serwera.');
    throw new Error(`Pterodactyl: ${e?.detail || e?.code || 'błąd ' + r.status}`);
  }
  return j;
}

export async function connect({ key, url }) {
  const k = String(key || '').trim();
  if (!/^ptlc_[A-Za-z0-9]{20,64}$/.test(k)) throw new Error('Wklej klucz konta z Pterodactyla (zaczyna się od ptlc_). Klucze aplikacji (ptla_) tu nie działają.');
  const u = String(url || DEFAULT_URL0()).trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(u)) throw new Error('Nieprawidłowy adres panelu gier.');
  const j = await call('GET', '/api/client/account', null, { key: k, url: u });
  save({ key: k, url: u, user: j?.attributes?.username || '', admin: !!j?.attributes?.admin, since: Date.now() });
  return info();
}
export function disconnect() { save({}); return info(); }
export function info() { const s = settings(); return { connected: !!s.key, url: s.url || DEFAULT_URL0(), user: s.user || '', admin: !!s.admin }; }

/* ------------------------------------------------------------ gracze */

/** Minecraft: zapytanie o stan serwera (Server List Ping). */
function mcPing(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 3000 });
    const varint = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
    const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varint(b.length), b]); };
    const pkt = (id, data) => { const body = Buffer.concat([varint(id), data]); return Buffer.concat([varint(body.length), body]); };
    let buf = Buffer.alloc(0);
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.on('connect', () => {
      const p = Buffer.alloc(2); p.writeUInt16BE(port);
      sock.write(pkt(0, Buffer.concat([varint(760), str(host), p, varint(1)])));
      sock.write(pkt(0, Buffer.alloc(0)));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        const rd = (o) => { let n = 0, s = 0, b; do { b = buf[o++]; if (b === undefined) throw 0; n |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return [n, o]; };
        let [len, o] = rd(0);
        if (buf.length < o + len) return;
        [, o] = rd(o); const [sl, o2] = rd(o);
        const j = JSON.parse(buf.subarray(o2, o2 + sl).toString('utf8'));
        done({ online: j.players?.online ?? null, max: j.players?.max ?? null, version: j.version?.name || '' });
      } catch { /* czekamy na resztę */ }
    });
    sock.on('timeout', () => done(null)); sock.on('error', () => done(null));
  });
}
async function fivem(host, port) {
  try {
    const r = await fetch(`http://${host}:${port}/players.json`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    let max = null;
    try { const i = await (await fetch(`http://${host}:${port}/info.json`, { signal: AbortSignal.timeout(3000) })).json(); max = Number(i?.vars?.sv_maxClients) || null; } catch {}
    return Array.isArray(j) ? { online: j.length, max } : null;
  } catch { return null; }
}

/* ------------------------------------------------------------- lista */

export const list = cached(20e3, async () => {
  const s = settings();
  if (!s.key) return [];
  const j = await call('GET', `/api/client${s.admin ? '?type=admin-all' : ''}`);
  const servers = (j?.data || []).map((x) => x.attributes);
  return Promise.all(servers.map(async (a) => {
    const alloc = (a.relationships?.allocations?.data || []).map((x) => x.attributes).find((x) => x.is_default) || {};
    let res = null;
    try { res = (await call('GET', `/api/client/servers/${a.identifier}/resources`)).attributes; } catch (e) { res = { error: e.message }; }
    const state = res?.current_state || (res?.error ? 'nieznany' : 'offline');
    const egg = String(a.description || a.name || '').toLowerCase();
    // adres z internetu: alias przydziału, a gdy to adres z sieci domowej — nazwa węzła (np. dom.example.pl)
    const priv = (ip) => !ip || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(ip);
    const publicHost = !priv(alloc.ip_alias) ? alloc.ip_alias : !priv(alloc.ip) ? alloc.ip : (a.sftp_details?.ip || CFG().dom?.host || alloc.ip);
    let players = null;
    if (state === 'running' && alloc.port) {
      if (alloc.port === 25565 || /minecraft|mods|forge|paper|spigot/.test(egg)) players = await mcPing(publicHost, alloc.port);
      else if (alloc.port === 30120 || (/fivem|cfx|txadmin|rp\b|roleplay/.test(egg) || (CFG().gry?.fivem || []).some((w) => egg.includes(String(w).toLowerCase())))) players = await fivem(publicHost, alloc.port);
    }
    return {
      id: a.identifier, uuid: a.uuid, name: a.name, description: a.description || '', node: a.node,
      address: alloc.port ? `${publicHost}:${alloc.port}` : '', suspended: !!a.is_suspended, installing: !!a.is_installing,
      limits: a.limits, state, players,
      memory: res?.resources?.memory_bytes ?? null, cpu: res?.resources?.cpu_absolute ?? null, disk: res?.resources?.disk_bytes ?? null, uptime: res?.resources?.uptime ?? null,
      error: res?.error || null, link: `${s.url || DEFAULT_URL0()}/server/${a.identifier}`,
    };
  }));
});

export async function power(id, signal) {
  if (!['start', 'stop', 'restart', 'kill'].includes(signal)) throw new Error('Nieznana akcja.');
  if (!/^[a-z0-9]{8}$/.test(id)) throw new Error('Nieprawidłowy serwer.');
  await call('POST', `/api/client/servers/${id}/power`, { signal });
  list.reset();
  return { ok: true };
}
