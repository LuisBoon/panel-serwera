// Przenoszenie stron na inny serwer z grupy (wariant A: kreator w 4 krokach).
// 1 Dokąd → 2 Co przenieść → 3 Przenoszę (paczka: pliki + zrzut bazy z kontami + ustawienia strony; tamten panel zakłada
// stronę swoim kreatorem i ją rozpakowuje) → 4 Przełącz adres (OVH sam albo instrukcja; certyfikat na nowym serwerze,
// stara strona tutaj zostaje wyłączona i czeka, aż ją usuniesz — po 7 dniach panel przypomina).
// Obsługuje zwykłe strony, PHP i WordPress (z bazą MariaDB). Aplikacji Node przez proxy jeszcze nie.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { run, readText, exists } from './util.mjs';
import * as T from './sitetools.mjs';
import * as C from './create.mjs';
import * as S from './system.mjs';
import * as APP from './apps.mjs';
import * as GR from './group.mjs';
import * as J from './journal.mjs';
import { C as CFG, DATA_DIR } from './config.mjs';

let db, OV = null, panelHosts = [];
const TMP = () => { const d = path.join(DATA_DIR, 'tmp'); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const MB = (n) => `${Math.max(1, Math.round(n / 1048576)).toLocaleString('pl-PL')} MB`;
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DB_RE = /^[A-Za-z0-9_]{1,64}$/;
const KEEP_DAYS = 7;

export function init(database, { ovh, hosts } = {}) {
  db = database; OV = ovh || null; panelHosts = hosts || [];
  db.exec(`CREATE TABLE IF NOT EXISTS przeniesienia(id TEXT PRIMARY KEY, site TEXT, server_id TEXT, server_name TEXT, target_ip TEXT, state TEXT,
    opts TEXT, info TEXT, created INTEGER, by TEXT, moved INTEGER, switched INTEGER, removed INTEGER)`);
}
const rowOf = (id) => { const r = db.prepare('SELECT * FROM przeniesienia WHERE id=?').get(String(id)); if (!r) throw Object.assign(new Error('Nie ma takiego przenoszenia.'), { status: 404 }); return { ...r, info: JSON.parse(r.info || '{}'), opts: JSON.parse(r.opts || '{}') }; };
const setRow = (id, patch) => { const r = rowOf(id); const n = { ...r, ...patch }; db.prepare('UPDATE przeniesienia SET state=?, target_ip=?, info=?, moved=?, switched=?, removed=? WHERE id=?').run(n.state, n.target_ip, JSON.stringify(n.info || {}), n.moved, n.switched, n.removed, id); return rowOf(id); };
export const forSite = (name) => { const r = db.prepare('SELECT id FROM przeniesienia WHERE site=? AND removed IS NULL ORDER BY created DESC LIMIT 1').get(String(name)); return r ? rowOf(r.id) : null; };
export const pending = () => db.prepare("SELECT id FROM przeniesienia WHERE removed IS NULL AND state IN ('czeka-dns','gotowe')").all().map((r) => rowOf(r.id));

async function mysqlLines(sql) { const r = await run('mysql', ['-N', '-B', '-e', sql], { timeout: 60000 }); if (!r.ok) throw new Error('MariaDB: ' + (r.err.split('\n').find((l) => /^ERROR/.test(l)) || r.err.split('\n').filter((l) => l && !/^-+$/.test(l))[0] || 'błąd')); return r.out.split('\n').filter(Boolean); }
async function dirSize(d) { const r = await run('du', ['-sb', d], { timeout: 300000 }); return Number(r.out.split('\t')[0]) || 0; }
async function freeBytes(d) { const r = await run('df', ['-B1', '--output=avail', d]); return Number(r.out.split('\n')[1]) || 0; }
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/* ------------------------------------------------------ serwer A: co przenieść */

export async function plan(name) {
  const info = T.siteInfo(name);
  const out = { name, ok: true, problems: [], root: info.root, kind: info.kind, https: info.https };
  if (info.proxies.length || info.unit) { out.ok = false; out.problems.push('To aplikacja działająca przez proxy (np. Node.js) — takie przeniesie dopiero następna wersja panelu. Zwykłe strony, PHP i WordPress przenoszą się w całości.'); }
  if (!info.root) { out.ok = false; out.problems.push('Ta strona nie ma folderu z plikami (np. samo przekierowanie) — załóż ją na tamtym serwerze w „Utwórz”.'); }
  if (panelHosts.includes(name)) { out.ok = false; out.problems.push('Przez tę stronę działa panel — jego się nie przenosi.'); }
  if (info.root) {
    out.size = await dirSize(info.root);
    out.files = Number((await run('bash', ['-c', 'find "$1" -type f | wc -l', '_', info.root], { timeout: 120000 })).out.trim()) || 0;
    const used = await T.dbsUsedBy(info.root).catch(() => []);
    if (used.length) {
      const d = used[0].db;
      const sz = await mysqlLines(`SELECT COALESCE(SUM(data_length+index_length),0) FROM information_schema.tables WHERE table_schema=${q(d)}`).catch(() => ['0']);
      const users = (await mysqlLines(`SELECT CONCAT(User,'@',Host) FROM mysql.db WHERE Db=${q(d)} OR Db=${q(d.replace(/_/g, '\\_'))}`).catch(() => [])).filter((u) => !/^root@/.test(u));
      out.db = { name: d, size: Number(sz[0]) || 0, users, files: used[0].files, others: used.slice(1).map((x) => x.db) };
    }
  }
  let st = null; try { st = APP.siteSettings(name); } catch {}
  out.settings = st && st.php ? { php: st.phpVersion || st.phpDefault || null, summary: settingsSummary(st) } : null;
  out.servers = GR.servers().filter((s) => s.rola === 'admin').map((s) => ({ id: s.id, nazwa: s.nazwa, url: s.url }));
  out.current = forSite(name);
  return out;
}
function settingsSummary(st) {
  const p = [];
  p.push(`PHP ${st.phpVersion || `${st.phpDefault || ''} (domyślne)`.trim()}`);
  if (st.memory) p.push(`pamięć ${st.memory}`);
  if (st.upload) p.push(`pliki do ${st.upload}`);
  if (st.redirects?.length) p.push(`${st.redirects.length} ${st.redirects.length === 1 ? 'przekierowanie' : 'przekierowań'}`);
  return p.join(', ') || 'domyślne';
}

/** Konta bazy z hasłem (skrótem) i uprawnieniami tylko do tej bazy — żeby konfiguracja strony działała bez zmian. */
async function dbAccounts(dbName) {
  const out = [];
  for (const l of await mysqlLines(`SELECT CONCAT(User,'|',Host) FROM mysql.db WHERE Db=${q(dbName)} OR Db=${q(dbName.replace(/_/g, '\\_'))}`)) {
    const [u, h] = l.split('|');
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(u) || !/^[A-Za-z0-9_.%:-]{1,60}$/.test(h) || u === 'root') continue;
    const create = (await mysqlLines(`SHOW CREATE USER ${q(u)}@${q(h)}`))[0] || '';
    const grants = (await mysqlLines(`SHOW GRANTS FOR ${q(u)}@${q(h)}`)).filter((g) => g.includes(`\`${dbName}\``) || g.includes(`\`${dbName.replace(/_/g, '\\_')}\``));
    out.push({ user: u, host: h, create, grants });
  }
  return out;
}

