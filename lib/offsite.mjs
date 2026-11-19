// Kopie w chmurze: po nocnej kopii wysyła zaszyfrowane bazy, kod i migawkę plików poza serwer (rclone).
// Szyfrowanie po stronie serwera (rclone crypt) — dostawca widzi tylko zaszyfrowane pliki o zaszyfrowanych nazwach.
// Raz w tygodniu sprawdza, czy kopię da się odczytać: porównuje sumy kontrolne i rozpakowuje najnowszy zrzut bazy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, spawnCollect, readText, exists } from './util.mjs';

let db, DATA_DIR, CONF;
const RCLONE = '/usr/bin/rclone';
import { C as CFG } from './config.mjs';
const SRC = process.env.CHMURA_SRC || CFG().kopie.katalog;
const NAME = () => String(CFG().nazwa || 'serwer').toLowerCase().replace(/[^a-z0-9-]/g, '-');

export const PROVIDERS = {
  b2: { name: 'Backblaze B2', hint: 'Najprostsze i najtańsze: 10 GB za darmo, potem ok. 0,03 zł za GB miesięcznie.', fields: [['account', 'keyID (identyfikator klucza)'], ['key', 'applicationKey (sam klucz)', true], ['bucket', 'Nazwa koszyka (bucket)']] },
  s3: { name: 'Inny dostawca S3 (Cloudflare R2, Wasabi, AWS, OVH…)', hint: 'Każda usługa zgodna z S3.', fields: [['endpoint', 'Adres (endpoint), np. https://s3.eu-central-003.backblazeb2.com'], ['region', 'Region (może zostać puste)'], ['key', 'Access key'], ['secret', 'Secret key', true], ['bucket', 'Nazwa koszyka (bucket)']] },
  sftp: { name: 'Serwer SFTP (np. Hetzner Storage Box, NAS w domu)', hint: 'Dowolny serwer z dostępem SFTP.', fields: [['host', 'Adres serwera'], ['port', 'Port (zwykle 22, Hetzner: 23)'], ['user', 'Użytkownik'], ['pass', 'Hasło', true], ['path', 'Katalog na serwerze (np. kopie)']] },
};

const DEFAULTS = { enabled: false, provider: '', cfg: {}, crypt: '', hour: 4, minute: 20, media: true, keepDays: 30, last: null, lastTest: null, history: [] };

export function init(database, dataDir) {
  db = database; DATA_DIR = dataDir; CONF = path.join(dataDir, 'rclone.conf');
}
export function settings() {
  const r = db.prepare("SELECT v FROM ustawienia WHERE k='chmura'").get();
  let s = {};
  try { s = r ? JSON.parse(r.v) : {}; } catch {}
  return { ...DEFAULTS, ...s };
}
function save(s) { db.prepare("INSERT OR REPLACE INTO ustawienia(k,v) VALUES('chmura',?)").run(JSON.stringify(s)); }

/** Ustawienia bez sekretów — do pokazania w przeglądarce. */
export function publicSettings() {
  const s = settings();
  const cfg = {};
  for (const [k, , secret] of PROVIDERS[s.provider]?.fields || []) cfg[k] = secret ? (s.cfg[k] ? '••••••' : '') : s.cfg[k] || '';
  return { enabled: s.enabled, provider: s.provider, cfg, hour: s.hour, minute: s.minute, media: s.media, keepDays: s.keepDays, last: s.last, lastTest: s.lastTest, history: (s.history || []).slice(-14), hasKey: !!s.crypt, configured: !!(s.provider && s.crypt) };
}

/* ------------------------------------------------------------ rclone.conf */

async function obscure(v) { const r = await run(RCLONE, ['obscure', String(v)]); if (!r.ok) throw new Error('rclone obscure: ' + r.err); return r.out.trim(); }

