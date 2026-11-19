// Bazy danych (wariant A — zakładki): lista baz, konta, silniki, zapytania SQL, karta bazy
// (Tabele / Zapytanie SQL / Kto ma dostęp / Kopie / Ustawienia) i kreator nowej bazy.
const { h, put, api, btn, linkBtn, ico, busy, toast, ask, watchJob, when, bytes, plural, reload, PAGES, isAdmin, backLink } = window.P;
const enc = encodeURIComponent;

const ENG = { mariadb: ['MariaDB', 'my'], postgres: ['PostgreSQL', 'pg'], mongo: ['MongoDB', 'mg'], redis: ['Redis', 'rd'], sqlite: ['SQLite', 'sq'] };
const engTag = (e) => h('span', { class: `eng ${ENG[e]?.[1] || ''}` }, ENG[e]?.[0] || e);
const SCOPE = { serwer: ['tylko serwer', 'ok'], dom: ['serwer i dom', 'info'], ip: ['wybrany adres', 'warn'], internet: ['z internetu', 'warn'], plik: ['plik', 'off'] };
const scopeChip = (s, kind) => h('span', { class: `pill ${kind || SCOPE[s]?.[1] || 'off'}` }, SCOPE[s]?.[0] || s);
const RIGHTS = { pelne: 'pełne', odczyt: 'odczyt', inne: 'własne' };
const BLABEL = { reczna: 'ręczna', 'przed edycja': 'przed edycją', 'przed zapytaniem': 'przed zapytaniem', 'przed wgraniem': 'przed wgraniem', 'przed przywroceniem': 'przed przywróceniem', 'przed usunieciem': 'przed usunięciem' };
const blabel = (l) => BLABEL[l.replace(/ \d+$/, '')] || l;
const unit = (e, n) => e === 'redis' ? plural(n, 'klucz', 'klucze', 'kluczy') : e === 'mongo' ? plural(n, 'kolekcja', 'kolekcje', 'kolekcji') : plural(n, 'tabela', 'tabele', 'tabel');
const dbHref = (e, n, rest = '') => `#/bazy/${e}/${enc(n)}${rest}`;

/* --------------------------------------------------------- okienka */

function modal(title, ...kids) {
  const m = h('div', { class: 'modal wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', null, title), ...kids);
  const bg = h('div', { class: 'modal-bg' }, m);
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { bg.remove(); document.removeEventListener('keydown', esc); };
  document.addEventListener('keydown', esc);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  document.body.append(bg);
  setTimeout(() => m.querySelector('input:not([type=checkbox]):not([type=radio]),textarea,select')?.focus(), 30);
  return { close, el: m };
}
async function copy(text, what = 'Skopiowano') { try { await navigator.clipboard.writeText(text); toast('✓ ' + what, 'ok'); } catch { toast('Zaznacz tekst i skopiuj ręcznie.', 'bad'); } }
/** Hasło pokazujemy raz — z przyciskami kopiowania. */
function showSecret(title, r) {
  const m = modal(title,
    h('p', null, 'Zapisz hasło teraz — panel nie pokaże go drugi raz (najwyżej ustawisz nowe).'),
    r.user ? h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'small muted' }, 'Login'), h('div', { class: 'secret-box' }, r.user)) : null,
    r.password ? h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'small muted' }, 'Hasło'), h('div', { class: 'secret-box' }, r.password), h('div', null, btn('Kopiuj hasło', () => copy(r.password, 'Skopiowano hasło'), { small: true, icon: 'kopiuj' }))) : null,
    r.env ? h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'small muted' }, 'Do pliku .env aplikacji'), h('div', { class: 'secret-box' }, r.env.trim()), h('div', null, btn('Kopiuj .env', () => copy(r.env, 'Skopiowano .env'), { small: true, icon: 'kopiuj' }))) : null,
    r.path ? h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'small muted' }, 'Plik bazy'), h('div', { class: 'secret-box' }, r.path)) : null,
    r.remote ? h('p', { class: 'small muted' }, r.remote) : null,
    r.note ? h('p', { class: 'small muted' }, r.note) : null,
    h('div', { class: 'acts' }, btn('Gotowe', () => m.close(), { kind: 'pri' })));
}
async function upload(url, file) {
  const r = await fetch(window.P.apiPath(url), { method: 'POST', credentials: 'same-origin', headers: { 'X-Panel': '1', 'Content-Type': 'application/octet-stream' }, body: file });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j?.error || `Błąd ${r.status}`);
  return j;
}
const run = (b, fn) => busy(b, async () => { try { await fn(); } catch (e) { toast(e.message, 'bad'); } });
function radios(name, opts, cur, onPick) {
  return h('div', { class: 'wz-radios' }, opts.map(([v, label, desc, disabled]) => {
    const r = h('input', { type: 'radio', name, checked: cur === v, disabled: disabled || null });
    r.onchange = () => onPick(v);
    return h('label', { class: `wz-radio ${cur === v ? 'on' : ''}`, style: disabled ? 'opacity:.5;cursor:not-allowed' : null }, r, h('div', { class: 'stack' }, h('b', null, label), desc ? h('span', { class: 's' }, desc) : null));
  }));
}
function accessPicker(state, engine, homeIp, onChange) {
  const local = ['redis', 'sqlite'].includes(engine);
  const ip = h('input', { class: 'input', placeholder: 'np. 203.0.113.7', value: state.ip || '', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Adres IP' });
  ip.oninput = () => { state.ip = ip.value.trim(); };
  return h('div', { class: 'stack', style: 'gap:10px' },
    radios('dostep-' + Math.random().toString(36).slice(2, 6), [
      ['serwer', 'Tylko z tego serwera', `strony i aplikacje na ${window.P.state.cfg?.domena || 'tym serwerze'}`],
      ...(window.P.state.cfg?.dom ? [['dom', `Też z: ${window.P.state.cfg.dom.opis || 'serwer w domu'}`, `${window.P.state.cfg.dom.host}${homeIp ? ' (teraz ' + homeIp + ')' : ''} — adres sam się aktualizuje`, local]] : []),
      ['ip', 'Też z wybranego adresu IP', 'np. Twój komputer', local],
    ], state.access, (v) => { state.access = v; onChange(); }),
    state.access === 'ip' ? ip : null,
    local ? h('span', { class: 'small muted' }, `${ENG[engine][0]} działa tylko na tym serwerze.`) : null);
}

/* ------------------------------------------------------- strona główna */

PAGES.bazy = async (box, args, q) => {
  if (args[0] === 'nowa') return newDbPage(box);
  if (ENG[args[0]] && args[1]) return dbCard(box, args[0], args[1], args.slice(2), q);
  const tab = ['konta', 'silniki', 'sql'].includes(args[0]) ? args[0] : 'bazy';
  const d = await api('GET', 'api/bazy');
  d.jobs?.filter((j) => !j.end).forEach((j) => watchJob(j));
  const showSys = q.has('systemowe');
  const dbs = d.dbs.filter((x) => showSys || !x.system);
  const users = d.users.filter((u) => showSys || !u.system);
  const running = d.engines.filter((e) => e.installed && e.active && e.id !== 'sqlite').length;
  const risky = d.users.filter((u) => u.risk === 'bad');
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Bazy danych'), h('div', { class: 'sub' }, 'Zakładaj bazy i konta, przeglądaj i zmieniaj dane. Przed każdą zmianą panel robi kopię.')),
      isAdmin() ? h('div', { class: 'acts' }, linkBtn('Nowe konto', '#/bazy/konta?nowe', { icon: 'konto' }), linkBtn('Nowa baza', '#/bazy/nowa', { kind: 'pri', icon: 'plus' })) : null),
    risky.map((u) => h('div', { class: 'alert error' }, h('span', { class: 'tag' }, 'RYZYKO'), h('span', { class: 'txt' }, `Konto ${u.user}: ${u.riskText}`), h('a', { href: '#/bazy/konta', class: 'btn sm' }, 'Pokaż'))),
    d.errors.map((e) => h('div', { class: 'alert warn' }, h('span', { class: 'tag' }, 'UWAGA'), h('span', { class: 'txt' }, e.text))),
    h('nav', { class: 'tabs', 'aria-label': 'Zakładki baz' }, [['bazy', 'Bazy', dbs.length], ['konta', 'Konta', users.length], ['silniki', 'Silniki', `${running} ${plural(running, 'działa', 'działają', 'działa')}`], ['sql', 'Zapytanie SQL']].map(([id, l, n]) =>
      h('a', { href: `#/bazy${id === 'bazy' ? '' : '/' + id}${showSys ? '?systemowe' : ''}`, class: id === tab ? 'on' : '', 'aria-current': id === tab ? 'page' : null }, l, n != null ? h('span', { class: 'dim', style: 'margin-left:6px;font-weight:400' }, n) : null))),
  );
  const sysLink = h('div', { class: 'acts' }, h('a', { href: `#/bazy${tab === 'bazy' ? '' : '/' + tab}${showSys ? '' : '?systemowe'}`, class: 'small' }, showSys ? 'Ukryj systemowe' : 'Pokaż też systemowe'));
  if (tab === 'konta') { accountsTab(box, d, users); put(box, sysLink); if (q.has('nowe') && isAdmin()) setTimeout(() => newAccount(d), 50); return; }
  if (tab === 'silniki') return enginesTab(box, d);
  if (tab === 'sql') return sqlConsole(box, { dbs: d.dbs.filter((x) => x.engine !== 'sqlite' || x.name) });
  put(box,
    h('section', { class: 'card' }, dbs.length ? h('div', { class: 'rows' }, dbs.map(dbRow)) : h('div', { class: 'list-empty' }, 'Brak baz.')),
    sysLink,
    d.files?.length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Dane w plikach'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Gry i aplikacje trzymające dane w katalogach — do pobrania jako .tar.gz'))),
      h('div', { class: 'rows' }, d.files.map((x) => h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('div', { class: 'stack grow', style: 'flex-basis:200px' }, h('span', { class: 't' }, x.name), h('span', { class: 's' }, `${x.path} · zmiana ${when(x.changed)}`)),
        h('span', { class: 'small muted nowrap' }, bytes(x.size)),
        linkBtn('Pobierz', `api/bazy/pliki/${enc(x.id)}/pobierz`, { small: true, icon: 'pobierz' }))))) : null,
  );
};
function dbRow(x) {
  const used = x.usedBy?.length ? x.usedBy.map((u) => u.label).join(', ') : (x.system ? 'systemowa' : 'nieużywana?');
  return h('a', { class: 'row db-row', href: dbHref(x.engine, x.name) },
    h('div', { class: 'stack grow', style: 'flex-basis:220px;min-width:0' },
      h('span', { class: 't' }, x.label && x.label !== x.name ? x.label : x.name, x.tables === 0 && !x.system ? h('span', { class: 'pill off', style: 'margin-left:8px' }, 'pusta') : null),
      h('span', { class: 's ell' }, `${used} · ${x.tables ?? '?'} ${unit(x.engine, x.tables ?? 0)}`)),
    engTag(x.engine),
    h('span', { class: 'small muted nowrap db-size' }, x.size == null ? '' : bytes(x.size)),
    scopeChip(x.scope),
    h('span', { class: 'muted', 'aria-hidden': 'true' }, '›'));
}

