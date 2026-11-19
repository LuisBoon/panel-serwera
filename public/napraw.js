// „Coś nie działa?” (wariant B): najpierw pytanie, co się dzieje i czego dotyczy, potem lista sprawdzeń
// z przyciskiem „Napraw” przy każdym błędzie.
const { h, put, api, btn, linkBtn, ico, busy, toast, ask, PAGES, isAdmin } = window.P;

const fx = { problem: null, target: null, result: null, running: false };
const ICON = { ok: '✓', bad: '✕', warn: '!', info: 'i', skip: '–' };

PAGES.napraw = async (box, args, q) => {
  const d = await api('GET', 'api/napraw');
  if (q.get('p')) { fx.problem = q.get('p'); fx.target = q.get('t') || null; fx.result = null; history.replaceState(null, '', '#/napraw'); }
  const holder = h('div', { class: 'stack', style: 'gap:22px' });
  const prob = () => d.problems.find((p) => p.id === fx.problem);
  const listFor = (kind) => ({ site: d.targets.sites, service: d.targets.services, game: d.targets.games, login: d.targets.login }[kind] || []);
  const run = async () => {
    fx.running = true; fx.result = null; render();
    try { fx.result = await api('POST', 'api/napraw/sprawdz', { problem: fx.problem, target: fx.target }); }
    catch (e) { fx.result = { checks: [{ status: 'bad', title: 'Nie udało się sprawdzić', text: e.message }], worst: 'bad' }; }
    fx.running = false; render();
    requestAnimationFrame(() => document.getElementById('wynik')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const doFix = (b, f) => busy(b, async () => {
    if (!(await ask({ title: `${f.label}?`, text: 'Panel zrobi to od razu i sprawdzi wszystko jeszcze raz. Zmiana trafi do Dziennika zmian.', ok: f.label }))) return;
    try { const r = await api('POST', 'api/napraw/napraw', { id: f.id, args: f.args }); toast('✓ ' + r.text, 'ok'); }
    catch (e) { toast(e.message, 'bad'); return; }
    await run();
  });
  const render = () => {
    const p = prob();
    const parts = [];
    parts.push(h('section', { class: 'stack', style: 'gap:12px' }, h('h2', { style: 'font-size:19px' }, 'Co się dzieje?'),
      h('div', { class: 'fx-qs' }, d.problems.map((x) => h('button', { type: 'button', class: `fx-q ${fx.problem === x.id ? 'on' : ''}`, 'aria-pressed': fx.problem === x.id ? 'true' : 'false', onclick: () => {
        fx.problem = x.id; fx.target = null; fx.result = null;
        if (!x.target) run(); else render();
      } }, x.title)))));
    if (p?.target) {
      const list = listFor(p.target);
      parts.push(h('section', { class: 'stack', style: 'gap:12px' }, h('h2', { style: 'font-size:19px' }, { site: 'Która strona?', service: 'Która usługa?', game: 'Który serwer gry?', login: 'Gdzie nie możesz się zalogować?' }[p.target]),
        list.length ? h('div', { class: 'chips fx-targets' }, list.map((t) => h('button', { type: 'button', class: `chip fx-t ${fx.target === t.id ? 'on' : ''} ${t.status === 'down' || t.status === 'nodns' ? 'bad' : ''}`, onclick: () => { fx.target = t.id; run(); } }, t.label, t.status === 'down' ? ' ✕' : t.status === 'off' ? ' (wyłączona)' : '')))
          : h('p', { class: 'small muted', style: 'margin:0' }, p.target === 'game' ? 'Panel nie jest połączony z panelem gier — ' : 'Brak pozycji.', p.target === 'game' ? h('a', { href: '#/gry' }, 'połącz go w „Serwery gier”') : null, p.target === 'game' ? '. Mogę też sprawdzić sam serwer w domu: ' : null,
            p.target === 'game' ? h('a', { href: '#/napraw', onclick: (e) => { e.preventDefault(); fx.target = ''; run(); } }, 'sprawdź') : null)));
    }
    if (fx.running) parts.push(h('div', { class: 'card loading', id: 'wynik' }, h('span', { class: 'spin' }), 'Sprawdzam… (do kilkunastu sekund)'));
    else if (fx.result) {
      const r = fx.result;
      const head = r.worst === 'bad' ? ['bad', 'Znalazłem problem'] : r.worst === 'warn' ? ['warn', 'Działa, ale jest coś do poprawy'] : ['ok', 'Nie widzę problemu'];
      parts.push(h('section', { class: 'stack', style: 'gap:12px', id: 'wynik' },
        h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, h('h2', { style: 'font-size:19px' }, head[1]), h('span', { class: `pill ${head[0]}` }, `${r.checks.filter((c) => c.status === 'bad').length} błędów · ${r.checks.filter((c) => c.status === 'warn').length} uwag`), h('span', { class: 'grow' }), btn('Sprawdź jeszcze raz', () => run(), { small: true, icon: 'restart' })),
        h('div', { class: 'fx-list' }, r.checks.map((c) => {
          const fb = c.fix && isAdmin() ? btn(c.fix.label, () => doFix(fb, c.fix), { small: true, kind: 'pri', icon: 'napraw' }) : null;
          return h('div', { class: `fx-c ${c.status}` }, h('span', { class: 'fx-s', 'aria-hidden': 'true' }, ICON[c.status] || '·'),
            h('div', { class: 'stack grow', style: 'gap:4px;min-width:0' }, h('b', null, c.title), c.text ? h('span', { class: 'small fx-text' }, c.text) : null,
              fb || c.link ? h('div', { class: 'acts', style: 'margin-top:4px;flex-wrap:wrap' }, fb, c.link ? linkBtn('Pokaż', c.link, { small: true }) : null) : null));
        })),
        r.worst === 'ok' ? h('p', { class: 'small muted', style: 'margin:0' }, 'Jeśli dalej coś nie działa, opisz to dokładniej albo zajrzyj do Logów. W terminalu możesz sprawdzić wszystko ręcznie.') : null));
    }
    holder.replaceChildren(...parts);
  };
  render();
  put(box, h('div', { class: 'head' }, h('div', null, h('h1', null, 'Coś nie działa?'), h('div', { class: 'sub' }, 'Wybierz, co się dzieje — panel sprawdzi po kolei wszystko, co zwykle się psuje, i powie, co naprawić.'))), holder);
};
