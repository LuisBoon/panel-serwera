// Mapa serwera (wariant A · schemat): strony → programy → dane (→ z zewnątrz). Kliknięcie podświetla drogę
// i mówi, co padnie; „Co padnie, jeśli wyłączę…” zaznacza na czerwono wszystko, co zależy od wybranej rzeczy.
const { h, put, api, btn, linkBtn, ico, toast, PAGES, plural } = window.P;
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v); for (const c of kids) if (c != null) e.append(c); return e; };
const NW = 210, NH = 30, GAP = 8, CG = 74, TOP = 34;
let filter = 'all', selected = null, sw = '';

function layout(d) {
  const sitesWithDb = new Set(d.sites.filter((s) => s.dbs.length).map((s) => s.id));
  const progKind = new Map(d.cols.prog.map((p) => [p.id, p.kind]));
  const keep = (n) => filter === 'all' || (filter === 'db' ? sitesWithDb.has(n.id) : filter === 'app' ? ['usluga', 'kontener'].includes(progKind.get(n.prog)) : progKind.get(n.prog) === 'pliki' || progKind.get(n.prog) === 'php');
  const site = d.cols.site.filter(keep);
  const shown = new Set(site.map((n) => n.id));
  const eOk = (e) => (!e.via || shown.has(e.via));
  const prog = d.cols.prog.filter((p) => filter === 'all' || d.edges.some((e) => e.to === p.id && shown.has(e.from)));
  const ps = new Set(prog.map((p) => p.id));
  const data = d.cols.data.filter((x) => filter === 'all' || d.edges.some((e) => e.to === x.id && ps.has(e.from) && eOk(e)));
  const ds = new Set(data.map((x) => x.id));
  const ext = d.cols.ext.filter((x) => filter === 'all' || d.edges.some((e) => e.from === x.id && ds.has(e.to)));
  const cols = [['STRONY', site], ['PROGRAMY', prog], ['DANE', data], ...(ext.length ? [['Z ZEWNĄTRZ', ext]] : [])];
  const pos = new Map();
  const rows = Math.max(...cols.map(([, l]) => l.length), 1);
  const H = TOP + rows * (NH + GAP) + 6;
  cols.forEach(([, list], ci) => { const off = TOP + ((rows - list.length) * (NH + GAP)) / 2; list.forEach((n, i) => pos.set(n.id, { x: ci * (NW + CG), y: off + i * (NH + GAP), n })); });
  const W = cols.length * NW + (cols.length - 1) * CG;
  const edges = d.edges.filter((e) => pos.has(e.from) && pos.has(e.to) && eOk(e));
  return { cols, pos, W, H, edges };
}

/** Co jest „na drodze” wybranego węzła: krawędzie i węzły do podświetlenia. */
function pathOf(d, id) {
  const nodes = new Set([id]), edges = new Set();
  const key = (e) => `${e.from}>${e.to}>${e.via || ''}`;
  const site = d.sites.find((s) => s.id === id);
  if (site) {
    if (site.prog) { nodes.add(site.prog); for (const e of d.edges) if (e.from === id && e.to === site.prog) edges.add(key(e)); }
    for (const db of site.dbs) { nodes.add(db); for (const e of d.edges) if (e.to === db && e.from === site.prog && (!e.via || e.via === id)) edges.add(key(e)); for (const e of d.edges) if (e.to === db && e.from.startsWith('ext:')) { nodes.add(e.from); edges.add(key(e)); } }
    return { nodes, edges };
  }
  if (id.startsWith('ext:')) {
    for (const e of d.edges) if (e.from === id) { edges.add(key(e)); nodes.add(e.to); for (const s of d.sites) if (s.dbs.includes(e.to)) { nodes.add(s.id); if (s.prog) nodes.add(s.prog); for (const x of d.edges) if ((x.from === s.id && x.to === s.prog) || (x.from === s.prog && x.to === e.to && (!x.via || x.via === s.id))) edges.add(key(x)); } }
    return { nodes, edges };
  }
  const isData = d.cols.data.some((x) => x.id === id);
  if (isData) {
    for (const e of d.edges) if (e.to === id) { edges.add(key(e)); nodes.add(e.from); }
    for (const s of d.sites) if (s.dbs.includes(id)) { nodes.add(s.id); for (const e of d.edges) if (e.from === s.id && e.to === s.prog) edges.add(key(e)); }
    return { nodes, edges };
  }
  // program
  for (const e of d.edges) {
    if (e.to === id) { nodes.add(e.from); edges.add(key(e)); }
    if (e.from === id) { nodes.add(e.to); edges.add(key(e)); }
  }
  return { nodes, edges };
}