/* --------------------------------------------------------------- konta */

function accountsTab(box, d, users) {
  const byEng = Object.keys(ENG).filter((e) => users.some((u) => u.engine === e));
  put(box, byEng.map((e) => h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('div', { style: 'display:flex;gap:10px;align-items:center' }, engTag(e), h('h2', null, 'Konta'))),
    h('div', { class: 'rows' }, users.filter((u) => u.engine === e).map((u) => accountRow(u, d))))));
}
function accountRow(u, d) {
  const dbs = u.global ? [h('span', { class: 'chip' }, `wszystkie bazy (${RIGHTS[u.global]})`)] : u.dbs.map((x) => h('a', { class: 'chip', href: dbHref(u.engine, x.db) }, `${x.db} · ${RIGHTS[x.rights]}`));
  return h('div', { class: 'row', style: 'flex-wrap:wrap;align-items:flex-start' },
    h('div', { class: 'stack grow', style: 'flex-basis:260px;min-width:0;gap:6px' },
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, h('b', { class: 'mono', style: 'font-size:14px' }, u.user),
        u.locked ? h('span', { class: 'pill off' }, 'zablokowane') : scopeChip(u.scope, u.risk === 'bad' ? 'bad' : null),
        u.system ? h('span', { class: 'pill off' }, 'systemowe') : null),
      h('div', { class: 'chips' }, dbs.length ? dbs : h('span', { class: 'small muted' }, 'bez dostępu do baz')),
      u.riskText && !u.locked ? h('span', { class: 'small', style: 'color:var(--warn-ink)' }, u.riskText) : null,
      u.scope !== 'serwer' && !u.locked && !u.riskText ? h('span', { class: 'small muted' }, `Łączy się: ${u.label}`) : null,
      u.note ? h('span', { class: 'small muted' }, u.note) : null),
    isAdmin() && !u.system ? btn('Zmień', () => editAccount(u, d), { small: true, icon: 'edytuj' }) : null);
}
function editAccount(u, d) {
  const dbs = d.dbs.filter((x) => x.engine === u.engine && !x.system && !(x.engine === 'redis' && /^db\d+$/.test(x.name)));
  const st = { access: u.scope === 'internet' ? null : u.scope, ip: u.ips?.[0] || '' };
  const rights = new Map(u.dbs.map((x) => [x.db, x.rights]));
  const dropGlobal = h('input', { type: 'checkbox' });
  const accBox = h('div');
  const drawAcc = () => accBox.replaceChildren(accessPicker(st, u.engine, d.homeIp, drawAcc));
  drawAcc();
  const rightsBox = u.engine === 'redis' ? h('p', { class: 'small muted' }, `To konto widzi tylko klucze zaczynające się od „${u.dbs[0]?.db || u.user}:”.`) : h('div', { class: 'stack', style: 'gap:6px' },
    u.global ? h('label', { class: 'check' }, dropGlobal, h('span', null, h('b', null, 'Odbierz dostęp do wszystkich baz'), h('br'), h('span', { class: 'small muted' }, 'zostaną tylko bazy wybrane niżej'))) : null,
    dbs.map((x) => {
      const sel = h('select', { class: 'input', style: 'width:auto;min-width:130px', 'aria-label': `Prawa do ${x.name}` }, h('option', { value: '' }, 'brak'), h('option', { value: 'odczyt' }, 'odczyt'), h('option', { value: 'pelne' }, 'pełne'), rights.get(x.name) === 'inne' ? h('option', { value: 'inne' }, 'własne (bez zmian)') : null);
      sel.value = rights.get(x.name) || '';
      sel.onchange = () => { if (sel.value) rights.set(x.name, sel.value); else rights.delete(x.name); };
      return h('div', { class: 'row', style: 'padding:4px 0' }, h('span', { class: 'grow mono' }, x.name), sel);
    }));
  const save = btn('Zapisz zmiany', () => run(save, async () => {
    const base = `api/bazy/konto/${u.engine}/${enc(u.user)}`;
    const wantScope = st.access;
    if (wantScope && (wantScope !== u.scope || (wantScope === 'ip' && st.ip !== (u.ips?.[0] || '')))) {
      if (u.engine !== 'redis') await api('POST', `${base}/skad`, { access: wantScope, ip: st.ip });
    }
    const list = [...rights.entries()].map(([db, r]) => ({ db, rights: r }));
    const before = JSON.stringify(u.dbs.map((x) => [x.db, x.rights]).sort());
    const after = JSON.stringify(list.map((x) => [x.db, x.rights]).sort());
    if (u.engine !== 'redis' && (before !== after || dropGlobal.checked)) await api('POST', `${base}/prawa`, { dbs: list, global: dropGlobal.checked ? 'usun' : 'zostaw' });
    m.close(); toast('✓ Zapisano', 'ok'); reload();
  }), { kind: 'pri' });
  const act = (label, a, opts = {}) => { const b = btn(label, () => run(b, async () => {
    if (opts.confirm && !(await ask(opts.confirm))) return;
    const r = await api('POST', `api/bazy/konto/${u.engine}/${enc(u.user)}/${a}`, {});
    m.close();
    if (r.password) showSecret(`Nowe hasło: ${u.user}`, { user: u.user, password: r.password, note: 'Wpisz je w ustawieniach aplikacji, która używa tego konta — stare hasło już nie działa.' });
    else toast('✓ Gotowe — w razie czego cofniesz to w Dzienniku zmian', 'ok');
    reload();
  }), { small: true, kind: opts.kind || '', icon: opts.icon }); return b; };
  const m = modal(`Konto ${u.user}`,
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, engTag(u.engine), u.locked ? h('span', { class: 'pill off' }, 'zablokowane') : scopeChip(u.scope, u.risk === 'bad' ? 'bad' : null)),
    u.note ? h('p', { class: 'small muted' }, u.note) : null,
    u.riskText ? h('p', { class: 'small', style: 'color:var(--warn-ink)' }, u.riskText) : null,
    h('h3', null, 'Skąd może się łączyć'),
    u.scope === 'internet' ? h('p', { class: 'small muted' }, 'Teraz: z całego internetu. Wybierz, żeby ograniczyć.') : null,
    accBox,
    h('h3', null, 'Do których baz'),
    rightsBox,
    h('div', { class: 'acts', style: 'flex-wrap:wrap;justify-content:space-between' },
      h('div', { class: 'acts', style: 'flex-wrap:wrap' },
        act('Nowe hasło', 'haslo', { icon: 'klucz', confirm: { title: 'Ustawić nowe hasło?', text: 'Stare hasło przestanie działać — aplikacja, która go używa, straci połączenie, dopóki nie wpiszesz w niej nowego.', ok: 'Ustaw nowe' } }),
        u.locked ? act('Odblokuj', 'odblokuj') : act('Zablokuj', 'blokuj', { confirm: { title: `Zablokować ${u.user}?`, text: 'Nikt nie zaloguje się tym kontem, dopóki go nie odblokujesz.', ok: 'Zablokuj' } }),
        act('Usuń', 'usun', { kind: 'danger', confirm: { title: `Usunąć konto ${u.user}?`, text: 'Konto zniknie razem z prawami. Bazy zostają. Da się to cofnąć w Dzienniku zmian.', ok: 'Usuń', danger: true, typed: u.user } })),
      h('div', { class: 'acts' }, btn('Anuluj', () => m.close()), save)));
}
function newAccount(d, preset = {}) {
  const engines = d.engines.filter((e) => e.installed && e.ready && e.active && e.id !== 'sqlite');
  const st = { engine: preset.engine || 'mariadb', access: 'serwer', ip: '', name: preset.name || '' };
  const rights = new Map(preset.db ? [[preset.db, 'pelne']] : []);
  const body = h('div', { class: 'stack', style: 'gap:12px' });
  const draw = () => {
    const name = h('input', { class: 'input mono', value: st.name, placeholder: 'np. sklep_odczyt', autocapitalize: 'off', spellcheck: 'false', autocomplete: 'off' });
    name.oninput = () => { st.name = name.value.trim(); };
    const eng = h('select', { class: 'input' }, engines.map((e) => h('option', { value: e.id }, e.name)));
    eng.value = st.engine; eng.onchange = () => { st.engine = eng.value; rights.clear(); st.access = 'serwer'; draw(); };
    const dbs = d.dbs.filter((x) => x.engine === st.engine && !x.system && !(x.engine === 'redis'));
    body.replaceChildren(
      h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Silnik'), eng), h('label', { class: 'field' }, h('span', null, 'Nazwa konta'), name)),
      h('h3', null, 'Skąd może się łączyć'), accessPicker(st, st.engine, d.homeIp, draw),
      st.engine === 'redis' ? h('p', { class: 'small muted' }, 'Konto Redisa widzi tylko klucze zaczynające się od jego nazwy i dwukropka.') : h('h3', null, 'Do których baz'),
      st.engine === 'redis' ? null : (dbs.length ? dbs.map((x) => {
        const sel = h('select', { class: 'input', style: 'width:auto;min-width:130px' }, h('option', { value: '' }, 'brak'), h('option', { value: 'odczyt' }, 'odczyt'), h('option', { value: 'pelne' }, 'pełne'));
        sel.value = rights.get(x.name) || ''; sel.onchange = () => { if (sel.value) rights.set(x.name, sel.value); else rights.delete(x.name); };
        return h('div', { class: 'row', style: 'padding:4px 0' }, h('span', { class: 'grow mono' }, x.name), sel);
      }) : h('p', { class: 'small muted' }, 'Brak baz w tym silniku.')));
  };
  draw();
  const ok = btn('Utwórz konto', () => run(ok, async () => {
    const r = await api('POST', 'api/bazy/konto', { engine: st.engine, user: st.name, access: st.access, ip: st.ip, dbs: [...rights.entries()].map(([db, x]) => ({ db, rights: x })) });
    m.close(); showSecret(`Konto ${r.user} gotowe`, r); reload();
  }), { kind: 'pri' });
  const m = modal('Nowe konto do bazy', body, h('div', { class: 'acts' }, btn('Anuluj', () => m.close()), ok));
}

