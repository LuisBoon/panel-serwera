// Karta strony: zakładki Aplikacja / Zmienne / Logi (aplikacje Node) i Ustawienia (PHP, adresy, przekierowania, Apache).
const { h, put, api, btn, linkBtn, busy, toast, ask, watchJob, when, bytes, plural, reload, every, isAdmin, pad, state } = window.P;
const enc = encodeURIComponent;
const run = (b, fn) => busy(b, async () => { try { await fn(); } catch (e) { toast(e.message, 'bad'); } });
async function upload(url, file) {
  const r = await fetch(window.P.apiPath(url), { method: 'POST', credentials: 'same-origin', headers: { 'X-Panel': '1', 'Content-Type': 'application/octet-stream' }, body: file });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j?.error || `Błąd ${r.status}`);
  return j;
}
const kv = (rows) => h('div', { class: 'rows' }, rows.filter(Boolean).map(([k, v]) => h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('span', { class: 'grow muted' }, k), h('span', { class: typeof v === 'string' && v.startsWith('/') ? 'mono' : '' }, v))));

/* ------------------------------------------------------------ Aplikacja */

async function tabApp(box, name, d) {
  const a = await api('GET', `api/strona/${enc(name)}/aplikacja`);
  a.jobs?.filter((j) => !j.end).forEach((j) => watchJob(j));
  const base = `api/strona/${enc(name)}/aplikacja`;
  const restart = btn('Uruchom ponownie', () => run(restart, async () => { if (!(await ask({ title: `Uruchomić ponownie ${a.unit}?`, text: 'Aplikacja zniknie na kilka sekund.', ok: 'Uruchom ponownie' }))) return; await api('POST', `${base}/restart`, {}); toast('✓ Uruchomiono ponownie', 'ok'); setTimeout(reload, 1500); }), { icon: 'restart' });
  const zipIn = h('input', { type: 'file', accept: '.zip', hidden: true });
  const zipB = btn('Aktualizuj z ZIP-a', () => zipIn.click(), { icon: 'wgraj' });
  zipIn.onchange = () => run(zipB, async () => {
    const f = zipIn.files[0]; zipIn.value = '';
    if (!f) return;
    if (!(await ask({ title: `Wgrać ${f.name}?`, text: `Pliki z ZIP-a zastąpią kod w ${a.dir} (bez node_modules, danych i .env). Najpierw zapiszę obecną wersję — jeśli aplikacja nie wstanie, wrócę do niej sam.`, ok: 'Wgraj i uruchom' }))) return;
    toast(`Wysyłam ${f.name} (${bytes(f.size)})…`);
    const r = await upload(`${base}/zip`, f); watchJob(r.job, () => reload());
  });
  const gitB = a.git ? btn('Aktualizuj z GitHuba', () => run(gitB, async () => { if (!(await ask({ title: 'Pobrać zmiany z GitHuba?', text: 'git pull + instalacja zależności + restart. Jeśli aplikacja nie wstanie, wrócę do obecnej wersji.', ok: 'Aktualizuj' }))) return; const r = await api('POST', `${base}/git`, {}); watchJob(r.job, () => reload()); }), { icon: 'aktualizacje' }) : null;
  const back = a.versions.length ? btn('Wróć do poprzedniej wersji', () => run(back, async () => { if (!(await ask({ title: 'Wrócić do poprzedniej wersji?', text: `Kod z ${when(a.versions[0].time)} (${a.versions[0].label}). Obecny stan też zapiszę.`, ok: 'Wróć', danger: true }))) return; const r = await api('POST', `${base}/wroc`, {}); watchJob(r.job, () => reload()); }), { icon: 'przywroc' }) : null;
  const lg = await api('GET', `${base}/logi`).catch(() => ({ lines: [] }));
  put(box,
    h('section', { class: 'gauges' },
      window.P.h('div', { class: 'gauge' }, h('span', { class: 'l' }, 'Stan'), h('span', { class: 'v' }, a.active ? 'Działa' : a.state === 'failed' ? 'Padła' : 'Zatrzymana'), h('span', { class: 'small muted' }, a.since ? 'od ' + when(a.since) : '')),
      h('div', { class: 'gauge' }, h('span', { class: 'l' }, 'Pamięć'), h('span', { class: 'v' }, a.mem ? bytes(a.mem) : '—'), h('span', { class: 'small muted' }, a.restarts ? `${a.restarts} ${plural(a.restarts, 'restart', 'restarty', 'restartów')}` : 'bez restartów')),
      h('div', { class: 'gauge' }, h('span', { class: 'l' }, 'Wersja'), h('span', { class: 'v' }, a.version || '—'), h('span', { class: 'small muted' }, `Node ${a.node}`)),
      h('div', { class: 'gauge' }, h('span', { class: 'l' }, 'Port'), h('span', { class: 'v' }, a.port || '—'), h('span', { class: 'small muted' }, `usługa ${a.unit}`))),
    h('div', { class: 'acts', style: 'flex-wrap:wrap' }, restart, zipB, zipIn, gitB, back),
    h('div', { class: 'cols' },
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Szczegóły')),
        kv([['Katalog aplikacji', a.dir], a.wd !== a.dir ? ['Uruchamiana w', a.wd] : null, ['Polecenie', a.exec], ['Działa jako', a.user], a.envFiles.length ? ['Plik ze zmiennymi', a.envFiles.join(', ')] : null, ['Repozytorium git', a.git ? 'tak' : 'nie']])),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Zapisane wersje'), h('span', { class: 'small muted' }, 'ostatnie 10')),
        a.versions.length ? h('div', { class: 'rows' }, a.versions.map((v) => { const rb = btn('Przywróć', () => run(rb, async () => { if (!(await ask({ title: 'Przywrócić tę wersję?', text: `Kod z ${when(v.time)} (${v.label}). Obecny stan też zapiszę.`, ok: 'Przywróć', danger: true }))) return; const r = await api('POST', `${base}/wroc`, { id: v.id }); watchJob(r.job, () => reload()); }), { small: true }); return h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { class: 'stack grow' }, h('span', { class: 't' }, when(v.time)), h('span', { class: 's' }, v.label)), h('span', { class: 'small muted' }, bytes(v.size)), rb); }))
          : h('div', { class: 'list-empty' }, 'Wersja zapisze się sama przed pierwszą aktualizacją z panelu.'))),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Ostatnie wpisy w logu'), linkBtn('Cały log', `#/strona/${enc(name)}/logi`, { small: true })),
      logBox(lg.lines.slice(-25))));
}
function logBox(lines) {
  return h('div', { class: 'logbox app-log' }, lines.length ? lines.map((l) => { const t = new Date(l.ts); return h('div', { class: l.err || /error|fatal|exception/i.test(l.msg) ? 'err' : '' }, h('span', { class: 'dim' }, `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())} `), l.msg); }) : h('span', { class: 'dim' }, 'Brak wpisów.'));
}

