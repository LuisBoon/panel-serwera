// Autopilot: serwer dba o siebie sam (naprawa usług, pilnowanie stron, dysk, kopie, aktualizacje, SSL,
// procesy testowe, ataki) i odzywa się — mailem albo pushem — tylko wtedy, gdy potrzebny jest człowiek.
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import * as S from './system.mjs';
import { C as CFG } from './config.mjs';
import * as D from './data.mjs';
import * as C from './create.mjs';
import { run, readText, exists, spawnCollect } from './util.mjs';

let db, DATA_DIR, PUBLIC_URL;
const MIN = 60e3, HOUR = 3600e3;

export const DEFAULTS = {
  enabled: true,
  rules: { naprawa: true, strony: true, dysk: true, kopie: true, aktualizacje: true, ssl: true, testowe: true, ataki: true },
  diskThreshold: 85,
  testMaxHours: 24,
  reboot: { auto: false, day: 0, hour: 5, once: null },
  notify: { level: 'wazne', email: '', emailOn: false, pushOn: false, gibcordOn: true },
};
const WATCH_GROUPS = new Set(['app', 'srv']);

export function init({ database, dataDir, publicUrl }) {
  db = database; DATA_DIR = dataDir; PUBLIC_URL = publicUrl;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ustawienia(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS zdarzenia(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, rule TEXT, level TEXT, text TEXT, detail TEXT, auto INTEGER, klucz TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS dostepnosc(site TEXT, hour INTEGER, checks INTEGER, ok INTEGER, ms INTEGER, PRIMARY KEY(site, hour));
    CREATE TABLE IF NOT EXISTS push(endpoint TEXT PRIMARY KEY, sub TEXT, ua TEXT, created INTEGER);
  `);
  vapid();
  if (process.env.AUTOPILOT === '0') { quiet = false; return; } // kopia testowa: bez działań na serwerze
  setTimeout(() => tick(true), 20e3);
  setInterval(() => tick(false), MIN).unref();
}

/* ------------------------------------------------------------ ustawienia */

function merge(a, b) {
  const o = { ...a };
  for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return o;
}
export function settings() {
  const r = db.prepare("SELECT v FROM ustawienia WHERE k='autopilot'").get();
  let saved = {};
  try { saved = r ? JSON.parse(r.v) : {}; } catch {}
  return merge(DEFAULTS, saved);
}
export function saveSettings(patch) {
  const cur = settings();
  const n = merge(cur, patch || {});
  // kontrola wartości
  n.enabled = !!n.enabled;
  for (const k of Object.keys(DEFAULTS.rules)) n.rules[k] = !!n.rules[k];
  n.rules.ssl = true; // certyfikatów nie da się wyłączyć — bez nich strony przestają działać
  n.diskThreshold = Math.max(60, Math.min(95, Math.round(Number(n.diskThreshold) || 85)));
  n.testMaxHours = Math.max(1, Math.min(240, Math.round(Number(n.testMaxHours) || 24)));
  n.reboot.auto = !!n.reboot.auto;
  n.reboot.day = Math.max(0, Math.min(6, Math.round(Number(n.reboot.day) || 0)));
  n.reboot.hour = Math.max(0, Math.min(23, Math.round(Number(n.reboot.hour) || 5)));
  n.notify.level = n.notify.level === 'wszystko' ? 'wszystko' : 'wazne';
  n.notify.email = String(n.notify.email || '').trim().slice(0, 200);
  if (n.notify.email && !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(n.notify.email)) throw new Error('Nieprawidłowy adres e-mail.');
  n.notify.emailOn = !!n.notify.emailOn && !!n.notify.email;
  n.notify.pushOn = !!n.notify.pushOn;
  n.notify.gibcordOn = !!n.notify.gibcordOn;
  db.prepare("INSERT INTO ustawienia(k,v) VALUES('autopilot',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(n));
  if (patch?.rules && 'aktualizacje' in patch.rules) setUnattended(n.rules.aktualizacje);
  return n;
}
function setUnattended(on) {
  const f = '/etc/apt/apt.conf.d/20auto-upgrades';
  fs.writeFileSync(f, `APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "${on ? 1 : 0}";\n`);
}

/* ----------------------------------------------------------- zdarzenia */

let quiet = true; // pierwszy przebieg tylko zapisuje historię, bez powiadomień
export function event(rule, level, text, { detail = '', auto = false, key = null, notify = false, ts = Date.now() } = {}) {
  const r = db.prepare('INSERT OR IGNORE INTO zdarzenia(ts,rule,level,text,detail,auto,klucz) VALUES(?,?,?,?,?,?,?)').run(ts, rule, level, text, String(detail).slice(0, 4000), auto ? 1 : 0, key);
  if (!r.changes) return false;
  const s = settings();
  if (!quiet && notify && (notify === 'wazne' || s.notify.level === 'wszystko')) sendNotification(text, detail, level).catch(() => {});
  return true;
}
export const events = (n = 60) => db.prepare('SELECT * FROM zdarzenia ORDER BY ts DESC, id DESC LIMIT ?').all(n);
setInterval(() => db?.prepare('DELETE FROM zdarzenia WHERE ts<?').run(Date.now() - 90 * 864e5), 6 * HOUR).unref();

/* -------------------------------------------------------- powiadomienia */

function smtpConfig() {
  const env = {};
  const own = CFG().smtp;
  if (own?.host) return { host: own.host, port: Number(own.port || 465), secure: own.secure ?? Number(own.port || 465) === 465, auth: own.user ? { user: own.user, pass: own.pass } : undefined, from: own.from || `Serwer ${CFG().nazwa} <noreply@${own.host}>` };
  for (const f of [CFG().gibcord?.smtp].filter(Boolean)) {
    for (const l of readText(f).split('\n')) {
      const m = l.match(/^Environment="?([A-Z_]+)=(.*?)"?\s*$/);
      if (m) env[m[1]] = m[2];
    }
  }
  if (!env.SMTP_HOST) return null;
  const dom = (String(env.SMTP_FROM || '').match(/@([^>\s]+)/) || [])[1] || CFG().gibcord?.domena || CFG().domena || 'localhost';
  return { host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 465), secure: env.SMTP_SECURE === '1' || Number(env.SMTP_PORT) === 465, auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined, from: `Serwer ${CFG().nazwa} <noreply@${dom}>` };
}
let vapidKeys = null;
function vapid() {
  const f = path.join(DATA_DIR, 'vapid.json');
  try { vapidKeys = JSON.parse(readText(f)); } catch {}
  if (!vapidKeys?.publicKey) { vapidKeys = webpush.generateVAPIDKeys(); fs.writeFileSync(f, JSON.stringify(vapidKeys), { mode: 0o600 }); }
  webpush.setVapidDetails(`mailto:noreply@${CFG().domena || CFG().adres || 'localhost'}`, vapidKeys.publicKey, vapidKeys.privateKey);
}
export const vapidPublic = () => vapidKeys.publicKey;
export function addPush(sub, ua) {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Nieprawidłowa subskrypcja.');
  db.prepare('INSERT OR REPLACE INTO push(endpoint,sub,ua,created) VALUES(?,?,?,?)').run(sub.endpoint, JSON.stringify(sub), String(ua || '').slice(0, 200), Date.now());
}
export function removePush(endpoint) { db.prepare('DELETE FROM push WHERE endpoint=?').run(String(endpoint || '')); }
export const pushCount = () => db.prepare('SELECT count(*) c FROM push').get().c;

const ICON = { error: '🔴', warn: '🟠', info: '🔵', ok: '🟢' };
// GibCord: konto-bot „Serwer …” pisze adminom (od GibCorda 5.10.3); token leży w danych GibCorda
// adres i token GibCorda (zmienne tylko do testów na kopii)
const gcUrl = () => process.env.GIBCORD_URL || CFG().gibcord?.url || '';
const gibcordToken = () => (CFG().moduly?.gibcord && (process.env.GIBCORD_TOKEN_FILE || CFG().gibcord?.tokenFile) ? readText(process.env.GIBCORD_TOKEN_FILE || CFG().gibcord.tokenFile).trim() : '');
/** Karta do GibCorda zbudowana z tytułu i treści (gdy nadawca nie podał własnej). */
export function simpleCard(title, body = '', level = 'info', link = '#/autopilot') {
  const lines = String(body || '').split('\n').map((l) => l.replace(/^\s*[•\-*]\s*/, '').trim()).filter(Boolean).slice(0, 10);
  const lv = ['ok', 'info', 'warn', 'error'].includes(level) ? level : 'info';
  return { level: lv, title: String(title).slice(0, 120), sections: lines.length ? [{ items: lines.map((t) => ({ text: t })) }] : [], buttons: [{ label: 'Otwórz panel', url: PUBLIC_URL + String(link).replace(/^\//, '') }] };
}
export async function sendNotification(title, body = '', level = 'info', { force = false, card = null, link = '#/autopilot' } = {}) {
  const s = settings();
  const res = [];
  if ((s.notify.emailOn || force) && s.notify.email) {
    const cfg = smtpConfig();
    if (!cfg) res.push({ via: 'e-mail', ok: false, error: 'brak konfiguracji poczty' });
    else {
      try {
        const t = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth });
        await t.sendMail({
          from: cfg.from, to: s.notify.email, subject: `${ICON[level] || ''} Serwer: ${title}`.trim(),
          text: `${title}\n\n${body}\n\nPanel: ${PUBLIC_URL}#/autopilot\n\n— autopilot serwera ${CFG().nazwa} (ustawienia powiadomień w panelu: Autopilot)`,
        });
        res.push({ via: 'e-mail', ok: true });
      } catch (e) { res.push({ via: 'e-mail', ok: false, error: e.message }); }
    }
  }
  if ((s.notify.gibcordOn || force) && gibcordToken()) {
    try {
      const r = await fetch(gcUrl() + '/api/internal/serwer', { method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json', 'x-dc': '1', 'x-serwer-token': gibcordToken() }, body: JSON.stringify({ text: `${ICON[level] || ''} **${title}**${body ? '\n' + String(body).slice(0, 1500) : ''}\n${PUBLIC_URL}${String(link).replace(/^\//, '')}`, card: card || simpleCard(title, body, level, link) }) });
      const j = await r.json().catch(() => ({}));
      res.push(r.ok ? { via: 'GibCord', ok: true, to: j.to } : { via: 'GibCord', ok: false, error: j.error || `kod ${r.status}` });
    } catch (e) { res.push({ via: 'GibCord', ok: false, error: e.message }); }
  }
  if (s.notify.pushOn || force) {
    for (const p of db.prepare('SELECT * FROM push').all()) {
      try {
        await webpush.sendNotification(JSON.parse(p.sub), JSON.stringify({ title: `Serwer: ${title}`, body: String(body).slice(0, 300), url: PUBLIC_URL + '#/autopilot', level }), { TTL: 3600 * 12 });
        res.push({ via: 'push', ok: true });
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) removePush(p.endpoint);
        res.push({ via: 'push', ok: false, error: e.statusCode ? `kod ${e.statusCode}` : e.message });
      }
    }
  }
  return res;
}