/* ------------------------------------------------------------- silniki */

function enginesTab(box, d) {
  put(box, h('div', { class: 'tiles' }, d.engines.map((e) => {
    const state = e.installing ? h('span', { class: 'pill info' }, 'instaluję…') : !e.installed ? h('span', { class: 'pill off' }, 'nie zainstalowany') : e.active ? h('span', { class: 'pill ok' }, 'działa') : h('span', { class: 'pill bad' }, 'wyłączony');
    const acts = [];
    if (isAdmin() && !e.installed && ['postgres', 'mongo'].includes(e.id) && !e.installing) {
      const b = btn('Zainstaluj', () => run(b, async () => {
        const okk = await ask({ title: `Zainstalować ${e.name}?`, text: `${e.name} zajmie ${e.ram} pamięci i trochę miejsca na dysku. Będzie działać tylko lokalnie (z hasłem), trafi do nocnych kopii i do autopilota. Instalacja trwa 1–3 minuty.`, ok: 'Zainstaluj' });
        if (!okk) return;
        const r = await api('POST', `api/bazy/silnik/${e.id}/zainstaluj`, {}); watchJob(r.job, () => reload());
      }), { small: true, kind: 'pri', icon: 'plus' });
      acts.push(b);
    }
    if (isAdmin() && e.installed && e.id !== 'sqlite') {
      const rb = btn('Uruchom ponownie', () => run(rb, async () => { if (!(await ask({ title: `Uruchomić ponownie ${e.name}?`, text: 'Aplikacje stracą połączenie z bazą na kilka sekund.', ok: 'Uruchom ponownie' }))) return; await api('POST', `api/bazy/silnik/${e.id}/restart`, {}); toast('✓ Uruchomiono ponownie', 'ok'); reload(); }), { small: true, icon: 'restart' });
      acts.push(rb);
      if (['postgres', 'mongo'].includes(e.id)) {
        const sb = btn(e.active ? 'Wyłącz' : 'Włącz', () => run(sb, async () => {
          if (e.active && !(await ask({ title: `Wyłączyć ${e.name}?`, text: 'Bazy w nim będą niedostępne, a silnik nie wstanie po restarcie serwera. Dane zostają.', ok: 'Wyłącz', danger: true }))) return;
          await api('POST', `api/bazy/silnik/${e.id}/${e.active ? 'stop' : 'start'}`, {}); reload();
        }), { small: true, kind: e.active ? 'ghost' : 'pri' });
        acts.push(sb);
      }
    }
    return h('section', { class: 'card tile', style: 'gap:10px' },
      h('div', { style: 'display:flex;justify-content:space-between;gap:10px;align-items:center' }, h('h2', null, e.name), state),
      h('p', { class: 'small', style: 'margin:0;color:#c9d1dc' }, e.desc),
      h('div', { class: 'small muted' }, [e.version ? `wersja ${e.version}` : null, e.mem ? `pamięć ${bytes(e.mem)}` : (!e.installed && e.ram ? `zajmie ${e.ram}` : null), e.portInfo || null].filter(Boolean).join(' · ')),
      e.portOpen ? h('a', { href: '#/zapora', class: 'small', style: 'color:var(--warn-ink)' }, 'Port bazy jest otwarty na świat — włącz zaporę') : null,
      acts.length ? h('div', { class: 'acts', style: 'flex-wrap:wrap' }, acts) : null);
  })));
}

