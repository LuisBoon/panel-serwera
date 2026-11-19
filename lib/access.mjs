// Dostęp: konta SFTP zamknięte w folderze jednej strony (chroot + bind mount) i klucze SSH roota.
// Konto SFTP: użytkownik systemowy w grupie www-data (pliki czyta Apache) i sftp-panel (blok Match w sshd).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, readText, exists } from './util.mjs';
import * as T from './sitetools.mjs';
import * as J from './journal.mjs';
import { C as CFG } from './config.mjs';
import { metrics } from './system.mjs';

const SSHD = '/etc/ssh/sshd_config';
const B0 = '# >>> panel-serwera: konta SFTP (nie edytuj ręcznie)', B1 = '# <<< panel-serwera';
const ROOT = '/srv/sftp';
const GROUP = 'sftp-panel';
const KEYS = '/root/.ssh/authorized_keys';
let db;

export function init(database) {
  db = database;
  db.exec('CREATE TABLE IF NOT EXISTS sftp(user TEXT PRIMARY KEY, site TEXT, dir TEXT, created INTEGER, by TEXT, note TEXT)');
  J.handler('klucze-ssh', async (d) => { fs.writeFileSync(KEYS, Buffer.from(d.content, 'base64'), { mode: 0o600 }); });
}

/* ---------------------------------------------------------------- sshd */

async function sshdReload(newText, oldText) {
  fs.writeFileSync(SSHD, newText);
  const t = await run('sshd', ['-t']);
  if (!t.ok) { fs.writeFileSync(SSHD, oldText); throw new Error('Konfiguracja SSH nie przeszła testu — nic nie zmieniłem. ' + t.err.trim().split('\n')[0]); }
  const r = await run('systemctl', ['reload', 'ssh']);
  if (!r.ok) { fs.writeFileSync(SSHD, oldText); await run('systemctl', ['reload', 'ssh']); throw new Error('Nie udało się przeładować SSH: ' + r.err.trim()); }
}
async function ensureSshd() {
  const t = readText(SSHD);
  if (t.includes(B0)) return;
  const block = [B0, `Match Group ${GROUP}`, `    ChrootDirectory ${ROOT}/%u`, '    ForceCommand internal-sftp -d /strona -u 0002', '    AllowTcpForwarding no', '    AllowAgentForwarding no', '    X11Forwarding no', '    PermitTunnel no', '    PasswordAuthentication yes', B1].join('\n');
  await sshdReload(t.replace(/\n*$/, '\n\n') + block + '\n', t);
}
async function ensureGroup() { if (!(await run('getent', ['group', GROUP])).ok) { const r = await run('groupadd', ['--system', GROUP]); if (!r.ok) throw new Error('groupadd: ' + r.err); } }

/* ---------------------------------------------------------------- SFTP */

