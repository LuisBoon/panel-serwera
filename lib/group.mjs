// Grupa serwerów (wariant A): każdy serwer ma pełny panel, a jeden może zarządzać innymi.
// Parowanie: na serwerze B właściciel tworzy jednorazowy kod → na serwerze A wkleja adres B i kod → B oddaje
// token. Potem panel A przekazuje zapytania /api/... do B (zdalny/<id>/api/...) z tym tokenem.
// Token daje prawa administratora albo tylko podgląd — nigdy właściciela (konta, terminal, SSH zostają lokalne).
import crypto from 'node:crypto';
import fs from 'node:fs';
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
           CREATE TABLE IF NOT EXISTS grupa_kody(hash TEXT PRIMARY KEY, rola TEXT, expires INTEGER, by TEXT);
           CREATE TABLE IF NOT EXISTS grupa_straz(url TEXT PRIMARY KEY, nazwa TEXT, down_since INTEGER, alerted INTEGER, last_ok INTEGER, last_err TEXT);
           CREATE TABLE IF NOT EXISTS ustawienia(k TEXT PRIMARY KEY, v TEXT);`);
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
export const serverRow = (id) => row(id);
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
/** Wysłanie pliku do zdalnego panelu (strumieniowo, np. paczka przenoszonej strony). */
export function upload(r, p, file, timeoutMs = 3600e3) {
  const target = new URL(r.url + p);
  const lib = target.protocol === 'https:' ? https : http;
  const size = fs.statSync(file).size;
  return new Promise((resolve, reject) => {
    const up = lib.request(target, { method: 'POST', timeout: timeoutMs, headers: { 'x-panel': '1', 'x-panel-grupa': r.token, 'content-type': 'application/octet-stream', 'content-length': size } }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch {} if (res.statusCode >= 400) reject(Object.assign(new Error(j.error || `błąd ${res.statusCode}`), { status: res.statusCode })); else resolve(j); });
    });
    up.on('timeout', () => up.destroy(new Error('przekroczony czas wysyłania')));
    up.on('error', reject);
    fs.createReadStream(file).on('error', reject).pipe(up);
  });
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

/* --------------------------------------------- strażnik grupy: serwery pilnują się nawzajem */
// Każdy panel co minutę sprawdza serwery, którymi zarządza (z tokenem), i panele, które zarządzają nim
// (publiczne api/stan). Gdy któryś nie odpowiada dłużej niż próg — alarm przez powiadomienia autopilota;
// gdy wróci — druga wiadomość z czasem przerwy.
const GUARD_DEF = { on: true, minutes: 5 };
export function guardSettings() {
  let v = {};
  try { v = JSON.parse(db.prepare("SELECT v FROM ustawienia WHERE k='straznik'").get()?.v || '{}'); } catch {}
  return { ...GUARD_DEF, ...v };
}
export function saveGuard(b) {
  const cur = guardSettings();
  const next = { on: 'on' in b ? !!b.on : cur.on, minutes: 'minutes' in b ? Math.min(60, Math.max(2, Math.round(Number(b.minutes) || 5))) : cur.minutes };
  db.prepare("INSERT OR REPLACE INTO ustawienia(k,v) VALUES('straznik',?)").run(JSON.stringify(next));
  return next;
}
function guardTargets() {
  const t = new Map();
  for (const r of db.prepare('SELECT * FROM grupa_serwery').all()) t.set(r.url, { url: r.url, nazwa: r.nazwa, row: r, kind: 'zarzadzam' });
  for (const a of db.prepare('SELECT * FROM grupa_dostep').all()) if (a.url && /^https?:\/\//.test(a.url) && !t.has(a.url)) t.set(a.url, { url: a.url, nazwa: a.nazwa, kind: 'zarzadza' });
  return [...t.values()];
}
async function alive(t) {
  if (t.row) { await call(t.row, 'GET', 'api/stan'); return; }
  const r = await fetch(t.url + 'api/stan', { signal: AbortSignal.timeout(10000), headers: { 'x-panel': '1' } });
  if (!r.ok) throw new Error(`kod ${r.status}`);
  const j = await r.json(); if (!j.version) throw new Error('to nie panel serwera');
}
const mins = (ms) => Math.max(1, Math.round(ms / 60e3));
/** Co minutę z serwera panelu. notify(title, body, level, opts) — powiadomienia autopilota. */
export async function guardTick(notify) {
  const g = guardSettings();
  const targets = guardTargets();
  const known = new Set(targets.map((t) => t.url));
  for (const r of db.prepare('SELECT url FROM grupa_straz').all()) if (!known.has(r.url)) db.prepare('DELETE FROM grupa_straz WHERE url=?').run(r.url);
  await Promise.all(targets.map(async (t) => {
    const cur = db.prepare('SELECT * FROM grupa_straz WHERE url=?').get(t.url) || { url: t.url, down_since: null, alerted: 0 };
    let err = null;
    try { await alive(t); } catch (e) { err = e.status === 401 || e.status === 403 ? null : (e.cause?.code || e.message || 'brak odpowiedzi'); }
    const now = Date.now();
    if (!err) {
      if (cur.alerted && g.on) await notify(`${t.nazwa} działa znowu`, `Nie odpowiadał przez ${mins(now - cur.down_since)} min (od ${new Date(cur.down_since).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}).`, 'ok', { link: '#/serwery' }).catch(() => {});
      db.prepare('INSERT OR REPLACE INTO grupa_straz(url,nazwa,down_since,alerted,last_ok,last_err) VALUES(?,?,NULL,0,?,NULL)').run(t.url, t.nazwa, now);
      return;
    }
    const since = cur.down_since || now;
    let alerted = cur.alerted;
    if (g.on && !alerted && now - since >= g.minutes * 60e3) {
      await notify(`${t.nazwa} nie odpowiada od ${mins(now - since)} min`, `Adres: ${t.url}\nOstatnia odpowiedź: ${cur.last_ok ? new Date(cur.last_ok).toLocaleString('pl-PL') : 'brak'}\nBłąd: ${err}\nAlarm wysłał serwer ${CFG().nazwa} (strażnik grupy).`, 'error', { link: '#/serwery' }).catch(() => {});
      alerted = 1;
    }
    db.prepare('INSERT OR REPLACE INTO grupa_straz(url,nazwa,down_since,alerted,last_ok,last_err) VALUES(?,?,?,?,?,?)').run(t.url, t.nazwa, since, alerted, cur.last_ok || null, String(err).slice(0, 200));
  }));
}
export function guardState() {
  const m = {};
  for (const r of db.prepare('SELECT * FROM grupa_straz').all()) m[r.url] = { downSince: r.down_since, alerted: !!r.alerted, lastOk: r.last_ok, error: r.last_err };
  return m;
}
