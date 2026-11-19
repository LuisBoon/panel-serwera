// Narzędzia: Dziennik zmian z cofaniem (i kolejne strony systemowe).
const { h, put, api, btn, linkBtn, busy, toast, ask, plural, PAGES, isAdmin, pad } = window.P;

const AREAS = { bazy: 'Bazy', naprawa: 'Naprawa', terminal: 'Terminal', strona: 'Strony', aplikacja: 'Aplikacje', system: 'System', harmonogram: 'Harmonogram', dostep: 'Dostęp', zapora: 'Zapora' };
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayLabel = (ts) => { const d = new Date(ts), t = new Date(); const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5); return diff === 0 ? 'Dziś' : diff === -1 ? 'Wczoraj' : d.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' }); };

PAGES.dziennik = async (box, args, q) => {
  const area = q.get('obszar') || '';
  const przed = q.get('przed') || '';
  const d = await api('GET', `api/dziennik?${area ? 'obszar=' + encodeURIComponent(area) + '&' : ''}${przed ? 'przed=' + przed : ''}`);
  const groups = new Map();
  for (const it of d.items) { const k = dayKey(it.ts); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  const undo = (b, it) => busy(b, async () => {
    if (!(await ask({ title: 'Cofnąć tę zmianę?', text: `„${it.text}”\n\nPanel przywróci stan sprzed tej zmiany.${/Zapytanie|Wgrano|Przywrócono/.test(it.text) ? ' Uwaga: przywrócona zostanie cała baza ze stanu sprzed zmiany — późniejsze zmiany w tej bazie też znikną.' : ''}`, ok: 'Cofnij', danger: true }))) return;
    try { await api('POST', `api/dziennik/${it.id}/cofnij`); toast('✓ Cofnięto', 'ok'); }
    catch (e) { toast(e.message, 'bad'); }
    window.P.reload();
  });
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Dziennik zmian'), h('div', { class: 'sub' }, 'Wszystko, co zmieniono w panelu — kto, kiedy i co. Większość zmian da się cofnąć jednym kliknięciem.'))),
    h('div', { class: 'chips' }, [['', 'Wszystko'], ...Object.entries(AREAS)].map(([id, l]) => h('a', { class: `chip ${area === id ? 'on-chip' : ''}`, href: `#/dziennik${id ? '?obszar=' + id : ''}` }, l))),
    d.items.length ? [...groups.entries()].map(([k, items]) => h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', { style: 'text-transform:capitalize' }, dayLabel(items[0].ts)), h('span', { class: 'small muted' }, `${items.length} ${plural(items.length, 'zmiana', 'zmiany', 'zmian')}`)),
      h('div', { class: 'rows' }, items.map((it) => {
        const t = new Date(it.ts);
        const b = it.can && isAdmin() ? btn('Cofnij', () => undo(b, it), { small: true, icon: 'przywroc' }) : null;
        return h('div', { class: 'row', style: 'flex-wrap:wrap;align-items:flex-start' },
          h('span', { class: 'mono small muted', style: 'min-width:44px;padding-top:2px' }, `${pad(t.getHours())}:${pad(t.getMinutes())}`),
          h('div', { class: 'stack grow', style: 'flex-basis:240px;min-width:0;gap:3px' },
            h('span', { style: it.undone ? 'text-decoration:line-through;color:var(--dim)' : null }, it.text),
            h('span', { class: 'small muted' }, [AREAS[it.area] || it.area, it.login, it.undone ? `cofnięto${it.undone_by ? ' (' + it.undone_by + ')' : ''}` : null].filter(Boolean).join(' · '))),
          it.link ? linkBtn('Pokaż', it.link, { small: true, kind: 'ghost' }) : null, b);
      })))) : h('div', { class: 'card list-empty' }, 'Jeszcze nic tu nie ma — zmiany z panelu pojawią się tutaj.'),
    d.items.length >= 150 ? h('div', null, linkBtn('Starsze', `#/dziennik?${area ? 'obszar=' + area + '&' : ''}przed=${d.items[d.items.length - 1].id}`, { small: true })) : null);
};

/* ============================================================ Wydajność (wariant B) */