/* --------------------------------------------------- konsola zapytań */

const sqlText = new Map();
const PLACEHOLDER = { mariadb: 'SELECT * FROM tabela LIMIT 20', postgres: 'SELECT * FROM tabela LIMIT 20', sqlite: 'SELECT * FROM tabela LIMIT 20', mongo: '{"find": "kolekcja", "filter": {}, "limit": 20}', redis: 'GET klucz' };
const VERB = { DELETE: ['usunie', 'usuń'], UPDATE: ['zmieni', 'zmień'], INSERT: ['doda', 'dodaj'], REPLACE: ['zmieni', 'zmień'], MERGE: ['zmieni', 'zmień'], delete: ['usunie', 'usuń'], update: ['zmieni', 'zmień'], insert: ['doda', 'dodaj'] };
function resultEl(r) {
  if (r.cols) {
    return h('div', { class: 'stack', style: 'gap:8px' },
      h('div', { class: 'small muted' }, `${r.rows.length} ${plural(r.rows.length, 'wiersz', 'wiersze', 'wierszy')}${r.truncated ? ' (pokazuję pierwsze 500)' : ''}${r.ms != null ? ` · ${r.ms} ms` : ''}${r.backup ? ' · kopia przed zmianą zapisana' : ''}`),
      r.rows.length ? h('div', { class: 'scroll', style: 'max-height:60vh' }, h('table', { class: 't' }, h('thead', null, h('tr', null, r.cols.map((c) => h('th', null, c)))),
        h('tbody', null, r.rows.map((row) => h('tr', null, row.map((v) => h('td', { class: v == null ? 'null' : '', title: v != null && String(v).length > 40 ? v : null }, v == null ? 'NULL' : v))))))) : null);
  }
  return h('div', { class: 'alert ok' }, h('span', { class: 'tag' }, 'OK'), h('span', { class: 'txt' }, `${r.affected != null ? `Zmienione wiersze: ${r.affected}` : 'Wykonano'}${r.info ? ' · ' + r.info : ''}${r.backup ? ' · kopia sprzed zmiany zapisana (cofniesz w Dzienniku zmian)' : ''}`));
}
function sqlConsole(box, { dbs, engine, name }) {
  const pickable = (dbs || []).filter((x) => !(x.engine === 'sqlite' && false));
  let cur = engine ? `${engine}:${name}` : (sessionStorage.getItem('bazy-sql') || '');
  if (!engine && !pickable.some((x) => `${x.engine}:${x.name}` === cur)) cur = pickable[0] ? `${pickable[0].engine}:${pickable[0].name}` : '';
  const sel = engine ? null : h('select', { class: 'input', style: 'width:auto;min-width:220px', 'aria-label': 'Baza' }, pickable.map((x) => h('option', { value: `${x.engine}:${x.name}` }, `${ENG[x.engine][0]} · ${x.label && x.label !== x.name ? x.label : x.name}`)));
  if (sel) { sel.value = cur; sel.onchange = () => { cur = sel.value; try { sessionStorage.setItem('bazy-sql', cur); } catch {} ta.placeholder = PLACEHOLDER[cur.split(':')[0]] || ''; }; }
  const ta = h('textarea', { class: 'sql-ta', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Zapytanie', placeholder: PLACEHOLDER[(cur || 'mariadb').split(':')[0]] || '' });
  ta.value = sqlText.get(cur) || sqlText.get('*') || '';
  ta.oninput = () => { sqlText.set(cur, ta.value); sqlText.set('*', ta.value); };
  const ro = h('input', { type: 'checkbox', checked: true });
  const out = h('div', { 'aria-live': 'polite' });
  const exec = async (b) => run(b, async () => {
    if (!cur) return toast('Wybierz bazę.', 'bad');
    const [e, ...rest] = cur.split(':'); const n = rest.join(':');
    const url = `api/bazy/${e}/${enc(n)}/sql`;
    out.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spin' }), 'Wykonuję…'));
    try {
      let r = await api('POST', url, { sql: ta.value, write: !ro.checked });
      if (r.needConfirm) {
        const v = VERB[r.word] || ['zmieni', 'zmień'];
        const okk = await ask({ title: 'Wykonać to zapytanie?', text: `${r.affected != null ? `To zapytanie ${v[0]} ${r.affected} ${plural(r.affected, 'wiersz', 'wiersze', 'wierszy')}.` : 'To zapytanie zmienia bazę (np. strukturę tabel) — nie da się podejrzeć wyniku przed wykonaniem.'}\nPrzed wykonaniem panel zrobi kopię bazy, więc zmianę cofniesz w Dzienniku zmian.`, ok: 'Wykonaj', danger: true, typed: v[1] });
        if (!okk) { out.replaceChildren(h('div', { class: 'small muted' }, 'Anulowano — nic się nie zmieniło.')); return; }
        r = await api('POST', url, { sql: ta.value, write: true, confirm: true });
      }
      out.replaceChildren(resultEl(r));
    } catch (er) { out.replaceChildren(h('div', { class: 'alert error' }, h('span', { class: 'tag' }, 'BŁĄD'), h('span', { class: 'txt mono', style: 'white-space:pre-wrap' }, er.message))); }
  });
  const go = btn('Wykonaj', () => exec(go), { kind: 'pri' });
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); exec(go); } });
  put(box, h('section', { class: 'card stack', style: 'gap:12px' },
    sel ? h('div', { class: 'row', style: 'padding:0;flex-wrap:wrap' }, h('span', { class: 'small muted' }, 'Baza'), sel) : null,
    ta,
    h('div', { class: 'row', style: 'padding:0;flex-wrap:wrap' }, h('label', { class: 'check grow' }, ro, h('span', null, h('b', null, 'Tylko odczyt'), h('span', { class: 'small muted' }, ' — wyłącz, żeby zmieniać dane'))), h('span', { class: 'small muted' }, 'Ctrl+Enter'), go),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Kolumny z hasłami i tokenami są ukryte. Zapytania zmieniające dane wymagają potwierdzenia, a przed nimi panel robi kopię bazy.')),
    out);
}