/* ----------------------------------------------------------------- stan */

const st = {
  streak: new Map(), down: new Map(), restarts: new Map(), last: {}, apt: { count: null, reboot: false, pkgs: [] },
  f2b: { banned: 0, total: 0, history: [] }, backupRetry: 0,
};
export const due = (name, ms) => { const t = Date.now(); if (t - (st.last[name] || 0) < ms) return false; st.last[name] = t; return true; };

// Moduły dopinają własne zasady (zapora, kopie w chmurze, raport…) i własne „sprawy do Ciebie”.
const extraRules = [];
const todoProviders = [];
export function addRule(name, fn) { extraRules.push([name, fn]); }
export function addTodo(fn) { todoProviders.push(fn); }

function canRestart(unit) {
  const now = Date.now();
  const arr = (st.restarts.get(unit) || []).filter((t) => now - t < HOUR);
  st.restarts.set(unit, arr);
  if (arr.length >= 3) return false;
  arr.push(now);
  return true;
}
async function restartUnit(unit, why) {
  if (!canRestart(unit)) {
    event('naprawa', 'error', `Usługa ${unit} pada co chwilę — przestałem ją restartować (3 próby w godzinę)`, { key: `limit:${unit}:${Math.floor(Date.now() / HOUR)}`, notify: 'wazne', detail: why });
    return false;
  }
  await run('systemctl', ['restart', unit + '.service'], { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 8000));
  const ok = (await run('systemctl', ['is-active', unit + '.service'])).out.trim() === 'active';
  if (ok) event('naprawa', 'warn', `Uruchomiłem ponownie usługę ${unit} — ${why}`, { auto: true, notify: 'info' });
  else {
    const logs = (await run('journalctl', ['-u', unit + '.service', '-n', '12', '--no-pager', '-o', 'cat'])).out;
    event('naprawa', 'error', `Usługa ${unit} nie wstaje po restarcie`, { detail: logs, notify: 'wazne', key: `nie-wstaje:${unit}:${Math.floor(Date.now() / (6 * HOUR))}` });
  }
  S.services.reset();
  return ok;
}

