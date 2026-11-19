// Przenoszenie strony na inny serwer z grupy (wariant A): 1 Dokąd → 2 Co przenieść → 3 Przenoszę → 4 Przełącz adres.
const { h, put, api, btn, linkBtn, ico, busy, toast, ask, watchJob, when, bytes, plural, PAGES, state, isAdmin } = window.P;
const enc = encodeURIComponent;
const STEPS = ['Dokąd', 'Co przenieść', 'Przenoszę', 'Przełącz adres'];
const steps = (on) => h('ol', { class: 'wz-steps' }, STEPS.map((l, i) => h('li', { class: `wz-step ${i < on ? 'done' : i === on ? 'on' : ''}` }, h('span', { 'aria-current': i === on ? 'step' : null }, h('span', { class: 'wz-num' }, i < on ? '✓' : String(i + 1)), l))));
const wz = {}; // wybory w krokach 1–2 (na stronę)

PAGES.przenies = async (box, args) => {
  const name = decodeURIComponent(args[0] || '');
  const d = await api('GET', `api/strona/${enc(name)}/przenies`);
  const w = (wz[name] ||= { step: 0, server: d.servers[0]?.id || '', withDb: true, withSettings: true });
  const head = h('div', { class: 'head' }, h('div', null, h('h1', null, 'Przenieś stronę'), h('div', { class: 'sub' }, `${name} — pliki, baza, ustawienia i certyfikat na inny serwer z grupy. Strona tutaj działa do samego przełączenia adresu.`)));
  const back = h('a', { href: `#/strona/${enc(name)}`, class: 'small', style: 'font-weight:600' }, `‹ ${name}`);
  const running = d.jobs.find((j) => !j.end);
  const cur = d.current && d.current.state !== 'blad' ? d.current : null;
  if (running) { put(box, back, head, steps(running.kind === 'przenies' ? 2 : 3), h('section', { class: 'card stack', style: 'gap:10px' }, h('h2', null, running.label), h('p', { class: 'small muted', style: 'margin:0' }, 'Okienko z postępem jest na dole ekranu. Możesz zamknąć tę stronę — zadanie dokończy się samo.'))); watchJob(running, () => window.P.reload()); return; }
  if (cur?.state === 'czeka-dns' || cur?.state === 'gotowe') return stepDns(box, back, head, name, d);
  // kroki 1–2
  if (!d.ok) { put(box, back, head, h('div', { class: 'alert warn' }, h('span', { class: 'tag' }, 'UWAGA'), h('span', { class: 'txt' }, d.problems.join(' ')))); return; }
  if (!d.servers.length) { put(box, back, head, steps(0), h('section', { class: 'card stack', style: 'gap:10px' }, h('h2', null, 'Nie ma dokąd przenieść'), h('p', { class: 'small muted', style: 'margin:0' }, 'Najpierw połącz drugi serwer (z prawem zarządzania) na stronie Wszystkie serwery.'), h('div', null, linkBtn('Wszystkie serwery', '#/serwery', { icon: 'serwery', kind: 'pri' })))); return; }
  const failed = d.current?.state === 'blad' ? h('div', { class: 'alert bad' }, h('span', { class: 'tag' }, 'BŁĄD'), h('span', { class: 'txt' }, `Poprzednia próba nie wyszła: ${d.current.info?.error || 'nieznany błąd'}. Na tamtym serwerze nic nie zostało — możesz spróbować jeszcze raz.`)) : null;
  if (w.step === 0) {
    const list = h('div', { class: 'stack', style: 'gap:8px' }, d.servers.map((s) => {
      const r = h('input', { type: 'radio', name: 'cel', value: s.id, checked: w.server === s.id || null, id: `cel-${s.id}` });
      r.onchange = () => { w.server = s.id; };
      return h('label', { class: 'check mv-opt', for: `cel-${s.id}` }, r, ico('logo', 18), h('span', { class: 'stack', style: 'gap:0;min-width:0' }, h('b', null, s.nazwa), h('span', { class: 'small muted ell' }, s.url.replace(/^https?:\/\//, '').replace(/\/$/, ''))));
    }));
    const next = btn('Dalej: co przenieść', () => { if (!w.server) return toast('Wybierz serwer.', 'bad'); w.step = 1; window.P.reload(); }, { kind: 'pri', icon: 'dalej' });
    put(box, back, head, failed, steps(0), h('section', { class: 'card stack', style: 'gap:12px' }, h('h2', null, 'Na który serwer?'), list, h('div', { class: 'acts' }, next)));
    return;
  }
  const srv = d.servers.find((s) => s.id === w.server) || d.servers[0];
  const opt = (id, on, disabled, title, sub) => { const c = h('input', { type: 'checkbox', checked: on || null, disabled: disabled || null, id }); return [c, h('label', { class: 'check mv-opt', for: id }, c, h('span', { class: 'stack', style: 'gap:0;min-width:0' }, h('b', null, title), h('span', { class: 'small muted' }, sub)))]; };
  const [, files] = opt('mv-pliki', true, true, 'Pliki strony', `${bytes(d.size)} · ${d.files.toLocaleString('pl-PL')} ${plural(d.files, 'plik', 'pliki', 'plików')} · ${d.root}`);
  const [cDb, rowDb] = d.db ? opt('mv-baza', w.withDb, false, `Baza danych ${d.db.name}`, `${bytes(d.db.size)}${d.db.users.length ? ' · konta: ' + d.db.users.map((u) => u.split('@')[0]).join(', ') + ' (z tym samym hasłem)' : ''}${d.db.others.length ? ' · w konfiguracji są też: ' + d.db.others.join(', ') + ' — tych nie przenoszę' : ''}`) : [null, null];
  const [cSet, rowSet] = d.settings ? opt('mv-ust', w.withSettings, false, 'Ustawienia PHP i przekierowania', d.settings.summary) : [null, null];
  const ssl = h('div', { class: 'mv-opt mv-info' }, ico('ssl', 18), h('span', { class: 'stack', style: 'gap:0' }, h('b', null, 'Certyfikat SSL'), h('span', { class: 'small muted' }, 'nowy pobierze się sam na tamtym serwerze po zmianie adresu')));
  const go = btn('Przenieś', () => busy(go, async () => {
    w.withDb = cDb ? cDb.checked : false; w.withSettings = cSet ? cSet.checked : false;
    if (!(await ask({ title: `Przenieść ${name} na „${srv.nazwa}”?`, text: 'Panel spakuje stronę i założy ją na tamtym serwerze. Tutaj nic się nie zmienia, dopóki nie przełączysz adresu w kroku 4.', ok: 'Przenieś' }))) return;
    try { const r = await api('POST', `api/strona/${enc(name)}/przenies`, { server: srv.id, withDb: w.withDb, withSettings: w.withSettings }); w.step = 0; watchJob(r.job, () => window.P.reload()); window.P.reload(); } catch (e) { toast(e.message, 'bad'); }
  }), { kind: 'pri', icon: 'przenies' });
  put(box, back, head, failed, steps(1), h('section', { class: 'card stack', style: 'gap:12px' },
    h('h2', null, `${name} → ${srv.nazwa}`),
    h('div', { class: 'stack', style: 'gap:8px' }, files, rowDb, rowSet, ssl),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Strona tutaj działa dalej aż do przełączenia adresu. Potem zostaje wyłączona (pliki i baza zostają), a usuniesz ją, kiedy zechcesz — panel przypomni po 7 dniach.'),
    h('div', { class: 'acts' }, btn('Wstecz', () => { w.step = 0; window.P.reload(); }, { icon: 'wstecz' }), go)));
};

function stepDns(box, back, head, name, d) {
  const x = d.dns;
  const done = d.current.state === 'gotowe';
  const ipList = (ips) => ips.length ? ips.join(', ') : 'nic (brak rekordu A)';
  const where = x.toTarget ? ['ok', `wskazuje na ${x.server} (${x.target})`] : x.ips.includes(x.here) ? ['warn', `wskazuje jeszcze na ten serwer (${x.here})`] : ['warn', `wskazuje na ${ipList(x.ips)}`];
  const recheck = btn('Sprawdź DNS', () => window.P.reload(), { icon: 'odswiez' });
  const ovhB = !done && x.ovh && !x.toTarget ? btn('Przestaw w OVH', () => busy(ovhB, async () => { try { const r = await api('POST', `api/przeniesienia/${x.id}/dns`, {}); watchJob(r.job, () => setTimeout(() => window.P.reload(), 4000)); } catch (e) { toast(e.message, 'bad'); } }), { kind: 'pri', icon: 'przenies' }) : null;
  const finB = !done ? btn('Zakończ przenoszenie', () => busy(finB, async () => {
    if (!(await ask({ title: 'Zakończyć przenoszenie?', text: `Tamten serwer pobierze certyfikat, a strona ${name} tutaj zostanie wyłączona (pliki i baza zostają).`, ok: 'Zakończ' }))) return;
    try { const r = await api('POST', `api/przeniesienia/${x.id}/zakoncz`, {}); watchJob(r.job, () => window.P.reload()); } catch (e) { toast(e.message, 'bad'); }
  }), { kind: 'pri', icon: 'tak', disabled: !x.toTarget }) : null;
  const left = x.removeAfter ? Math.ceil((x.removeAfter - Date.now()) / 864e5) : null;
  const delB = done && state.role === 'wlasciciel' ? btn('Usuń starą kopię tutaj', () => busy(delB, async () => {
    if (!(await ask({ title: `Usunąć starą kopię ${name}?`, text: `Usunę pliki, bazę i konfigurację strony z tego serwera. Archiwum i zrzut bazy zostaną w koszu kopii. ${left > 0 ? `Panel radzi poczekać jeszcze ${left} ${left === 1 ? 'dzień' : 'dni'}, aż upewnisz się, że wszystko działa na „${x.server}”.` : ''}`, ok: 'Usuń', danger: true }))) return;
    try { const r = await api('POST', `api/przeniesienia/${x.id}/usun`, {}); watchJob(r.job, () => window.P.reload()); } catch (e) { toast(e.message, 'bad'); }
  }), { kind: 'danger', icon: 'usun' }) : null;
  put(box, back, head, steps(done ? 4 : 3),
    h('section', { class: 'card stack', style: 'gap:12px' },
      h('h2', null, done ? `${name} działa na „${x.server}”` : 'Przełącz adres na nowy serwer'),
      h('div', { class: 'rows' },
        h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('b', { class: 'grow' }, 'Strona na nowym serwerze'), h('span', { class: 'small muted' }, `${x.server} · ${x.target} · ${x.info?.dir || ''}`), h('span', { class: 'pill ok' }, 'gotowa')),
        h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('b', { class: 'grow' }, `Adres ${x.name}`), h('span', { class: `small ${where[0] === 'ok' ? '' : 'muted'}` }, where[1]), h('span', { class: `pill ${where[0]}` }, x.toTarget ? 'przełączony' : 'czeka')),
        done ? h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('b', { class: 'grow' }, 'Stara strona tutaj'), h('span', { class: 'small muted' }, `wyłączona ${when(x.switched)}${left > 0 ? ` · usuniesz ją za ${left} ${left === 1 ? 'dzień' : 'dni'} (albo od razu)` : ' · można ją usunąć'}`)) : null),
      !done && !x.toTarget ? (x.ovh ? h('p', { class: 'small muted', style: 'margin:0' }, 'Domena jest w OVH połączonym z panelem — „Przestaw w OVH” zmieni rekord A sam. Nowy adres zwykle działa po 1–5 minutach.')
        : h('div', { class: 'stack', style: 'gap:6px' }, h('p', { class: 'small', style: 'margin:0' }, 'U operatora domeny zmień rekord A:'), h('div', { class: 'secret-box mono', style: 'font-size:15px' }, `${x.name}  →  ${x.target}`), h('p', { class: 'small muted', style: 'margin:0' }, 'Najlepiej z TTL 300 (5 minut). Potem kliknij „Sprawdź DNS”.'))) : null,
      h('div', { class: 'acts', style: 'flex-wrap:wrap' }, ovhB, !done ? recheck : null, finB, delB)));
  if (!done && !x.toTarget) window.P.every(20000, () => window.P.reload());
}