/** Zadanie na serwerze A: paczka → wysyłka → tamten panel zakłada stronę. */
export async function start(name, b, who, say) {
  const r = GR.serverRow(b.server);
  if (r.rola !== 'admin') throw new Error(`Serwer „${r.nazwa}” jest połączony tylko do podglądu.`);
  const p = await plan(name);
  if (!p.ok) throw new Error(p.problems.join(' '));
  if (p.current && !p.current.removed && p.current.state !== 'blad') throw new Error('Ta strona jest już przenoszona — dokończ albo usuń poprzednie przenoszenie.');
  const withDb = b.withDb !== false && !!p.db, withSettings = b.withSettings !== false && !!p.settings;
  // nazwy na tamtym serwerze (zmiana tylko w kopii testowej panelu, gdy oba „serwery” to ta sama maszyna)
  const asName = b.asName && process.env.AUTOPILOT === '0' ? String(b.asName).toLowerCase() : name;
  const asDb = withDb ? (b.asDb && process.env.AUTOPILOT === '0' ? String(b.asDb) : p.db.name) : null;
  if (!NAME_RE.test(asName) || (asDb && !DB_RE.test(asDb))) throw new Error('Nieprawidłowa nazwa.');
  const id = crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO przeniesienia(id,site,server_id,server_name,state,opts,info,created,by) VALUES(?,?,?,?,?,?,?,?,?)').run(id, name, r.id, r.nazwa, 'kopiuje', JSON.stringify({ withDb, withSettings, asName, asDb }), '{}', Date.now(), who?.login || '');
  const work = fs.mkdtempSync(path.join(TMP(), 'przenies-'));
  try {
    say(`▸ sprawdzam, czy ${asName} da się założyć na „${r.nazwa}”\n`);
    const chk = await GR.call(r, 'POST', 'api/grupa/strona/sprawdz', { name: asName, db: asDb, size: p.size + (withDb ? p.db.size * 2 : 0) });
    if (!chk.ok) throw new Error(`Na „${r.nazwa}”: ${chk.problems.join(' ')}`);
    if (await freeBytes(TMP()) < p.size * 1.1 + (withDb ? p.db.size : 0) + 200 * 1048576) throw new Error('Za mało miejsca tutaj na spakowanie strony.');
    say(`▸ pakuję pliki (${MB(p.size)}, ${p.files.toLocaleString('pl-PL')} ${p.files === 1 ? 'plik' : [2, 3, 4].includes(p.files % 10) && ![12, 13, 14].includes(p.files % 100) ? 'pliki' : 'plików'})\n`);
    let x = await run('tar', ['czf', path.join(work, 'pliki.tar.gz'), '-C', p.root, '.'], { timeout: 3600e3 });
    if (!x.ok) throw new Error('Pakowanie plików nie wyszło: ' + x.err.slice(0, 200));
    const meta = { name: asName, from: CFG().nazwa, oldRoot: p.root, db: null, settings: null, created: Date.now() };
    if (withDb) {
      say(`▸ zrzut bazy ${p.db.name} (${MB(p.db.size)})\n`);
      x = await run('bash', ['-c', 'set -o pipefail; mysqldump --single-transaction --quick --routines --triggers --events --default-character-set=utf8mb4 "$1" | gzip > "$2"', '_', p.db.name, path.join(work, 'baza.sql.gz')], { timeout: 3600e3 });
      if (!x.ok) throw new Error('Zrzut bazy nie wyszedł: ' + x.err.slice(0, 200));
      const acc = await dbAccounts(p.db.name);
      meta.db = { name: asDb, from: p.db.name, accounts: acc.map((a) => ({ ...a, grants: a.grants.map((g) => g.replace(`ON \`${p.db.name}\`.`, `ON \`${asDb}\`.`).replace(`ON \`${p.db.name.replace(/_/g, '\\_')}\`.`, `ON \`${asDb}\`.`)) })) };
      say(`  konta bazy: ${acc.map((a) => a.user).join(', ') || 'brak'} (z tym samym hasłem)\n`);
    }
    if (withSettings) { try { meta.settings = APP.siteSettings(name); } catch {} }
    fs.writeFileSync(path.join(work, 'meta.json'), JSON.stringify(meta));
    const pkg = path.join(work, 'paczka.tar');
    x = await run('tar', ['cf', pkg, '-C', work, 'meta.json', 'pliki.tar.gz', ...(withDb ? ['baza.sql.gz'] : [])], { timeout: 600e3 });
    if (!x.ok) throw new Error('Paczka nie wyszła: ' + x.err.slice(0, 200));
    say(`▸ wysyłam na „${r.nazwa}” (${MB(fs.statSync(pkg).size)})\n`);
    const up = await GR.upload(r, 'api/grupa/strona/przyjmij', pkg);
    fs.rmSync(work, { recursive: true, force: true });
    say(`▸ „${r.nazwa}” zakłada stronę:\n`);
    const res = await follow(r, up.job, say);
    setRow(id, { state: 'czeka-dns', target_ip: res.ip || null, info: { ...res, size: p.size, db: withDb ? asDb : null }, moved: Date.now() });
    J.add(who, 'strony', `Przeniesiono ${name} na serwer ${r.nazwa} (czeka na przełączenie adresu)`, null, `#/przenies/${encodeURIComponent(name)}`);
    say(`✓ strona działa na „${r.nazwa}” (${res.ip}) — zostało przełączyć adres\n`);
    return { ok: true, result: { ...res, id } };
  } catch (e) {
    fs.rmSync(work, { recursive: true, force: true });
    setRow(id, { state: 'blad', info: { error: e.message } });
    throw e;
  }
}
async function follow(r, job, say) {
  let seen = 0;
  for (let i = 0; i < 3600; i++) {
    await new Promise((ok) => setTimeout(ok, 2000));
    let j;
    try { j = await GR.call(r, 'GET', `api/zadania/${job.id}`); } catch (e) { if (i > 5 && e.status === 404) throw new Error('Tamten panel zgubił zadanie (restart?).'); continue; }
    const out = String(j.out || '');
    if (out.length > seen) { say(out.slice(seen).split('\n').map((l) => (l ? '  ' + l : l)).join('\n')); seen = out.length; }
    if (j.end) { if (!j.ok) throw new Error(`Na „${r.nazwa}” nie wyszło — szczegóły wyżej.`); return j.result || {}; }
  }
  throw new Error('Za długo — sprawdź stan na tamtym serwerze.');
}