/* ----------------------------------------------------------- karta bazy */

const DB_TABS = [['tabele', 'Tabele'], ['sql', 'Zapytanie SQL'], ['dostep', 'Kto ma dostęp'], ['kopie', 'Kopie'], ['ustawienia', 'Ustawienia']];
async function dbCard(box, engine, name, rest, q) {
  const tab = rest[0] === 'tabela' ? 'tabele' : (DB_TABS.some(([id]) => id === rest[0]) ? rest[0] : 'tabele');
  const d = await api('GET', `api/bazy/${engine}/${enc(name)}`);
  d.jobs?.filter((j) => !j.end).forEach((j) => watchJob(j));
  const x = d.db;
  const base = dbHref(engine, name);
  const tabLabel = engine === 'mongo' ? 'Kolekcje' : engine === 'redis' ? 'Klucze' : 'Tabele';
  const kopia = btn('Kopia teraz', () => run(kopia, async () => { const r = await api('POST', `api/bazy/${engine}/${enc(name)}/kopia`, {}); watchJob(r.job, () => reload()); }), { icon: 'kopie' });
  put(box,
    backLink('#/bazy', 'Bazy danych'),
    h('div', { class: 'head' },
      h('div', { style: 'min-width:0' }, h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, h('h1', { style: 'overflow-wrap:anywhere' }, x.label && x.label !== x.name ? x.label : name), engTag(engine), scopeChip(x.scope), x.app ? h('span', { class: 'pill off' }, 'tylko odczyt') : null),
        h('div', { class: 'sub' }, [x.size != null ? bytes(x.size) : null, `${x.tables ?? '?'} ${unit(engine, x.tables ?? 0)}`, x.changed ? 'zmiana ' + when(x.changed) : null].filter(Boolean).join(' · '),
          x.usedBy?.length ? [' · używa: ', x.usedBy.map((u, i) => [i ? ', ' : '', u.link ? h('a', { href: u.link }, u.label) : u.label])] : null)),
      h('div', { class: 'acts' }, linkBtn('Pobierz', `api/bazy/${engine}/${enc(name)}/pobierz`, { icon: 'pobierz' }), isAdmin() && engine !== 'redis' ? kopia : null)),
    h('nav', { class: 'tabs', 'aria-label': 'Zakładki bazy' }, DB_TABS.filter(([id]) => !(engine === 'sqlite' && id === 'dostep')).map(([id, l]) => h('a', { href: `${base}/${id}`, class: id === tab ? 'on' : '', 'aria-current': id === tab ? 'page' : null },
      id === 'tabele' ? tabLabel : id === 'sql' && engine === 'mongo' ? 'Zapytanie' : id === 'sql' && engine === 'redis' ? 'Polecenia' : l,
      id === 'dostep' ? h('span', { class: 'dim', style: 'margin-left:6px;font-weight:400' }, x.access.length) : id === 'kopie' ? h('span', { class: 'dim', style: 'margin-left:6px;font-weight:400' }, d.backups.length) : null))),
  );
  if (tab === 'sql') return sqlConsole(box, { engine, name });
  if (tab === 'dostep') return accessTab(box, d, engine, name);
  if (tab === 'kopie') return backupsTab(box, d, engine, name);
  if (tab === 'ustawienia') return settingsTab(box, d, engine, name);
  return tablesTab(box, d, engine, name, rest[0] === 'tabela' ? rest[1] : null, q);
}

