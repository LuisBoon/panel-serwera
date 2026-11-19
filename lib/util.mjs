// Wspólne narzędzia panelu: uruchamianie poleceń (zawsze bez powłoki), pamięć podręczna, drobiazgi.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';

/** Uruchamia program z listą argumentów (bez powłoki — żadnego wstrzykiwania). */
export function run(cmd, args = [], { timeout = 20000, input, maxBuffer = 32 * 1024 * 1024, env, cwd } = {}) {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { timeout, maxBuffer, env: env || process.env, cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: stdout || '',
        err: (stderr || '') + (err && !stderr ? String(err.message || err) : ''),
      });
    });
    if (input != null) p.stdin.end(input);
  });
}

/** Wynik funkcji trzymany przez `ms`; równoległe wywołania czekają na jedno liczenie. */
export function cached(ms, fn) {
  let val, at = 0, pending = null;
  const get = async (force = false) => {
    if (!force && val !== undefined && Date.now() - at < ms) return val;
    if (pending) return pending;
    pending = (async () => {
      try { val = await fn(); at = Date.now(); return val; }
      finally { pending = null; }
    })();
    return pending;
  };
  get.peek = () => val;
  get.reset = () => { at = 0; };
  return get;
}

export function readText(path, fallback = '') {
  try { return fs.readFileSync(path, 'utf8'); } catch { return fallback; }
}

export function exists(path) {
  try { fs.accessSync(path); return true; } catch { return false; }
}

export function stat(path) {
  try { return fs.statSync(path); } catch { return null; }
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Ostatnie `max` znaków tekstu (do przechowywania wyjścia zadań). */
export function tail(text, max = 20000) {
  return text.length > max ? '…\n' + text.slice(-max) : text;
}

/** Długie zadanie w tle: spawn z przechwyceniem wyjścia. */
export function spawnCollect(cmd, args, { onData, env, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(cmd, args, { env: env || process.env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (b) => { const s = b.toString(); out = tail(out + s, 200000); onData?.(s); };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    p.on('error', (e) => { out += `\n${e.message}`; });
    p.on('close', (code) => resolve({ ok: code === 0, code, out }));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