async function cleanSafe(reason) {
  const before = S.metrics().disk.free;
  const cands = await S.cleanupCandidates();
  const done = [];
  for (const c of cands) if (['przegladarka', 'apt', 'dziennik', 'cache'].includes(c.id) && c.size > 0) { try { await S.cleanup(c.id); done.push(c.name.toLowerCase()); } catch {} }
  const freed = Math.max(0, S.metrics().disk.free - before);
  if (done.length) event('dysk', 'info', `Posprzątałem dysk (${reason}) — zwolniono ${Math.round(freed / 1048576)} MB`, { auto: true, detail: done.join(', '), notify: 'info' });
  return freed;
}

/* ---------------------------------------------------------------- reguły */

async function ruleSites(s) {
  const list = await S.sites(true);
  const hour = Math.floor(Date.now() / HOUR);
  const up = db.prepare('INSERT INTO dostepnosc(site,hour,checks,ok,ms) VALUES(?,?,1,?,?) ON CONFLICT(site,hour) DO UPDATE SET checks=checks+1, ok=ok+excluded.ok, ms=ms+excluded.ms');
  for (const x of list) {
    if (!x.enabled || x.status === 'nodns' || x.status === 'off') continue;
    const bad = x.status === 'down';
    up.run(x.name, hour, bad ? 0 : 1, x.http?.ms || 0);
    if (!s.rules.strony) continue;
    if (bad) {
      const n = (st.streak.get(x.name) || 0) + 1;
      st.streak.set(x.name, n);
      if (n === 3 && !st.down.has(x.name)) {
        st.down.set(x.name, Date.now() - 2 * MIN);
        const why = x.http?.code ? `zwraca błąd ${x.http.code}` : `nie odpowiada (${x.http?.error || 'brak połączenia'})`;
        event('strony', 'error', `Strona ${x.name} ${why}`, { key: `padla:${x.name}:${st.down.get(x.name)}`, notify: x.services.length && s.rules.naprawa ? 'info' : 'wazne' });
        if (x.services.length && s.rules.naprawa) for (const u of x.services) await restartUnit(u, `strona ${x.name} ${why}`);
      }
    } else {
      st.streak.set(x.name, 0);
      if (st.down.has(x.name)) {
        const mins = Math.round((Date.now() - st.down.get(x.name)) / MIN);
        st.down.delete(x.name);
        event('strony', 'ok', `Strona ${x.name} znów działa (przerwa ok. ${mins} min)`, { notify: 'wazne' });
      }
    }
  }
}

