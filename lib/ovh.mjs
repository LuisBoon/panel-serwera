// Domeny w OVH: po podłączeniu klucza API panel sam dodaje rekordy A dla nowych stron
// (i usuwa je przy usuwaniu strony), więc tworzenie strony nie wymaga już wizyty w OVH.
import crypto from 'node:crypto';
import { metrics } from './system.mjs';

let db;
const API = 'https://eu.api.ovh.com/1.0';
export const TOKEN_URL = 'https://eu.api.ovh.com/createToken/?GET=/domain/zone/*&POST=/domain/zone/*&PUT=/domain/zone/*&DELETE=/domain/zone/*';

export function init(database) { db = database; }
function settings() {
  const r = db.prepare("SELECT v FROM ustawienia WHERE k='ovh'").get();
  try { return r ? JSON.parse(r.v) : {}; } catch { return {}; }
}
function save(s) { db.prepare("INSERT OR REPLACE INTO ustawienia(k,v) VALUES('ovh',?)").run(JSON.stringify(s)); }
export const ready = () => { const s = settings(); return !!(s.ak && s.as && s.ck && s.zones?.length); };
export function info() { const s = settings(); return { connected: ready(), zones: s.zones || [], added: (s.added || []).slice(-20), since: s.since || null }; }

let delta = null;
async function call(method, p, body, cred = settings()) {
  if (delta == null) { try { const t = await (await fetch(API + '/auth/time', { signal: AbortSignal.timeout(8000) })).text(); delta = Number(t) - Math.floor(Date.now() / 1000); } catch { delta = 0; } }
  const ts = String(Math.floor(Date.now() / 1000) + delta);
  const url = API + p;
  const data = body ? JSON.stringify(body) : '';
  const sig = '$1$' + crypto.createHash('sha1').update([cred.as, cred.ck, method, url, data, ts].join('+')).digest('hex');
  const r = await fetch(url, { method, signal: AbortSignal.timeout(15000), headers: { 'X-Ovh-Application': cred.ak, 'X-Ovh-Consumer': cred.ck, 'X-Ovh-Timestamp': ts, 'X-Ovh-Signature': sig, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: data || undefined });
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
  if (!r.ok) {
    const msg = j?.message || txt || `HTTP ${r.status}`;
    throw new Error(r.status === 403 || /Invalid|credential|not been granted/i.test(msg) ? `OVH nie przyjęło klucza: ${msg}` : `OVH: ${msg}`);
  }
  return j;
}

export async function connect({ ak, as, ck }) {
  const cred = { ak: String(ak || '').trim(), as: String(as || '').trim(), ck: String(ck || '').trim() };
  if (!/^[A-Za-z0-9]{8,64}$/.test(cred.ak) || !/^[A-Za-z0-9]{16,64}$/.test(cred.as) || !/^[A-Za-z0-9]{16,64}$/.test(cred.ck)) throw new Error('Wklej wszystkie trzy wartości z OVH: Application Key, Application Secret i Consumer Key.');
  const zones = await call('GET', '/domain/zone', null, cred);
  if (!Array.isArray(zones) || !zones.length) throw new Error('Klucz działa, ale na tym koncie OVH nie ma żadnej strefy DNS.');
  save({ ...cred, zones, since: Date.now(), added: settings().added || [] });
  return info();
}
export function disconnect() { save({}); return info(); }

function split(host) {
  const s = settings();
  const h = String(host).toLowerCase().replace(/\.$/, '');
  const zone = (s.zones || []).filter((z) => h === z || h.endsWith('.' + z)).sort((a, b) => b.length - a.length)[0];
  if (!zone) return null;
  return { zone, sub: h === zone ? '' : h.slice(0, -(zone.length + 1)) };
}
export const manages = (host) => ready() && !!split(host);

/** Ustawia rekord A host → IP serwera (dodaje albo poprawia). */
export async function ensure(host, say = () => {}, target = null) {
  const sp = split(host);
  if (!sp) return { ok: false, reason: 'domena nie jest w OVH' };
  const ip = target || metrics().ip; // target: IP innego serwera (przenoszenie strony)
  const ids = await call('GET', `/domain/zone/${sp.zone}/record?fieldType=A&subDomain=${encodeURIComponent(sp.sub)}`);
  let changed = false;
  if (ids?.length) {
    for (const id of ids) {
      const rec = await call('GET', `/domain/zone/${sp.zone}/record/${id}`);
      if (rec.target !== ip) { await call('PUT', `/domain/zone/${sp.zone}/record/${id}`, { target: ip, ttl: 300 }); changed = true; say(`▸ OVH: poprawiam ${host} → ${ip} (było ${rec.target})\n`); }
    }
  } else {
    await call('POST', `/domain/zone/${sp.zone}/record`, { fieldType: 'A', subDomain: sp.sub, target: ip, ttl: 300 });
    changed = true;
    say(`▸ OVH: dodaję rekord ${host} → ${ip}\n`);
  }
  if (changed) {
    await call('POST', `/domain/zone/${sp.zone}/refresh`);
    const s = settings(); s.added = [...(s.added || []), { host, ip, ts: Date.now() }].slice(-50); save(s);
  } else say(`▸ OVH: ${host} już wskazuje na ${ip}\n`);
  return { ok: true, changed };
}
/** Usuwa rekord A, jeśli wskazuje na ten serwer (nie rusza cudzych). */
export async function remove(host, say = () => {}) {
  const sp = split(host);
  if (!sp || !sp.sub) return { ok: false };
  const ip = metrics().ip;
  const ids = await call('GET', `/domain/zone/${sp.zone}/record?fieldType=A&subDomain=${encodeURIComponent(sp.sub)}`);
  let n = 0;
  for (const id of ids || []) {
    const rec = await call('GET', `/domain/zone/${sp.zone}/record/${id}`);
    if (rec.target === ip) { await call('DELETE', `/domain/zone/${sp.zone}/record/${id}`); n++; }
  }
  if (n) { await call('POST', `/domain/zone/${sp.zone}/refresh`); say(`▸ OVH: usunięto rekord ${host}\n`); }
  return { ok: true, removed: n };
}
export async function wildcard(zone) {
  if (!settings().zones?.includes(zone)) throw new Error('Tej domeny nie ma w OVH.');
  return ensure(`*.${zone}`);
}
export async function records(zone) {
  if (!settings().zones?.includes(zone)) throw new Error('Tej domeny nie ma w OVH.');
  const ids = await call('GET', `/domain/zone/${zone}/record?fieldType=A`);
  const out = [];
  for (const id of (ids || []).slice(0, 80)) { const r = await call('GET', `/domain/zone/${zone}/record/${id}`); out.push({ sub: r.subDomain, target: r.target, ttl: r.ttl }); }
  return out.sort((a, b) => a.sub.localeCompare(b.sub));
}