async function tablesTab(box, d, engine, name, table, q) {
  const base = dbHref(engine, name);
  if (d.db.tablesError) put(box, h('div', { class: 'alert error' }, h('span', { class: 'tag' }, 'BŁĄD'), h('span', { class: 'txt' }, d.db.tablesError)));
  const list = h('div', { class: 'card db-tables' }, d.tables.length ? h('div', { class: 'db-tlist' }, d.tables.map((t) => h('a', { href: `${base}/tabela/${enc(t.name)}`, class: t.name === table ? 'on' : '' },
    h('span', { class: 'ell mono' }, t.name, t.view && engine !== 'redis' ? h('span', { class: 'dim' }, ' (widok)') : null),
    h('small', { class: 'dim' }, t.rows == null ? '' : `${t.approx ? '~' : ''}${Number(t.rows).toLocaleString('pl-PL')}`)))) : h('div', { class: 'list-empty' }, engine === 'mongo' ? 'Brak kolekcji.' : 'Brak tabel — utwórz je zapytaniem SQL albo wgraj plik .sql w zakładce Kopie.'));
  const main = h('div', { class: 'db-main' });
  put(box, h('div', { class: `db-split ${table ? 'has-table' : ''}` }, list, main));
  setTimeout(() => list.querySelector('a.on')?.scrollIntoView({ block: 'center' }), 60);
  if (!table) { put(main, h('div', { class: 'card fm-empty' }, h('span', { class: 'muted' }, d.tables.length ? 'Wybierz tabelę z listy.' : ''))); return; }
  const od = Math.max(0, Number(q.get('od')) || 0);
  const szukaj = q.get('szukaj') || '';
  const r = await api('GET', `api/bazy/${engine}/${enc(name)}/tabela/${enc(table)}?od=${od}&szukaj=${enc(szukaj)}`);
  const tbase = `${base}/tabela/${enc(table)}`;
  const search = h('input', { class: 'input', type: 'search', value: szukaj, placeholder: engine === 'mongo' ? 'Szukaj albo filtr JSON, np. {"poziom": 5}' : 'Szukaj w tabeli…', 'aria-label': 'Szukaj' });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = `${tbase}?szukaj=${enc(search.value)}`; });
  const to = od + r.rows.length;
  const editable = r.editable && isAdmin();
  put(main, h('div', { class: 'stack', style: 'gap:10px' },
    h('a', { href: base, class: 'small db-back' }, '‹ Wszystkie tabele'),
    h('div', { class: 'row', style: 'padding:0;flex-wrap:wrap;gap:8px' },
      h('h2', { class: 'mono grow', style: 'font-size:18px;overflow-wrap:anywhere' }, table),
      editable ? btn('Wiersz', () => (r.mongo ? docModal(engine, name, table, null) : rowModal(engine, name, table, r, -1)), { small: true, icon: 'plus' }) : null),
    h('div', { style: 'display:flex;gap:8px' }, h('div', { class: 'grow' }, search), btn('Szukaj', () => { location.hash = `${tbase}?szukaj=${enc(search.value)}`; }, { small: true })),
    r.readonlyApp ? h('div', { class: 'small muted' }, 'To baza działającej aplikacji — panel pokazuje ją tylko do odczytu.') : (!r.editable && !r.view && engine !== 'redis' ? h('div', { class: 'small muted' }, 'Ta tabela nie ma klucza głównego — wiersze zmienisz zapytaniem SQL.') : null),
    h('div', { class: 'row', style: 'padding:0;flex-wrap:wrap;gap:8px' },
      h('span', { class: 'small muted grow' }, r.rows.length ? `wiersze ${od + 1}–${to}${r.total != null ? ` z ${r.approx ? '~' : ''}${Number(r.total).toLocaleString('pl-PL')}` : ''}${editable ? ' · kliknij wiersz, żeby go zmienić' : ''}` : (szukaj ? 'nic nie znalazłem' : 'tabela jest pusta')),
      od > 0 ? linkBtn('Poprzednie', `${tbase}?od=${Math.max(0, od - r.limit)}&szukaj=${enc(szukaj)}`, { small: true }) : null,
      r.rows.length === r.limit ? linkBtn('Następne', `${tbase}?od=${od + r.limit}&szukaj=${enc(szukaj)}`, { small: true }) : null),
    r.rows.length ? h('div', { class: 'scroll', style: 'max-height:65vh' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, r.cols.map((c) => h('th', { title: c.type || null }, c.name, c.pk ? h('span', { class: 'pk-ico', title: 'klucz główny', 'aria-label': 'klucz główny' }, ico('klucz', 14)) : null)))),
      h('tbody', null, r.rows.map((row, i) => h('tr', { class: editable ? 'click' : '', tabindex: editable ? '0' : null, onclick: editable ? () => (r.mongo ? docModal(engine, name, table, r, i) : rowModal(engine, name, table, r, i)) : null, onkeydown: editable ? (e) => { if (e.key === 'Enter') (r.mongo ? docModal(engine, name, table, r, i) : rowModal(engine, name, table, r, i)); } : null },
        row.map((v) => h('td', { class: v == null ? 'null' : '', title: v != null && String(v).length > 40 ? v : null }, v == null ? 'NULL' : v))))))) : null));
}
function rowModal(engine, name, table, r, i) {
  const isNew = i < 0;
  const full = isNew ? {} : r.full[i];
  const fields = new Map();
  const form = h('div', { class: 'rowform' }, r.cols.map((c) => {
    if (c.binary) return h('div', { class: 'field' }, h('span', null, c.name), h('div', { class: 'small muted' }, 'dane binarne — bez zmian'));
    const val = isNew ? '' : (full[c.name] ?? '');
    const long = String(val).length > 60 || /text|json|blob/i.test(c.type || '');
    const inp = h(long ? 'textarea' : 'input', { class: 'input', value: c.secret ? '' : val, placeholder: c.secret ? (isNew ? '' : 'ukryte — wpisz, żeby zmienić') : isNew && c.auto ? '(nada się samo)' : '', autocomplete: 'off', spellcheck: 'false' });
    if (long) inp.value = c.secret ? '' : val;
    const nul = c.nullable || (isNew && c.auto) ? h('input', { type: 'checkbox', checked: !isNew && full[c.name] == null && !c.secret }) : null;
    if (nul) nul.onchange = () => { inp.disabled = nul.checked; };
    if (nul?.checked) inp.disabled = true;
    fields.set(c.name, { c, inp, nul, orig: c.secret ? null : (isNew ? null : full[c.name] ?? null) });
    return h('div', { class: 'field' }, h('span', null, h('b', { class: 'mono' }, c.name), h('span', { class: 'dim' }, ` ${c.type || ''}${c.pk ? ' · klucz' : ''}${c.auto ? ' · auto' : ''}`)), inp,
      nul ? h('label', { class: 'check', style: 'min-height:28px' }, nul, h('span', { class: 'small' }, 'puste (NULL)')) : null);
  }));
  const values = () => {
    const v = {};
    for (const [k, f] of fields) {
      if (f.nul?.checked) { if (isNew || f.orig !== null || f.c.secret) v[k] = { null: true }; continue; }
      if (f.c.secret && f.inp.value === '') { if (!isNew) v[k] = { keep: true }; continue; }
      if (!isNew && f.inp.value === (f.orig ?? '') && f.orig !== null) continue;
      if (!isNew && f.orig === null && f.inp.value === '') continue;
      v[k] = { v: f.inp.value };
    }
    return v;
  };
  const url = `api/bazy/${engine}/${enc(name)}/wiersz`;
  const save = btn(isNew ? 'Dodaj' : 'Zapisz', () => run(save, async () => {
    await api('POST', url, { table, action: isNew ? 'insert' : 'update', key: isNew ? null : r.keys[i], values: values() });
    m.close(); toast(isNew ? '✓ Dodano wiersz' : '✓ Zapisano — cofniesz to w Dzienniku zmian', 'ok'); reload();
  }), { kind: 'pri' });
  const del = isNew ? null : btn('Usuń wiersz', () => run(del, async () => {
    if (!(await ask({ title: 'Usunąć ten wiersz?', text: 'Da się to cofnąć w Dzienniku zmian.', ok: 'Usuń', danger: true }))) return;
    await api('POST', url, { table, action: 'delete', key: r.keys[i] });
    m.close(); toast('✓ Usunięto wiersz', 'ok'); reload();
  }), { kind: 'danger', small: true, icon: 'usun' });
  const m = modal(isNew ? `Nowy wiersz · ${table}` : `Wiersz · ${table}`, form, h('div', { class: 'acts', style: 'justify-content:space-between;flex-wrap:wrap' }, h('div', null, del), h('div', { class: 'acts' }, btn('Anuluj', () => m.close()), save)));
}
function docModal(engine, name, coll, r, i) {
  const isNew = !r;
  const ta = h('textarea', { class: 'sql-ta', style: 'min-height:260px', spellcheck: 'false' });
  ta.value = isNew ? '{\n  \n}' : (() => { try { return JSON.stringify(JSON.parse(r.docs[i]), null, 2); } catch { return r.docs[i]; } })();
  const url = `api/bazy/${engine}/${enc(name)}/wiersz`;
  const save = btn(isNew ? 'Dodaj' : 'Zapisz', () => run(save, async () => {
    await api('POST', url, { table: coll, action: isNew ? 'insert' : 'update', key: isNew ? null : r.keys[i], values: { doc: ta.value } });
    m.close(); toast('✓ Zapisano', 'ok'); reload();
  }), { kind: 'pri' });
  const del = isNew ? null : btn('Usuń dokument', () => run(del, async () => {
    if (!(await ask({ title: 'Usunąć ten dokument?', text: 'Da się to cofnąć w Dzienniku zmian.', ok: 'Usuń', danger: true }))) return;
    await api('POST', url, { table: coll, action: 'delete', key: r.keys[i] }); m.close(); reload();
  }), { kind: 'danger', small: true, icon: 'usun' });
  const m = modal(isNew ? `Nowy dokument · ${coll}` : `Dokument · ${coll}`, h('p', { class: 'small muted' }, 'Dokument w JSON. Ukryte pola (hasła, tokeny) zostają bez zmian.'), ta,
    h('div', { class: 'acts', style: 'justify-content:space-between;flex-wrap:wrap' }, h('div', null, del), h('div', { class: 'acts' }, btn('Anuluj', () => m.close()), save)));
}

