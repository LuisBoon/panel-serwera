// Grupa serwerów (wariant A): każdy serwer ma pełny panel, a jeden może zarządzać innymi.
// Parowanie: na serwerze B właściciel tworzy jednorazowy kod → na serwerze A wkleja adres B i kod → B oddaje
// token. Potem panel A przekazuje zapytania /api/... do B (zdalny/<id>/api/...) z tym tokenem.
// Token daje prawa administratora albo tylko podgląd — nigdy właściciela (konta, terminal, SSH zostają lokalne).
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { C as CFG, publicUrl } from './config.mjs';

let db;
export const ROLES = { admin: 'zarządzanie (wszystko oprócz kont, terminala i SSH)', podglad: 'tylko podgląd' };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (n = 6) => crypto.randomBytes(n).toString('hex');

export function init(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS grupa_serwery(id TEXT PRIMARY KEY, nazwa TEXT, url TEXT, token TEXT, rola TEXT, wersja TEXT, added INTEGER, by TEXT, last_ok INTEGER, last_err TEXT);
           CREATE TABLE IF NOT EXISTS grupa_dostep(id TEXT PRIMARY KEY, nazwa TEXT, url TEXT, token_hash TEXT, rola TEXT, created INTEGER, by TEXT, last_used INTEGER, ip TEXT);
           CREATE TABLE IF NOT EXISTS grupa_kody(hash TEXT PRIMARY KEY, rola TEXT, expires INTEGER, by TEXT);`);
}

/* --------------------------------------------- strona B: pozwól się połączyć */

/** Jednorazowy kod do parowania (15 minut). */
export function newCode(rola, who) {
  if (!ROLES[rola]) throw new Error('Wybierz zakres dostępu.');
  db.prepare('DELETE FROM grupa_kody WHERE expires<?').run(Date.now());
  const raw = crypto.randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 12);
  const code = raw.match(/.{1,4}/g).join('-');
  db.prepare('INSERT INTO grupa_kody(hash,rola,expires,by) VALUES(?,?,?,?)').run(sha(code.replace(/-/g, '')), rola, Date.now() + 15 * 60e3, who?.login || '');
  return { code, expires: Date.now() + 15 * 60e3, rola };
}
/** Wywołuje panel A: wymiana kodu na token. */
export function pair({ code, nazwa, url }, ip) {
  db.prepare('DELETE FROM grupa_kody WHERE expires<?').run(Date.now());
  const h = sha(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const k = db.prepare('SELECT * FROM grupa_kody WHERE hash=?').get(h);
  if (!k) throw Object.assign(new Error('Kod jest nieprawidłowy albo wygasł — wygeneruj nowy na tamtym serwerze.'), { status: 403 });
  db.prepare('DELETE FROM grupa_kody WHERE hash=?').run(h);
  const id = rid(6), token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO grupa_dostep(id,nazwa,url,token_hash,rola,created,by,last_used,ip) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, String(nazwa || 'inny panel').slice(0, 60), String(url || '').slice(0, 200), sha(token), k.rola, Date.now(), k.by, Date.now(), ip || '');
  return { id, token, rola: k.rola, nazwa: CFG().nazwa };
}
/** Sprawdza nagłówek x-panel-grupa: „<id>:<token>”. Zwraca wpis albo null. */
export function checkToken(hdr, ip) {
  const m = /^([a-f0-9]{12}):([a-f0-9]{64})$/.exec(String(hdr || ''));
  if (!m) return null;
  const r = db.prepare('SELECT * FROM grupa_dostep WHERE id=?').get(m[1]);
  if (!r) return null;
  const a = Buffer.from(sha(m[2])), b = Buffer.from(r.token_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() - (r.last_used || 0) > 60e3) db.prepare('UPDATE grupa_dostep SET last_used=?, ip=? WHERE id=?').run(Date.now(), ip || '', r.id);
  return r;
}
export const accessList = () => db.prepare('SELECT id,nazwa,url,rola,created,by,last_used,ip FROM grupa_dostep ORDER BY created').all();
export function revokeAccess(id) { const r = db.prepare('DELETE FROM grupa_dostep WHERE id=?').run(String(id)); if (!r.changes) throw new Error('Nie ma takiego połączenia.'); }

/* --------------------------------------------- strona A: zarządzaj innymi */

function normUrl(u) {
  let s = String(u || '').trim();
  if (!/^https?:\/\//.test(s)) s = 'https://' + s;
  let url;
  try { url = new URL(s); } catch { throw new Error('Nieprawidłowy adres panelu.'); }
  if (url.protocol === 'http:' && !/^(127\.|localhost$|10\.|192\.168\.|100\.)/.test(url.hostname)) throw new Error('Panel w internecie musi mieć https:// (http działa tylko w sieci lokalnej i Tailscale).');
  return url.origin + url.pathname.replace(/\/?$/, '/');
}
export async function connect({ url, code }, who) {
  const base = normUrl(url);
  if (db.prepare('SELECT 1 FROM grupa_serwery WHERE url=?').get(base)) throw new Error('Ten serwer jest już połączony.');
  let r, j;
  try {
    r = await fetch(base + 'api/grupa/sparuj', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', 'x-panel': '1' }, body: JSON.stringify({ code, nazwa: CFG().nazwa, url: publicUrl() }) });
    j = await r.json().catch(() => ({}));
  } catch (e) { throw new Error(`Nie mogę połączyć się z ${base} (${e.cause?.code || e.message}). Sprawdź adres i czy panel tam działa.`); }
  if (!r.ok) throw new Error(j.error || `Tamten panel odpowiedział błędem ${r.status}.`);
  const id = rid(6);
  db.prepare('INSERT INTO grupa_serwery(id,nazwa,url,token,rola,wersja,added,by,last_ok) VALUES(?,?,?,?,?,?,?,?,?)').run(id, String(j.nazwa || base).slice(0, 60), base, `${j.id}:${j.token}`, j.rola, j.wersja || '', Date.now(), who?.login || '', Date.now());
  return { id, nazwa: j.nazwa, rola: j.rola };
}
export const servers = () => db.prepare('SELECT id,nazwa,url,rola,wersja,added,by,last_ok,last_err FROM grupa_serwery ORDER BY added').all();
const row = (id) => { const r = db.prepare('SELECT * FROM grupa_serwery WHERE id=?').get(String(id)); if (!r) throw Object.assign(new Error('Nie ma takiego serwera w grupie.'), { status: 404 }); return r; };
export async function disconnect(id) {
  const r = row(id);
  try { await call(r, 'POST', 'api/grupa/odlacz-mnie', {}); } catch {}
  db.prepare('DELETE FROM grupa_serwery WHERE id=?').run(r.id);
}
export function rename(id, nazwa) { row(id); db.prepare('UPDATE grupa_serwery SET nazwa=? WHERE id=?').run(String(nazwa || '').trim().slice(0, 60) || 'serwer', String(id)); }

/** Zapytanie JSON do zdalnego panelu (pulpit zbiorczy, stan). */
export async function call(r, method, p, body, who) {
  const res = await fetch(r.url + p, { method, signal: AbortSignal.timeout(12000), headers: { 'x-panel': '1', 'x-panel-grupa': r.token, 'x-panel-kto': who?.login || '', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || `błąd ${res.status}`), { status: res.status });
  return j;
}
/** Stan wszystkich zdalnych serwerów (do przełącznika i pulpitu zbiorczego). */
export async function overview(who) {
  return Promise.all(servers().map(async (s) => {
    const r = row(s.id);
    try {
      const [st, pu] = await Promise.all([call(r, 'GET', 'api/stan', null, who), call(r, 'GET', 'api/pulpit', null, who).catch(() => null)]);
      db.prepare('UPDATE grupa_serwery SET last_ok=?, last_err=NULL, wersja=? WHERE id=?').run(Date.now(), st.version || '', s.id);
      return { ...s, ok: true, version: st.version, konfig: st.konfig, rola: st.role || s.rola, pulpit: pu ? summary(pu) : null };
    } catch (e) {
      db.prepare('UPDATE grupa_serwery SET last_err=? WHERE id=?').run(e.message.slice(0, 200), s.id);
      return { ...s, ok: false, error: e.status === 401 || e.status === 403 ? 'tamten panel nie przyjmuje już tokenu (połączenie odwołane?)' : e.message };
    }
  }));
}
/** Skrót pulpitu: zasoby, liczba stron i alarmów. */
export function summary(p) {
  const m = p.metrics || {};
  return {
    cpu: m.cpu?.pct ?? null, mem: m.mem ? Math.round((1 - m.mem.available / m.mem.total) * 100) : null, disk: m.disk ? Math.round(m.disk.used / m.disk.total * 100) : null,
    uptime: m.uptime || null, alerts: (p.alerts || []).filter((a) => a.level === 'error').length, warns: (p.alerts || []).filter((a) => a.level === 'warn').length,
    sites: Array.isArray(p.sites) ? { all: p.sites.filter((x) => x.enabled !== false && x.status !== 'off').length, ok: p.sites.filter((x) => x.status === 'ok' || x.status === 'redirect').length } : p.sites ? { all: p.sites.total ?? null, ok: p.sites.ok ?? null } : null, host: m.host, os: m.os, ip: m.ip,
  };
}

/** Przekazanie zapytania przeglądarki do zdalnego panelu (strumieniowo — pliki, wgrywanie, długie odpytywanie). */
export function proxy(id, rest, req, res, who) {
  const r = row(id);
  const target = new URL(r.url + rest);
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { 'x-panel': '1', 'x-panel-grupa': r.token, 'x-panel-kto': who.login, accept: req.headers.accept || '*/*' };
  for (const h of ['content-type', 'content-length', 'range']) if (req.headers[h]) headers[h] = req.headers[h];
  return new Promise((resolve) => {
    const up = lib.request(target, { method: req.method, headers, timeout: 60000 }, (ur) => {
      const out = {};
      for (const h of ['content-type', 'content-length', 'content-disposition', 'cache-control']) if (ur.headers[h]) out[h] = ur.headers[h];
      res.writeHead(ur.statusCode || 502, { ...out, 'x-panel-serwer': r.nazwa ? encodeURIComponent(r.nazwa) : '' });
      ur.pipe(res);
      ur.on('end', resolve); ur.on('error', resolve);
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', (e) => {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: `Serwer „${r.nazwa}” nie odpowiada (${e.code || e.message}).` })); }
      else res.destroy();
      resolve();
    });
    if (req.method === 'GET' || req.method === 'HEAD') up.end(); else req.pipe(up);
  });
}