const { ico, watchJob, when, bytes, every } = window.P;
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
/** Jeden wykres liniowy z wypełnieniem, siatką i podpowiedzią (jedna seria = bez legendy, tytuł ją nazywa). */
function lineChart(points, { key, max = 100, fmt = (v) => `${Math.round(v)}%`, label }) {
  const W = 600, H = 150, P = { l: 40, r: 10, t: 10, b: 22 };
  const wrap = h('div', { class: 'chart-wrap' });
  if (points.length < 2) { wrap.append(h('div', { class: 'small muted', style: 'padding:24px 0' }, 'Zbieram dane — wykres pojawi się w ciągu godziny.')); return wrap; }
  const t0 = points[0].ts, t1 = points[points.length - 1].ts;
  const x = (t) => P.l + (t - t0) / Math.max(1, t1 - t0) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - Math.min(max, Math.max(0, v)) / max) * (H - P.t - P.b);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `${label}: wykres` });
  for (const g of [0, 0.5, 1]) {
    svg.append(svgEl('line', { x1: P.l, x2: W - P.r, y1: y(max * g), y2: y(max * g), class: 'chart-grid' }));
    const t = svgEl('text', { x: P.l - 6, y: y(max * g) + 4, class: 'chart-ax', 'text-anchor': 'end' }); t.textContent = fmt(max * g); svg.append(t);
  }
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { d: `${d} L${x(t1)} ${y(0)} L${x(t0)} ${y(0)} Z`, class: 'chart-area' }));
  svg.append(svgEl('path', { d, class: 'chart-line' }));
  const last = points[points.length - 1];
  svg.append(svgEl('circle', { cx: x(last.ts), cy: y(last[key]), r: 3.5, class: 'chart-dot' }));
  const day = (t) => new Date(t).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
  for (const [t, anchor] of [[t0, 'start'], [t1, 'end']]) { const e = svgEl('text', { x: x(t), y: H - 6, class: 'chart-ax', 'text-anchor': anchor }); e.textContent = day(t); svg.append(e); }
  const cross = svgEl('line', { y1: P.t, y2: H - P.b, class: 'chart-cross', visibility: 'hidden' });
  const hot = svgEl('circle', { r: 4, class: 'chart-dot', visibility: 'hidden' });
  svg.append(cross, hot);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * W;
    let best = points[0]; for (const p of points) if (Math.abs(x(p.ts) - px) < Math.abs(x(best.ts) - px)) best = p;
    cross.setAttribute('x1', x(best.ts)); cross.setAttribute('x2', x(best.ts)); cross.setAttribute('visibility', 'visible');
    hot.setAttribute('cx', x(best.ts)); hot.setAttribute('cy', y(best[key])); hot.setAttribute('visibility', 'visible');
    tip.textContent = `${new Date(best.ts).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${fmt(best[key])}`;
    tip.hidden = false; tip.style.left = `${Math.min(r.width - 150, Math.max(0, x(best.ts) / W * r.width - 70))}px`;
  });
  svg.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hot.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  wrap.append(svg, tip);
  return wrap;
}

PAGES.wydajnosc = async (box, args, q) => {
  const days = Number(q.get('dni')) || 30;
  const d = await api('GET', `api/wydajnosc?dni=${days}`);
  const u = d.usage;
  const mb = (n) => `${Math.round(n / 1048576)} MB`;
  const top = u.groups.slice(0, 9);
  const maxMem = top[0]?.mem || 1;
  const f = d.forecast;
  const fixTest = (b) => busy(b, async () => { try { const r = await api('POST', 'api/napraw/napraw', { id: 'testowe', args: {} }); toast('✓ ' + r.text, 'ok'); } catch (e) { toast(e.message, 'bad'); } window.P.reload(); });
  const cpuNow = u.groups.filter((g) => g.cpu > 1).sort((a, b) => b.cpu - a.cpu).slice(0, 4);
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Wydajność'), h('div', { class: 'sub' }, 'Co zajmuje serwer teraz i jak było w ostatnich tygodniach.'))),
    h('div', { class: 'cols' },
      h('section', { class: 'card stack', style: 'gap:12px' },
        h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Co zjada pamięć?'), h('div', { class: 'small muted', style: 'margin-top:4px' }, `Zajęte ${mb(u.used)} z ${mb(u.total)} · wolne ${mb(u.available)}`))),
        h('div', { class: 'mem-bars' }, top.map((g) => h('div', { class: 'mem-bar' }, h('span', { class: 'ell' }, g.name), h('i', { style: `width:${Math.max(2, g.mem / maxMem * 100)}%` }), h('span', { class: 'nowrap' }, mb(g.mem))))),
        h('p', { class: 'small muted', style: 'margin:0' }, 'Liczona jest pamięć wszystkich procesów danej usługi. Część jest współdzielona, więc suma bywa większa niż zajęta pamięć.')),
      h('section', { class: 'card stack', style: 'gap:10px' },
        h('h2', null, 'Odpowiedzi'),
        h('div', { class: 'fx-list' },
          h('div', { class: `fx-c ${d.metrics.cpu.load[0] > u.cores ? 'warn' : 'ok'}` }, h('span', { class: 'fx-s' }, d.metrics.cpu.load[0] > u.cores ? '!' : '✓'), h('div', { class: 'stack grow', style: 'gap:4px' }, h('b', null, d.metrics.cpu.load[0] > u.cores ? 'Procesor jest mocno zajęty' : 'Procesor ma zapas'), h('span', { class: 'small fx-text' }, `Obciążenie ${d.metrics.cpu.load.map((x) => x.toFixed(2)).join(' / ')} (1/5/15 min) przy ${u.cores} rdzeniach.${cpuNow.length ? ' Teraz najwięcej: ' + cpuNow.map((g) => `${g.name} ${Math.round(g.cpu)}%`).join(', ') + '.' : ''}`))),
          h('div', { class: `fx-c ${f.days != null && f.days < 30 ? 'bad' : f.days != null && f.days < 90 ? 'warn' : 'ok'}` }, h('span', { class: 'fx-s' }, f.days != null && f.days < 90 ? '!' : '✓'), h('div', { class: 'stack grow', style: 'gap:4px' }, h('b', null, f.days != null ? `Dysk zapełni się za około ${f.days} ${plural(f.days, 'dzień', 'dni', 'dni')}` : f.perDay != null ? 'Zajętość dysku nie rośnie' : 'Prognoza dysku'), h('span', { class: 'small fx-text' }, `Wolne ${bytes(f.free)} z ${bytes(f.total)}.${f.perDay > 1e6 ? ` Przybywa ok. ${bytes(f.perDay)} dziennie.` : ''}${f.note ? ' ' + f.note : ''}`))),
          d.tips.map((t) => { const b = t.fix === 'testowe' ? btn('Zatrzymaj', () => fixTest(b), { small: true, kind: 'pri' }) : null; return h('div', { class: `fx-c ${t.level}` }, h('span', { class: 'fx-s' }, t.level === 'warn' ? '!' : 'i'), h('div', { class: 'stack grow', style: 'gap:4px' }, h('span', { class: 'small fx-text' }, t.text), b ? h('div', null, b) : null)); })))),
    h('div', { class: 'chips' }, [[1, 'doba'], [7, '7 dni'], [30, '30 dni']].map(([n, l]) => h('a', { class: `chip ${days === n ? 'on-chip' : ''}`, href: `#/wydajnosc?dni=${n}` }, l))),
    h('div', { class: 'tiles' },
      h('section', { class: 'card stack', style: 'gap:6px' }, h('h2', null, 'Procesor'), h('span', { class: 'small muted' }, `średnio ${days > 2 ? 'w godzinie' : 'w 5 min'}`), lineChart(d.history, { key: 'cpu', label: 'Procesor' })),
      h('section', { class: 'card stack', style: 'gap:6px' }, h('h2', null, 'Pamięć'), h('span', { class: 'small muted' }, 'zajęta, w procentach'), lineChart(d.history, { key: 'mem', label: 'Pamięć' })),
      h('section', { class: 'card stack', style: 'gap:6px' }, h('h2', null, 'Dysk'), h('span', { class: 'small muted' }, 'zajęte miejsce'), lineChart(d.history.map((p) => ({ ...p, diskGb: p.disk / 1073741824 })), { key: 'diskGb', max: Math.ceil(f.total / 1073741824), fmt: (v) => `${Math.round(v)} GB`, label: 'Dysk' }))));
  every(60000, () => window.P.reload());
};