function accessTab(box, d, engine, name) {
  const x = d.db;
  const users = new Map(d.users.map((u) => [u.user, u]));
  const give = btn('Nadaj dostęp', () => grantModal(d, engine, name), { small: true, kind: 'pri', icon: 'plus' });
  put(box, h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Kto ma dostęp'), h('div', { class: 'small muted', style: 'margin-top:4px' }, engine === 'redis' ? 'W Redisie każde konto widzi tylko klucze ze swoim przedrostkiem.' : 'Konta, którymi aplikacje (albo Ty) łączą się z tą bazą.')), isAdmin() && engine !== 'redis' ? give : null),
    x.access.length ? h('div', { class: 'rows' }, x.access.map((a) => {
      const u = users.get(a.user);
      const take = !a.all && isAdmin() && u ? btn('Zabierz', () => run(take, async () => {
        if (!(await ask({ title: `Zabrać ${a.user} dostęp do ${name}?`, text: 'Aplikacja używająca tego konta straci dostęp do bazy. Da się to cofnąć w Dzienniku zmian.', ok: 'Zabierz', danger: true }))) return;
        await api('POST', `api/bazy/konto/${engine}/${enc(a.user)}/prawa`, { dbs: u.dbs.filter((y) => y.db !== name && y.rights !== 'inne').map((y) => ({ db: y.db, rights: y.rights })) });
        toast('✓ Zabrano dostęp', 'ok'); reload();
      }), { small: true, kind: 'ghost' }) : null;
      return h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('div', { class: 'stack grow', style: 'flex-basis:220px' }, h('span', { class: 't mono' }, a.user), h('span', { class: 's' }, `${a.all ? 'wszystkie bazy' : 'prawa: ' + RIGHTS[a.rights]} · ${a.label}`)),
        a.locked ? h('span', { class: 'pill off' }, 'zablokowane') : scopeChip(a.scope),
        linkBtn('Konto', '#/bazy/konta', { small: true }), take);
    })) : h('div', { class: 'list-empty' }, 'Żadne konto nie ma dostępu do tej bazy.')));
}
function grantModal(d, engine, name) {
  const others = d.users.filter((u) => !u.global && !u.dbs.some((x) => x.db === name));
  let mode = others.length ? 'istniejace' : 'nowe';
  const st = { access: 'serwer', ip: '' };
  const body = h('div', { class: 'stack', style: 'gap:12px' });
  const who = h('select', { class: 'input' }, others.map((u) => h('option', { value: u.user }, u.user)));
  const rights = h('select', { class: 'input' }, h('option', { value: 'pelne' }, 'pełne (czytanie i zapis)'), h('option', { value: 'odczyt' }, 'tylko odczyt'));
  const nname = h('input', { class: 'input mono', value: `${name}_${engine === 'mongo' ? 'app' : 'odczyt'}`.slice(0, 32), autocapitalize: 'off', spellcheck: 'false' });
  const draw = () => body.replaceChildren(
    radios('grant', [['istniejace', 'Istniejące konto', `${others.length} do wyboru`, !others.length], ['nowe', 'Nowe konto', 'dostanie hasło do skopiowania']], mode, (v) => { mode = v; draw(); }),
    mode === 'istniejace' ? h('label', { class: 'field' }, h('span', null, 'Konto'), who) : h('label', { class: 'field' }, h('span', null, 'Nazwa nowego konta'), nname),
    h('label', { class: 'field' }, h('span', null, 'Prawa'), rights),
    mode === 'nowe' ? [h('h3', null, 'Skąd może się łączyć'), accessPicker(st, engine, d.homeIp, draw)] : null);
  draw();
  const ok = btn('Nadaj', () => run(ok, async () => {
    if (mode === 'nowe') {
      const r = await api('POST', 'api/bazy/konto', { engine, user: nname.value.trim(), access: st.access, ip: st.ip, dbs: [{ db: name, rights: rights.value }] });
      m.close(); showSecret(`Konto ${r.user} gotowe`, r);
    } else {
      const u = others.find((x) => x.user === who.value);
      await api('POST', `api/bazy/konto/${engine}/${enc(u.user)}/prawa`, { dbs: [...u.dbs.filter((y) => y.rights !== 'inne').map((y) => ({ db: y.db, rights: y.rights })), { db: name, rights: rights.value }] });
      m.close(); toast('✓ Nadano dostęp', 'ok');
    }
    reload();
  }), { kind: 'pri' });
  const m = modal(`Dostęp do ${name}`, body, h('div', { class: 'acts' }, btn('Anuluj', () => m.close()), ok));
}

function backupsTab(box, d, engine, name) {
  const fileIn = h('input', { type: 'file', accept: engine === 'mongo' ? '.archive,.gz' : '.sql,.gz', hidden: true });
  const up = btn('Wgraj plik', () => fileIn.click(), { icon: 'wgraj' });
  fileIn.onchange = () => run(up, async () => {
    const f = fileIn.files[0]; fileIn.value = '';
    if (!f) return;
    if (!(await ask({ title: `Wgrać ${f.name} do ${name}?`, text: `Zawartość pliku trafi do bazy ${name}${engine === 'mariadb' ? ' (tabele z pliku zastąpią te o tych samych nazwach)' : ''}. Przed tym panel zrobi kopię obecnego stanu.`, ok: 'Wgraj' }))) return;
    toast(`Wysyłam ${f.name} (${bytes(f.size)})…`);
    const r = await upload(`api/bazy/${engine}/${enc(name)}/wgraj?n=${enc(f.name)}`, f);
    watchJob(r.job, () => reload());
  });
  const kopia = btn('Kopia teraz', () => run(kopia, async () => { const r = await api('POST', `api/bazy/${engine}/${enc(name)}/kopia`, {}); watchJob(r.job, () => reload()); }), { kind: 'pri', icon: 'kopie' });
  const restore = (b, f) => run(b, async () => {
    const t = await ask({ title: `Przywrócić ${name} z kopii?`, text: `Baza wróci do stanu z ${when(f.time)} (${blabel(f.label)}). Zmiany zrobione później znikną — ale przed przywróceniem panel zapisze obecny stan.`, ok: 'Przywróć', danger: true, typed: name });
    if (!t) return;
    const r = await api('POST', `api/bazy/${engine}/${enc(name)}/przywroc`, { file: f.path, confirm: t });
    watchJob(r.job, () => reload());
  });
  put(box, h('section', { class: 'card' },
    h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Kopie tej bazy'), h('div', { class: 'small muted', style: 'margin-top:4px' }, engine === 'redis' ? 'Redis zapisuje kopię sam. „Pobierz” u góry daje plik dump.rdb.' : 'Nocne kopie, ręczne i te sprzed każdej zmiany z panelu.')),
      isAdmin() && engine !== 'redis' ? h('div', { class: 'acts' }, d.db.app ? null : up, kopia, fileIn) : null),
    d.backups.length ? h('div', { class: 'rows' }, d.backups.map((f) => {
      const rb = isAdmin() && !d.db.app && !/wszystkie/.test(f.name) ? btn('Przywróć', () => restore(rb, f), { small: true, icon: 'przywroc' }) : null;
      return h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('div', { class: 'stack grow', style: 'flex-basis:200px' }, h('span', { class: 't' }, when(f.time)), h('span', { class: 's' }, blabel(f.label))),
        h('span', { class: 'small muted nowrap' }, bytes(f.size)),
        linkBtn('Pobierz', `api/kopie/pobierz?p=${enc(f.path)}`, { small: true, icon: 'pobierz' }), rb);
    })) : h('div', { class: 'list-empty' }, engine === 'redis' ? '' : 'Jeszcze nie ma kopii — pierwsza powstanie w nocy albo po kliknięciu „Kopia teraz”.')));
}