async function ruleServices(s) {
  if (!s.rules.naprawa) return;
  for (const x of await S.services(true)) {
    if (!WATCH_GROUPS.has(x.group) || x.unit === 'panel-serwera') continue;
    const crashed = x.failed || (!x.active && x.enabled && x.result && x.result !== 'success');
    if (crashed) await restartUnit(x.unit, x.failed ? 'była w stanie „padła”' : `zatrzymała się z błędem (${x.result})`);
  }
}

async function ruleDisk(s) {
  if (!s.rules.dysk || !due('dysk', 10 * MIN)) return;
  const m = S.metrics().disk;
  const pct = () => (S.metrics().disk.used / S.metrics().disk.total) * 100;
  if (pct() < s.diskThreshold) return;
  await cleanSafe(`zajęte ${Math.round(pct())}%, próg ${s.diskThreshold}%`);
  if (pct() >= s.diskThreshold) event('dysk', 'warn', `Dysk nadal zajęty w ${Math.round(pct())}% — trzeba ręcznie usunąć coś większego`, { key: `dysk-pelny:${Math.floor(Date.now() / (12 * HOUR))}`, notify: 'wazne', detail: `wolne: ${Math.round(m.free / 1048576)} MB` });
}

async function ruleBackups(s) {
  if (!s.rules.kopie || !due('kopie', 5 * MIN)) return;
  const set = D.backupSettings();
  const now = new Date();
  // przed nocną kopią: zrób miejsce, zamiast ją pominąć
  if (now.getHours() === set.hour && now.getMinutes() >= Math.max(0, set.minute - 20) && now.getMinutes() < set.minute) {
    if (S.metrics().disk.free < ((set.minFreeMb || 2048) + 512) * 1048576) await cleanSafe('przed nocną kopią');
  }
  const runs = D.backupRuns(6);
  for (const r of runs.slice().reverse()) {
    if (r.status === 'running') continue;
    if (r.status === 'ok') event('kopie', 'ok', `Kopia zapasowa: OK${r.size ? ' (razem ' + r.size.replace('.', ',') + ')' : ''}`, { key: `kopia:${r.start}`, ts: r.end || r.start, auto: true });
    else {
      const fresh = Date.now() - r.start < 3 * HOUR && r === runs[0];
      const space = /malo miejsca/.test(r.error);
      const isNew = event('kopie', 'error', `Kopia zapasowa się nie wykonała: ${r.error}`, { key: `kopia:${r.start}`, ts: r.start, notify: fresh && space && !quiet ? 'info' : 'wazne' });
      if (isNew && fresh && space && !quiet && Date.now() - st.backupRetry > 6 * HOUR) {
        st.backupRetry = Date.now();
        await cleanSafe('kopia nie miała miejsca');
        const res = await spawnCollect('nice', ['-n', '10', D.BACKUP_SCRIPT]);
        event('kopie', res.ok ? 'ok' : 'error', res.ok ? 'Posprzątałem i zrobiłem kopię jeszcze raz — udało się' : 'Ponowna kopia też się nie udała', { auto: true, notify: res.ok ? 'info' : 'wazne' });
      }
    }
  }
  const lastOk = runs.find((r) => r.status === 'ok');
  if (!lastOk || Date.now() - lastOk.start > 30 * HOUR) event('kopie', 'warn', 'Od ponad doby nie ma udanej kopii zapasowej', { key: `brak-kopii:${new Date().toDateString()}`, notify: 'wazne' });
}