async function writeConf(s) {
  const c = s.cfg;
  let target = '';
  if (s.provider === 'b2') target = `[cel]\ntype = b2\naccount = ${c.account}\nkey = ${c.key}\nhard_delete = true\n`;
  else if (s.provider === 's3') target = `[cel]\ntype = s3\nprovider = Other\naccess_key_id = ${c.key}\nsecret_access_key = ${c.secret}\nendpoint = ${c.endpoint}\n${c.region ? `region = ${c.region}\n` : ''}`;
  else if (s.provider === 'sftp') target = `[cel]\ntype = sftp\nhost = ${c.host}\nuser = ${c.user}\nport = ${c.port || 22}\npass = ${await obscure(c.pass)}\nshell_type = none\n`;
  else if (s.provider === 'lokalny' && process.env.CHMURA_TEST) target = `[cel]\ntype = local\n`;
  else throw new Error('Wybierz, gdzie wysyłać kopie.');
  const base = s.provider === 'lokalny' ? `cel:${c.path}` : s.provider === 'sftp' ? `cel:${(c.path || 'kopie').replace(/^\/+/, '')}/${NAME()}` : `cel:${c.bucket}/${NAME()}`;
  const [pw1, pw2] = s.crypt.split(':');
  const conf = `${target}\n[szyfr]\ntype = crypt\nremote = ${base}\nfilename_encryption = standard\ndirectory_name_encryption = true\npassword = ${await obscure(pw1)}\npassword2 = ${await obscure(pw2)}\n`;
  fs.writeFileSync(CONF, conf, { mode: 0o600 });
  return conf;
}
const rc = (args, opts = {}) => run(RCLONE, ['--config', CONF, ...args], { timeout: 120000, ...opts });

const clean = (v) => String(v ?? '').trim().replace(/[\r\n]/g, '');

export async function configure(body) {
  const s = settings();
  const provider = String(body.provider || '');
  if (provider === 'lokalny' && process.env.CHMURA_TEST) PROVIDERS.lokalny = { name: 'Katalog lokalny (test)', fields: [['path', 'Katalog']] };
  if (!PROVIDERS[provider]) throw new Error('Wybierz, gdzie wysyłać kopie.');
  const old = s.provider === provider ? s.cfg : {};
  const cfg = {};
  for (const [k, label, secret] of PROVIDERS[provider].fields) {
    let v = clean(body.cfg?.[k]);
    if (secret && (v === '' || v === '••••••') && old[k]) v = old[k];
    if (!v && !['region', 'port', 'path'].includes(k)) throw new Error(`Uzupełnij: ${label}.`);
    if (/[\s=\[\]]/.test(v) && !['endpoint', 'path'].includes(k)) throw new Error(`Nieprawidłowa wartość: ${label}.`);
    cfg[k] = v;
  }
  if (provider === 's3' && !/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(cfg.endpoint)) throw new Error('Adres musi zaczynać się od https://');
  if (cfg.bucket && !/^[a-z0-9][a-z0-9.-]{1,62}$/i.test(cfg.bucket)) throw new Error('Nieprawidłowa nazwa koszyka.');
  if (provider === 'sftp' && cfg.port && !/^\d{1,5}$/.test(cfg.port)) throw new Error('Nieprawidłowy port.');
  const n = { ...s, provider, cfg };
  if (!n.crypt) n.crypt = crypto.randomBytes(24).toString('base64url') + ':' + crypto.randomBytes(24).toString('base64url');
  await writeConf(n);
  // próba połączenia: lista katalogu docelowego (utworzy go, jeśli trzeba)
  const test = await rc(['mkdir', 'szyfr:'], { timeout: 60000 });
  if (!test.ok) throw new Error('Nie udało się połączyć: ' + (test.err.split('\n').find((l) => /ERROR|error|Failed/.test(l)) || test.err).slice(0, 300));
  const w = await rc(['rcat', 'szyfr:proba.txt'], { input: `Panel serwera ${CFG().nazwa} — próba zapisu ${new Date().toISOString()}\n`, timeout: 60000 });
  if (!w.ok) throw new Error('Połączenie działa, ale nie da się zapisać pliku: ' + w.err.slice(0, 300));
  n.enabled = true;
  save(n);
  return publicSettings();
}

export function setOptions(body) {
  const s = settings();
  if ('enabled' in body) s.enabled = !!body.enabled && !!s.provider;
  if ('media' in body) s.media = !!body.media;
  if ('keepDays' in body) s.keepDays = Math.max(7, Math.min(365, Math.round(Number(body.keepDays) || 30)));
  if ('hour' in body) s.hour = Math.max(0, Math.min(23, Math.round(Number(body.hour))));
  save(s);
  return publicSettings();
}