/* ================================================================ Aktualizacje */

PAGES.aktualizacje = async (box) => {
  const d = await api('GET', 'api/aktualizacje');
  d.jobs?.filter((j) => !j.end).forEach((j) => watchJob(j, () => window.P.reload()));
  const sec = d.packages.filter((p) => p.security).length;
  const inst = btn('Zainstaluj teraz', () => busy(inst, async () => {
    if (!(await ask({ title: `Zainstalować ${d.packages.length} ${plural(d.packages.length, 'aktualizację', 'aktualizacje', 'aktualizacji')}?`, text: 'Trwa to zwykle 1–5 minut. Usługi, które tego wymagają, uruchomią się ponownie same (strony mogą zniknąć na kilka sekund).', ok: 'Zainstaluj' }))) return;
    try { const r = await api('POST', 'api/aktualizacje/zainstaluj', {}); watchJob(r.job, () => window.P.reload()); } catch (e) { toast(e.message, 'bad'); }
  }), { kind: 'pri', icon: 'aktualizacje', disabled: !d.packages.length });
  const tm = new Date(); tm.setDate(tm.getDate() + (tm.getHours() >= 4 ? 1 : 0)); tm.setHours(4, 0, 0, 0);
  const dt = h('input', { class: 'input', type: 'datetime-local', value: `${tm.getFullYear()}-${pad(tm.getMonth() + 1)}-${pad(tm.getDate())}T04:00`, 'aria-label': 'Kiedy restart', style: 'width:auto' });
  const plan = btn('Zaplanuj restart', () => busy(plan, async () => {
    const at = new Date(dt.value).getTime();
    if (!(await ask({ title: 'Zaplanować restart serwera?', text: `${new Date(at).toLocaleString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}. Strony i aplikacje znikną na 1–2 minuty. Po starcie panel sprawdzi wszystko i da znać.`, ok: 'Zaplanuj' }))) return;
    try { await api('POST', 'api/aktualizacje/restart', { at }); toast('✓ Restart zaplanowany', 'ok'); } catch (e) { toast(e.message, 'bad'); }
    window.P.reload();
  }), { small: true, kind: 'pri' });
  const cancel = d.plan ? btn('Anuluj', () => busy(cancel, async () => { await api('POST', 'api/aktualizacje/restart', { anuluj: true }); window.P.reload(); }), { small: true }) : null;
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Aktualizacje'), h('div', { class: 'sub' }, `Poprawki bezpieczeństwa instalują się same w nocy${d.lastAuto ? ' (ostatnio ' + when(d.lastAuto) + ')' : ''}. Tu zainstalujesz resztę i zaplanujesz restart.`)), h('div', { class: 'acts' }, inst)),
    h('div', { class: 'cols' },
      h('section', { class: 'card stack', style: 'gap:10px' },
        h('div', { class: 'card-h' }, h('div', null, h('h2', null, d.packages.length ? `Czeka ${d.packages.length} ${plural(d.packages.length, 'aktualizacja', 'aktualizacje', 'aktualizacji')}` : 'System jest aktualny'), sec ? h('div', { class: 'small', style: 'margin-top:4px;color:var(--warn-ink)' }, `w tym ${sec} poprawek bezpieczeństwa`) : null)),
        d.packages.length ? h('div', { class: 'rows', style: 'max-height:50vh;overflow:auto' }, d.packages.map((p) => h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('span', { class: 'mono grow' }, p.name), p.security ? h('span', { class: 'pill warn' }, 'bezpieczeństwo') : null, h('span', { class: 'small muted mono' }, `${p.from} → ${p.to}`)))) : h('div', { class: 'list-empty' }, 'Nic nie czeka.')),
      h('section', { class: 'card stack', style: 'gap:12px' },
        h('h2', null, 'Restart serwera'),
        d.reboot ? h('div', { class: 'alert warn' }, h('span', { class: 'tag' }, 'RESTART'), h('span', { class: 'txt' }, `Część poprawek zadziała dopiero po restarcie${d.rebootPkgs.length ? ' (' + d.rebootPkgs.slice(0, 5).join(', ') + ')' : ''}.`)) : h('p', { class: 'small muted', style: 'margin:0' }, 'Restart nie jest teraz potrzebny.'),
        h('div', { class: 'small muted' }, `Serwer działa od ${when(d.boot)} · jądro ${d.kernel}`),
        d.plan ? h('div', { class: 'alert info' }, h('span', { class: 'tag' }, 'PLAN'), h('span', { class: 'txt' }, `Restart ${new Date(d.plan.at).toLocaleString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`), cancel)
          : h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, dt, plan),
        d.lastCheck ? h('div', { class: `alert ${d.lastCheck.ok ? 'ok' : 'error'}` }, h('span', { class: 'tag' }, 'PO RESTARCIE'), h('span', { class: 'txt' }, `${when(d.lastCheck.at)}: ${d.lastCheck.text}`)) : null,
        h('p', { class: 'small muted', style: 'margin:0' }, 'Po każdym restarcie panel sprawdza wszystkie strony i usługi i wysyła wynik tam, gdzie inne powiadomienia (ustawienia na stronie Autopilot).'))));
};

