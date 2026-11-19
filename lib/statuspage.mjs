// Publiczna strona statusu (wariant B — paski z 90 dni). Strona jest generowana na serwerze, bez skryptów
// i bez żadnych szczegółów technicznych: tylko nazwy usług, czy działają i historia przerw.
import * as S from './system.mjs';
import { C as CFG } from './config.mjs';

let db;
const HOUR = 3600e3;
export const DEFAULTS = new Proxy({}, { get: (_, k) => ({ enabled: true, title: CFG().status?.title || `${CFG().nazwa} — stan usług`, services: CFG().status?.services || [], notices: [] })[k],
  ownKeys: () => ['enabled', 'title', 'services', 'notices'], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });

export function init(database) { db = database; }
export function settings() {
  const r = db.prepare("SELECT v FROM ustawienia WHERE k='status'").get();
  let s = {}; try { s = r ? JSON.parse(r.v) : {}; } catch {}
  return { ...DEFAULTS, ...s };
}
export function save(patch) {
  const cur = settings();
  const n = { ...cur, ...patch };
  n.enabled = !!n.enabled;
  n.title = String(n.title || DEFAULTS.title).slice(0, 80);
  const known = new Set(S.siteConfigs().map((x) => x.name));
  n.services = (Array.isArray(n.services) ? n.services : []).slice(0, 12).map((x, i) => ({
    id: String(x.id || `u${i}`).replace(/[^a-z0-9-]/gi, '').slice(0, 20) || `u${i}`,
    name: String(x.name || '').trim().slice(0, 50),
    sites: (Array.isArray(x.sites) ? x.sites : []).map(String).filter((s) => known.has(s)).slice(0, 5),
    units: (Array.isArray(x.units) ? x.units : []).map(String).filter((u) => /^[a-z0-9@._-]+$/i.test(u)).slice(0, 5),
  })).filter((x) => x.name && (x.sites.length || x.units.length));
  n.notices = (Array.isArray(n.notices) ? n.notices : []).slice(-30);
  db.prepare("INSERT OR REPLACE INTO ustawienia(k,v) VALUES('status',?)").run(JSON.stringify(n));
  cache = null;
  return n;
}
export function addNotice(text, level) {
  const s = settings();
  s.notices = [...s.notices, { ts: Date.now(), text: String(text).trim().slice(0, 300), level: ['info', 'warn', 'ok'].includes(level) ? level : 'info' }];
  return save(s);
}
export function removeNotice(ts) { const s = settings(); s.notices = s.notices.filter((n) => n.ts !== Number(ts)); return save(s); }

/** Dzień po dniu (90 dni): procent udanych sprawdzeń dla danej usługi (najgorsza z jej stron). */
function daily(sites) {
  const now = Date.now();
  const startHour = Math.floor((now - 90 * 864e5) / HOUR);
  const rows = sites.length ? db.prepare(`SELECT site, hour, checks, ok FROM dostepnosc WHERE hour>=? AND site IN (${sites.map(() => '?').join(',')})`).all(startHour, ...sites) : [];
  const days = new Map();
  for (const r of rows) {
    const d = new Date(r.hour * HOUR); const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let x = days.get(key); if (!x) days.set(key, x = new Map());
    const s = x.get(r.site) || { c: 0, o: 0 }; s.c += r.checks; s.o += r.ok; x.set(r.site, s);
  }
  const out = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date(now - i * 864e5); const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const x = days.get(key);
    if (!x) { out.push({ day: key, pct: null, down: 0 }); continue; }
    let worst = 100, down = 0;
    for (const s of x.values()) { const p = s.c ? s.o / s.c * 100 : 100; if (p < worst) worst = p; down = Math.max(down, s.c - s.o); }
    out.push({ day: key, pct: worst, down });
  }
  return out;
}

let cache = null;
export async function data() {
  if (cache && Date.now() - cache.at < 60e3) return cache.v;
  const s = settings();
  const sites = await S.sites();
  const units = await S.services();
  const svc = s.services.map((x) => {
    const st = x.sites.map((n) => sites.find((y) => y.name === n)).filter(Boolean);
    const un = x.units.map((n) => units.find((y) => y.unit === n)).filter(Boolean);
    const bad = st.some((y) => y.status === 'down') || un.some((y) => y.failed || !y.active);
    const off = st.length && st.every((y) => y.status === 'off');
    const days = daily(x.sites);
    const measured = days.filter((d) => d.pct != null);
    const avg = measured.length ? measured.reduce((a, d) => a + d.pct, 0) / measured.length : null;
    return { id: x.id, name: x.name, state: off ? 'off' : bad ? 'down' : 'ok', days, avg };
  });
  // przerwy z historii: dni, w których coś nie działało dłużej niż chwilę (minuta = jedno sprawdzenie)
  const incidents = [];
  for (const x of svc) for (const d of x.days) if (d.pct != null && d.down >= 3) incidents.push({ day: d.day, text: `${x.name} — przerwa w działaniu (ok. ${d.down} min)`, level: d.down >= 30 ? 'down' : 'warn' });
  incidents.sort((a, b) => b.day.localeCompare(a.day));
  const v = { title: s.title, enabled: s.enabled, services: svc, incidents: incidents.slice(0, 15), notices: s.notices.slice().reverse().slice(0, 5), checked: Date.now() };
  cache = { at: Date.now(), v };
  return v;
}

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDay = (k) => { const [y, m, d] = k.split('-'); return `${Number(d)}.${m}`; };
const pctTxt = (p) => p == null ? 'brak danych' : `${p >= 99.995 ? '100' : p.toFixed(2).replace('.', ',')}%`;