async function ruleSsl() {
  if (due('ssl-nowe', 5 * MIN)) {
    for (const r of C.list()) {
      if (!r.host) continue;
      if (r.ssl === 'czeka-dns' || (r.ssl === 'blad' && Date.now() - (r.ssl_try || 0) > HOUR)) {
        const out = await C.trySsl(r.slug);
        if (out === 'gotowe') event('ssl', 'ok', `Pobrałem certyfikat dla ${r.host} — strona działa przez https`, { auto: true, notify: 'info' });
        else if (out === 'blad') event('ssl', 'error', `Nie udało się pobrać certyfikatu dla ${r.host}`, { key: `ssl-blad:${r.host}:${new Date().toDateString()}`, notify: 'wazne' });
      }
    }
  }
  if (due('ssl-daty', 6 * HOUR)) {
    const certs = await S.certs(true);
    for (const x of await S.sites()) {
      const days = x.cert?.validTo ? Math.floor((x.cert.validTo - Date.now()) / 864e5) : null;
      if (days == null || days >= 14) continue;
      const c = certs.find((k) => k.domains.includes(x.name) || k.name === x.name);
      if (c) {
        const [cmd, args] = await S.renewCert(c.name);
        const r = await run(cmd, args, { timeout: 180000 });
        event('ssl', r.ok ? 'info' : 'error', r.ok ? `Odnowiłem certyfikat ${x.name} (zostało ${days} dni)` : `Certyfikat ${x.name} wygasa za ${days} dni i nie chce się odnowić`, { auto: r.ok, key: `ssl-odnow:${x.name}:${new Date().toDateString()}`, notify: r.ok ? 'info' : 'wazne' });
        S.certs.reset(); S.sites.reset();
      }
    }
  }
}

// usługi, które po aktualizacji wciąż mają w pamięci stare (usunięte z dysku) biblioteki
const NO_AUTO_RESTART = new Set(['ssh', 'tailscaled', 'dbus', 'panel-serwera']);
export async function staleUnits() {
  const out = [];
  for (const x of await S.services()) {
    if (!WATCH_GROUPS.has(x.group) || !x.active || !x.pid) continue;
    let maps = '';
    try { maps = fs.readFileSync(`/proc/${x.pid}/maps`, 'utf8'); } catch { continue; }
    const libs = [...new Set(maps.split('\n').filter((l) => l.endsWith('(deleted)') && /\.so/.test(l)).map((l) => path.basename(l.trim().split(/\s+/)[5] || '')))].filter(Boolean);
    if (libs.length) out.push({ unit: x.unit, name: x.name, libs: libs.slice(0, 5), auto: !NO_AUTO_RESTART.has(x.unit) });
  }
  return out;
}
export async function restartStale(reason) {
  const list = (await staleUnits()).filter((u) => u.auto);
  const done = [];
  for (const u of list) {
    if (u.unit === 'apache2' && !(await run('apache2ctl', ['configtest'])).ok) continue;
    const r = await run('systemctl', ['restart', u.unit + '.service'], { timeout: 120000 });
    if (r.ok) done.push(u.name);
  }
  S.services.reset(); S.sites.reset();
  if (done.length) event('aktualizacje', 'info', `Odświeżyłem usługi po aktualizacji (${reason}): ${done.join(', ')}`, { auto: true, notify: 'info' });
  return done;
}

