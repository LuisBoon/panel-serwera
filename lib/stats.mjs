// Statystyki odwiedzin z logów Apache — bez ciasteczek i bez skryptów na stronach.
// Osoba = skrót (adres IP + przeglądarka) z solą zmienianą codziennie, więc nie da się nikogo śledzić między dniami.
// Boty, skanery i własne sprawdzanie serwera są odfiltrowane.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import * as S from './system.mjs';

let db;
const BOT = /bot|crawl|spider|slurp|curl|wget|python|go-http|java\/|scan|zgrab|masscan|headless|httpclient|okhttp|libwww|nikto|nmap|facebookexternalhit|preview|monitor|uptime|check|fetch|axios|node-fetch|undici|panel-serwera|^-?$/i;
const ASSET = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|map|json|mp3|ogg|wav|mp4|webm|wasm|txt|xml|webmanifest|pdf|zip|exe|apk)(\?|$)/i;
const NOT_PAGE = /^\/(api|ws|uploads|socket|_next|static|assets|vendor|\.well-known)\b/i;
// adresy, które szukają dziur, to skanery — wyrzucamy wszystkie ich wejścia z tego dnia
const ATTACK = /(\/\.(env|git|aws|ssh|svn|ht|DS_Store|vscode|idea)|wp-(login|admin|content|includes|config)|xmlrpc|phpmyadmin|\/pma\b|\/cgi-bin|\/vendor\/|\/actuator|\/boaform|hnap1|\/owa\/|autodiscover|\/solr|\/druid|\/jenkins|\/manager\/html|\/console\b|\/shell|eval-stdin|\/(admin|setup|install|info|phpinfo|test|config|wlwmanifest)\.php|\/server-status|\/telescope|\/_ignition|\/geoserver|\/remote\/login|\/ecp\/|\/containers\/json|\/bin\/sh|\.\.\/|\/sftp-config|\/backup|\.sql\b|\.bak\b|\/cdn-cgi\/|\/aws|\/credentials|\/swagger|\/graphql|\/api\/v1\/pods)/i;
const scanners = new Map(); // dzień → Set(IP)
const LOCAL = /^(127\.|::1$|83\.168\.69\.56$|2001:67c:b58:200::325:1$)/;
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// combined: IP - user [czas] "żądanie" kod bajty "referer" "ua"; vhost_combined ma jeszcze „host:port ” na początku
const LINE = /^(?:(\S+):\d+ )?(\S+) \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):\d{2}:\d{2} [+-]\d{4}\] "(\S+) (\S+)[^"]*" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"/;

