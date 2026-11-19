// Terminal w przeglądarce: pełna powłoka root na serwerze, tylko dla właściciela i po świeżym kodzie z aplikacji.
// Każda sesja jest zapisywana do pliku (DATA_DIR/terminal), a nieużywana zamyka się sama.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { stamp } from './util.mjs';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'terminal-pty.py');
const IDLE_MS = 20 * 60e3, MAX_MS = 3 * 3600e3, KEEP_DAYS = 30, BUF = 400 * 1024;
let DIR = '/var/lib/panel-serwera/terminal';
let onEnd = () => {};
const sessions = new Map();

export function init(dataDir, { ended } = {}) {
  DIR = path.join(dataDir, 'terminal');
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (ended) onEnd = ended;
  setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (!s.closed && (now - s.lastInput > IDLE_MS || now - s.started > MAX_MS)) close(s.id, now - s.started > MAX_MS ? 'limit 3 godzin' : 'bezczynność 20 min');
      if (s.closed && now - s.closedAt > 10 * 60e3) sessions.delete(s.id);
    }
  }, 30e3).unref();
}

function frame(kind, data) {
  const b = Buffer.from(data);
  const h = Buffer.alloc(5); h.write(kind, 0); h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
}
function wake(s) { const w = s.waiters.splice(0); for (const f of w) f(); }

export function open(who, { cols = 100, rows = 30 } = {}) {
  for (const s of sessions.values()) if (s.login === who.login && !s.closed) close(s.id, 'otwarto nową sesję');
  for (const f of fs.readdirSync(DIR)) { const p = path.join(DIR, f); try { if (Date.now() - fs.statSync(p).mtimeMs > KEEP_DAYS * 864e5) fs.rmSync(p); } catch {} }
  const id = crypto.randomBytes(16).toString('hex');
  const file = path.join(DIR, `${stamp()}-${who.login.replace(/[^a-z0-9._-]/gi, '')}.log`);
  const env = { HOME: '/root', USER: 'root', LOGNAME: 'root', SHELL: '/bin/bash', TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', PANEL_TERMINAL: '1' };
  const p = spawn('python3', ['-I', HELPER], { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: '/root', detached: true });
  const s = { id, login: who.login, ip: who.ip, started: Date.now(), lastInput: Date.now(), closed: false, closedAt: 0, reason: '', chunks: [], seq: 0, size: 0, dec: new StringDecoder('utf8'), waiters: [], proc: p, file, fd: fs.openSync(file, 'a', 0o600), bytesIn: 0 };
  fs.writeSync(s.fd, `# sesja terminala panelu: ${who.login} z ${who.ip}, ${new Date().toISOString()}\n`);
  const push = (t) => {
    if (!t) return;
    s.chunks.push({ seq: ++s.seq, t }); s.size += t.length;
    while (s.size > BUF && s.chunks.length > 1) s.size -= s.chunks.shift().t.length;
    wake(s);
  };
  p.stdout.on('data', (b) => { try { fs.writeSync(s.fd, b); } catch {} push(s.dec.write(b)); });
  p.stderr.on('data', (b) => push(s.dec.write(b)));
  p.on('exit', () => { if (!s.closed) finish(s, 'powłoka zakończona'); });
  p.on('error', (e) => { push(`\r\nNie udało się uruchomić terminala: ${e.message}\r\n`); finish(s, 'błąd'); });
  p.stdin.on('error', () => {});
  sessions.set(id, s);
  resize(id, who.login, cols, rows);
  return { id, started: s.started };
}
function finish(s, reason) {
  if (s.closed) return;
  s.closed = true; s.closedAt = Date.now(); s.reason = reason;
  try { fs.writeSync(s.fd, `\n# koniec sesji (${reason}), ${new Date().toISOString()}\n`); fs.closeSync(s.fd); } catch {}
  wake(s);
  onEnd(s);
}
function get(id, login) {
  const s = sessions.get(String(id));
  if (!s || s.login !== login) throw Object.assign(new Error('Sesja terminala wygasła — otwórz nową.'), { status: 410 });
  return s;
}
export async function read(id, login, since = 0) {
  const s = get(id, login);
  const pick = () => s.chunks.filter((c) => c.seq > since);
  let list = pick();
  if (!list.length && !s.closed) {
    await new Promise((resolve) => { const t = setTimeout(resolve, 25000); s.waiters.push(() => { clearTimeout(t); resolve(); }); });
    list = pick();
  }
  const lost = s.chunks.length && since && s.chunks[0].seq > since + 1;
  return { seq: s.seq, data: (lost ? '\r\n[…]\r\n' : '') + list.map((c) => c.t).join(''), closed: s.closed, reason: s.reason };
}
export function write(id, login, data) {
  const s = get(id, login);
  if (s.closed) throw Object.assign(new Error('Sesja jest zakończona.'), { status: 410 });
  const d = String(data || '');
  if (d.length > 64 * 1024) throw new Error('Za dużo naraz — wklej mniejszy fragment.');
  s.lastInput = Date.now(); s.bytesIn += d.length;
  s.proc.stdin.write(frame('d', d));
}
export function resize(id, login, cols, rows) {
  const s = get(id, login);
  if (s.closed) return;
  s.proc.stdin.write(frame('r', `${Math.round(Number(cols) || 100)} ${Math.round(Number(rows) || 30)}`));
}
export function close(id, reason = 'zamknięto') {
  const s = sessions.get(String(id));
  if (!s || s.closed) return;
  try { process.kill(-s.proc.pid, 'SIGHUP'); } catch {}
  setTimeout(() => { try { process.kill(-s.proc.pid, 'SIGKILL'); } catch {} }, 3000).unref();
  finish(s, reason);
}
export function closeFor(id, login, reason) { get(id, login); close(id, reason); }
export function list() { return [...sessions.values()].filter((s) => !s.closed).map((s) => ({ login: s.login, ip: s.ip, started: s.started, lastInput: s.lastInput })); }
export function logs() {
  let f = []; try { f = fs.readdirSync(DIR).filter((x) => x.endsWith('.log')); } catch {}
  return f.sort().reverse().slice(0, 30).map((x) => { const st = fs.statSync(path.join(DIR, x)); return { name: x, size: st.size, time: st.mtimeMs }; });
}
export function logPath(name) { if (!/^[\w.-]+\.log$/.test(String(name))) throw new Error('Nie ma takiego zapisu.'); const p = path.join(DIR, name); if (!fs.existsSync(p)) throw new Error('Nie ma takiego zapisu.'); return p; }