async function ruleUpdates(s) {
  const now0 = new Date();
  if (s.rules.aktualizacje && now0.getHours() === 4 && now0.getMinutes() >= 30 && due('odswiez-uslugi-noc', 20 * HOUR)) {
    try { await restartStale('w nocy, 04:30'); } catch (e) { console.error('autopilot odświeżanie:', e.message); }
  }
  if (!due('aktualizacje', HOUR)) return;
  st.stale = await staleUnits().catch(() => []);
  const a = await run('apt', ['list', '--upgradable'], { timeout: 60000, env: { ...process.env, LANG: 'C' } });
  st.apt.count = a.out.split('\n').filter((l) => l.includes('[upgradable')).length;
  st.apt.reboot = exists('/var/run/reboot-required');
  st.apt.pkgs = readText('/var/run/reboot-required.pkgs').split('\n').filter(Boolean);
  for (const l of readText('/var/log/unattended-upgrades/unattended-upgrades.log').split('\n').slice(-400)) {
    const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ INFO Packages that will be upgraded: (.+)$/);
    if (m) event('aktualizacje', 'info', `Zainstalowałem poprawki systemu: ${m[2].split(' ').slice(0, 6).join(', ')}${m[2].split(' ').length > 6 ? '…' : ''}`, { key: `apt:${m[1]}`, ts: Date.parse(m[1].replace(' ', 'T')), auto: true });
  }
  if (!st.apt.reboot) return;
  const now = new Date();
  const planned = s.reboot.once && Date.now() >= s.reboot.once;
  const weekly = s.reboot.auto && now.getDay() === s.reboot.day && now.getHours() === s.reboot.hour;
  if ((planned || weekly) && S.metrics().uptime > 20 * 3600) {
    event('aktualizacje', 'info', 'Restartuję serwer po aktualizacjach — strony wrócą za ok. 1–2 minuty', { auto: true, notify: 'info' });
    fs.writeFileSync(path.join(DATA_DIR, 'restart-planowany'), String(Date.now()));
    if (planned) saveSettings({ reboot: { once: null } });
    setTimeout(() => run('systemctl', ['reboot']), 8000);
  }
}

async function ruleTests(s) {
  if (!s.rules.testowe || !due('testowe', 30 * MIN)) return;
  const old = (await S.testProcs()).filter((p) => Date.now() - p.start > s.testMaxHours * HOUR);
  if (!old.length) return;
  const killed = await S.killTestProcs(old.map((p) => p.pid));
  const mb = Math.round(old.filter((p) => killed.includes(p.pid)).reduce((a, p) => a + p.rss, 0) / 1048576);
  if (killed.length) event('testowe', 'info', `Zatrzymałem ${killed.length} starych procesów testowych (działały ponad ${s.testMaxHours} h) — zwolniono ok. ${mb} MB RAM`, { auto: true, detail: old.map((p) => `${p.pid} ${p.what}`).join('\n') });
}

