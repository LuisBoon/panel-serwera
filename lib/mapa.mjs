// Mapa serwera: co od czego zależy — strona → program (usługa, PHP, kontener) → dane (bazy). Rysuje się sama
// z konfiguracji Apache, nasłuchujących portów, usług systemd i przeglądu baz. Do każdego „wyłącznika”
// (usługa, PHP, silnik bazy, Apache) liczy, co przestanie działać.
import fs from 'node:fs';
import path from 'node:path';
import * as S from './system.mjs';
import * as DB from './dbadmin.mjs';
import * as APP from './apps.mjs';
import * as D from './data.mjs';
import { run, cached } from './util.mjs';

let DATA_DIR = '', storeList = async () => [];
export function init({ dataDir, store }) { DATA_DIR = dataDir; if (store) storeList = store; }

async function listeners() {
  const r = await run('ss', ['-ltnpH'], { timeout: 10000 });
  const map = new Map();
  for (const l of r.out.split('\n')) {
    const m = l.match(/\s(\S+):(\d+)\s+\S+\s+users:\(\("([^"]+)",pid=(\d+)/);
    if (!m) continue;
    const port = Number(m[2]);
    if (map.has(port)) continue;
    let unit = '';
    try { unit = (fs.readFileSync(`/proc/${m[4]}/cgroup`, 'utf8').match(/\/([^/]+)\.service/) || [])[1] || ''; } catch {}
    map.set(port, { port, proc: m[3], pid: Number(m[4]), unit, local: /^(127\.|\[::1\]|localhost)/.test(m[1]) });
  }
  return map;
}
async function unitDirs(units) {
  if (!units.length) return new Map();
  const r = await run('systemctl', ['show', '-p', 'Id,WorkingDirectory,ExecStart', ...units.map((u) => u + '.service')], { timeout: 15000 });
  const out = new Map();
  for (const b of r.out.split(/\n\n+/)) {
    const id = (b.match(/^Id=(.+)$/m) || [])[1]; if (!id) continue;
    const wd = (b.match(/^WorkingDirectory=(.+)$/m) || [])[1] || '';
    const ex = (b.match(/path=([^ ;]+)/) || [])[1] || '';
    const arg = (b.match(/argv\[\]=\S+ ([^ ;]+)/) || [])[1] || '';
    out.set(id.replace(/\.service$/, ''), [wd, ex, arg].filter((x) => x.startsWith('/')));
  }
  return out;
}
const hasPhp = (root) => {
  try { if (fs.existsSync(path.join(root, 'index.php'))) return true; return fs.readdirSync(root).some((f) => f.endsWith('.php')); } catch { return false; }
};

export const build = cached(60e3, async () => {
  const [confs, states, svcs, ov, ports, store] = await Promise.all([S.siteConfigs(), S.sites().catch(() => []), S.services().catch(() => []), DB.overview().catch(() => ({ dbs: [], users: [], engines: [] })), listeners(), storeList().catch(() => [])]);
  const stateOf = new Map(states.map((s) => [s.name, s]));
  const svcOf = new Map(svcs.map((s) => [s.unit, s]));
  const nodes = new Map(), edges = [];
  const node = (id, col, label, extra = {}) => { if (!nodes.has(id)) nodes.set(id, { id, col, label, ...extra }); return nodes.get(id); };
  const edge = (from, to, via = null) => { if (!edges.some((e) => e.from === from && e.to === to && e.via === via)) edges.push({ from, to, via }); };
  const sites = [];
  const units = new Set();
  // 1) strony i programy, które je obsługują
  for (const c of confs.filter((x) => x.enabled)) {
    const st = stateOf.get(c.name);
    const sid = 'site:' + c.name;
    const s = node(sid, 'site', c.name, { state: st?.status === 'down' ? 'bad' : st?.status === 'off' ? 'off' : 'ok', https: c.https });
    let prog = null;
    const px = c.proxies.map((p) => Number((String(p).match(/:(\d+)/) || [])[1])).find(Boolean);
    if (px) {
      const app = store.find((a) => Number(a.port) === px);
      const l = ports.get(px);
      if (app) prog = node('app:' + app.id, 'prog', `${app.name} (kontener)`, { sub: `:${px}`, kind: 'kontener', state: app.state === 'dziala' ? 'ok' : 'bad', unit: 'docker' });
      else if (l?.unit) { const sv = svcOf.get(l.unit); prog = node('unit:' + l.unit, 'prog', sv?.name || l.unit, { sub: `:${px}`, kind: 'usluga', unit: l.unit, state: sv?.failed ? 'bad' : sv && !sv.active ? 'off' : 'ok' }); units.add(l.unit); }
      else prog = node('port:' + px, 'prog', `nic nie słucha`, { sub: `:${px}`, kind: 'brak', state: 'bad' });
    } else if (c.root && hasPhp(c.root)) {
      let v = null; try { const ss = APP.siteSettings(c.name); v = ss.phpVersion ? `${ss.phpVersion} (FPM)` : ss.phpDefault ? `${ss.phpDefault}` : null; } catch {}
      const fpm = v?.includes('FPM');
      prog = node(fpm ? `php:${v}` : 'php:apache', 'prog', `PHP ${v || ''}`.trim(), { kind: 'php', unit: fpm ? `php${v.split(' ')[0]}-fpm` : 'apache2', state: 'ok' });
    } else if (c.root) prog = node('static', 'prog', 'same pliki', { kind: 'pliki', unit: 'apache2', state: 'ok' });
    if (prog) edge(sid, prog.id);
    sites.push({ name: c.name, id: sid, prog: prog?.id || null, root: c.root, dir: c.dir, dbs: [] });
    s.prog = prog?.id || null;
  }
  // 2) dane: bazy i kto ich używa
  const dirs = await unitDirs([...new Set([...units, ...ov.dbs.filter((d) => d.service).map((d) => d.service)])]);
  const unitByPath = (p) => [...dirs.entries()].find(([, ds]) => ds.some((d) => p === d || p.startsWith(d + '/') || d.startsWith(p + '/')))?.[0];
  const siteByName = new Map(sites.map((s) => [s.name, s]));
  for (const d of ov.dbs.filter((x) => !x.system && x.name !== 'fail2ban')) {
    const did = `db:${d.engine}:${d.name}`;
    const label = d.engine === 'sqlite' ? (d.path ? path.basename(d.path) : d.name) : `${DB.NAMES[d.engine]} · ${d.name}`;
    node(did, 'data', label, { engine: d.engine, kind: 'baza', unit: DB.UNITS[d.engine] || null, size: d.size || null });
    let used = false;
    for (const u of d.usedBy || []) {
      const m = String(u.label).match(/^strona (.+)$/);
      if (m && siteByName.has(m[1])) { const s = siteByName.get(m[1]); if (s.prog) edge(s.prog, did, s.id); else edge(s.id, did); s.dbs.push(did); used = true; continue; }
      const o = String(u.label).match(/^aplikacja \/opt\/([^/ ]+)/);
      const unit = d.service || (o && unitByPath('/opt/' + o[1]));
      if (unit) { const sv = svcOf.get(unit); node('unit:' + unit, 'prog', sv?.name || unit, { kind: 'usluga', unit, state: sv?.failed ? 'bad' : sv && !sv.active ? 'off' : 'ok' }); edge('unit:' + unit, did); used = true; continue; }
      if (/^serwer gry/.test(u.label)) { node('ext:gry', 'ext', 'serwery gier (z panelu gier)', { kind: 'zewn', state: 'ok' }); edge('ext:gry', did); used = true; }
    }
    if (d.service && !used) { const sv = svcOf.get(d.service); node('unit:' + d.service, 'prog', sv?.name || d.service, { kind: 'usluga', unit: d.service, state: sv?.failed ? 'bad' : 'ok' }); edge('unit:' + d.service, did); }
    // dostęp z zewnątrz (serwer w domu, konkretne adresy)
    for (const a of (d.access || []).filter((x) => !x.locked && ['dom', 'ip', 'internet'].includes(x.scope))) {
      const xid = a.scope === 'dom' ? 'ext:dom' : `ext:${a.scope}:${a.user}`;
      node(xid, 'ext', a.scope === 'dom' ? (ov.homeLabel || 'serwer w domu') : a.scope === 'internet' ? `konto ${a.user} (z internetu)` : `konto ${a.user} (${a.label || 'z zewnątrz'})`, { kind: 'zewn', state: a.scope === 'internet' ? 'warn' : 'ok' });
      edge(xid, did);
    }
  }
  // baza samego panelu
  const pu = [...nodes.values()].find((n) => n.unit === 'panel-serwera');
  if (pu && fs.existsSync(path.join(DATA_DIR, 'panel.sqlite'))) { node('db:panel', 'data', 'panel.sqlite', { engine: 'sqlite', kind: 'baza' }); edge(pu.id, 'db:panel'); }
  // dane programów (bazy podpięte do usługi) należą też do stron tej usługi
  for (const s of sites) if (s.prog) for (const e of edges.filter((x) => x.from === s.prog && !x.via)) if (!s.dbs.includes(e.to)) s.dbs.push(e.to);
  // 3) co padnie, jeśli wyłączysz…
  const sw = [];
  const progs = [...nodes.values()].filter((n) => n.col === 'prog' && n.kind !== 'zewn' && n.kind !== 'brak');
  const ext = [...nodes.values()].filter((n) => n.col === 'ext');
  const extOf = (dbIds) => ext.filter((x) => edges.some((e) => e.from === x.id && dbIds.includes(e.to))).map((x) => x.label);
  sw.push({ id: 'apache2', label: 'Apache (serwer stron)', sites: sites.map((s) => s.name), ext: [] });
  for (const p of progs) {
    const hit = sites.filter((s) => s.prog === p.id).map((s) => s.name);
    const dbIds = edges.filter((e) => e.from === p.id).map((e) => e.to);
    if (p.unit && p.unit !== 'apache2') sw.push({ id: p.id, label: p.label + (p.sub ? ` ${p.sub}` : ''), sites: hit, ext: p.kind === 'usluga' ? [] : [], data: dbIds });
  }
  for (const eng of [...new Set([...nodes.values()].filter((n) => n.col === 'data' && n.engine && n.engine !== 'sqlite').map((n) => n.engine))]) {
    const dbIds = [...nodes.values()].filter((n) => n.col === 'data' && n.engine === eng).map((n) => n.id);
    const hit = sites.filter((s) => s.dbs.some((d) => dbIds.includes(d))).map((s) => s.name);
    const progsHit = progs.filter((p) => !sites.some((s) => s.prog === p.id) && edges.some((e) => e.from === p.id && dbIds.includes(e.to))).map((p) => p.label);
    sw.push({ id: 'engine:' + eng, label: DB.NAMES[eng], sites: hit, ext: [...extOf(dbIds), ...progsHit], data: dbIds, engine: eng });
  }
  // kolejność: strony pogrupowane po programie, dane w kolejności pierwszego użycia — mniej skrzyżowań
  const progOrder = [...new Set([...sites.map((s) => s.prog).filter(Boolean), ...progs.map((p) => p.id), ...ext.map((x) => x.id)])];
  const siteNodes = sites.slice().sort((a, b) => progOrder.indexOf(a.prog) - progOrder.indexOf(b.prog) || a.name.localeCompare(b.name)).map((s) => nodes.get(s.id));
  const dataOrder = [];
  for (const p of progOrder) for (const e of edges.filter((x) => x.from === p)) if (nodes.get(e.to)?.col === 'data' && !dataOrder.includes(e.to)) dataOrder.push(e.to);
  for (const n of nodes.values()) if (n.col === 'data' && !dataOrder.includes(n.id)) dataOrder.push(n.id);
  const set = D.backupSettings();
  return {
    at: Date.now(),
    cols: {
      site: siteNodes,
      prog: progOrder.map((id) => nodes.get(id)).filter((n) => n && n.col === 'prog'),
      data: dataOrder.map((id) => nodes.get(id)),
      ext: ext,
    },
    edges, sites: sites.map(({ name, id, prog, dbs, root }) => ({ name, id, prog, dbs, files: !!root && root.startsWith('/var/www/') })),
    switches: sw.filter((x) => x.sites.length || x.ext.length),
    backup: set.hour != null ? `co noc ${String(set.hour).padStart(2, '0')}:${String(set.minute).padStart(2, '0')}` : null,
  };
});