function draw(d, L, onPick) {
  const svg = sv('svg', { viewBox: `-2 0 ${L.W + 4} ${L.H}`, class: 'mp-svg', role: 'img', 'aria-label': 'Mapa serwera: strony, programy i dane' });
  const hl = selected ? pathOf(d, selected) : null;
  const sw0 = sw ? d.switches.find((x) => x.id === sw) : null;
  const hitSites = new Set((sw0?.sites || []).map((n) => 'site:' + n));
  const hitData = new Set(sw0?.data || []);
  const hitExt = new Set(d.cols.ext.filter((x) => (sw0?.ext || []).includes(x.label)).map((x) => x.id));
  const swNode = sw0 ? (sw0.id.startsWith('engine:') ? null : sw0.id) : null;
  L.cols.forEach(([title], ci) => svg.append(sv('text', { x: ci * (NW + CG), y: 18, class: 'mp-t' }, title)));
  const key = (e) => `${e.from}>${e.to}>${e.via || ''}`;
  const g = sv('g');
  for (const e of L.edges) {
    const a = L.pos.get(e.from), b = L.pos.get(e.to);
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
    // dane → z zewnątrz rysujemy od prawej strony danych
    const back = a.x > b.x;
    const [sx, sy, tx, ty] = back ? [b.x + NW, y2, a.x, y1] : [x1, y1, x2, y2];
    const mx = (sx + tx) / 2;
    const on = hl ? hl.edges.has(key(e)) : false;
    const hit = sw0 && (hitSites.has(e.from) || hitData.has(e.to) || e.from === swNode || hitExt.has(e.from));
    g.append(sv('path', { d: `M${sx} ${sy} C${mx} ${sy} ${mx} ${ty} ${tx} ${ty}`, class: `mp-e ${on ? 'on' : ''} ${hit ? 'hit' : ''} ${hl && !on ? 'dim' : ''}` }));
  }
  svg.append(g);
  for (const [id, p] of L.pos) {
    const n = p.n;
    const on = hl ? hl.nodes.has(id) : false;
    const hit = sw0 && (hitSites.has(id) || hitData.has(id) || id === swNode || hitExt.has(id) || (sw0.engine && n.engine === sw0.engine));
    const max = n.sub ? 21 : 27;
    const label = n.label.length > max ? n.label.slice(0, max - 1) + '…' : n.label;
    const el = sv('g', { class: `mp-n ${n.col} ${n.state || ''} ${on ? 'on' : ''} ${hl && !on ? 'dim' : ''} ${hit ? 'hit' : ''} ${id === selected ? 'sel' : ''}`, tabindex: '0', role: 'button', 'aria-label': n.label },
      sv('title', {}, n.label + (n.sub ? ' ' + n.sub : '')),
      sv('rect', { x: p.x, y: p.y, width: NW, height: NH, rx: 8 }),
      sv('text', { x: p.x + 11, y: p.y + 19.5 }, label),
      n.sub ? sv('text', { x: p.x + NW - 9, y: p.y + 19.5, class: 'mp-sub', 'text-anchor': 'end' }, n.sub) : null);
    el.addEventListener('click', () => onPick(id));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onPick(id); } });
    svg.append(el);
  }
  return svg;
}

function detail(d, id) {
  const all = [...d.cols.site, ...d.cols.prog, ...d.cols.data, ...d.cols.ext];
  const n = all.find((x) => x.id === id);
  if (!n) return null;
  const name = (x) => all.find((y) => y.id === x)?.label || x;
  const kv = (k, v) => [h('span', null, k), h('b', null, v)];
  const rows = [];
  let link = null;
  if (n.col === 'site') {
    const s = d.sites.find((x) => x.id === id);
    const prog = s.prog ? name(s.prog) : '—';
    rows.push(kv('Działa dzięki', ['Apache', prog, ...s.dbs.map(name)].join(' → ')));
    if (d.backup) rows.push(kv('Kopia', `${d.backup} · ${[s.files ? 'pliki' : null, s.dbs.length ? (s.dbs.length > 1 ? 'bazy' : 'baza') : null].filter(Boolean).join(' i ') || 'konfiguracja'}`));
    for (const w of d.switches.filter((w) => w.id !== 'apache2' && (w.id === s.prog || (w.engine && s.dbs.some((x) => (w.data || []).includes(x))))))
      rows.push(kv(`Jeśli wyłączysz ${w.label}`, h('span', { class: w.sites.length + w.ext.length > 1 ? 'mp-bad' : '' }, impact(w))));
    link = linkBtn('Otwórz kartę strony', `#/strona/${encodeURIComponent(n.label)}`, { small: true, icon: 'ext' });
  } else if (n.col === 'prog') {
    const sites = d.sites.filter((s) => s.prog === id).map((s) => s.name);
    const dbs = d.edges.filter((e) => e.from === id).map((e) => name(e.to));
    rows.push(kv('Obsługuje', sites.length ? sites.join(', ') : '—'));
    if (dbs.length) rows.push(kv('Dane', [...new Set(dbs)].join(', ')));
    const w = d.switches.find((x) => x.id === id);
    if (w) rows.push(kv('Jeśli go wyłączysz', h('span', { class: 'mp-bad' }, impact(w))));
    link = n.unit && n.unit !== 'apache2' ? linkBtn('Usługi', '#/uslugi', { small: true, icon: 'uslugi' }) : null;
  } else if (n.col === 'data') {
    const users = d.edges.filter((e) => e.to === id).map((e) => e.via ? name(e.via) : name(e.from));
    rows.push(kv('Używa', users.length ? [...new Set(users)].join(', ') : 'nikt (nie znalazłem odwołań)'));
    if (n.engine && n.engine !== 'sqlite') { const w = d.switches.find((x) => x.engine === n.engine); if (w) rows.push(kv(`Jeśli wyłączysz ${w.label}`, h('span', { class: 'mp-bad' }, impact(w)))); }
    link = linkBtn('Bazy danych', '#/bazy', { small: true, icon: 'bazy' });
  } else {
    rows.push(kv('Łączy się z', d.edges.filter((e) => e.from === id).map((e) => name(e.to)).join(', ')));
    link = linkBtn('Konta baz', '#/bazy/konta', { small: true, icon: 'bazy' });
  }
  return h('div', { class: 'mp-detail' }, h('div', { class: 'mp-dh' }, ico('klik', 16), h('b', null, `Kliknięto: ${n.label}`)), h('div', { class: 'mp-kv' }, rows.flat()), link ? h('div', { class: 'acts', style: 'justify-content:flex-start' }, link) : null);
}
function impact(w) {
  const parts = [];
  if (w.sites.length) parts.push(`${w.sites.length} ${plural(w.sites.length, 'strona', 'strony', 'stron')}`);
  if (w.ext.length) parts.push(w.ext.join(', '));
  return parts.length ? 'padnie ' + parts.join(' i ') : 'nic z listy stron';
}