/** Plik do odzyskania kopii bez tego serwera — zawiera klucze, więc trzeba go trzymać w bezpiecznym miejscu. */
export async function recoveryKit() {
  const s = settings();
  if (!s.crypt) throw new Error('Kopie w chmurze nie są jeszcze ustawione.');
  const conf = await writeConf(s);
  return `KOPIE SERWERA ${String(CFG().nazwa).toUpperCase()} — PAKIET ODZYSKIWANIA
Wygenerowano: ${new Date().toLocaleString('pl-PL')}

Ten plik pozwala odczytać kopie w chmurze nawet wtedy, gdy serwera już nie ma.
Trzymaj go poza serwerem (np. w menedżerze haseł albo na pendrive). Kto go ma, ten ma dostęp do kopii.

1. Zainstaluj rclone: https://rclone.org/downloads/
2. Zapisz wszystko między liniami ===== jako plik rclone.conf
3. Zobacz, co jest w kopii:        rclone --config rclone.conf ls szyfr:
4. Pobierz wszystko do katalogu:   rclone --config rclone.conf copy szyfr: ./kopie --progress
   (bazy: kopie/bazy/*.sql.gz, kod stron i konfiguracja: kopie/kod/*.tar.gz, pliki: kopie/media/biezace)

Klucze szyfrowania (gdyby trzeba było odtworzyć konfigurację ręcznie, typ „crypt”, szyfrowanie nazw: standard):
  hasło 1: ${s.crypt.split(':')[0]}
  hasło 2 (sól): ${s.crypt.split(':')[1]}

=====
${conf}=====
`;
}

/* ------------------------------------------------------------- wysyłka */

const busy = { on: false };
function latestSnapshot() {
  const dir = path.join(SRC, 'media');
  try { return fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop() || null; } catch { return null; }
}
function statsOf(out) {
  const m = out.match(/Transferred:\s+([\d.]+ ?\w+) \/ ([\d.]+ ?\w+)/);
  const files = (out.match(/Transferred:\s+(\d+) \/ (\d+), 100%/) || [])[1];
  return { sent: m ? m[1] : '0 B', files: files ? Number(files) : null };
}

export async function upload(say = () => {}) {
  const s = settings();
  if (!s.provider || !s.crypt) throw new Error('Najpierw ustaw, gdzie wysyłać kopie.');
  if (busy.on) throw new Error('Wysyłka już trwa.');
  busy.on = true;
  const t0 = Date.now();
  const res = { start: t0, end: null, ok: false, sent: [], msg: '' };
  try {
    await writeConf(s);
    const common = ['--transfers', '4', '--checkers', '8', '--stats-one-line', '--stats', '0', '--stats-log-level', 'NOTICE', '--retries', '5', '--low-level-retries', '20', '--bwlimit', '0'];
    const steps = [
      ['bazy', ['copy', path.join(SRC, 'bazy'), 'szyfr:bazy', ...common]],
      ['kod i konfiguracja', ['copy', path.join(SRC, 'kod'), 'szyfr:kod', ...common]],
    ];
    const snap = latestSnapshot();
    if (s.media && snap) steps.push([`pliki (migawka ${snap})`, ['sync', path.join(SRC, 'media', snap), 'szyfr:media/biezace', '--backup-dir', `szyfr:media/stare/${snap}`, ...common]]);
    for (const [label, args] of steps) {
      say(`▸ ${label}\n`);
      const r = await spawnCollect(RCLONE, ['--config', CONF, ...args, '-v'], { onData: (x) => { for (const l of x.split('\n')) if (/ERROR|Transferred:/.test(l)) say('  ' + l.replace(/^.*?(ERROR|Transferred)/, '$1').trim() + '\n'); } });
      if (!r.ok) throw new Error(`${label}: rclone zakończył się błędem (kod ${r.code})`);
      res.sent.push({ label, ...statsOf(r.out) });
    }
    say(`▸ sprzątam w chmurze kopie starsze niż ${s.keepDays} dni\n`);
    await rc(['delete', 'szyfr:bazy', '--min-age', `${s.keepDays}d`], { timeout: 600000 });
    await rc(['delete', 'szyfr:kod', '--min-age', `${s.keepDays}d`], { timeout: 600000 });
    const old = await rc(['lsf', '--dirs-only', 'szyfr:media/stare'], { timeout: 120000 });
    const cutoff = new Date(Date.now() - s.keepDays * 864e5).toISOString().slice(0, 10);
    for (const d of old.out.split('\n').map((x) => x.replace(/\/$/, '')).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x) && x < cutoff)) await rc(['purge', `szyfr:media/stare/${d}`], { timeout: 600000 });
    const size = await rc(['size', 'szyfr:', '--json'], { timeout: 600000 });
    try { res.total = JSON.parse(size.out).bytes; } catch {}
    res.ok = true;
    say(`✓ wysłane${res.total ? ` — w chmurze łącznie ${(res.total / 1073741824).toFixed(2).replace('.', ',')} GB` : ''}\n`);
  } catch (e) {
    res.msg = e.message;
    say(`✗ ${e.message}\n`);
  } finally {
    busy.on = false;
    res.end = Date.now();
    const n = settings();
    n.last = res;
    n.history = [...(n.history || []), { t: res.start, ok: res.ok, total: res.total || null }].slice(-60);
    save(n);
  }
  return res;
}