/* =============================================================== Harmonogram */

const WHEN_OPTS = [['dzien', 'codziennie o…'], ['godzina', 'co godzinę'], ['minuty', 'co kilka minut'], ['tydzien', 'co tydzień'], ['miesiac', 'co miesiąc'], ['minuta', 'co minutę'], ['start', 'przy starcie serwera'], ['wlasne', 'własne (cron)']];
function cronForm(d, job, done) {
  const st = job ? { name: job.name, kind: job.kind, target: job.target, enabled: job.enabled, when: { every: 'wlasne', cron: job.sched } } : { name: '', kind: 'polecenie', target: '', enabled: true, when: { every: 'dzien', at: '03:30', n: 15, minute: 0, dow: 1, dom: 1 } };
  const body = h('div', { class: 'stack', style: 'gap:12px' });
  const draw = () => {
    const name = h('input', { class: 'input', value: st.name, placeholder: 'np. Sprzątanie starych plików' }); name.oninput = () => { st.name = name.value; };
    const kind = h('select', { class: 'input' }, h('option', { value: 'polecenie' }, 'Uruchom polecenie lub skrypt'), h('option', { value: 'adres' }, 'Otwórz adres (np. cron.php strony)'), h('option', { value: 'usluga' }, 'Uruchom ponownie usługę')); kind.value = st.kind; kind.onchange = () => { st.kind = kind.value; st.target = ''; draw(); };
    let target;
    if (st.kind === 'usluga') { target = h('select', { class: 'input' }, h('option', { value: '' }, '— wybierz —'), d.services.map((x) => h('option', { value: x.unit }, `${x.name} (${x.unit})`))); target.value = st.target; target.onchange = () => { st.target = target.value; }; }
    else { target = h(st.kind === 'polecenie' ? 'textarea' : 'input', { class: st.kind === 'polecenie' ? 'sql-ta' : 'input mono', style: st.kind === 'polecenie' ? 'min-height:80px' : null, value: st.target, placeholder: st.kind === 'polecenie' ? 'np. find /var/www/strona/tmp -mtime +7 -delete' : 'https://strona.example.pl/cron.php', spellcheck: 'false' }); if (st.kind === 'polecenie') target.value = st.target; target.oninput = () => { st.target = target.value; }; }
    const ev = h('select', { class: 'input' }, WHEN_OPTS.map(([v, l]) => h('option', { value: v }, l))); ev.value = st.when.every; ev.onchange = () => { st.when.every = ev.value; draw(); };
    const extra = [];
    const w = st.when;
    const inp = (k, attrs) => { const i = h('input', { class: 'input', value: w[k] ?? '', ...attrs }); i.oninput = () => { w[k] = i.value; }; return i; };
    if (['dzien', 'tydzien', 'miesiac'].includes(w.every)) extra.push(h('label', { class: 'field' }, h('span', null, 'Godzina'), inp('at', { type: 'time' })));
    if (w.every === 'tydzien') { const s2 = h('select', { class: 'input' }, ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'].map((x, i) => h('option', { value: i }, x))); s2.value = w.dow; s2.onchange = () => { w.dow = s2.value; }; extra.push(h('label', { class: 'field' }, h('span', null, 'Dzień'), s2)); }
    if (w.every === 'miesiac') extra.push(h('label', { class: 'field' }, h('span', null, 'Dzień miesiąca (1–28)'), inp('dom', { type: 'number', min: 1, max: 28 })));
    if (w.every === 'minuty') extra.push(h('label', { class: 'field' }, h('span', null, 'Co ile minut'), inp('n', { type: 'number', min: 2, max: 30 })));
    if (w.every === 'godzina') extra.push(h('label', { class: 'field' }, h('span', null, 'W której minucie'), inp('minute', { type: 'number', min: 0, max: 59 })));
    if (w.every === 'wlasne') extra.push(h('label', { class: 'field' }, h('span', null, 'Wyrażenie cron (minuta godzina dzień miesiąc dzień-tygodnia)'), inp('cron', { class: 'input mono', placeholder: '30 3 * * *' })));
    body.replaceChildren(
      h('label', { class: 'field' }, h('span', null, 'Nazwa'), name),
      h('label', { class: 'field' }, h('span', null, 'Co zrobić'), kind),
      h('label', { class: 'field' }, h('span', null, st.kind === 'usluga' ? 'Usługa' : st.kind === 'adres' ? 'Adres' : 'Polecenie (wykona się jako root)'), target),
      h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Kiedy'), ev), ...extra));
  };
  draw();
  const ok = btn(job ? 'Zapisz' : 'Dodaj zadanie', () => busy(ok, async () => { try { await api('POST', 'api/cron/zadanie', { id: job?.id, ...st }); m.close(); toast('✓ Zapisano', 'ok'); done(); } catch (e) { toast(e.message, 'bad'); } }), { kind: 'pri' });
  const m = window.P.modal ? window.P.modal(job ? 'Zmień zadanie' : 'Nowe zadanie', body, h('div', { class: 'acts' }, btn('Anuluj', () => m.close()), ok)) : null;
}
function modalBasic(title, ...kids) {
  const mm = h('div', { class: 'modal wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', null, title), ...kids);
  const bg = h('div', { class: 'modal-bg' }, mm);
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { bg.remove(); document.removeEventListener('keydown', esc); };
  document.addEventListener('keydown', esc);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  document.body.append(bg);
  return { close };
}
window.P.modal = window.P.modal || modalBasic;

PAGES.cron = async (box) => {
  const d = await api('GET', 'api/cron');
  d.jobs?.filter((j) => !j.end).forEach((j) => watchJob(j, () => window.P.reload()));
  const names = { hourly: 'co godzinę', daily: 'codziennie', weekly: 'co tydzień', monthly: 'co miesiąc' };
  const add = isAdmin() ? btn('Nowe zadanie', () => cronForm(d, null, () => window.P.reload()), { kind: 'pri', icon: 'plus' }) : null;
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Harmonogram'), h('div', { class: 'sub' }, 'Zadania, które serwer wykonuje sam o stałych porach.')), h('div', { class: 'acts' }, add)),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Twoje zadania'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Dodane w panelu — możesz je zmieniać, wyłączać i uruchamiać od razu.'))),
      d.panel.length ? h('div', { class: 'rows' }, d.panel.map((j) => {
        const runB = btn('Uruchom teraz', () => busy(runB, async () => { try { const r = await api('POST', `api/cron/${j.id}/uruchom`, {}); watchJob(r.job, () => window.P.reload()); } catch (e) { toast(e.message, 'bad'); } }), { small: true, icon: 'play' });
        const tog = h('input', { type: 'checkbox', checked: j.enabled, 'aria-label': 'Włączone' });
        tog.onchange = async () => { try { await api('POST', `api/cron/${j.id}/wlacz`, { on: tog.checked }); toast(tog.checked ? '✓ Włączone' : 'Wyłączone', 'ok'); } catch (e) { toast(e.message, 'bad'); } window.P.reload(); };
        const del = btn('', () => busy(del, async () => { if (!(await ask({ title: `Usunąć „${j.name}”?`, text: 'Da się to cofnąć w Dzienniku zmian.', ok: 'Usuń', danger: true }))) return; await api('POST', `api/cron/${j.id}/usun`, {}); window.P.reload(); }), { small: true, icon: 'usun', kind: 'ghost', title: 'Usuń' });
        const outBox = j.last?.out ? h('details', null, h('summary', { class: 'small' }, 'Wynik ostatniego uruchomienia'), h('div', { class: 'logbox app-log', style: 'max-height:200px;margin-top:6px' }, j.last.out)) : null;
        return h('div', { class: 'row', style: 'flex-wrap:wrap;align-items:flex-start' },
          h('label', { class: 'check', style: 'min-height:24px' }, tog),
          h('div', { class: 'stack grow', style: 'flex-basis:260px;min-width:0;gap:4px' },
            h('b', null, j.name),
            h('span', { class: 'small' }, `${j.human} · ${j.kindName}`),
            h('span', { class: 'mono small muted', style: 'overflow-wrap:anywhere' }, j.target),
            h('span', { class: 'small muted' }, [j.next ? `następne: ${when(j.next)}` : (j.enabled ? '' : 'wyłączone'), j.last ? `ostatnio: ${when(j.last.start)} — ${j.last.code === 0 ? 'OK' : j.last.code == null ? 'trwa' : 'błąd (kod ' + j.last.code + ')'}` : 'jeszcze nie uruchamiane'].filter(Boolean).join(' · ')),
            outBox),
          h('div', { class: 'acts' }, runB, isAdmin() ? btn('Zmień', () => cronForm(d, j, () => window.P.reload()), { small: true, icon: 'edytuj' }) : null, isAdmin() ? del : null));
      })) : h('div', { class: 'list-empty' }, 'Jeszcze nie dodałeś żadnego zadania.')),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Zadania systemowe i aplikacji'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Tylko podgląd — dodane ręcznie lub przez programy.'))),
      h('div', { class: 'rows' }, d.items.map((i) => h('div', { class: 'row', style: 'flex-wrap:wrap;align-items:flex-start' },
        h('span', { class: 'pill info', style: 'min-width:150px' }, i.human),
        h('div', { class: 'stack grow', style: 'flex-basis:260px' }, i.desc ? h('span', { class: 't' }, i.desc) : null, h('span', { class: 'mono s', style: 'overflow-wrap:anywhere' }, i.cmd), h('span', { class: 'small dim' }, `${i.source} · jako ${i.user}`)))))),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Zadania okresowe systemu')),
      h('div', { class: 'rows' }, Object.entries(d.periodic).filter(([, l]) => l.length).map(([k, l]) => h('div', { class: 'row' }, h('span', { class: 'pill info', style: 'min-width:110px' }, names[k]), h('span', { class: 'mono s' }, l.join(', ')))))),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Timery systemd')),
      h('div', { class: 'rows' }, d.timers.map((t) => h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('div', { class: 'stack grow', style: 'flex-basis:220px' }, h('span', { class: 'mono t' }, t.unit), h('span', { class: 's' }, `uruchamia ${t.activates}`)),
        h('div', { class: 'stack small' }, h('span', null, `następne: ${t.next ? when(t.next) : '—'}`), h('span', { class: 'dim' }, `ostatnie: ${t.last ? when(t.last) : '—'}`)))))));
};

