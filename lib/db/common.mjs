// Wspólne dla silników baz: hasła, nazwy, maskowanie poufnych kolumn, adresy (dom, serwer).
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { metrics } from '../system.mjs';
import { C } from '../config.mjs';

export const BACKUP_DIR = process.env.BAZY_KOPIE || C().kopie.katalog;
export const homeHost = () => C().dom?.host || '';
/** Nazwy nowych baz i kont: małe litery, cyfry i podkreślnik, zaczyna się literą. */
export const NEW_NAME_RE = /^[a-z][a-z0-9_]{1,31}$/;
/** Istniejące nazwy (np. konta z panelu gier: u3_Iu3fwaJMVO) — do odczytu i akcji. */
export const NAME_RE = /^[A-Za-z0-9_$.-]{1,80}$/;
export const HOST_RE = /^[A-Za-z0-9_.%:-]{1,255}$/;
export const TABLE_RE = /^[^\0/\\]{1,128}$/;
export const SECRET_COL = /pass|hash|token|secret|salt|otp|totp|2fa|session|cookie|api_?key|private|vapid|auth_key|p256dh|endpoint|has[lł]o|klucz/i;

export function checkNew(name, what = 'Nazwa') {
  const n = String(name || '').trim();
  if (!NEW_NAME_RE.test(n)) throw new Error(`${what}: 2–32 znaki — małe litery, cyfry i _ (na początku litera).`);
  return n;
}
export function checkName(name) {
  const n = String(name ?? '');
  if (!NAME_RE.test(n)) throw new Error('Nieprawidłowa nazwa.');
  return n;
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function password(len = 24) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[crypto.randomInt(ALPHA.length)];
  return s;
}

/** Wartość komórki do pokazania: poufne kolumny ukryte, długie teksty przycięte. */
export function cell(v, col, max = 400) {
  if (v === null || v === undefined) return null;
  if (SECRET_COL.test(col) && String(v).length) return '•••••• ukryte';
  if (v instanceof Uint8Array) return `[dane binarne, ${v.length} B]`;
  if (typeof v === 'object') { try { v = JSON.stringify(v); } catch { v = String(v); } }
  const s = String(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}
export const isSecret = (col) => SECRET_COL.test(col);

let homeCache = { at: 0, ip: '' };
/** Adres serwera w domu (z konfiguracji) — zmienia się, więc sprawdzamy co kilka minut. */
export async function homeIp() {
  if (!homeHost()) return '';
  if (Date.now() - homeCache.at < 5 * 60e3 && homeCache.ip) return homeCache.ip;
  try { homeCache = { at: Date.now(), ip: (await dns.resolve4(homeHost())).sort()[0] || '' }; } catch {}
  return homeCache.ip;
}
export const serverIp = () => metrics().ip || '';

/** Pierwsze słowo zapytania (bez komentarzy na początku). */
export function firstWord(sql) {
  const s = String(sql || '').replace(/^(\s|\/\*[\s\S]*?\*\/|--[^\n]*(\n|$)|#[^\n]*(\n|$))*/, '');
  return (s.match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
}