export function init(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS stat_dzien(site TEXT, day TEXT, visitors INTEGER DEFAULT 0, views INTEGER DEFAULT 0, hits INTEGER DEFAULT 0, bytes INTEGER DEFAULT 0, e404 INTEGER DEFAULT 0, e5xx INTEGER DEFAULT 0, mobile INTEGER DEFAULT 0, bots INTEGER DEFAULT 0, PRIMARY KEY(site, day));
    CREATE TABLE IF NOT EXISTS stat_top(site TEXT, day TEXT, kind TEXT, key TEXT, n INTEGER, PRIMARY KEY(site, day, kind, key));
    CREATE TABLE IF NOT EXISTS stat_gosc(site TEXT, day TEXT, h TEXT, page INTEGER DEFAULT 0, asset INTEGER DEFAULT 0, counted INTEGER DEFAULT 0, PRIMARY KEY(site, day, h));
    CREATE TABLE IF NOT EXISTS stat_poz(file TEXT PRIMARY KEY, ino INTEGER, pos INTEGER);
    CREATE TABLE IF NOT EXISTS stat_sol(day TEXT PRIMARY KEY, salt TEXT);
  `);
  q = {
    day: db.prepare(`INSERT INTO stat_dzien(site,day,visitors,views,hits,bytes,e404,e5xx,mobile,bots) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(site,day) DO UPDATE SET visitors=visitors+excluded.visitors, views=views+excluded.views, hits=hits+excluded.hits, bytes=bytes+excluded.bytes, e404=e404+excluded.e404, e5xx=e5xx+excluded.e5xx, mobile=mobile+excluded.mobile, bots=bots+excluded.bots`),
    top: db.prepare('INSERT INTO stat_top(site,day,kind,key,n) VALUES(?,?,?,?,?) ON CONFLICT(site,day,kind,key) DO UPDATE SET n=n+excluded.n'),
    guest: db.prepare('INSERT INTO stat_gosc(site,day,h,page,asset) VALUES(?,?,?,?,?) ON CONFLICT(site,day,h) DO UPDATE SET page=max(page,excluded.page), asset=max(asset,excluded.asset) RETURNING page, asset, counted'),
    counted: db.prepare('UPDATE stat_gosc SET counted=1 WHERE site=? AND day=? AND h=?'),
    pos: db.prepare('SELECT * FROM stat_poz WHERE file=?'),
    setPos: db.prepare('INSERT OR REPLACE INTO stat_poz(file,ino,pos) VALUES(?,?,?)'),
  };
  setTimeout(() => update().catch((e) => console.error('statystyki:', e.message)), 30e3);
  setInterval(() => update().catch((e) => console.error('statystyki:', e.message)), 5 * 60e3).unref();
}
let q;

// sól na dany dzień trzymana w bazie (przeżywa restart), kasowana po dwóch dniach razem ze skrótami osób
const salts = new Map();
function salt(day) {
  let v = salts.get(day);
  if (!v) {
    v = db.prepare('SELECT salt FROM stat_sol WHERE day=?').get(day)?.salt;
    if (!v) { v = crypto.randomBytes(16).toString('hex'); db.prepare('INSERT OR IGNORE INTO stat_sol(day,salt) VALUES(?,?)').run(day, v); }
    salts.set(day, v);
  }
  return v;
}

/** Zbiera wiersze w pamięci i zapisuje je za jednym razem (transakcja). */
function collector(site) {
  const days = new Map();
  const get = (d) => { let x = days.get(d); if (!x) days.set(d, x = { hits: 0, bytes: 0, e5xx: 0, bots: 0, guests: new Map() }); return x; };
  const pending = [];
  return {
    line(l, hostFilter) {
      const m = l.match(LINE);
      if (!m) return;
      const [, vhost, ip, dd, mon, yyyy, , method, url, code, size, ref, ua] = m;
      if (hostFilter && vhost && !hostFilter.has(vhost.toLowerCase())) return;
      if (LOCAL.test(ip)) return;
      const day = `${yyyy}-${String(MON[mon] + 1).padStart(2, '0')}-${dd}`;
      if (ATTACK.test(url) || Number(code) === 400) { let set = scanners.get(day); if (!set) scanners.set(day, set = new Set()); set.add(ip); }
      pending.push([day, ip, method, url, code, size, ref, ua]);
    },
    count([day, ip, method, url, code, size, ref, ua]) {
      const x = get(day);
      const c = Number(code);
      x.hits++;
      x.bytes += size === '-' ? 0 : Number(size);
      if (BOT.test(ua) || !/Mozilla|Opera/.test(ua) || scanners.get(day)?.has(ip)) { x.bots++; return; }
      const p = url.split('?')[0].slice(0, 200);
      const g = crypto.createHash('sha256').update(salt(day) + ip + ua).digest('base64url').slice(0, 16);
      let gu = x.guests.get(g);
      if (!gu) x.guests.set(g, gu = { page: 0, asset: 0, views: [], e404: [], mobile: /Mobi|Android|iPhone|iPad/i.test(ua) });
      if (c >= 500) x.e5xx++;
      // przeglądarka człowieka pobiera też pliki strony (style, skrypty, ikonę) albo rozmawia z API aplikacji
      if (ASSET.test(p) || /favicon|apple-touch/.test(p)) gu.asset = 1;
      if (/^\/(api|ws)\b/.test(p) && c < 400) { gu.asset = 1; gu.page = 1; } // aplikacja (GibCord na telefonie / w Windows) rozmawia tylko z API
      if (c === 404 && !ASSET.test(p) && !NOT_PAGE.test(p)) gu.e404.push(p);
      if (method !== 'GET' || c >= 400 || (c >= 300 && c !== 304) || ASSET.test(p) || NOT_PAGE.test(p)) return;
      gu.page = 1;
      let rh = '';
      if (ref && ref !== '-') { try { const h = new URL(ref).hostname.replace(/^www\./, ''); if (h && !site.hosts.has(h) && !site.hosts.has('www.' + h)) rh = h; } catch {} }
      gu.views.push([p, rh]);
    },
    flush() {
      for (const e of pending) this.count(e);
      pending.length = 0;
      db.exec('BEGIN');
      try {
        for (const [day, x] of days) {
          const top = new Map();
          const add = (k) => top.set(k, (top.get(k) || 0) + 1);
          let visitors = 0, views = 0, mobile = 0, e404 = 0;
          for (const [g, gu] of x.guests) {
            const row = q.guest.get(site.name, day, g, gu.page, gu.asset);
            const ok = row.asset && row.page;
            if (!ok) continue;
            if (!row.counted) { visitors++; q.counted.run(site.name, day, g); }
            views += gu.views.length;
            if (gu.mobile) mobile += gu.views.length;
            for (const [p, rh] of gu.views) { add('path\t' + p); if (rh) add('ref\t' + rh); }
            for (const p of gu.e404) { e404++; add('404\t' + p); }
          }
          q.day.run(site.name, day, visitors, views, x.hits, x.bytes, e404, x.e5xx, mobile, x.bots);
          for (const [k, n] of top) { const [kind, key] = k.split('\t'); q.top.run(site.name, day, kind, key, n); }
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      days.clear();
    },
  };
}

function readFrom(file, pos) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (pos > size) pos = 0;
    const len = Math.min(size - pos, 64 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, pos);
    const text = buf.toString('utf8');
    const cut = text.lastIndexOf('\n') + 1; // niepełny ostatni wiersz zostaje na następny raz
    return { text: text.slice(0, cut), pos: pos + Buffer.byteLength(text.slice(0, cut)) };
  } finally { fs.closeSync(fd); }
}

let running = false;
export async function update() {
  if (running) return;
  running = true;
  try {
    const sites = S.siteConfigs();
    const byLog = new Map(); // ten sam plik logu może należeć do kilku nazw — liczymy go raz, przy pierwszej
    for (const s of sites) for (const l of s.logs.filter((p) => /access/.test(p))) {
      if (!byLog.has(l)) byLog.set(l, { name: s.name, hosts: new Set([s.name, ...s.aliases].map((x) => x.toLowerCase())) });
    }
    for (const [file, site] of byLog) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const c = collector(site);
      const filter = /other_vhosts/.test(file) ? site.hosts : null;
      const prev = q.pos.get(file);
      if (!prev) {
        // pierwszy raz: wczytujemy też starsze, obrócone logi (do 14 dni)
        const old = [];
        for (let i = 14; i >= 2; i--) if (fs.existsSync(`${file}.${i}.gz`)) old.push(`${file}.${i}.gz`);
        for (const f of old) { try { for (const l of zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n')) c.line(l, filter); } catch {} }
        if (fs.existsSync(`${file}.1`)) for (const l of fs.readFileSync(`${file}.1`, 'utf8').split('\n')) c.line(l, filter);
        const r = readFrom(file, 0);
        for (const l of r.text.split('\n')) c.line(l, filter);
        c.flush();
        q.setPos.run(file, st.ino, r.pos);
        continue;
      }
      if (prev.ino !== st.ino) {
        // log został obrócony: dokańczamy stary (teraz .1), potem nowy od początku
        try { const s1 = fs.statSync(`${file}.1`); if (s1.ino === prev.ino) { const r1 = readFrom(`${file}.1`, prev.pos); for (const l of r1.text.split('\n')) c.line(l, filter); } } catch {}
        prev.pos = 0;
      }
      const r = readFrom(file, prev.pos);
      for (const l of r.text.split('\n')) c.line(l, filter);
      c.flush();
      q.setPos.run(file, st.ino, r.pos);
    }
    const twoDays = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    db.prepare('DELETE FROM stat_gosc WHERE day<?').run(twoDays);
    db.prepare('DELETE FROM stat_sol WHERE day<?').run(twoDays);
    for (const d of salts.keys()) if (d < twoDays) salts.delete(d);
    for (const d of scanners.keys()) if (d < twoDays) scanners.delete(d);
    db.prepare('DELETE FROM stat_top WHERE day<?').run(new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10));
  } finally { running = false; }
}

/* ------------------------------------------------------------ odczyt */

const dayStr = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function range(days, offset = 0) {
  const end = Date.now() - offset * 864e5;
  const list = [];
  for (let i = days - 1; i >= 0; i--) list.push(dayStr(end - i * 864e5));
  return list;
}
function sumRows(site, list) {
  const r = db.prepare(`SELECT COALESCE(SUM(visitors),0) visitors, COALESCE(SUM(views),0) views, COALESCE(SUM(hits),0) hits, COALESCE(SUM(bytes),0) bytes, COALESCE(SUM(e404),0) e404, COALESCE(SUM(e5xx),0) e5xx, COALESCE(SUM(mobile),0) mobile FROM stat_dzien WHERE site=? AND day>=? AND day<=?`).get(site, list[0], list[list.length - 1]);
  return r;
}
function series(site, list) {
  const rows = new Map(db.prepare('SELECT day, visitors, views FROM stat_dzien WHERE site=? AND day>=? AND day<=?').all(site, list[0], list[list.length - 1]).map((r) => [r.day, r]));
  return list.map((d) => ({ day: d, visitors: rows.get(d)?.visitors || 0, views: rows.get(d)?.views || 0 }));
}
function tops(site, list, kind, n = 10) {
  return db.prepare('SELECT key, SUM(n) n FROM stat_top WHERE site=? AND kind=? AND day>=? AND day<=? GROUP BY key ORDER BY n DESC LIMIT ?').all(site, kind, list[0], list[list.length - 1], n);
}
function lastVisit(site) { return db.prepare('SELECT MAX(day) d FROM stat_dzien WHERE site=? AND views>0').get(site)?.d || null; }

export function summary(days = 7) {
  days = [1, 7, 30, 90].includes(days) ? days : 7;
  const cur = range(days), prev = range(days, days);
  const names = db.prepare('SELECT DISTINCT site FROM stat_dzien').all().map((r) => r.site);
  const sites = names.map((name) => {
    const a = sumRows(name, cur), b = sumRows(name, prev);
    return { name, ...a, prevVisitors: b.visitors, change: b.visitors ? Math.round((a.visitors - b.visitors) / b.visitors * 100) : null, series: series(name, days === 1 ? range(7) : cur).map((x) => x.visitors), last: lastVisit(name) };
  }).sort((x, y) => y.visitors - x.visitors || y.views - x.views);
  const total = sites.reduce((t, s) => { for (const k of ['visitors', 'views', 'hits', 'bytes', 'e404', 'e5xx', 'prevVisitors']) t[k] += s[k]; return t; }, { visitors: 0, views: 0, hits: 0, bytes: 0, e404: 0, e5xx: 0, prevVisitors: 0 });
  total.change = total.prevVisitors ? Math.round((total.visitors - total.prevVisitors) / total.prevVisitors * 100) : null;
  const tips = [];
  for (const s of sites) {
    const bad = tops(s.name, cur, '404', 1)[0];
    if (bad && bad.n >= 5) tips.push({ kind: '404', site: s.name, path: bad.key, n: bad.n, text: `${bad.n} ${bad.n === 1 ? 'osoba trafiła' : 'razy ktoś trafił'} na nieistniejącą stronę ${s.name}${bad.key}` });
    if (s.last) { const ago = Math.floor((Date.now() - Date.parse(s.last)) / 864e5); if (ago >= 10) tips.push({ kind: 'cisza', site: s.name, text: `${s.name} — nikt nie wchodził od ${ago} dni` }); }
  }
  const first = db.prepare('SELECT MIN(day) d FROM stat_dzien').get()?.d || null;
  return { days, total, sites, tips: tips.slice(0, 6), since: first };
}

export function details(site, days = 7) {
  days = [1, 7, 30, 90].includes(days) ? days : 7;
  const cur = range(days);
  const a = sumRows(site, cur), b = sumRows(site, range(days, days));
  return {
    site, days, ...a, prevVisitors: b.visitors, change: b.visitors ? Math.round((a.visitors - b.visitors) / b.visitors * 100) : null,
    series: series(site, days === 1 ? range(7) : cur), paths: tops(site, cur, 'path'), refs: tops(site, cur, 'ref'), notFound: tops(site, cur, '404'),
    mobilePct: a.views ? Math.round(a.mobile / a.views * 100) : null, last: lastVisit(site),
  };
}

/** Do raportu tygodniowego. */
export function week() { return summary(7); }