/* ========================================================= Alarmy (na Autopilocie) */

window.AUTOPILOT_EXTRA = async (box) => {
  let d; try { d = await api('GET', 'api/alarmy'); } catch { return; }
  const form = () => {
    const st = { metric: 'pamiec', target: '', value: 90, minutes: 5 };
    const body = h('div', { class: 'stack', style: 'gap:12px' });
    const draw = () => {
      const m = d.metrics[st.metric];
      const met = h('select', { class: 'input' }, Object.entries(d.metrics).map(([k, v]) => h('option', { value: k }, v.name))); met.value = st.metric; met.onchange = () => { st.metric = met.value; st.target = ''; st.value = { pamiec: 90, procesor: 90, dysk: 90, obciazenie: 4, wolna: 2000 }[st.metric] ?? 0; draw(); };
      const opts = m.needs === 'site' ? d.sites.map((s) => [s, s]) : m.needs === 'service' ? d.services.map((s) => [s.unit, s.name]) : m.needs === 'game' ? d.games.map((g) => [g.id, g.name]) : [];
      const tgt = m.needs ? h('select', { class: 'input' }, h('option', { value: '' }, '— wybierz —'), opts.map(([v, l]) => h('option', { value: v }, l))) : null;
      if (tgt) { tgt.value = st.target; tgt.onchange = () => { st.target = tgt.value; }; }
      const val = m.bool ? null : h('input', { class: 'input', type: 'number', value: st.value, min: 0 }); if (val) val.oninput = () => { st.value = val.value; };
      const min = h('input', { class: 'input', type: 'number', value: st.minutes, min: 1, max: 240 }); min.oninput = () => { st.minutes = min.value; };
      body.replaceChildren(h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Jeśli'), met), tgt ? h('label', { class: 'field' }, h('span', null, m.needs === 'site' ? 'Strona' : m.needs === 'service' ? 'Usługa' : 'Serwer gry'), tgt) : null,
        val ? h('label', { class: 'field' }, h('span', null, `Powyżej${m.unit ? ' (' + m.unit + ')' : ''}`), val) : null, h('label', { class: 'field' }, h('span', null, 'Przez ile minut'), min)),
        m.needs === 'game' && !d.games.length ? h('p', { class: 'small muted', style: 'margin:0' }, 'Najpierw połącz panel z panelem gier (Serwery gier).') : null,
        h('p', { class: 'small muted', style: 'margin:0' }, 'Powiadomienie pójdzie tam, gdzie inne powiadomienia autopilota (np. e-mail, push, GibCord). Gdy wróci do normy — też dam znać.'));
    };
    draw();
    const ok = btn('Dodaj alarm', () => busy(ok, async () => { try { await api('POST', 'api/alarmy', st); mm.close(); toast('✓ Alarm dodany', 'ok'); window.P.reload(); } catch (e) { toast(e.message, 'bad'); } }), { kind: 'pri' });
    const mm = window.P.modal('Nowy alarm', body, h('div', { class: 'acts' }, btn('Anuluj', () => mm.close()), ok));
  };
  put(box, h('section', { class: 'card', id: 'alarmy' },
    h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Własne alarmy'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Daj znać, gdy coś przekroczy próg przez kilka minut.')), isAdmin() ? btn('Nowy alarm', form, { small: true, icon: 'plus' }) : null),
    d.alarms.length ? h('div', { class: 'rows' }, d.alarms.map((a) => {
      const del = btn('', () => busy(del, async () => { await api('POST', `api/alarmy/${a.id}/usun`, {}); window.P.reload(); }), { small: true, icon: 'usun', kind: 'ghost', title: 'Usuń alarm' });
      return h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('span', { class: `pill ${a.fired ? 'bad' : a.since ? 'warn' : 'ok'}` }, a.fired ? 'ALARM' : a.since ? 'liczę czas' : 'w normie'), h('div', { class: 'stack grow', style: 'flex-basis:240px' }, h('span', { class: 't' }, `Jeśli ${a.text}`), a.last ? h('span', { class: 's' }, `ostatnio: ${a.last}`) : null), isAdmin() ? del : null);
    })) : h('div', { class: 'list-empty' }, 'Brak alarmów. Np. „pamięć powyżej 90% przez 5 min” albo „serwer gry wyłączony przez 3 min”.')));
};

