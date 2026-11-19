// Redis: pamięć podręczna (dziś używa jej panel gier). „Baza” założona w panelu to osobne konto z hasłem,
// które widzi tylko swoje klucze (przedrostek nazwa:*). Redis działa tylko lokalnie.
import fs from 'node:fs';
import { run } from '../util.mjs';
import { cell, isSecret } from './common.mjs';

export const installed = () => fs.existsSync('/usr/bin/redis-server');
export const UNIT = 'redis-server';
async function cli(args, { input } = {}) {
  const r = await run('redis-cli', ['--no-auth-warning', ...args], { timeout: 15000, input });
  if (!r.ok || /^(ERR|WRONGTYPE|NOPERM|NOAUTH)/.test(r.out.trim())) throw new Error('Redis: ' + (r.out.trim() || r.err.trim()));
  return r.out;
}
/** Polecenie z argumentami przekazanymi przez stdin (hasła nie trafiają do listy procesów). */
async function cmd(...args) {
  const line = args.map((a) => '"' + String(a).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(' ') + '\n';
  return cli([], { input: line });
}
export async function info() {
  const t = await cli(['INFO']);
  const g = (k) => (t.match(new RegExp(`^${k}:(.*)$`, 'm')) || [])[1]?.trim() || '';
  const dbs = [...t.matchAll(/^db(\d+):keys=(\d+),expires=(\d+)/gm)].map((m) => ({ n: Number(m[1]), keys: Number(m[2]) }));
  return { version: g('redis_version'), mem: Number(g('used_memory')) || 0, clients: Number(g('connected_clients')) || 0, dbs };
}
export async function version() { try { return (await info()).version; } catch { return ''; } }
async function save() { await cli(['CONFIG', 'REWRITE']).catch(() => {}); }

export async function users() {
  const t = await cli(['ACL', 'LIST']);
  return t.split('\n').filter((l) => l.startsWith('user ')).map((l) => {
    const p = l.split(' ');
    const u = p[1];
    const on = p.includes('on');
    const nopass = p.includes('nopass');
    const keys = p.filter((x) => x.startsWith('~')).map((x) => x.slice(1));
    const prefix = keys.length === 1 && /^[a-z0-9_]+:\*$/.test(keys[0]) ? keys[0].slice(0, -2) : null;
    return { engine: 'redis', user: u, hosts: ['localhost'], locked: !on, global: prefix ? null : 'pelne', grantOption: false, dbs: prefix ? [{ db: prefix, rights: 'pelne' }] : [], nopass, system: u === 'default' };
  });
}
export async function list() {
  const i = await info();
  const out = i.dbs.map((d) => ({ name: `db${d.n}`, size: d.n === 0 ? i.mem : 0, tables: d.keys, changed: null, system: false, keys: d.keys }));
  if (!out.length) out.push({ name: 'db0', size: i.mem, tables: 0, keys: 0, changed: null, system: false });
  for (const u of await users()) {
    const pre = u.dbs[0]?.db;
    if (!pre) continue;
    out.push({ name: pre, size: null, tables: await countKeys(pre + ':*'), changed: null, system: false, prefix: true });
  }
  return out;
}
async function countKeys(pattern, cap = 20000) {
  let cur = '0', n = 0;
  do {
    const t = (await cmd('SCAN', cur, 'MATCH', pattern, 'COUNT', 1000)).trim().split('\n');
    cur = t[0]; n += t.slice(1).filter(Boolean).length;
  } while (cur !== '0' && n < cap);
  return n;
}
export async function exists(name) { return (await users()).some((u) => u.dbs[0]?.db === name); }
export async function userExists(u) { return (await users()).some((x) => x.user === u); }
export async function createUser(u, pass) {
  if (await userExists(u)) throw new Error(`Konto ${u} już istnieje.`);
  await cmd('ACL', 'SETUSER', u, 'on', '>' + pass, `~${u}:*`, `&${u}:*`, '+@all', '-@admin', '-@dangerous', '-select');
  await save();
}
const guard = (u) => { if (u === 'default') throw new Error('Konta domyślnego używa panel gier — panel go nie zmienia.'); };
export async function setPassword(u, pass) { guard(u); await cmd('ACL', 'SETUSER', u, 'resetpass', '>' + pass); await save(); }
export async function setLocked(u, on) { guard(u); await cmd('ACL', 'SETUSER', u, on ? 'off' : 'on'); await save(); }
export async function dropUser(u) { guard(u); await cmd('ACL', 'DELUSER', u); await save(); }
export async function createDb() {} // baza = konto z przedrostkiem
export async function dropDb(name) {
  // usuwa klucze z przedrostkiem (konto usuwa się osobno)
  let cur = '0';
  do {
    const t = (await cmd('SCAN', cur, 'MATCH', name + ':*', 'COUNT', 1000)).trim().split('\n');
    cur = t[0];
    const keys = t.slice(1).filter(Boolean);
    if (keys.length) await cmd('UNLINK', ...keys);
  } while (cur !== '0');
}

/* ---------------------------------------------------------------- dane */

const dbIndex = (name) => { const m = /^db(\d+)$/.exec(name); return m ? Number(m[1]) : 0; };
const patternOf = (name) => (/^db\d+$/.test(name) ? '*' : name + ':*');
export async function tables(name) {
  return [{ name: 'klucze', rows: /^db\d+$/.test(name) ? (await info()).dbs.find((d) => d.n === dbIndex(name))?.keys ?? 0 : await countKeys(patternOf(name)), size: null, approx: false, view: true }];
}
export async function rows(name, _t, { od = 0, szukaj = '', limit = 50 } = {}) {
  const n = dbIndex(name);
  const pat = szukaj ? (/^db\d+$/.test(name) ? `*${szukaj}*` : `${name}:*${szukaj}*`) : patternOf(name);
  const keys = [];
  let cur = '0';
  do {
    const t = (await cli(['-n', String(n), 'SCAN', cur, 'MATCH', pat, 'COUNT', '1000'])).trim().split('\n');
    cur = t[0]; keys.push(...t.slice(1).filter(Boolean));
  } while (cur !== '0' && keys.length < od + limit + 1 && keys.length < 50000);
  keys.sort();
  const page = keys.slice(od, od + limit);
  const out = [];
  for (const k of page) {
    const type = (await cli(['-n', String(n), 'TYPE', k])).trim();
    const ttl = Number((await cli(['-n', String(n), 'TTL', k])).trim());
    let val = '';
    if (isSecret(k)) val = '•••••• ukryte';
    else if (type === 'string') val = cell((await cli(['-n', String(n), '--raw', 'GET', k])).replace(/\n$/, ''), 'v', 300);
    else if (type === 'hash') val = `${(await cli(['-n', String(n), 'HLEN', k])).trim()} pól`;
    else if (type === 'list') val = `${(await cli(['-n', String(n), 'LLEN', k])).trim()} elementów`;
    else if (type === 'set') val = `${(await cli(['-n', String(n), 'SCARD', k])).trim()} elementów`;
    else if (type === 'zset') val = `${(await cli(['-n', String(n), 'ZCARD', k])).trim()} elementów`;
    out.push([k, type, ttl < 0 ? 'bez końca' : `${ttl} s`, val]);
  }
  return { cols: [{ name: 'klucz' }, { name: 'typ' }, { name: 'wygasa' }, { name: 'wartość' }], rows: out, total: keys.length > od + limit ? null : keys.length, approx: false, offset: od, limit, editable: false, view: true };
}

/* ------------------------------------------------------------ zapytania */

const READ = new Set(['GET', 'MGET', 'HGET', 'HGETALL', 'HKEYS', 'HLEN', 'LRANGE', 'LLEN', 'SMEMBERS', 'SCARD', 'ZRANGE', 'ZCARD', 'TYPE', 'TTL', 'PTTL', 'EXISTS', 'STRLEN', 'SCAN', 'DBSIZE', 'INFO', 'KEYS', 'MEMORY', 'OBJECT', 'PING', 'TIME', 'HEXISTS', 'SISMEMBER', 'ZSCORE', 'GETRANGE', 'LINDEX', 'HSCAN', 'SSCAN', 'ZSCAN']);
const BLOCK = new Set(['FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'CONFIG', 'ACL', 'DEBUG', 'MODULE', 'SLAVEOF', 'REPLICAOF', 'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'MIGRATE', 'SCRIPT', 'EVAL', 'EVALSHA', 'FUNCTION', 'MONITOR', 'SUBSCRIBE', 'PSUBSCRIBE', 'CLIENT', 'FAILOVER', 'CLUSTER', 'SELECT', 'SWAPDB', 'MOVE']);
function words(text) {
  const out = []; const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(String(text)))) out.push(m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}
export function classify(text) {
  const w = (words(text)[0] || '').toUpperCase();
  if (!w) return { kind: 'blocked', msg: 'Wpisz polecenie, np. GET klucz' };
  if (BLOCK.has(w)) return { kind: 'blocked', msg: 'Tego polecenia nie uruchamiam z panelu — użyj terminala.' };
  if (READ.has(w)) return { kind: 'read', word: w };
  return { kind: 'dml', word: w };
}
export async function query(name, text, { mode = 'read' } = {}) {
  const a = words(text);
  if (mode === 'preview') return { affected: null };
  const out = await cli(['-n', String(dbIndex(name)), ...a]);
  return { cols: ['wynik'], rows: out.replace(/\n$/, '').split('\n').slice(0, 500).map((l) => [l]) };
}
export const dumpArgs = () => ['redis-cli', ['--rdb', '-']];