/* ------------------------------------------------------------- Zmienne */

async function tabEnv(box, name) {
  const a = await api('GET', `api/strona/${enc(name)}/aplikacja`);
  const rows = a.env.map((e) => ({ ...e, orig: e.value, del: false }));
  const list = h('div', { class: 'rows' });
  const draw = () => list.replaceChildren(...rows.map((r) => {
    if (r.del) return h('div', { class: 'row', style: 'opacity:.55' }, h('span', { class: 'mono grow', style: 'text-decoration:line-through' }, r.key), btn('Przywróć', () => { r.del = false; draw(); }, { small: true, kind: 'ghost' }));
    const key = r.isNew ? h('input', { class: 'input mono', value: r.key, placeholder: 'NAZWA', style: 'max-width:240px', autocapitalize: 'characters', spellcheck: 'false' }) : h('b', { class: 'mono', style: 'min-width:180px;overflow-wrap:anywhere' }, r.key);
    if (r.isNew) key.oninput = () => { r.key = key.value.trim(); };
    const val = h('input', { class: 'input mono', value: r.value ?? '', placeholder: r.secret && r.value == null ? '•••••• ukryte — wpisz, żeby zmienić' : '', spellcheck: 'false', autocomplete: 'off' });
    val.oninput = () => { r.value = val.value; r.changed = true; };
    const show = r.secret && r.value == null ? btn('Pokaż', () => run(show, async () => { const x = await api('GET', `api/strona/${enc(name)}/aplikacja/zmienna?k=${enc(r.key)}`); r.value = x.value; r.orig = x.value; draw(); }), { small: true, kind: 'ghost' }) : null;
    return h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' }, key, h('div', { style: 'flex:1 1 260px;min-width:0' }, val), show, btn('', () => { if (r.isNew) rows.splice(rows.indexOf(r), 1); else r.del = true; draw(); }, { small: true, icon: 'usun', kind: 'ghost', title: 'Usuń zmienną' }));
  }));
  draw();
  const add = btn('Dodaj zmienną', () => { rows.push({ key: '', value: '', isNew: true, changed: true }); draw(); list.querySelector('input:last-of-type')?.focus(); }, { small: true, icon: 'plus' });
  const save = btn('Zapisz i uruchom ponownie', () => run(save, async () => {
    const changes = rows.filter((r) => r.del || r.isNew || (r.changed && r.value !== r.orig)).map((r) => (r.del ? { key: r.key, value: null } : { key: r.key, value: r.value ?? '' }));
    if (!changes.length) return toast('Nic się nie zmieniło.');
    if (!(await ask({ title: 'Zapisać zmienne?', text: `Zmieniasz: ${changes.map((c) => c.key || '(bez nazwy)').join(', ')}.\nAplikacja uruchomi się ponownie. Jeśli nie wstanie w 30 sekund, panel sam przywróci poprzednie wartości.`, ok: 'Zapisz' }))) return;
    const r = await api('POST', `api/strona/${enc(name)}/aplikacja/zmienne`, { changes });
    watchJob(r.job, () => reload());
  }), { kind: 'pri' });
  put(box, h('section', { class: 'card stack', style: 'gap:12px' },
    h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Zmienne aplikacji'), h('div', { class: 'small muted', style: 'margin-top:4px' }, `Ustawienia, z którymi startuje usługa ${a.unit}. Wartości z hasłami i kluczami są ukryte.`))),
    list, h('div', { class: 'acts', style: 'justify-content:space-between;flex-wrap:wrap' }, add, save),
    a.envFiles.length ? h('p', { class: 'small muted', style: 'margin:0' }, `Aplikacja czyta też zmienne z pliku ${a.envFiles.join(', ')} — ten plik zmienisz w terminalu albo w Plikach.`) : null));
}