/** Test odtworzenia: sumy kontrolne + pobranie i rozpakowanie najnowszego zrzutu bazy. */
export async function verify(say = () => {}) {
  const s = settings();
  if (!s.provider || !s.crypt) throw new Error('Najpierw ustaw, gdzie wysyłać kopie.');
  await writeConf(s);
  const res = { start: Date.now(), ok: false, msg: '' };
  try {
    say('▸ porównuję sumy kontrolne baz (bez pobierania)\n');
    const cc = await rc(['cryptcheck', path.join(SRC, 'bazy'), 'szyfr:bazy', '--one-way'], { timeout: 900000 });
    const diff = (cc.err.match(/(\d+) differences found/) || [])[1];
    if (!cc.ok && diff !== '0') throw new Error(`Sumy się nie zgadzają${diff ? ` (${diff} różnic)` : ''}: ${cc.err.split('\n').filter((l) => /ERROR/.test(l)).slice(0, 2).join(' ')}`);
    say('✓ sumy kontrolne się zgadzają\n');
    const list = await rc(['lsf', 'szyfr:bazy', '--files-only'], { timeout: 120000 });
    const newest = list.out.split('\n').filter((f) => f.endsWith('.sql.gz')).sort((a, b) => a.replace(/^.*_/, '').localeCompare(b.replace(/^.*_/, ''))).pop();
    if (!newest) throw new Error('W chmurze nie ma żadnego zrzutu bazy.');
    say(`▸ pobieram i rozpakowuję ${newest}\n`);
    const tmp = path.join(DATA_DIR, 'tmp', 'test-' + crypto.randomBytes(4).toString('hex') + '.sql.gz');
    const get = await rc(['copyto', `szyfr:bazy/${newest}`, tmp], { timeout: 600000 });
    if (!get.ok) throw new Error('Nie udało się pobrać: ' + get.err.slice(0, 200));
    const gz = await run('gzip', ['-t', tmp]);
    const head = (await run('bash', ['-c', `zcat "$1" | head -c 4000`, '_', tmp])).out;
    fs.rmSync(tmp, { force: true });
    if (!gz.ok) throw new Error('Pobrany zrzut jest uszkodzony.');
    if (!/(MariaDB|MySQL) dump|CREATE TABLE|INSERT INTO/.test(head)) throw new Error('Pobrany plik nie wygląda na zrzut bazy.');
    res.ok = true; res.file = newest;
    say('✓ kopię da się odczytać i rozpakować\n');
  } catch (e) { res.msg = e.message; say(`✗ ${e.message}\n`); }
  res.end = Date.now();
  const n = settings(); n.lastTest = res; save(n);
  return res;
}

export const isBusy = () => busy.on;
export const ready = () => { const s = settings(); return s.enabled && !!s.provider && !!s.crypt && exists(RCLONE); };