/* ------------------------------------------------------ serwer B: przyjęcie strony */

export async function canReceive({ name, db: dbName, size }) {
  const problems = [];
  const n = String(name || '').toLowerCase();
  if (!NAME_RE.test(n)) problems.push('Nieprawidłowy adres strony.');
  else { const chk = await C.check({ template: 'pusta', host: n }); if (!chk.ok) problems.push(...chk.problems); }
  if (dbName) {
    if (!DB_RE.test(dbName)) problems.push('Nieprawidłowa nazwa bazy.');
    else if ((await mysqlLines(`SHOW DATABASES LIKE ${q(dbName)}`).catch(() => ['?'])).length) problems.push(`Baza ${dbName} już tu jest — nie nadpisuję jej.`);
  }
  const free = await freeBytes('/var/www');
  if (Number(size) && free < Number(size) * 2.2 + 500 * 1048576) problems.push(`Za mało miejsca na dysku (wolne ${MB(free)}).`);
  return { ok: !problems.length, problems, free, ip: S.metrics().ip };
}

/** Zadanie na serwerze B: rozpakowanie paczki, założenie strony, bazy i kont. */
export async function receive(pkg, who, say) {
  const work = fs.mkdtempSync(path.join(TMP(), 'przyjmij-'));
  let made = null, dbMade = null;
  try {
    let x = await run('tar', ['xf', pkg, '-C', work, '--no-same-owner'], { timeout: 600e3 });
    if (!x.ok) throw new Error('Paczka jest uszkodzona.');
    const meta = JSON.parse(readText(path.join(work, 'meta.json')) || '{}');
    const chk = await canReceive({ name: meta.name, db: meta.db?.name, size: 0 });
    if (!chk.ok) throw new Error(chk.problems.join(' '));
    say(`▸ zakładam ${meta.name}\n`);
    made = await C.create({ template: 'pusta', host: meta.name, startPage: false }, who, say);
    say(`▸ rozpakowuję pliki do ${made.dir}\n`);
    for (const f of fs.readdirSync(made.dir)) fs.rmSync(path.join(made.dir, f), { recursive: true, force: true });
    x = await run('tar', ['xzf', path.join(work, 'pliki.tar.gz'), '-C', made.dir, '--no-same-owner'], { timeout: 3600e3 });
    if (!x.ok) throw new Error('Rozpakowanie plików nie wyszło: ' + x.err.slice(0, 200));
    await run('chown', ['-R', 'www-data:www-data', made.dir], { timeout: 600e3 });
    // ścieżki na sztywno w konfiguracji (np. /var/www/stara-nazwa) → nowy folder
    if (meta.oldRoot && meta.oldRoot !== made.dir && /^\/[\w./-]+$/.test(meta.oldRoot)) {
      const g = await run('grep', ['-rlF', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=uploads', '--exclude-dir=cache', '--include=*.php', '--include=*.ini', '--include=*.json', '--include=*.env', '--include=.env', '--include=*.conf', '--include=*.yml', '--include=*.yaml', '--include=.htaccess', '--include=.user.ini', meta.oldRoot, made.dir], { timeout: 120e3 });
      const files = g.out.split('\n').filter(Boolean).filter((f) => { try { return fs.statSync(f).size < 2 * 1048576; } catch { return false; } });
      for (const f of files) fs.writeFileSync(f, readText(f).split(meta.oldRoot).join(made.dir));
      if (files.length) say(`  poprawiam ścieżkę ${meta.oldRoot} → ${made.dir} w: ${files.map((f) => path.relative(made.dir, f)).slice(0, 6).join(', ')}${files.length > 6 ? '…' : ''}\n`);
    }
    if (meta.db) {
      say(`▸ baza ${meta.db.name}\n`);
      await mysqlLines(`CREATE DATABASE \`${meta.db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      dbMade = meta.db.name;
      x = await run('bash', ['-c', 'set -o pipefail; zcat "$1" | mysql "$2"', '_', path.join(work, 'baza.sql.gz'), meta.db.name], { timeout: 3600e3 });
      if (!x.ok) throw new Error('Import bazy nie wyszedł: ' + x.err.slice(0, 200));
      for (const a of meta.db.accounts || []) {
        if (!/^[A-Za-z0-9_.-]{1,80}$/.test(a.user) || !/^[A-Za-z0-9_.%:-]{1,60}$/.test(a.host)) continue;
        const exists_ = (await mysqlLines(`SELECT COUNT(*) FROM mysql.user WHERE User=${q(a.user)} AND Host=${q(a.host)}`))[0] !== '0';
        if (!exists_ && /^CREATE USER /i.test(a.create)) await mysqlLines(a.create);
        for (const g of a.grants) if (/^GRANT [A-Z ,]+ ON `[A-Za-z0-9_\\]+`\.\* TO /.test(g)) await mysqlLines(g);
        say(`  konto ${a.user}@${a.host}${exists_ ? ' (już było — dodane uprawnienia)' : ''}\n`);
      }
      C.setDb(made.slug, meta.db.name, (meta.db.accounts || [])[0]?.user || null);
    }
    if (meta.settings) {
      try { await APP.saveSiteSettings(meta.name, meta.settings, who, (t) => say('  ' + t)); say('  ustawienia strony przeniesione\n'); }
      catch (e) { say(`  ustawień strony nie udało się przenieść (${e.message}) — ustawisz je w karcie strony\n`); }
    }
    J.add(who, 'strony', `Przyjęto stronę ${meta.name} z serwera ${meta.from}`, null, `#/strona/${encodeURIComponent(meta.name)}`);
    say(`✓ ${meta.name} gotowa — certyfikat pobierze się po przełączeniu adresu\n`);
    return { ok: true, result: { ip: S.metrics().ip, dir: made.dir, slug: made.slug, name: meta.name, db: meta.db?.name || null } };
  } catch (e) {
    say(`✗ ${e.message} — sprzątam\n`);
    if (dbMade) await run('mysql', ['-e', `DROP DATABASE IF EXISTS \`${dbMade}\``]);
    if (made) { try { await C.remove(made.slug, () => {}); } catch {} }
    throw e;
  } finally { fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(pkg, { force: true }); }
}
/** Na serwerze B: certyfikat po przełączeniu adresu. */
export async function receiveSsl(name, say) {
  const r = C.list().find((x) => x.host === String(name));
  if (!r) throw new Error('Tej strony nie ma na tym serwerze.');
  return C.trySsl(r.slug, say);
}

/* ------------------------------------------------------ serwer A: przełączenie adresu */

export async function dnsState(id) {
  const r = rowOf(id);
  const name = r.opts.asName || r.site;
  let ips = [];
  try { ips = await dns.resolve4(name); } catch {}
  const here = S.metrics().ip;
  return { id, site: r.site, name, state: r.state, server: r.server_name, target: r.target_ip, here, ips, toTarget: !!r.target_ip && ips.includes(r.target_ip) && !ips.includes(here), ovh: !!OV?.manages(name), moved: r.moved, switched: r.switched, info: r.info, removeAfter: r.switched ? r.switched + KEEP_DAYS * 864e5 : null };
}
export async function switchDns(id, say) {
  const r = rowOf(id);
  if (!r.target_ip) throw new Error('Nie znam adresu IP tamtego serwera.');
  if (!OV?.manages(r.opts.asName || r.site)) throw new Error('Ta domena nie jest w OVH połączonym z panelem — zmień rekord A ręcznie.');
  return OV.ensure(r.opts.asName || r.site, say, r.target_ip);
}
/** Po przełączeniu DNS: certyfikat na nowym serwerze i wyłączenie strony tutaj. */
export async function finish(id, who, say) {
  const r = rowOf(id);
  const st = await dnsState(id);
  if (!st.toTarget) throw new Error(`Adres ${st.name} wskazuje jeszcze na ${st.ips.join(', ') || 'nic'} — poczekaj na DNS (zwykle kilka minut).`);
  const srv = GR.serverRow(r.server_id);
  say(`▸ certyfikat na „${srv.nazwa}”\n`);
  try { const x = await GR.call(srv, 'POST', 'api/grupa/strona/ssl', { name: st.name }); say(x.ok ? '✓ certyfikat gotowy\n' : `  certyfikat jeszcze nie (${x.msg || 'spróbuje sam później'})\n`); }
  catch (e) { say(`  certyfikat jeszcze nie (${e.message}) — tamten panel spróbuje sam później\n`); }
  say('▸ wyłączam starą stronę tutaj (pliki i baza zostają)\n');
  await S.setSiteEnabled(r.site, false, panelHosts);
  setRow(id, { state: 'gotowe', switched: Date.now() });
  J.add(who, 'strony', `Przełączono ${r.site} na serwer ${r.server_name} — stara strona tutaj wyłączona`, null, `#/przenies/${encodeURIComponent(r.site)}`);
  say(`✓ gotowe — starą kopię usuniesz tutaj, kiedy zechcesz (panel przypomni po ${KEEP_DAYS} dniach)\n`);
  return { ok: true };
}
/** Usunięcie starej kopii (archiwum plików i zrzut bazy zostają w koszu kopii). */
export async function removeOld(id, who, say) {
  const r = rowOf(id);
  if (r.state !== 'gotowe') throw new Error('Najpierw dokończ przełączenie adresu.');
  const made = C.list().find((x) => x.host === r.site);
  if (made) await C.remove(made.slug, say);
  else {
    const info = T.siteInfo(r.site);
    const TRASH = path.join(CFG().kopie.katalog, 'usuniete');
    fs.mkdirSync(TRASH, { recursive: true, mode: 0o700 });
    const when = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    if (r.info?.db || r.opts.withDb) {
      const used = info.root ? await T.dbsUsedBy(info.root).catch(() => []) : [];
      const d = used[0]?.db;
      if (d) {
        say(`▸ zrzut bazy ${d} do kosza kopii\n`);
        const x = await run('bash', ['-c', 'set -o pipefail; mysqldump --single-transaction "$1" | gzip > "$2"', '_', d, path.join(TRASH, `${d}_${when}.sql.gz`)], { timeout: 900e3 });
        if (!x.ok) throw new Error('Zrzut bazy nie wyszedł — nic nie usunąłem.');
        r.info.dropDb = d;
      }
    }
    if (info.root && /^\/var\/www\/[^/]+\/?/.test(info.root)) {
      say(`▸ archiwum plików do kosza kopii\n`);
      const x = await run('tar', ['czf', path.join(TRASH, `${T.keyOf(r.site)}_${when}.tar.gz`), '-C', '/', info.root.slice(1)], { timeout: 3600e3 });
      if (!x.ok) throw new Error('Archiwum nie wyszło — nic nie usunąłem.');
    }
    say(`▸ usuwam konfigurację ${r.site}\n`);
    for (const x of info.files || []) { const f = x.file || x; if (/^\/etc\/apache2\/sites-(available|enabled)\/[^/]+\.conf$/.test(f)) { await run('a2dissite', ['-q', path.basename(f, '.conf')]); fs.rmSync(f.replace('/sites-enabled/', '/sites-available/'), { force: true }); } }
    const t = await run('apache2ctl', ['configtest']); if (t.ok) await run('systemctl', ['reload', 'apache2']);
    if (info.root && /^\/var\/www\/[a-z0-9._-]+$/.test(info.root.replace(/\/$/, ''))) fs.rmSync(info.root, { recursive: true, force: true });
    if (r.info.dropDb) await run('mysql', ['-e', `DROP DATABASE IF EXISTS \`${r.info.dropDb}\``]);
  }
  setRow(id, { removed: Date.now() });
  J.add(who, 'strony', `Usunięto starą kopię ${r.site} po przeniesieniu na ${r.server_name} (archiwum w koszu kopii)`);
  say('✓ usunięto — archiwum zostało w koszu kopii\n');
  return { ok: true };
}
/** Dla autopilota: przypomnienie o starych kopiach po 7 dniach. */
export function reminders() {
  return pending().filter((r) => r.state === 'gotowe' && r.switched && Date.now() - r.switched > KEEP_DAYS * 864e5).map((r) => ({ site: r.site, server: r.server_name, since: r.switched }));
}