/* ---------------------------------------------------------------- Logi */

async function tabLogs(box, name) {
  let cursor = '', paused = false, onlyErr = false;
  const lines = [];
  const boxEl = h('div', { class: 'logbox app-log', style: 'max-height:70vh' });
  const draw = () => { const atEnd = boxEl.scrollTop + boxEl.clientHeight >= boxEl.scrollHeight - 30; boxEl.replaceChildren(...logBox(lines.filter((l) => !onlyErr || l.err || /error|fatal|exception/i.test(l.msg)).slice(-500)).childNodes); if (atEnd) boxEl.scrollTop = boxEl.scrollHeight; };
  const pull = async () => {
    if (paused) return;
    try { const r = await api('GET', `api/strona/${enc(name)}/aplikacja/logi${cursor ? '?kursor=' + enc(cursor) : ''}`); if (r.lines.length) { lines.push(...r.lines); if (lines.length > 2000) lines.splice(0, lines.length - 2000); draw(); } cursor = r.cursor || cursor; } catch {}
  };
  const pauseB = btn('Wstrzymaj', () => { paused = !paused; pauseB.textContent = paused ? 'Wznów' : 'Wstrzymaj'; }, { small: true });
  const err = h('input', { type: 'checkbox' }); err.onchange = () => { onlyErr = err.checked; draw(); };
  put(box, h('section', { class: 'card stack', style: 'gap:10px' },
    h('div', { class: 'row', style: 'padding:0;flex-wrap:wrap' }, h('h2', { class: 'grow' }, 'Log na żywo'), h('label', { class: 'check', style: 'min-height:32px' }, err, h('span', { class: 'small' }, 'tylko błędy')), pauseB),
    boxEl));
  await pull();
  boxEl.scrollTop = boxEl.scrollHeight;
  every(3000, pull);
}

/* ----------------------------------------------------------- Ustawienia */