PAGES.mapa = async (box, args, q, quiet) => {
  const d = await api('GET', 'api/mapa');
  const wrap = h('div', { class: 'mp-wrap' });
  const info = h('div');
  const swInfo = h('div');
  const render = () => {
    const L = layout(d);
    wrap.replaceChildren(L.cols.some(([, l]) => l.length) ? draw(d, L, (id) => { selected = selected === id ? null : id; render(); }) : h('div', { class: 'list-empty' }, 'Nic do pokazania przy tym filtrze.'));
    info.replaceChildren(selected ? detail(d, selected) || '' : h('p', { class: 'small muted', style: 'margin:0' }, 'Kliknij stronę, program albo bazę — podświetlę, od czego zależy i co padnie, jeśli to wyłączysz.'));
    const w = sw ? d.switches.find((x) => x.id === sw) : null;
    swInfo.replaceChildren(w ? h('div', { class: 'alert warn' }, h('span', { class: 'tag' }, 'PADNIE'), h('span', { class: 'txt' }, [...w.sites, ...w.ext].join(', ') || 'nic z listy stron')) : '');
    chips.forEach((c) => c.classList.toggle('on', c.dataset.f === filter));
  };
  const chips = [['all', 'Wszystko'], ['db', 'Z bazą danych'], ['app', 'Aplikacje'], ['files', 'PHP i pliki']].map(([f, l]) => h('button', { type: 'button', class: 'store-chip', 'data-f': f, onclick: () => { filter = f; render(); } }, l));
  const sel = h('select', { class: 'input mp-sel', id: 'mapa-wylacz', 'aria-label': 'Co padnie, jeśli wyłączę', onchange: () => { sw = sel.value; selected = null; render(); } },
    h('option', { value: '' }, 'Co padnie, jeśli wyłączę…'), d.switches.map((w) => h('option', { value: w.id, selected: w.id === sw ? true : null }, w.label)));
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Mapa serwera'), h('div', { class: 'sub' }, 'Co od czego zależy: strona → program → dane. Rysuje się sama z konfiguracji Apache, usług i baz.')),
      h('div', { class: 'acts' }, (() => { const b = btn('Odśwież', async () => { b.disabled = true; try { await api('GET', 'api/mapa?odswiez=1'); window.P.reload(); } catch (e) { toast(e.message, 'bad'); } finally { b.disabled = false; } }, { icon: 'odswiez' }); return b; })())),
    h('section', { class: 'card stack', style: 'gap:12px' },
      h('div', { class: 'mp-bar' }, h('div', { class: 'store-chips' }, chips), sel),
      swInfo, wrap, info,
      h('p', { class: 'small muted', style: 'margin:0' }, `${d.cols.site.length} ${plural(d.cols.site.length, 'strona', 'strony', 'stron')} · ${d.cols.prog.length} ${plural(d.cols.prog.length, 'program', 'programy', 'programów')} · ${d.cols.data.length} ${plural(d.cols.data.length, 'baza', 'bazy', 'baz')}. Wszystko idzie przez Apache — jego wyłączenie zatrzyma wszystkie strony. Na telefonie przesuwaj schemat palcem.`)));
  render();
};
