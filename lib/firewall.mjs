// Zapora (ufw): bezpieczny zestaw reguł jednym kliknięciem, zaufane adresy (np. serwer gier w domu)
// odświeżane same, gdy zmieni się domowe IP, i bezpiecznik — po włączeniu zapora sama się wyłącza,
// jeśli w ciągu kilku minut nie potwierdzimy, że serwer dalej jest osiągalny.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { run, readText } from './util.mjs';
import { C as CFG } from './config.mjs';

let db, MARK = '/var/lib/panel-serwera/zapora-bezpiecznik.txt';
const UFW = '/usr/sbin/ufw';
const TAG = 'panel:';
const UNDO_UNIT = 'panel-zapora-cofnij';
export const UNDO_SECONDS = 300;

/** Usługi, które muszą być widoczne z internetu. Każda to lista specyfikacji ufw. */
// stałe + dodatkowe z konfiguracji (np. TURN i poczta komunikatora)
export const SERVICES = {
  ssh: { name: 'SSH (logowanie do serwera)', specs: ['22/tcp'], locked: true },
  www: { name: 'Strony (HTTP i HTTPS)', specs: ['80/tcp', '443/tcp'], locked: true },
  ...(fs.existsSync('/etc/apache2/sites-enabled/panel-serwera-ip.conf') ? { panelip: { name: 'Panel pod adresem IP (port 8443)', specs: ['8443/tcp'] } } : {}),
  ...Object.fromEntries(Object.entries(CFG().zapora?.uslugi || {}).filter(([, v]) => v && Array.isArray(v.specs)).map(([k, v]) => [k, { name: String(v.name || k), specs: v.specs.map(String) }])),
  tailscale: { name: 'Tailscale (bezpośrednie połączenia)', specs: ['41641/udp'] },
};
/** Porty, które nie powinny być widoczne z internetu — do ostrzeżeń, gdy zapora jest wyłączona. */
const RISKY = { 3306: 'Baza danych MariaDB', 6379: 'Redis', 5355: 'LLMNR (rozpoznawanie nazw)', 5353: 'mDNS (avahi)', 8099: 'Panel (bez Apache)', 11211: 'Memcached', 27017: 'MongoDB', 5432: 'PostgreSQL' };

const DEFAULTS = {
  services: Object.fromEntries(Object.keys(SERVICES).map((k) => [k, true])),
  trusted: (CFG().zapora?.zaufane || []).map((t) => ({ host: t.host, ports: String(t.ports || '3306'), note: t.note || '', ip: '' })),
  custom: [],
};

export function init(database, dataDir) { db = database; if (dataDir) MARK = path.join(dataDir, 'zapora-bezpiecznik.txt'); }

export function settings() {
  const r = db.prepare("SELECT v FROM ustawienia WHERE k='zapora'").get();
  let s = {};
  try { s = r ? JSON.parse(r.v) : {}; } catch {}
  return { ...DEFAULTS, ...s, services: { ...DEFAULTS.services, ...(s.services || {}) } };
}
function save(s) { db.prepare("INSERT OR REPLACE INTO ustawienia(k,v) VALUES('zapora',?)").run(JSON.stringify(s)); }

/* ------------------------------------------------------------ kontrola */

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
function checkPorts(p) {
  const s = String(p || '').trim();
  if (!/^\d{1,5}(:\d{1,5})?$/.test(s)) throw new Error('Nieprawidłowy port — wpisz np. 8080 albo zakres 6000:6010.');
  const [a, b] = s.split(':').map(Number);
  if (a < 1 || a > 65535 || (b != null && (b < a || b > 65535))) throw new Error('Nieprawidłowy port — zakres 1–65535.');
  return s;
}
function checkFrom(f) {
  const s = String(f || '').trim();
  if (!s || s === 'any' || s === 'wszyscy') return 'any';
  if (net.isIP(s.split('/')[0])) return s;
  throw new Error('Nieprawidłowy adres — wpisz IP (np. 203.0.113.7) albo zostaw puste dla wszystkich.');
}

/* --------------------------------------------------------- stan ufw */

async function ufw(args) { return run(UFW, args, { timeout: 30000 }); }