/* ===================================================================== Dostęp */

function secretModal(title, rows, note) {
  const m = window.P.modal(title,
    h('p', null, 'Zapisz to teraz — hasła nie da się później podejrzeć (najwyżej ustawisz nowe).'),
    ...rows.map(([k, v]) => h('div', { class: 'stack', style: 'gap:4px' }, h('span', { class: 'small muted' }, k), h('div', { class: 'secret-box' }, v))),
    note ? h('p', { class: 'small muted' }, note) : null,
    h('div', { class: 'acts' }, btn('Kopiuj wszystko', async () => { try { await navigator.clipboard.writeText(rows.map(([k, v]) => `${k}: ${v}`).join('\n')); toast('✓ Skopiowano', 'ok'); } catch { toast('Zaznacz i skopiuj ręcznie.', 'bad'); } }, { icon: 'kopiuj' }), btn('Gotowe', () => m.close(), { kind: 'pri' })));
}
PAGES.dostep = async (box, args) => {
  const tab = args[0] === 'klucze' ? 'klucze' : 'sftp';
  let d;
  try { d = await api('GET', 'api/dostep'); }
  catch (e) { put(box, h('div', { class: 'head' }, h('h1', null, 'Dostęp')), h('div', { class: 'alert info' }, h('span', { class: 'tag' }, 'INFO'), h('span', { class: 'txt' }, 'Konta SFTP i klucze SSH zmienia tylko właściciel panelu.'))); return; }
  put(box, h('div', { class: 'head' }, h('div', null, h('h1', null, 'Dostęp'), h('div', { class: 'sub' }, 'Kto może wgrywać pliki na serwer i logować się przez SSH.'))),
    h('nav', { class: 'tabs' }, [['sftp', 'Konta SFTP', d.sftp.length], ['klucze', 'Klucze SSH', d.ssh.keys.length]].map(([id, l, n]) => h('a', { href: `#/dostep${id === 'sftp' ? '' : '/klucze'}`, class: id === tab ? 'on' : '' }, l, h('span', { class: 'dim', style: 'margin-left:6px;font-weight:400' }, n)))));
  if (tab === 'klucze') {
    const s = d.ssh;
    const ta = h('textarea', { class: 'sql-ta', style: 'min-height:80px', placeholder: 'ssh-ed25519 AAAA… ja@komputer', spellcheck: 'false' });
    const add = btn('Dodaj klucz', () => busy(add, async () => { try { await api('POST', 'api/dostep/klucze', { key: ta.value }); toast('✓ Dodano klucz', 'ok'); window.P.reload(); } catch (e) { toast(e.message, 'bad'); } }), { kind: 'pri', small: true, icon: 'plus' });
    const rootOn = s.rootLogin === 'yes';
    const rootB = btn(rootOn ? 'Wyłącz logowanie roota hasłem' : 'Włącz logowanie roota hasłem', () => busy(rootB, async () => {
      if (!(await ask(rootOn ? { title: 'Wyłączyć logowanie roota hasłem?', text: `Jako root wejdziesz już tylko kluczem SSH (masz ${s.keys.length} ${plural(s.keys.length, 'klucz', 'klucze', 'kluczy')}).${s.rootPasswordLogins30d ? ` Uwaga: w ostatnich 30 dniach ktoś ${s.rootPasswordLogins30d} razy zalogował się jako root hasłem — jeśli to Ty, najpierw dodaj swój klucz.` : ''} Obecne połączenia zostaną.`, ok: 'Wyłącz', danger: true, typed: 'wyłącz' } : { title: 'Włączyć logowanie roota hasłem?', text: 'Hasło roota znów będzie działać przez SSH (chroni je ochrona logowania fail2ban).', ok: 'Włącz' }))) return;
      try { await api('POST', 'api/dostep/root-haslo', { on: !rootOn }); toast('✓ Zmieniono', 'ok'); } catch (e) { toast(e.message, 'bad'); }
      window.P.reload();
    }), { small: true, kind: rootOn ? '' : 'pri' });
    put(box,
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Klucze roota'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Komputery, które mogą zalogować się jako root bez hasła (/root/.ssh/authorized_keys).'))),
        s.keys.length ? h('div', { class: 'rows' }, s.keys.map((k) => {
          const del = btn('', () => busy(del, async () => { if (!(await ask({ title: 'Usunąć ten klucz?', text: `${k.comment || k.type} — ten komputer nie zaloguje się już kluczem. Da się to cofnąć w Dzienniku zmian.`, ok: 'Usuń', danger: true }))) return; try { await api('POST', 'api/dostep/klucze/usun', { fp: k.fp }); toast('✓ Usunięto', 'ok'); } catch (e) { toast(e.message, 'bad'); } window.P.reload(); }), { small: true, icon: 'usun', kind: 'ghost', title: 'Usuń klucz' });
          return h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { class: 'stack grow', style: 'flex-basis:240px;min-width:0' }, h('span', { class: 't' }, k.comment || '(bez opisu)'), h('span', { class: 's mono', style: 'overflow-wrap:anywhere' }, `${k.type}${k.bits ? ' ' + k.bits : ''} · ${k.fp}`), h('span', { class: 's' }, k.last ? `ostatnio użyty ${when(k.last.ts)} z ${k.last.ip}` : 'nieużywany w ostatnich 60 dniach')), del);
        })) : h('div', { class: 'list-empty' }, 'Brak kluczy.'),
        h('div', { class: 'stack', style: 'gap:8px;margin-top:12px' }, h('b', null, 'Nowy klucz publiczny'), ta, h('div', null, add))),
      h('section', { class: 'card stack', style: 'gap:10px' }, h('h2', null, 'Logowanie roota hasłem'),
        h('p', { class: 'small', style: 'margin:0;color:#c9d1dc' }, rootOn ? `Włączone — root może wejść przez SSH hasłem. Bezpieczniej jest logować się tylko kluczem.${s.rootPasswordLogins30d ? ` (W ostatnich 30 dniach: ${s.rootPasswordLogins30d} logowań hasłem.)` : ''}` : 'Wyłączone — root wchodzi tylko kluczem SSH.'),
        h('div', null, rootB)));
    return;
  }
  const site = h('select', { class: 'input' }, d.sites.map((x) => h('option', { value: x.name }, `${x.name} (${x.root})`)));
  const user = h('input', { class: 'input mono', placeholder: 'np. sklep-pliki', autocapitalize: 'off', spellcheck: 'false' });
  const note = h('input', { class: 'input', placeholder: 'dla kogo (opcjonalnie)' });
  const create = btn('Utwórz konto', () => busy(create, async () => {
    try { const r = await api('POST', 'api/dostep/sftp', { user: user.value, site: site.value, note: note.value }); secretModal(`Konto SFTP ${r.user}`, [['Serwer', r.host], ['Port', String(r.port)], ['Protokół', 'SFTP'], ['Login', r.user], ['Hasło', r.password]], `Np. w FileZilli: Plik → Menedżer stron → protokół SFTP. Po zalogowaniu widać tylko folder „strona” = ${r.dir}.`); window.P.reload(); }
    catch (e) { toast(e.message, 'bad'); }
  }), { kind: 'pri', icon: 'plus' });
  put(box,
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Konta SFTP'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Każde konto widzi tylko pliki jednej strony — bez konsoli i bez dostępu do reszty serwera.'))),
      d.sftp.length ? h('div', { class: 'rows' }, d.sftp.map((x) => {
        const act = (label, a, opts = {}) => { const b = btn(label, () => busy(b, async () => {
          if (opts.confirm && !(await ask(opts.confirm))) return;
          try { const r = await api('POST', `api/dostep/sftp/${encodeURIComponent(x.user)}/${a}`, {}); if (r.password) secretModal(`Nowe hasło: ${x.user}`, [['Login', x.user], ['Hasło', r.password]]); else toast('✓ Gotowe', 'ok'); } catch (e) { toast(e.message, 'bad'); }
          window.P.reload();
        }), { small: true, kind: opts.kind || '' }); return b; };
        return h('div', { class: 'row', style: 'flex-wrap:wrap' },
          h('div', { class: 'stack grow', style: 'flex-basis:240px;min-width:0' }, h('span', { class: 't mono' }, x.user, x.locked ? h('span', { class: 'pill off', style: 'margin-left:8px' }, 'zablokowane') : null), h('span', { class: 's' }, `${x.site} · ${x.dir}${x.note ? ' · ' + x.note : ''}`), h('span', { class: 's' }, x.last ? `ostatnio ${when(x.last.ts)} z ${x.last.ip}` : 'jeszcze się nie logował')),
          act('Nowe hasło', 'haslo'), x.locked ? act('Odblokuj', 'odblokuj') : act('Zablokuj', 'blokuj'),
          act('Usuń', 'usun', { kind: 'danger', confirm: { title: `Usunąć konto ${x.user}?`, text: 'Konto zniknie. Pliki strony zostają nietknięte.', ok: 'Usuń', danger: true, typed: x.user } }));
      })) : h('div', { class: 'list-empty' }, 'Brak kont SFTP.')),
    h('section', { class: 'card stack', style: 'gap:12px' }, h('h2', null, 'Nowe konto SFTP'),
      h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Strona'), site), h('label', { class: 'field' }, h('span', null, 'Login'), user), h('label', { class: 'field' }, h('span', null, 'Opis'), note)),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Hasło wygeneruję i pokażę raz. Pliki wgrane przez to konto od razu widzi strona.'),
      h('div', null, create)));
};