export async function html() {
  const v = await data();
  if (!v.enabled) return null;
  const allOk = v.services.every((x) => x.state !== 'down');
  const time = new Date(v.checked).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  const bar = (d) => `<i class="${d.pct == null ? 'n' : d.pct >= 99.5 ? '' : d.pct >= 95 ? 'w' : 'd'}" title="${fmtDay(d.day)}: ${pctTxt(d.pct)}"></i>`;
  const svc = v.services.map((x) => `
      <div class="svc"><div class="top"><b>${esc(x.name)}</b><span class="st ${x.state}">${x.state === 'ok' ? 'Działa' : x.state === 'off' ? 'Wyłączone' : 'Nie działa'}</span></div>
        <div class="bars" role="img" aria-label="${esc(x.name)}: dostępność z ostatnich 90 dni ${pctTxt(x.avg)}">${x.days.map(bar).join('')}</div>
        <div class="axis"><span>90 dni temu</span><span>${x.avg == null ? '' : pctTxt(x.avg) + ' czasu'}</span><span>dziś</span></div></div>`).join('');
  const notices = v.notices.map((n) => `<div class="note ${n.level}"><b>${new Date(n.ts).toLocaleDateString('pl-PL')}</b> ${esc(n.text)}</div>`).join('');
  const inc = v.incidents.length ? v.incidents.map((i) => `<li><b>${fmtDay(i.day)}</b> — ${esc(i.text)}</li>`).join('') : '<li>Brak przerw w ostatnich 90 dniach.</li>';
  return `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(v.title)}</title><meta name="description" content="Czy działają usługi ${esc(v.title)}">
<meta http-equiv="refresh" content="120">
<style>
:root{--bg:#fff;--fg:#1f2328;--mut:#57606a;--line:#e3e6ea;--ok:#2da44e;--w:#d4a72c;--d:#cf222e;--n:#d0d7de;--card:#f6f8fa}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9da7b3;--line:#30363d;--ok:#3fb950;--w:#d29922;--d:#f85149;--n:#30363d;--card:#161b22}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 60px;display:flex;flex-direction:column;gap:20px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}h1{margin:0;font-size:22px}
.mut{color:var(--mut);font-size:14px}.banner{border-radius:12px;padding:16px 20px;font-weight:700;font-size:18px;color:#fff;background:var(--ok)}.banner.bad{background:var(--d)}
.svc{padding:18px 0;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px}.top{display:flex;justify-content:space-between;gap:10px}
.st{font-size:14px;font-weight:600;color:var(--ok)}.st.down{color:var(--d)}.st.off{color:var(--mut)}
.bars{display:flex;gap:2px;height:34px}.bars i{flex:1;min-width:0;border-radius:2px;background:var(--ok)}.bars i.w{background:var(--w)}.bars i.d{background:var(--d)}.bars i.n{background:var(--n)}
.axis{display:flex;justify-content:space-between;color:var(--mut);font-size:12px}
.note{background:var(--card);border:1px solid var(--line);border-left-width:4px;border-radius:10px;padding:12px 16px}.note.warn{border-left-color:var(--w)}.note.ok{border-left-color:var(--ok)}.note.info{border-left-color:#0969da}
h2{font-size:17px;margin:8px 0 0}ul{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px}
@media (max-width:520px){.bars{gap:1px;height:28px}}
</style></head>
<body><main>
  <header><h1>${esc(v.title)}</h1><span class="mut">sprawdzane co minutę · ostatnio ${time}</span></header>
  <div class="banner ${allOk ? '' : 'bad'}">${allOk ? 'Wszystko działa' : 'Coś nie działa — już nad tym pracujemy'}</div>
  ${notices}
  <section>${svc}</section>
  <section><h2>Historia przerw</h2><ul>${inc}</ul></section>
  <p class="mut">Strona odświeża się sama. Pokazuje tylko, czy usługi działają — bez adresów i danych technicznych.</p>
</main></body></html>`;
}