async function tabSettings(box, name, d) {
  const s = await api('GET', `api/strona/${enc(name)}/ustawienia`);
  s.jobs?.filter((j) => !j.end).forEach((j) => watchJob(j, () => reload()));
  const st = { phpVersion: s.phpVersion || s.phpDefault || '', upload: s.upload || '', memory: s.memory || '', time: s.time || '', redirects: s.redirects.map((r) => ({ ...r })) };
  const sizes = (cur, list) => { const sel = h('select', { class: 'input' }, h('option', { value: '' }, 'domyślnie'), list.map((x) => h('option', { value: x }, x.replace('M', ' MB')))); sel.value = cur; return sel; };
  const parts = [];
  if (s.php) {
    const ver = h('select', { class: 'input' }, s.versions.map((v) => h('option', { value: v.v }, `PHP ${v.v}${v.v === s.phpDefault ? ' (domyślna)' : v.fpm ? '' : ' — trzeba zainstalować'}`)));
    ver.value = st.phpVersion;
    const instBox = h('div');
    const drawInst = () => {
      const v = s.versions.find((x) => x.v === ver.value);
      instBox.replaceChildren(...(v && v.v !== s.phpDefault && !v.fpm ? [(() => { const b = btn(`Zainstaluj PHP ${v.v}`, () => run(b, async () => { if (!(await ask({ title: `Zainstalować PHP ${v.v}?`, text: 'Doinstaluję PHP z modułami do baz, obrazków i ZIP-ów (ok. 1 minuty). Strony korzystające z innej wersji nie zmienią się.', ok: 'Zainstaluj' }))) return; const r = await api('POST', `api/php/${v.v}/zainstaluj`, {}); watchJob(r.job, () => reload()); }), { small: true, kind: 'pri' }); return b; })()] : []));
      st.phpVersion = ver.value;
    };
    ver.onchange = drawInst; drawInst();
    const up = sizes(st.upload, ['8M', '32M', '64M', '128M', '256M', '512M', '1024M']); up.onchange = () => { st.upload = up.value; };
    const mem = sizes(st.memory, ['128M', '256M', '512M', '1024M']); mem.onchange = () => { st.memory = mem.value; };
    const tm = h('input', { class: 'input', type: 'number', min: 10, max: 3600, value: st.time, placeholder: 'domyślnie (30)' }); tm.oninput = () => { st.time = tm.value; };
    parts.push(h('section', { class: 'card stack', style: 'gap:12px' }, h('h2', null, 'PHP'),
      h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Wersja PHP'), ver), h('label', { class: 'field' }, h('span', null, 'Największy wgrywany plik'), up), h('label', { class: 'field' }, h('span', null, 'Pamięć dla skryptu'), mem), h('label', { class: 'field' }, h('span', null, 'Najdłuższy czas skryptu (s)'), tm)),
      instBox,
      h('p', { class: 'small muted', style: 'margin:0' }, 'Inna wersja niż domyślna działa w osobnym procesie PHP tylko dla tej strony.')));
  }
  // przekierowania
  const redList = h('div', { class: 'stack', style: 'gap:8px' });
  const drawRed = () => redList.replaceChildren(...st.redirects.map((r, i) => {
    const from = h('input', { class: 'input mono', value: r.from, placeholder: '/stara-strona', spellcheck: 'false' }); from.oninput = () => { r.from = from.value.trim(); };
    const to = h('input', { class: 'input mono', value: r.to, placeholder: '/nowa-strona albo https://…', spellcheck: 'false' }); to.oninput = () => { r.to = to.value.trim(); };
    const code = h('select', { class: 'input', style: 'width:auto' }, h('option', { value: '301' }, 'stałe (301)'), h('option', { value: '302' }, 'tymczasowe (302)')); code.value = String(r.code || 301); code.onchange = () => { r.code = Number(code.value); };
    return h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, h('div', { style: 'flex:1 1 180px' }, from), h('span', { class: 'muted' }, '→'), h('div', { style: 'flex:2 1 220px' }, to), code, btn('', () => { st.redirects.splice(i, 1); drawRed(); }, { small: true, icon: 'usun', kind: 'ghost', title: 'Usuń' }));
  }));
  drawRed();
  parts.push(h('section', { class: 'card stack', style: 'gap:12px' }, h('h2', null, 'Przekierowania'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Gdy ktoś wejdzie na stary adres na tej stronie, przeglądarka trafi pod nowy.'),
    redList, h('div', null, btn('Dodaj przekierowanie', () => { st.redirects.push({ from: '', to: '', code: 301 }); drawRed(); }, { small: true, icon: 'plus' }))));
  const save = btn('Zapisz ustawienia', () => run(save, async () => {
    await api('POST', `api/strona/${enc(name)}/ustawienia`, { phpVersion: st.phpVersion, upload: st.upload, memory: st.memory, time: st.time, redirects: st.redirects.filter((r) => r.from || r.to) });
    toast('✓ Zapisano — strona działa (cofniesz to w Dzienniku zmian)', 'ok'); reload();
  }), { kind: 'pri' });
  parts.push(h('div', { class: 'acts', style: 'justify-content:flex-end' }, save));
  // dodatkowe adresy
  const alias = h('input', { class: 'input', placeholder: `np. www.${name}`, autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Dodatkowy adres' });
  const addA = btn('Dodaj adres', () => run(addA, async () => {
    const host = alias.value.trim().toLowerCase();
    if (!host) return;
    const r = await api('POST', 'api/utworz', { szablon: 'przekierowanie', adres: host, cel: `https://${name}/` });
    watchJob(r.job, () => reload()); alias.value = '';
  }), { small: true, icon: 'plus' });
  parts.push(h('section', { class: 'card stack', style: 'gap:12px' }, h('h2', null, 'Dodatkowe adresy'),
    h('p', { class: 'small muted', style: 'margin:0' }, `Inne adresy, które prowadzą na ${name} (np. z www albo stara domena). Adres musi wskazywać na serwer (rekord A w OVH) — certyfikat pobiorę sam.`),
    s.aliases.length ? h('div', { class: 'rows' }, s.aliases.map((a) => h('div', { class: 'row' }, h('span', { class: 'grow mono' }, a.host), h('span', { class: `pill ${a.ssl === 'gotowe' ? 'ok' : 'warn'}` }, a.ssl === 'gotowe' ? 'https działa' : 'czeka na DNS'), linkBtn('Zarządzaj', '#/utworz', { small: true })))) : null,
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, h('div', { style: 'flex:1 1 220px' }, alias), addA)));
  // edytor Apache
  const fsel = h('select', { class: 'input', style: 'width:auto' }, s.vhostFiles.map((f) => h('option', { value: f }, f)));
  const ta = h('textarea', { class: 'sql-ta', style: 'min-height:300px', spellcheck: 'false', 'aria-label': 'Konfiguracja Apache' });
  let mtime = null;
  const load = async () => { const r = await api('GET', `api/strona/${enc(name)}/vhost?f=${enc(fsel.value)}`); ta.value = r.text; mtime = r.mtime; };
  fsel.onchange = load;
  const saveV = btn('Zapisz i sprawdź', () => run(saveV, async () => {
    if (!(await ask({ title: 'Zapisać konfigurację Apache?', text: 'Panel sprawdzi ją przed włączeniem. Jeśli Apache zgłosi błąd, przywrócę poprzednią treść.', ok: 'Zapisz' }))) return;
    const r = await api('POST', `api/strona/${enc(name)}/vhost`, { file: fsel.value, text: ta.value, mtime }); mtime = r.mtime; toast('✓ Zapisano i przeładowano Apache', 'ok');
  }), { kind: 'pri', small: true });
  const edWrap = h('div', { class: 'stack', style: 'gap:10px' }, h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, fsel, h('span', { class: 'grow' }), saveV), ta);
  edWrap.hidden = true;
  const openEd = btn('Pokaż edytor', () => run(openEd, async () => { await load(); edWrap.hidden = false; openEd.hidden = true; }), { small: true, icon: 'edytuj' });
  if (s.vhostFiles.length) parts.push(h('section', { class: 'card stack', style: 'gap:12px' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Konfiguracja Apache'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Dla zaawansowanych. Błędna zmiana nie przejdzie — panel ją wycofa.')), openEd), edWrap));
  put(box, ...parts);
}

window.SITE_EXTRA = { aplikacja: tabApp, zmienne: tabEnv, logi: tabLogs, ustawienia: tabSettings };