/* ============================================================== Plan awaryjny */

PAGES.awaria = async (box) => {
  const d = await api('GET', 'api/awaria');
  const ready = d.items.filter((i) => i.ok === false).length === 0;
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Plan awaryjny'), h('div', { class: 'sub' }, 'Co zrobić, gdyby ten serwer padł na dobre — i czy jesteś na to gotowy.')),
      h('div', { class: 'acts' }, linkBtn('Pobierz paczkę ratunkową', 'api/awaria/paczka', { kind: 'pri', icon: 'pobierz' }))),
    h('section', { class: 'card stack', style: 'gap:10px' }, h('h2', null, ready ? 'Wszystko gotowe' : 'Czego jeszcze brakuje'),
      h('div', { class: 'fx-list' }, d.items.map((i) => h('div', { class: `fx-c ${i.ok === true ? 'ok' : i.ok === false ? 'bad' : 'info'}` }, h('span', { class: 'fx-s', 'aria-hidden': 'true' }, ico(i.ok === true ? 'tak' : i.ok === false ? 'x' : 'literai', 14)),
        h('div', { class: 'stack grow', style: 'gap:4px' }, h('b', null, i.text), h('span', { class: 'small fx-text' }, i.desc), i.ok === false && i.link ? h('div', null, linkBtn('Napraw', i.link, { small: true })) : null))))),
    h('section', { class: 'card stack', style: 'gap:10px' }, h('h2', null, 'Jak to działa'),
      h('ol', { style: 'margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;color:#c9d1dc' },
        h('li', null, 'Co noc panel robi kopię baz, stron, aplikacji i całej konfiguracji serwera, a potem wysyła ją zaszyfrowaną do chmury.'),
        h('li', null, 'Paczka ratunkowa to instrukcja, skrypt i spis tego, co jest na serwerze. Nie zawiera haseł.'),
        h('li', null, 'Do odczytania kopii potrzebny jest Pakiet odzyskiwania (Kopie → Kopie w chmurze). Trzymaj oba pliki poza serwerem, np. w menedżerze haseł i na pendrive.'),
        h('li', null, 'Na nowym serwerze z Debianem 12 uruchamiasz skrypt z paczki — pobierze kopie z chmury i postawi strony, bazy i usługi. Potem tylko przestawiasz domeny w OVH.')),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Pobierz paczkę ponownie po większych zmianach (nowe strony, aplikacje) — spis w środku jest robiony w chwili pobrania.')));
};