export async function active() {
  const r = await ufw(['status']);
  return /Status: active/.test(r.out);
}
/** Reguły dodane przez panel (rozpoznawane po komentarzu „panel:”). */
async function panelRules() {
  const r = await ufw(['show', 'added']);
  return r.out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ufw ') && l.includes(`comment '${TAG}`));
}
async function allRules() {
  const r = await ufw(['show', 'added']);
  return r.out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ufw '));
}

/** Docelowy zestaw reguł z ustawień: [ [argumenty ufw...], ... ]. */
function desired(s) {
  const out = [];
  for (const [id, svc] of Object.entries(SERVICES)) {
    if (!svc.locked && !s.services[id]) continue;
    for (const spec of svc.specs) out.push(['allow', spec, 'comment', `${TAG}${id}`]);
  }
  out.push(['allow', 'in', 'on', 'tailscale0', 'comment', `${TAG}tailscale-siec`]);
  for (const t of s.trusted) {
    if (!t.ip) continue;
    for (const port of String(t.ports).split(',').map((x) => x.trim()).filter(Boolean)) {
      out.push(['allow', 'proto', 'tcp', 'from', t.ip, 'to', 'any', 'port', port, 'comment', `${TAG}zaufany:${t.host}`]);
    }
  }
  for (const c of s.custom) {
    const spec = c.proto === 'all' ? c.port : `${c.port}/${c.proto}`;
    if (c.from === 'any') out.push(['allow', spec, 'comment', `${TAG}wlasna:${c.id}`]);
    else for (const pr of c.proto === 'all' ? ['tcp', 'udp'] : [c.proto]) out.push(['allow', 'proto', pr, 'from', c.from, 'to', 'any', 'port', c.port, 'comment', `${TAG}wlasna:${c.id}`]);
  }
  return out;
}
// „ufw show added” wypisuje reguły w swojej kolejności słów — porównujemy po kluczu (akcja, interfejs, protokół, skąd, dokąd, port)
const norm = (line) => line.replace(/^ufw\s+/, '').replace(/\s+comment\s+'.*'$/, '').replace(/\s+/g, ' ').trim();
function ruleKey(tokens) {
  const t = [...tokens];
  const ci = t.indexOf('comment'); if (ci >= 0) t.length = ci;
  const k = { action: '', iface: '', proto: '', from: 'any', to: 'any', port: '' };
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    if (['allow', 'deny', 'reject', 'limit'].includes(w) && !k.action) k.action = w;
    else if (w === 'in' && t[i + 1] === 'on') { k.iface = t[i + 2]; i += 2; }
    else if (w === 'proto') k.proto = t[++i];
    else if (w === 'from') k.from = t[++i];
    else if (w === 'to') k.to = t[++i];
    else if (w === 'port') k.port = t[++i];
    else if (/^\d/.test(w)) { const [p, pr] = w.split('/'); k.port = p; if (pr) k.proto = pr; }
  }
  return `${k.action}|${k.iface}|${k.proto}|${k.from}|${k.to}|${k.port}`;
}
const lineKey = (line) => ruleKey(norm(line).split(' '));
const normArgs = (args) => { const i = args.indexOf('comment'); return (i >= 0 ? args.slice(0, i) : args).join(' '); };

async function resolveTrusted(s) {
  let changed = [];
  for (const t of s.trusted) {
    try {
      const ips = await dns.resolve4(t.host);
      const ip = ips.sort()[0] || '';
      if (ip && ip !== t.ip) { changed.push({ host: t.host, from: t.ip, to: ip }); t.ip = ip; }
    } catch { /* brak odpowiedzi DNS — zostaje poprzedni adres */ }
  }
  return changed;
}

/** Ustawia reguły zgodnie z ustawieniami: dodaje brakujące, usuwa przestarzałe reguły panelu. */
export async function syncRules(s = settings(), say = () => {}) {
  const want = desired(s);
  const have = await allRules();
  const haveKeys = new Set(have.map(lineKey));
  const wantKeys = new Set(want.map(ruleKey));
  for (const args of want) {
    if (haveKeys.has(ruleKey(args))) continue;
    const r = await ufw(args);
    say(`${r.ok ? '+' : '✗'} ${normArgs(args)}${r.ok ? '' : ' — ' + (r.err || r.out).trim()}\n`);
  }
  for (const line of await panelRules()) {
    if (wantKeys.has(lineKey(line))) continue;
    const r = await ufw(['--force', 'delete', ...norm(line).split(' ')]);
    say(`${r.ok ? '−' : '✗'} ${norm(line)}\n`);
  }
}

/* ------------------------------------------------------------ bezpiecznik */

async function undoPending() {
  const r = await run('systemctl', ['show', `${UNDO_UNIT}.timer`, '-p', 'ActiveState', '-p', 'NextElapseUSecMonotonic', '--timestamp=unix']);
  if (!/ActiveState=active/.test(r.out)) return null;
  const since = Number(readText(MARK).trim()) || 0;
  return since ? since + UNDO_SECONDS * 1000 : Date.now() + UNDO_SECONDS * 1000;
}
async function armUndo() {
  await run('systemctl', ['stop', `${UNDO_UNIT}.timer`, `${UNDO_UNIT}.service`]);
  await run('systemctl', ['reset-failed', `${UNDO_UNIT}.timer`, `${UNDO_UNIT}.service`]);
  const r = await run('systemd-run', [`--unit=${UNDO_UNIT}`, `--on-active=${UNDO_SECONDS}`, '--timer-property=AccuracySec=1s', UFW, '--force', 'disable']);
  if (!r.ok) throw new Error('Nie udało się nastawić bezpiecznika: ' + r.err.trim());
  try { fs.writeFileSync(MARK, String(Date.now())); } catch {}
}
export async function confirm() {
  await run('systemctl', ['stop', `${UNDO_UNIT}.timer`]);
  await run('systemctl', ['reset-failed', `${UNDO_UNIT}.timer`, `${UNDO_UNIT}.service`]);
  return { ok: true };
}

/** Sprawdza po cichu, czy z internetu dalej przychodzą nowe połączenia (boty pukają co chwilę):
 *  wpisy w logu Apache i próby SSH z obcych adresów po chwili włączenia. */
export async function seenFromOutside(sinceMs) {
  const res = { www: false, ssh: false };
  const local = /^(127\.|::1|83\.168\.69\.56|100\.|10\.|192\.168\.)/;
  const r = await run('bash', ['-c', 'tail -n 400 /var/log/apache2/*access.log 2>/dev/null']);
  for (const line of r.out.split('\n')) {
    const m = line.match(/^(\S+) \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\]/);
    if (!m || local.test(m[1])) continue;
    const t = Date.parse(`${m[3]} ${m[2]} ${m[4]} ${m[5]}:${m[6]}:${m[7]} GMT${m[8]}`);
    if (t >= sinceMs) { res.www = true; break; }
  }
  const j = await run('journalctl', ['-u', 'ssh', '--since', `@${Math.floor(sinceMs / 1000)}`, '--no-pager', '-o', 'cat']);
  res.ssh = /from (?!127\.|100\.)\d+\.\d+\.\d+\.\d+ port/.test(j.out);
  return res;
}

/* ---------------------------------------------------------------- akcje */

export async function enable(say = () => {}) {
  const s = settings();
  const ch = await resolveTrusted(s);
  for (const c of ch) say(`▸ ${c.host} → ${c.to}\n`);
  save(s);
  say('▸ ustawiam reguły\n');
  await run(UFW, ['default', 'deny', 'incoming']);
  await run(UFW, ['default', 'allow', 'outgoing']);
  await run(UFW, ['default', 'allow', 'routed']); // nic tu nie przekazujemy dalej, ale nie zmieniamy zachowania Tailscale
  await syncRules(s, say);
  say(`▸ bezpiecznik: jeśli nie potwierdzisz w ciągu ${UNDO_SECONDS / 60} min, zapora sama się wyłączy\n`);
  await armUndo();
  const r = await ufw(['--force', 'enable']);
  if (!r.ok) { await confirm(); throw new Error('ufw nie chce się włączyć: ' + (r.err || r.out).trim()); }
  say('✓ zapora włączona\n');
  return { ok: true, undoAt: Date.now() + UNDO_SECONDS * 1000 };
}
export async function disable() {
  await confirm();
  const r = await ufw(['--force', 'disable']);
  if (!r.ok) throw new Error((r.err || r.out).trim());
  return { ok: true };
}

export async function setService(id, on) {
  if (!SERVICES[id]) throw new Error('Nieznana usługa.');
  if (SERVICES[id].locked && !on) throw new Error('Tej usługi nie da się zamknąć — odcięłoby to serwer.');
  const s = settings(); s.services[id] = !!on; save(s);
  if (await active()) await syncRules(s);
  return s;
}
export async function addTrusted({ host, ports, note }) {
  const h = String(host || '').trim().toLowerCase();
  const s = settings();
  let ip = '';
  if (net.isIP(h)) ip = h;
  else if (HOST_RE.test(h)) { try { ip = (await dns.resolve4(h)).sort()[0]; } catch { throw new Error(`Nie znam adresu ${h} — sprawdź nazwę.`); } }
  else throw new Error('Wpisz nazwę (np. dom.example.pl) albo adres IP.');
  const pp = String(ports || '3306').split(',').map((x) => checkPorts(x)).join(',');
  s.trusted = s.trusted.filter((t) => t.host !== h).concat([{ host: h, ports: pp, note: String(note || '').slice(0, 80), ip }]);
  save(s);
  if (await active()) await syncRules(s);
  return s;
}
export async function removeTrusted(host) {
  const s = settings(); s.trusted = s.trusted.filter((t) => t.host !== host); save(s);
  if (await active()) await syncRules(s);
  return s;
}
export async function addCustom({ port, proto, from, note }) {
  const s = settings();
  const c = { id: Math.random().toString(36).slice(2, 8), port: checkPorts(port), proto: ['tcp', 'udp', 'all'].includes(proto) ? proto : 'tcp', from: checkFrom(from), note: String(note || '').slice(0, 80) };
  s.custom.push(c); save(s);
  if (await active()) await syncRules(s);
  return s;
}
export async function removeCustom(id) {
  const s = settings(); s.custom = s.custom.filter((c) => c.id !== id); save(s);
  if (await active()) await syncRules(s);
  return s;
}

/* ------------------------------------------------------------------ stan */

async function listening() {
  const r = await run('ss', ['-tulnpH']);
  const out = [];
  for (const line of r.out.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5) continue;
    const proto = p[0];
    const local = p[4];
    const m = local.match(/^(.*):(\d+)$/);
    if (!m) continue;
    const addr = m[1].replace(/%.*$/, '');
    if (/^(127\.|\[::1\]|\[::ffff:127\.)/.test(addr) || /^100\.|^\[fd7a:/.test(addr)) continue; // lokalne i Tailscale
    const proc = (line.match(/users:\(\("([^"]+)"/) || [])[1] || '';
    out.push({ proto, port: Number(m[2]), addr, proc });
  }
  const seen = new Set();
  return out.filter((x) => { const k = x.proto + x.port; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.port - b.port);
}
function covered(port, proto, s) {
  for (const [id, svc] of Object.entries(SERVICES)) {
    if (!svc.locked && !s.services[id]) continue;
    for (const spec of svc.specs) {
      const [range, pr] = spec.split('/');
      if (pr && pr !== proto) continue;
      const [a, b] = range.split(':').map(Number);
      if (port >= a && port <= (b || a)) return { by: svc.name, all: true };
    }
  }
  for (const c of s.custom) {
    if (c.proto !== 'all' && c.proto !== proto) continue;
    const [a, b] = c.port.split(':').map(Number);
    if (port >= a && port <= (b || a)) return { by: c.note || 'Twoja reguła', all: c.from === 'any' };
  }
  for (const t of s.trusted) if (proto === 'tcp' && String(t.ports).split(',').map(Number).includes(port)) return { by: `tylko ${t.host}`, all: false };
  return null;
}

let failCache = { at: 0, n: 0 };
async function dbAttacks() {
  if (Date.now() - failCache.at < 10 * 60e3) return failCache.n;
  const j = await run('journalctl', ['-u', 'mariadb', '--since', '-7d', '--no-pager', '-o', 'cat'], { timeout: 20000 });
  failCache = { at: Date.now(), n: (j.out.match(/Access denied for user/g) || []).length };
  return failCache.n;
}

export async function status() {
  const s = settings();
  const [on, rules, ports, undoAt, attacks] = await Promise.all([active(), allRules(), listening(), undoPending(), dbAttacks()]);
  const exposed = ports.map((p) => {
    const c = covered(p.port, p.proto.startsWith('udp') ? 'udp' : 'tcp', s);
    return { ...p, proto: p.proto.startsWith('udp') ? 'udp' : 'tcp', label: RISKY[p.port] || '', open: on ? !!c?.all : true, limited: on && c && !c.all ? c.by : '', by: c?.by || '' };
  });
  const risky = exposed.filter((p) => p.open && RISKY[p.port]);
  return {
    active: on, undoAt, settings: s, attacks,
    services: Object.entries(SERVICES).map(([id, v]) => ({ id, name: v.name, specs: v.specs, locked: !!v.locked, on: !!(v.locked || s.services[id]) })),
    ports: exposed, risky, otherRules: rules.filter((l) => !l.includes(`comment '${TAG}`) && !new Set(desired(s).map(ruleKey)).has(lineKey(l))).map(norm),
  };
}

/** Wołane przez autopilota co kilka minut: odświeża adresy zaufanych nazw i pilnuje bezpiecznika. */
export async function maintain(onChange = () => {}) {
  const s = settings();
  if (!s.trusted.length) return;
  const ch = await resolveTrusted(s);
  if (!ch.length) return;
  save(s);
  if (await active()) await syncRules(s);
  for (const c of ch) if (c.from) onChange(c); // pierwsze ustalenie adresu to nie zmiana
}