function settingsTab(box, d, engine, name) {
  if (!isAdmin()) return put(box, h('div', { class: 'list-empty' }, 'Tylko administrator zmienia ustawienia bazy.'));
  const cloneName = h('input', { class: 'input mono', value: `${name}_kopia`.slice(0, 32), autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Nazwa kopii' });
  const clone = btn('Skopiuj', () => run(clone, async () => { const r = await api('POST', `api/bazy/${engine}/${enc(name)}/klonuj`, { to: cloneName.value.trim() }); watchJob(r.job, () => reload()); }), { icon: 'kopiuj' });
  const withUsers = h('input', { type: 'checkbox', checked: true });
  const del = btn('Usuń bazę', () => run(del, async () => {
    const t = await ask({ title: `Usunąć bazę ${name}?`, text: `Baza zniknie${withUsers.checked ? ' razem z kontami, które miały dostęp tylko do niej' : ''}. Przed usunięciem panel zapisze jej kopię w koszu kopii (Kopie zapasowe → Kosz).`, ok: 'Usuń bazę', danger: true, typed: name });
    if (!t) return;
    const r = await api('POST', `api/bazy/${engine}/${enc(name)}/usun`, { confirm: t, withUsers: withUsers.checked });
    watchJob(r.job, (j) => { if (j.ok) location.hash = '#/bazy'; });
  }), { kind: 'danger', icon: 'usun' });
  put(box,
    ['mariadb', 'postgres', 'sqlite', 'mongo'].includes(engine) && !d.db.app ? h('section', { class: 'card stack', style: 'gap:12px' }, h('h2', null, 'Skopiuj bazę'),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Nowa baza z tymi samymi danymi — np. do testów. Konta nie są kopiowane.'),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, h('div', { style: 'flex:1 1 220px' }, cloneName), clone)) : null,
    d.db.app ? h('div', { class: 'alert info' }, h('span', { class: 'tag' }, 'INFO'), h('span', { class: 'txt' }, 'To baza działającej aplikacji — panel jej nie zmienia ani nie usuwa.')) :
      d.db.system ? h('div', { class: 'alert info' }, h('span', { class: 'tag' }, 'INFO'), h('span', { class: 'txt' }, 'Baza systemowa — nie da się jej usunąć.')) :
        h('section', { class: 'card stack', style: 'gap:12px;border-color:var(--bad-line)' }, h('h2', null, 'Usuń bazę'),
          d.db.usedBy?.length ? h('p', { class: 'small', style: 'margin:0;color:var(--warn-ink)' }, `Uwaga: tej bazy używa ${d.db.usedBy.map((u) => u.label).join(', ')}.`) : null,
          engine !== 'sqlite' ? h('label', { class: 'check' }, withUsers, h('span', null, 'Usuń też konta, które miały dostęp tylko do tej bazy')) : null,
          h('div', null, del)));
}

/* ------------------------------------------------------- nowa baza */

const nb = { step: 1, engine: null, name: '', access: 'serwer', ip: '', result: null };
async function newDbPage(box) {
  const d = await api('GET', 'api/bazy');
  const holder = h('div', { class: 'stack', style: 'gap:22px' });
  const STEPS = ['Rodzaj', 'Nazwa i dostęp', 'Dane do połączenia'];
  const render = () => {
    const stepper = h('ol', { class: 'wz-steps', 'aria-label': 'Kroki' }, STEPS.map((label, i) => {
      const n = i + 1, on = nb.step === n, done = nb.step > n;
      return h('li', { class: `wz-step ${on ? 'on' : done ? 'done' : ''}` }, h('span', { 'aria-current': on ? 'step' : null }, h('span', { class: 'wz-num' }, done ? '✓' : String(n)), label));
    }));
    let body;
    if (nb.step === 1) {
      body = h('section', { class: 'stack', style: 'gap:14px' }, h('h2', { style: 'font-size:19px' }, 'Jaka baza?'),
        h('div', { class: 'wz-kinds' }, d.engines.map((e) => {
          const ok = e.installed && e.ready && e.active;
          return h('button', { type: 'button', class: `wz-kind ${nb.engine === e.id ? 'on' : ''}`, 'aria-pressed': nb.engine === e.id ? 'true' : 'false', onclick: () => { if (!ok) { location.hash = '#/bazy/silniki'; return; } nb.engine = e.id; if (['redis', 'sqlite'].includes(e.id)) nb.access = 'serwer'; render(); } },
            h('span', { class: `wz-ico eng-ico ${ENG[e.id][1]}` }, ENG[e.id][0].slice(0, 2)),
            h('span', { class: 'stack', style: 'gap:4px;text-align:left' }, h('b', { style: 'font-size:16px' }, e.name, ' ', ok ? h('span', { class: 'pill ok' }, 'gotowe') : h('span', { class: 'pill off' }, e.installed ? 'wyłączony' : 'zainstaluj')),
              h('span', { class: 'small muted', style: 'line-height:1.4' }, e.desc + (!e.installed && e.ram ? ` Zajmie ${e.ram} pamięci.` : ''))));
        })),
        h('div', { class: 'acts', style: 'justify-content:flex-end' }, linkBtn('Anuluj', '#/bazy'), btn('Dalej', () => { nb.step = 2; render(); }, { kind: 'pri', disabled: !nb.engine })));
    } else if (nb.step === 2) {
      const inp = h('input', { class: 'input mono', value: nb.name, placeholder: 'np. sklep', autocapitalize: 'off', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Nazwa bazy', style: 'font-size:17px;min-height:52px' });
      const hint = h('div', { class: 'small muted' }, 'Małe litery, cyfry i podkreślnik. Tak samo nazwie się konto do tej bazy.');
      inp.oninput = () => { nb.name = inp.value.trim(); };
      const accBox = h('div');
      const drawAcc = () => accBox.replaceChildren(accessPicker(nb, nb.engine, d.homeIp, drawAcc));
      drawAcc();
      const create = btn('Utwórz bazę', () => run(create, async () => {
        nb.result = await api('POST', 'api/bazy/nowa', { engine: nb.engine, name: nb.name, access: nb.access, ip: nb.ip });
        nb.step = 3; render();
      }), { kind: 'pri' });
      body = h('section', { class: 'stack', style: 'gap:14px' }, h('h2', { style: 'font-size:19px' }, `Nowa baza ${ENG[nb.engine][0]}`),
        h('div', { class: 'card stack', style: 'gap:10px' }, h('b', null, 'Nazwa'), inp, hint),
        nb.engine === 'sqlite' ? null : h('div', { class: 'card stack', style: 'gap:10px' }, h('b', null, 'Skąd można się łączyć'), accBox),
        h('div', { class: 'acts', style: 'justify-content:flex-end' }, btn('Wstecz', () => { nb.step = 1; render(); }), create));
      setTimeout(() => inp.isConnected && inp.focus(), 50);
    } else {
      const r = nb.result;
      body = h('section', { class: 'stack', style: 'gap:14px' }, h('h2', { style: 'font-size:19px' }, `✓ Baza ${r.name} gotowa`),
        h('div', { class: 'card stack', style: 'gap:12px' },
          r.password ? h('p', { class: 'small', style: 'margin:0;color:var(--warn-ink)' }, 'Zapisz hasło teraz — panel nie pokaże go drugi raz.') : null,
          r.user ? h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'small muted' }, 'Login'), h('div', { class: 'secret-box' }, r.user)) : null,
          r.password ? h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'small muted' }, 'Hasło'), h('div', { class: 'secret-box' }, r.password), h('div', null, btn('Kopiuj hasło', () => copy(r.password, 'Skopiowano hasło'), { small: true, icon: 'kopiuj' }))) : null,
          r.env ? h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'small muted' }, 'Do pliku .env aplikacji'), h('div', { class: 'secret-box' }, r.env.trim()), h('div', null, btn('Kopiuj .env', () => copy(r.env, 'Skopiowano .env'), { small: true, icon: 'kopiuj' }))) : null,
          r.remote ? h('p', { class: 'small muted', style: 'margin:0' }, r.remote) : null,
          r.note ? h('p', { class: 'small muted', style: 'margin:0' }, r.note) : null),
        h('div', { class: 'acts', style: 'justify-content:flex-end' }, btn('Utwórz kolejną', () => { Object.assign(nb, { step: 1, engine: null, name: '', access: 'serwer', ip: '', result: null }); render(); }), linkBtn('Otwórz bazę', dbHref(r.engine, r.name), { kind: 'pri' })));
    }
    holder.replaceChildren(stepper, body);
  };
  if (nb.step === 3) Object.assign(nb, { step: 1, engine: null, name: '', access: 'serwer', ip: '', result: null });
  render();
  put(box, backLink('#/bazy', 'Bazy danych'), h('div', { class: 'head' }, h('div', null, h('h1', null, 'Nowa baza'), h('div', { class: 'sub' }, 'Baza, konto z hasłem i dane do wklejenia w aplikacji — w trzech krokach.'))), holder);
}