export async function fail2ban() {
  const r = await run('fail2ban-client', ['status']);
  const jails = ((r.out.match(/Jail list:\s*(.*)/) || [])[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const j of jails) {
    const x = (await run('fail2ban-client', ['status', j])).out;
    out.push({
      jail: j,
      banned: Number((x.match(/Currently banned:\s*(\d+)/) || [])[1] || 0),
      total: Number((x.match(/Total banned:\s*(\d+)/) || [])[1] || 0),
      failed: Number((x.match(/Total failed:\s*(\d+)/) || [])[1] || 0),
      ips: ((x.match(/Banned IP list:\s*(.*)/) || [])[1] || '').split(/\s+/).filter(Boolean),
    });
  }
  return out;
}
export async function unban(jail, ip) {
  if (!/^[a-z0-9_-]+$/i.test(jail) || !/^[0-9a-f.:]+$/i.test(ip)) throw new Error('Nieprawidłowe dane.');
  const r = await run('fail2ban-client', ['set', jail, 'unbanip', ip]);
  if (!r.ok) throw new Error(r.err || 'Nie udało się odblokować.');
}
export async function ban(jail, ip) {
  if (!/^[a-z0-9_-]+$/i.test(jail) || !/^[0-9a-f.:]+$/i.test(ip)) throw new Error('Nieprawidłowe dane.');
  const r = await run('fail2ban-client', ['set', jail, 'banip', ip]);
  if (!r.ok) throw new Error(r.err || 'Nie udało się zablokować.');
}

async function ruleAttacks(s) {
  if (!due('ataki', 10 * MIN)) return;
  const jails = await fail2ban();
  st.f2b.banned = jails.reduce((a, j) => a + j.banned, 0);
  st.f2b.total = jails.reduce((a, j) => a + j.total, 0);
  st.f2b.jails = jails.map((j) => ({ jail: j.jail, banned: j.banned, total: j.total }));
  st.f2b.history.push({ t: Date.now(), total: st.f2b.total });
  st.f2b.history = st.f2b.history.filter((h) => Date.now() - h.t < 2 * HOUR);
  const hourAgo = st.f2b.history.find((h) => Date.now() - h.t >= 55 * MIN);
  if (s.rules.ataki && hourAgo && st.f2b.total - hourAgo.total > 150) {
    event('ataki', 'warn', `Nietypowo dużo ataków: ${st.f2b.total - hourAgo.total} zablokowanych adresów w godzinę`, { key: `atak:${Math.floor(Date.now() / (6 * HOUR))}`, notify: 'info' });
  }
}

let busy = false;
async function tick(first) {
  if (busy) return;
  busy = true;
  const s = settings();
  try {
    if (first) {
      const marker = path.join(DATA_DIR, 'restart-planowany');
      if (exists(marker)) { event('aktualizacje', 'ok', 'Serwer uruchomił się ponownie po aktualizacjach', { auto: true, notify: 'info' }); fs.rmSync(marker, { force: true }); }
    }
    if (s.enabled) {
      for (const [name, fn] of [['strony', ruleSites], ['usługi', ruleServices], ['dysk', ruleDisk], ['kopie', ruleBackups], ['ssl', ruleSsl], ['aktualizacje', ruleUpdates], ['testowe', ruleTests], ['ataki', ruleAttacks]]) {
        try { await fn(s); } catch (e) { console.error(`autopilot ${name}:`, e.message); }
      }
      for (const [name, fn] of extraRules) {
        try { await fn(s); } catch (e) { console.error(`autopilot ${name}:`, e.message); }
      }
    } else if (due('ataki-wylaczony', 10 * MIN)) { try { await ruleAttacks(s); } catch {} }
  } finally {
    busy = false;
    if (first) quiet = false;
  }
}
export const runNow = () => { st.last = {}; return tick(false); };

/* ------------------------------------------------------------ podsumowanie */

export function uptime(site) {
  const h = Math.floor(Date.now() / HOUR);
  const q = db.prepare('SELECT COALESCE(SUM(checks),0) c, COALESCE(SUM(ok),0) o, COALESCE(SUM(ms),0) ms FROM dostepnosc WHERE site=? AND hour>?');
  const f = (hours) => { const r = q.get(site, h - hours); return r.c ? { pct: r.o / r.c * 100, ms: Math.round(r.ms / r.c), checks: r.c } : null; };
  return { d1: f(24), d7: f(24 * 7), d30: f(24 * 30) };
}
export function uptimeAll() {
  const h = Math.floor(Date.now() / HOUR);
  const rows = db.prepare('SELECT site, SUM(checks) c, SUM(ok) o FROM dostepnosc WHERE hour>? GROUP BY site').all(h - 24);
  return Object.fromEntries(rows.map((r) => [r.site, r.c ? r.o / r.c * 100 : null]));
}

export async function status() {
  const s = settings();
  const [sites, svc] = await Promise.all([S.sites(), S.services()]);
  const m = S.metrics();
  const diskPct = Math.round(m.disk.used / m.disk.total * 100);
  const runs = D.backupRuns(6);
  const lastOk = runs.find((r) => r.status === 'ok');
  const watched = svc.filter((x) => WATCH_GROUPS.has(x.group));
  const siteList = sites.filter((x) => x.enabled && x.status !== 'off');
  const down = siteList.filter((x) => x.status === 'down');
  const nodns = siteList.filter((x) => x.status === 'nodns');
  const created = C.list();
  const todo = [];
  if (!s.enabled) todo.push({ level: 'warn', text: 'Autopilot jest wyłączony', desc: 'Serwer nie naprawia się sam i nie wysyła powiadomień.', action: 'wlacz', cta: 'Włącz autopilota' });
  for (const x of down) {
    const fixable = x.services.length > 0;
    todo.push({ level: 'error', text: `${x.name} ${x.http?.code ? 'zwraca błąd ' + x.http.code : 'nie odpowiada'}`, desc: fixable ? 'Autopilot próbował restartu usługi — jeśli to trwa, trzeba zajrzeć do logów.' : 'Tej strony autopilot nie umie naprawić restartem — to błąd w samej aplikacji, trzeba go naprawić ręcznie.', link: x.logs[1] || x.logs[0] ? '#/logi?z=' + encodeURIComponent('f:' + (x.logs.find((l) => /error/.test(l)) || x.logs[0])) : '#/strony', cta: 'Pokaż log' });
  }
  for (const x of watched.filter((v) => v.failed)) todo.push({ level: 'error', text: `Usługa ${x.name} (${x.unit}) nie działa`, desc: 'Restart nie pomógł albo autopilot jest wyłączony.', link: '#/logi?z=' + encodeURIComponent('j:' + x.unit), cta: 'Pokaż log' });
  for (const r of created.filter((c) => c.ssl === 'czeka-dns' || c.ssl === 'blad')) todo.push({ level: 'warn', text: `${r.host}: ${r.ssl === 'blad' ? 'certyfikat się nie pobrał' : 'czeka na wpis DNS'}`, desc: r.ssl_msg || '', link: '#/utworz', cta: 'Szczegóły' });
  const stale = (st.stale || []).filter((u) => u.auto);
  if (stale.some((u) => u.unit === 'apache2' || /php/.test(u.unit))) todo.push({ level: 'decision', text: 'Strony działają na starej wersji PHP po aktualizacji', desc: `Autopilot odświeży to sam dziś o 04:30. Możesz też teraz (strony znikną na ok. 1 s). Dotyczy: ${stale.map((u) => u.name).join(', ')}`, action: 'odswiez-uslugi', cta: 'Odśwież teraz' });
  if (st.apt.reboot) todo.push({ level: 'decision', text: 'Serwer czeka na restart po aktualizacjach', desc: s.reboot.once ? `Zaplanowany: ${new Date(s.reboot.once).toLocaleString('pl-PL', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}. Strony znikną na ok. 1–2 minuty.` : `Strony znikną na ok. 1–2 minuty. Najlepiej w nocy.${st.apt.pkgs.length ? ' Dotyczy: ' + st.apt.pkgs.slice(0, 4).join(', ') : ''}`, action: s.reboot.once ? 'anuluj-restart' : 'zaplanuj-restart', cta: s.reboot.once ? 'Anuluj restart' : 'Zaplanuj na 05:00' });
  if (diskPct >= 90) todo.push({ level: 'error', text: `Dysk zajęty w ${diskPct}%`, desc: 'Sprzątanie nie wystarczyło — trzeba usunąć coś większego.', link: '#/dysk', cta: 'Pokaż dysk' });
  if (runs[0] && runs[0].status === 'error' && (!lastOk || lastOk.start < runs[0].start)) todo.push({ level: 'error', text: 'Ostatnia kopia zapasowa się nie wykonała', desc: runs[0].error, link: '#/kopie', cta: 'Pokaż kopie' });
  if (!(s.notify.emailOn && s.notify.email) && !(s.notify.pushOn && pushCount()) && !(s.notify.gibcordOn && gibcordToken())) todo.push({ level: 'info', text: 'Ustaw powiadomienia', desc: 'Podaj e-mail albo włącz push — wtedy autopilot da Ci znać, gdy coś będzie wymagało Ciebie.', link: '#powiadomienia', cta: 'Ustaw' });
  for (const f of todoProviders) { try { todo.push(...((await f(s)) || [])); } catch (e) { console.error('autopilot sprawy:', e.message); } }
  const okSites = siteList.length - down.length - nodns.length;
  const okSvc = watched.filter((x) => x.active).length;
  const items = [okSites === siteList.length - nodns.length, ...watched.map((x) => x.active), diskPct < s.diskThreshold, !!lastOk && Date.now() - lastOk.start < 30 * HOUR, !st.apt.reboot];
  const tests = await S.testProcs();
  const nearest = sites.filter((x) => x.cert?.validTo).sort((a, b) => a.cert.validTo - b.cert.validTo)[0];
  return {
    settings: s, todo,
    ring: { ok: items.filter(Boolean).length, total: items.length },
    tiles: { sites: { ok: okSites, total: siteList.length - nodns.length }, services: { ok: okSvc, total: watched.length }, disk: diskPct, lastBackup: lastOk ? lastOk.end || lastOk.start : null },
    rules: {
      naprawa: { ok: watched.every((x) => x.active), down: watched.filter((x) => !x.active).map((x) => x.name) },
      strony: { down: down.map((x) => x.name), checked: siteList.length, uptime: uptimeAll() },
      dysk: { pct: diskPct, threshold: s.diskThreshold },
      kopie: { last: runs[0] || null, lastOk: lastOk || null },
      aktualizacje: { count: st.apt.count, reboot: st.apt.reboot, stale: (st.stale || []).map((u) => u.name) },
      ssl: { nearest: nearest ? { name: nearest.name, validTo: nearest.cert.validTo } : null },
      testowe: { count: tests.length, rss: tests.reduce((a, p) => a + p.rss, 0), maxHours: s.testMaxHours },
      ataki: { banned: st.f2b.banned, total: st.f2b.total, jails: st.f2b.jails || [] },
    },
    notify: { email: s.notify.email, emailOn: s.notify.emailOn, pushOn: s.notify.pushOn, pushDevices: pushCount(), level: s.notify.level, mailReady: !!smtpConfig(), gibcordOn: s.notify.gibcordOn, gibcordReady: !!gibcordToken() },
    events: events(60),
  };
}

export function planReboot(cancel) {
  if (cancel) return saveSettings({ reboot: { once: null } });
  const d = new Date(); d.setHours(5, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return saveSettings({ reboot: { once: d.getTime() } });
}