const USER_RE = /^[a-z][a-z0-9_-]{2,30}$/;
function fstabLine(u, dir) { return `${dir} ${ROOT}/${u}/strona none bind 0 0 # panel-serwera sftp ${u}`; }
function lastLogins() {
  return run('journalctl', ['-u', 'ssh', '--since', '-60d', '--no-pager', '-o', 'short-unix', '--grep', 'Accepted (password|publickey) for']).then((r) => {
    const m = new Map();
    for (const l of r.out.split('\n')) { const x = l.match(/^(\d+)\.\d+ .*Accepted (\w+) for (\S+) from (\S+)/); if (x) m.set(x[3], { ts: Number(x[1]) * 1000, how: x[2], ip: x[4] }); }
    return m;
  });
}
export async function sftpList() {
  const last = await lastLogins();
  const rows = db.prepare('SELECT * FROM sftp ORDER BY created').all();
  const out = [];
  for (const r of rows) {
    const sh = await run('passwd', ['-S', r.user]);
    out.push({ ...r, locked: / L /.test(sh.out), mounted: (await run('mountpoint', ['-q', `${ROOT}/${r.user}/strona`])).ok, last: last.get(r.user) || null });
  }
  return out;
}
export async function sftpCreate({ user, site, note }, who) {
  const u = String(user || '').trim().toLowerCase();
  if (!USER_RE.test(u)) throw new Error('Login: 3–31 znaków — małe litery, cyfry, _ i - (na początku litera).');
  if ((await run('id', [u])).ok) throw new Error(`Konto ${u} już istnieje na serwerze.`);
  const info = T.siteInfo(String(site || ''));
  const dir = info.root;
  if (!dir || !/^\/var\/www\/[^/]+/.test(dir)) throw new Error('Ta strona nie ma folderu z plikami w /var/www.');
  const pass = crypto.randomBytes(15).toString('base64url');
  await ensureGroup();
  const ch = path.join(ROOT, u);
  const undo = [];
  try {
    for (const d of ['/srv', ROOT, ch]) { fs.mkdirSync(d, { recursive: true }); fs.chownSync(d, 0, 0); fs.chmodSync(d, 0o755); }
    fs.mkdirSync(path.join(ch, 'strona'), { recursive: true });
    let r = await run('useradd', ['-M', '-d', '/strona', '-s', '/usr/sbin/nologin', '-g', 'www-data', '-G', GROUP, '-c', `SFTP ${info.name} - panel serwera`, u]);
    if (!r.ok) throw new Error('useradd: ' + r.err.trim());
    undo.push(() => run('userdel', [u]));
    r = await run('chpasswd', [], { input: `${u}:${pass}\n` });
    if (!r.ok) throw new Error('chpasswd: ' + r.err.trim());
    // zapis do plików strony przez grupę www-data; nowe pliki dziedziczą grupę
    await run('chmod', ['-R', 'g+rwX', dir], { timeout: 120000 });
    await run('find', [dir, '-type', 'd', '-exec', 'chmod', 'g+s', '{}', '+'], { timeout: 120000 });
    const fst = readText('/etc/fstab');
    if (!fst.includes(`${ROOT}/${u}/strona `)) fs.writeFileSync('/etc/fstab', fst.replace(/\n*$/, '\n') + fstabLine(u, dir) + '\n');
    undo.push(() => fs.writeFileSync('/etc/fstab', fst));
    r = await run('mount', ['--bind', dir, path.join(ch, 'strona')]);
    if (!r.ok) throw new Error('mount: ' + r.err.trim());
    undo.push(() => run('umount', [path.join(ch, 'strona')]));
    await ensureSshd();
  } catch (e) {
    for (const f of undo.reverse()) { try { await f(); } catch {} }
    fs.rmSync(ch, { recursive: true, force: true });
    throw e;
  }
  db.prepare('INSERT OR REPLACE INTO sftp(user,site,dir,created,by,note) VALUES(?,?,?,?,?,?)').run(u, info.name, dir, Date.now(), who?.login || '', String(note || '').slice(0, 100));
  J.add(who, 'dostep', `Nowe konto SFTP ${u} → ${info.name}`, null, '#/dostep');
  return { user: u, password: pass, host: CFG().domena || metrics().ip, port: 22, dir };
}
function row(u) { const r = db.prepare('SELECT * FROM sftp WHERE user=?').get(String(u)); if (!r) throw new Error('Nie ma takiego konta SFTP.'); return r; }
export async function sftpPassword(u, who) {
  const r = row(u);
  const pass = crypto.randomBytes(15).toString('base64url');
  const x = await run('chpasswd', [], { input: `${r.user}:${pass}\n` });
  if (!x.ok) throw new Error('chpasswd: ' + x.err.trim());
  J.add(who, 'dostep', `Nowe hasło konta SFTP ${r.user}`, null, '#/dostep');
  return { password: pass };
}
export async function sftpLock(u, on, who) {
  const r = row(u);
  await run('usermod', [on ? '-L' : '-U', r.user]);
  if (on) await run('pkill', ['-KILL', '-u', r.user]);
  J.add(who, 'dostep', `${on ? 'Zablokowano' : 'Odblokowano'} konto SFTP ${r.user}`, null, '#/dostep');
}
export async function sftpDelete(u, who) {
  const r = row(u);
  await run('pkill', ['-KILL', '-u', r.user]);
  const mp = path.join(ROOT, r.user, 'strona');
  await run('umount', [mp]);
  if ((await run('mountpoint', ['-q', mp])).ok) throw new Error('Nie udało się odpiąć folderu — spróbuj za chwilę.');
  fs.writeFileSync('/etc/fstab', readText('/etc/fstab').split('\n').filter((l) => !l.includes(`# panel-serwera sftp ${r.user}`)).join('\n'));
  await run('userdel', [r.user]);
  // tylko pusty punkt montowania i katalog chroot (pliki strony zostają nietknięte w /var/www)
  try { fs.rmdirSync(mp); fs.rmdirSync(path.join(ROOT, r.user)); } catch {}
  db.prepare('DELETE FROM sftp WHERE user=?').run(r.user);
  J.add(who, 'dostep', `Usunięto konto SFTP ${r.user} (pliki strony zostały)`, null, '#/dostep');
}

/* ------------------------------------------------------------- klucze SSH */

const KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]{40,}( .{0,200})?$/;
async function fingerprint(line) {
  const r = await run('ssh-keygen', ['-lf', '-'], { input: line + '\n' });
  const m = r.out.match(/^(\d+) (SHA256:\S+) (.*) \((\w+)\)/);
  return m ? { bits: Number(m[1]), fp: m[2], type: m[4] } : null;
}
export async function keys() {
  const last = new Map();
  const r = await run('journalctl', ['-u', 'ssh', '--since', '-60d', '--no-pager', '-o', 'short-unix', '--grep', 'Accepted publickey for root']);
  for (const l of r.out.split('\n')) { const x = l.match(/^(\d+)\.\d+ .*Accepted publickey for root from (\S+) .*: \S+ (SHA256:\S+)/); if (x) last.set(x[3], { ts: Number(x[1]) * 1000, ip: x[2] }); }
  const out = [];
  const lines = readText(KEYS).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith('#')) continue;
    const f = await fingerprint(l);
    const comment = (l.match(/^(?:\S+ )?(?:ssh-\S+|ecdsa-\S+|sk-\S+) \S+ (.*)$/) || [])[1] || '';
    out.push({ line: i, type: f?.type || l.split(' ')[0], bits: f?.bits || null, fp: f?.fp || '?', comment, options: !/^(ssh-|ecdsa-|sk-)/.test(l), last: f ? last.get(f.fp) || null : null });
  }
  const sshd = await run('sshd', ['-T']);
  const g = (k) => (sshd.out.match(new RegExp(`^${k} (.*)$`, 'm')) || [])[1] || '';
  const pwdLogins = [...(await run('journalctl', ['-u', 'ssh', '--since', '-30d', '--no-pager', '-o', 'cat', '--grep', 'Accepted password for root'])).out.split('\n').filter(Boolean)].length;
  return { keys: out, rootLogin: g('permitrootlogin'), password: g('passwordauthentication'), rootPasswordLogins30d: pwdLogins };
}
export async function keyAdd(text, who) {
  const line = String(text || '').trim().replace(/\s+/g, ' ');
  if (!KEY_RE.test(line)) throw new Error('To nie wygląda na klucz publiczny SSH — powinien zaczynać się od ssh-ed25519 albo ssh-rsa (plik .pub).');
  if (/PRIVATE KEY/.test(line)) throw new Error('To klucz prywatny — wklej publiczny (plik .pub).');
  const f = await fingerprint(line);
  if (!f) throw new Error('Klucz jest uszkodzony.');
  const cur = readText(KEYS);
  if ((await keys()).keys.some((k) => k.fp === f.fp)) throw new Error('Ten klucz już jest dodany.');
  fs.mkdirSync('/root/.ssh', { recursive: true, mode: 0o700 });
  const before = Buffer.from(cur).toString('base64');
  fs.writeFileSync(KEYS, cur.replace(/\n*$/, cur ? '\n' : '') + line + '\n', { mode: 0o600 });
  J.add(who, 'dostep', `Dodano klucz SSH ${f.type} ${f.fp.slice(0, 20)}…${line.split(' ')[2] ? ' (' + line.split(' ').slice(2).join(' ').slice(0, 40) + ')' : ''}`, { type: 'klucze-ssh', data: { content: before } }, '#/dostep/klucze');
  return { fp: f.fp };
}
export async function keyRemove(fp, who) {
  const k = await keys();
  const key = k.keys.find((x) => x.fp === fp);
  if (!key) throw new Error('Nie ma takiego klucza.');
  if (k.keys.length === 1 && !/^yes$/.test(k.password)) throw new Error('To ostatni klucz, a logowanie hasłem jest wyłączone — po usunięciu nikt nie wejdzie przez SSH. Najpierw dodaj inny klucz.');
  const cur = readText(KEYS);
  const lines = cur.split('\n');
  lines.splice(key.line, 1);
  fs.writeFileSync(KEYS, lines.join('\n'), { mode: 0o600 });
  J.add(who, 'dostep', `Usunięto klucz SSH ${key.type} ${fp.slice(0, 20)}…${key.comment ? ' (' + key.comment.slice(0, 40) + ')' : ''}`, { type: 'klucze-ssh', data: { content: Buffer.from(cur).toString('base64') } }, '#/dostep/klucze');
}
/** Logowanie roota hasłem: wyłączenie zostawia logowanie kluczem (PermitRootLogin prohibit-password). */
export async function rootPassword(on, who) {
  const k = await keys();
  if (!on && !k.keys.length) throw new Error('Nie ma żadnego klucza SSH — po wyłączeniu haseł nie dałoby się wejść jako root. Najpierw dodaj klucz.');
  const t = readText(SSHD);
  const line = `PermitRootLogin ${on ? 'yes' : 'prohibit-password'}`;
  let next;
  if (/^PermitRootLogin\s+\S+/m.test(t)) next = t.replace(/^PermitRootLogin\s+\S+.*$/gm, line);
  else next = t.replace(/^(Include .*\n)/m, `$1${line}\n`);
  await sshdReload(next, t);
  J.add(who, 'dostep', on ? 'Włączono logowanie roota hasłem (SSH)' : 'Wyłączono logowanie roota hasłem — tylko klucze SSH', { type: 'plik', data: { path: SSHD, content: Buffer.from(t).toString('base64'), mode: 0o644, after: ['ssh'] } }, '#/dostep/klucze');
}
J.afterRestore?.('ssh', async () => { const t = await run('sshd', ['-t']); if (t.ok) await run('systemctl', ['reload', 'ssh']); });
