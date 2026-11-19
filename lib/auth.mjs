// Logowanie: hasło (scrypt) + kod z aplikacji (TOTP, RFC 6238), sesje w ciasteczku HttpOnly.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = ((val << 8) | b) & 0xfff; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

export function b32decode(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = ((val << 5) | B32.indexOf(c)) & 0xfff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

export const newTotpSecret = () => b32encode(crypto.randomBytes(20));

/** Zwraca numer kroku czasowego, jeśli kod pasuje (±30 s) i nie był już użyty; inaczej null. */
export function verifyTotp(secret, code, lastStep = -1) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const key = b32decode(secret);
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const step = now + d;
    if (step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code))) return step;
  }
  return null;
}

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export async function hashPassword(pass) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(String(pass).normalize('NFC'), salt, 64, SCRYPT);
  return `s1$${salt.toString('hex')}$${h.toString('hex')}`;
}

export async function checkPassword(pass, stored) {
  const [v, saltHex, hashHex] = String(stored || '').split('$');
  if (v !== 's1' || !saltHex || !hashHex) {
    await scrypt('x', 'y', 64, SCRYPT); // ta sama długość odpowiedzi dla nieistniejącego konta
    return false;
  }
  const h = await scrypt(String(pass).normalize('NFC'), Buffer.from(saltHex, 'hex'), 64, SCRYPT);
  const want = Buffer.from(hashHex, 'hex');
  return want.length === h.length && crypto.timingSafeEqual(want, h);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
