// Sklep z aplikacjami (wariant A · Półki): gotowe aplikacje w kontenerach Docker, z adresem, certyfikatem i kopiami.
const { h, put, api, btn, linkBtn, ico, busy, toast, ask, watchJob, when, PAGES, state, isAdmin } = window.P;
const CAT = { 'Pliki i zdjęcia': ['#1d3550', '#9cc7ff'], 'Hasła': ['#163a2f', '#8ff0d0'], 'Monitoring': ['#2f2a12', '#ffe08a'], 'Kod': ['#2a1f3d', '#d3b8ff'], 'Praca': ['#3a2216', '#ffc39b'], 'Gry': ['#1f3320', '#9fe39a'] };
const tile = (a, size = 22) => { const c = CAT[a.cat] || ['#222a35', '#c9d1dc']; return h('span', { class: 'app-i', style: `background:${c[0]};color:${c[1]}` }, ico(a.icon, size)); };
let filter = 'Wszystkie';

PAGES.sklep = async (box) => {
  const d = await api('GET', 'api/sklep');
  d.jobs.filter((j) => !j.end).forEach((j) => watchJob(j, () => window.P.reload()));
  const owner = state.role === 'wlasciciel';
  const dk = d.docker;
  const run = (b, path, okMsg) => busy(b, async () => { try { const r = await api('POST', path, {}); watchJob(r.job, () => window.P.reload()); if (okMsg) toast(okMsg, 'ok'); } catch (e) { toast(e.message, 'bad'); } });
  const dockerCard = !dk.running ? h('section', { class: 'card stack', style: 'gap:10px' },
    h('div', { style: 'display:flex;gap:10px;align-items:center' }, ico('kontener', 22), h('h2', null, dk.installed ? 'Docker nie działa' : 'Sklep potrzebuje Dockera')),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Każda aplikacja działa w osobnym kontenerze — instaluje się, aktualizuje i usuwa bez śladu w reszcie serwera. Docker zajmuje ok. 80 MB pamięci. Kontenery dostają porty tylko na 127.0.0.1: z internetu widać je wyłącznie przez Apache z https.'),
    owner ? h('div', null, (() => { const b = btn(dk.installed ? 'Uruchom Dockera' : 'Zainstaluj Dockera', () => run(b, 'api/sklep/docker'), { kind: 'pri', icon: 'pobierz' }); return b; })()) : h('p', { class: 'small', style: 'margin:0' }, 'Dockera instaluje właściciel serwera.')) : null;
  const installed = d.installed.length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Twoje aplikacje')),
    h('div', { class: 'rows' }, d.installed.map((x) => {
      const a = d.apps.find((y) => y.id === x.app) || { icon: x.icon, cat: x.kind === 'gra' ? 'Gry' : '' };
      const pill = { dziala: ['ok', 'działa'], zatrzymana: ['bad', 'zatrzymana'], restartuje: ['warn', 'restartuje się'] }[x.state] || ['info', x.state];
      const act = (label, a2, icon, kind = '') => { const b = btn(label, () => run(b, `api/sklep/${encodeURIComponent(x.id)}/${a2}`), { small: true, icon, kind }); return b; };
      const logB = btn('Logi', async () => { try { const r = await api('GET', `api/sklep/${encodeURIComponent(x.id)}/logi`); await ask({ title: `Logi: ${x.name}`, text: '', ok: 'Zamknij', extra: h('pre', { class: 'logbox app-log', style: 'max-height:55vh' }, r.text || '(pusto)') }); } catch (e) { toast(e.message, 'bad'); } }, { small: true, icon: 'logi' });
      const delB = owner ? btn('', () => busy(delB, async () => {
        if (!(await ask({ title: `Usunąć ${x.name}?`, text: x.kind === 'gra' ? 'Zatrzymam serwer gry i usunę jego świat. Jeśli chcesz go zachować, pobierz najpierw nocną kopię.' : `Zatrzymam kontenery, usunę adres ${x.host} i dane aplikacji.`, ok: 'Usuń', danger: true, typed: x.host || x.id }))) return;
        try { const r = await api('POST', `api/sklep/${encodeURIComponent(x.id)}/usun`, {}); watchJob(r.job, () => window.P.reload()); } catch (e) { toast(e.message, 'bad'); }
      }), { small: true, icon: 'usun', kind: 'ghost', title: 'Usuń aplikację' }) : null;
      return h('div', { class: 'row', style: 'flex-wrap:wrap;gap:12px' }, tile(a, 20),
        h('div', { class: 'stack grow', style: 'flex-basis:200px;gap:2px;min-width:0' }, h('span', { class: 't' }, x.name, ' ', h('span', { class: `pill ${pill[0]}` }, pill[1]), x.kind === 'wlasna' ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'własna') : null),
          x.kind === 'gra' ? h('span', { class: 's' }, 'adres w grze: ', h('b', { class: 'mono' }, x.addr || '—')) : h('a', { class: 's', href: `https://${x.host}/`, target: '_blank', rel: 'noopener noreferrer' }, x.host),
          x.notes ? h('details', null, h('summary', { class: 'small' }, x.kind === 'gra' ? 'Jak dołączyć' : 'Pierwsze logowanie'), h('div', { class: 'small fx-text', style: 'margin-top:4px' }, x.notes)) : null),
        h('div', { class: 'acts', style: 'flex-wrap:wrap' }, x.kind === 'gra' ? btn('Kopiuj adres', () => { navigator.clipboard?.writeText(x.addr || '').then(() => toast('✓ Skopiowano adres', 'ok'), () => toast(x.addr || '', 'ok')); }, { small: true, icon: 'kopiuj' }) : linkBtn('Otwórz', `https://${x.host}/`, { small: true, icon: 'ext', blank: true }), isAdmin() ? act('Aktualizuj', 'aktualizuj', 'aktualizacje') : null, isAdmin() ? act('', 'restart', 'restart') : null, logB, delB));
    }))) : null;
  const cats = ['Wszystkie', ...new Set(d.apps.map((a) => a.cat)), ...(owner ? ['Własna'] : [])];
  const chips = h('div', { class: 'store-chips' }, cats.map((c) => h('button', { type: 'button', class: `store-chip ${c === filter ? 'on' : ''}`, onclick: () => { filter = c; window.P.reload(); } }, c)));
  const card = (a) => {
    const b = btn(a.installed ? 'Zainstaluj kolejną' : 'Zainstaluj', () => (a.game ? installGame : install)(a, d, b), { small: true, icon: 'pobierz', kind: a.installed ? '' : 'pri', disabled: !dk.running || !isAdmin() || (a.game && a.fit === 'bad') });
    return h('section', { class: 'card app-card' }, h('div', { style: 'display:flex;gap:12px;align-items:flex-start' }, tile(a),
      h('div', { class: 'stack grow', style: 'gap:3px;min-width:0' }, h('b', null, a.name, a.installed ? h('span', { class: 'pill ok', style: 'margin-left:8px' }, 'zainstalowana') : null), h('span', { class: 'small', style: 'color:#c9d1dc' }, a.desc),
        h('span', { class: 'small muted' }, `${a.cat} · ok. ${a.ram >= 1024 ? (a.ram / 1024).toFixed(1).replace('.', ',').replace(',0', '') + ' GB' : a.ram + ' MB'} pamięci${a.game ? ` · port ${a.ports.map((p) => `${p[0]}${p[1] === 'udp' ? ' UDP' : ''}`).join(', ')}` : ''}`), a.fit !== 'ok' ? h('span', { class: 'small', style: `color:var(--${a.fit === 'bad' ? 'bad' : 'warn'}-ink)` }, a.fit === 'bad' ? '✗ za mało wolnej pamięci na tym serwerze' : '⚠ na styk z wolną pamięcią') : null)),
      h('div', { class: 'acts', style: 'justify-content:space-between;flex-wrap:wrap' }, h('a', { class: 'small', href: a.url, target: '_blank', rel: 'noopener noreferrer' }, 'strona projektu'), b));
  };
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Sklep z aplikacjami'), h('div', { class: 'sub' }, `Gotowe aplikacje jednym kliknięciem — własny adres z certyfikatem, kopie co noc, aktualizacja przyciskiem. Wolna pamięć: ${(d.freeMb / 1024).toFixed(1).replace('.', ',')} GB.`))),
    dockerCard, installed, chips,
    filter === 'Własna' && owner ? customCard(d) : h('div', { class: 'apps-grid' }, d.apps.filter((a) => filter === 'Wszystkie' || a.cat === filter).map(card)),
    filter === 'Gry' ? h('p', { class: 'small muted', style: 'margin:0' }, `Gry potrzebują otwartego portu — Docker otwiera go sam, a panel pokaże adres do wpisania w grze (${d.addr}). Świat trafia do nocnej kopii.`) : null);
};

async function install(a, d, b) {
  const host = h('input', { class: 'input', id: 'sklep-adres', value: d.domain ? `${a.sub}.${d.domain}` : '', placeholder: 'np. hasla.mojserwer.pl', autocapitalize: 'off', spellcheck: 'false' });
  const extra = h('div', { class: 'stack', style: 'gap:8px' }, h('label', { class: 'field' }, h('span', null, 'Adres aplikacji'), host),
    h('span', { class: 'small muted' }, 'Rekord A tego adresu musi wskazywać na serwer (z OVH połączonym z panelem doda się sam). Certyfikat https pobierze się automatycznie.'));
  if (!(await ask({ title: `Zainstalować ${a.name}?`, text: `${a.desc} Zajmie ok. ${a.ram} MB pamięci.`, ok: 'Zainstaluj', extra }))) return;
  await busy(b, async () => { try { const r = await api('POST', 'api/sklep/zainstaluj', { app: a.id, host: host.value }); watchJob(r.job, () => window.P.reload()); toast('Instaluję w tle — postęp w okienku na dole', 'ok'); } catch (e) { toast(e.message, 'bad'); } });
}

async function installGame(a, d, b) {
  const inputs = (a.fields || []).map((f) => ({ f, el: h('input', { class: 'input', id: `gra-${f.id}`, value: f.def || '', maxlength: f.max || 60, type: /haslo/.test(f.id) ? 'password' : 'text', autocomplete: 'off' }) }));
  const extra = h('div', { class: 'stack', style: 'gap:10px' }, inputs.map(({ f, el }) => h('label', { class: 'field' }, h('span', null, f.label), el)),
    h('span', { class: 'small muted' }, `Port ${a.ports.map((p) => `${p[0]}${p[1] === 'udp' ? ' (UDP)' : ''}`).join(', ')} będzie otwarty na świat — zajęty? wezmę następny wolny. Zajmie ok. ${a.ram >= 1024 ? (a.ram / 1024).toFixed(1).replace('.', ',') + ' GB' : a.ram + ' MB'} pamięci.`),
    a.fit === 'warn' ? h('span', { class: 'small fx-text' }, '⚠ To na styk z wolną pamięcią — strony mogą zwolnić, gdy ktoś gra.') : null);
  if (!(await ask({ title: `Postawić serwer ${a.name}?`, text: a.desc, ok: 'Zainstaluj', extra }))) return;
  await busy(b, async () => { try { const r = await api('POST', 'api/sklep/zainstaluj', { app: a.id, fields: Object.fromEntries(inputs.map(({ f, el }) => [f.id, el.value])) }); watchJob(r.job, () => window.P.reload()); toast('Instaluję w tle — postęp w okienku na dole', 'ok'); } catch (e) { toast(e.message, 'bad'); } });
}

/* ------------------------------------------- własna aplikacja (wariant A · formularz, compose jako opcja) */
let customMode = 'form';
function customCard(d) {
  const dk = d.docker;
  const field = (label, el, hint) => h('label', { class: 'field' }, h('span', null, label), el, hint || null);
  const name = h('input', { class: 'input', id: 'wl-nazwa', placeholder: 'np. Moja aplikacja', maxlength: 40 });
  const host = h('input', { class: 'input', id: 'wl-adres', placeholder: d.domain ? `np. moja.${d.domain}` : 'np. moja.mojserwer.pl', autocapitalize: 'off', spellcheck: 'false' });
  const submit = async (b, body) => busy(b, async () => {
    if (!(await ask({ title: 'Zainstalować własną aplikację?', text: `Kontener dostanie port tylko na 127.0.0.1, adres https://${body.host || '…'}/ z certyfikatem i dane w nocnej kopii. Obraz pochodzi spoza sklepu — instaluj tylko to, czemu ufasz.`, ok: 'Zainstaluj' }))) return;
    try { const r = await api('POST', 'api/sklep/zainstaluj', { kind: 'wlasna', ...body }); watchJob(r.job, () => window.P.reload()); toast('Instaluję w tle — postęp w okienku na dole', 'ok'); } catch (e) { toast(e.message, 'bad'); }
  });
  const swap = btn(customMode === 'form' ? 'Wklej compose.yml zamiast tego' : 'Wróć do formularza', () => { customMode = customMode === 'form' ? 'compose' : 'form'; window.P.reload(); }, { icon: customMode === 'form' ? 'plikkod' : 'wstecz' });
  if (customMode === 'compose') {
    const ta = h('textarea', { class: 'input mono wl-yaml', id: 'wl-compose', rows: 14, spellcheck: 'false', placeholder: 'services:\n  app:\n    image: ghcr.io/firma/aplikacja:latest\n    ports: ["3000:3000"]\n    volumes: ["./dane:/data"]' });
    const out = h('div', { class: 'stack', style: 'gap:8px' });
    let checked = '';
    const inst = btn('Zainstaluj', () => submit(inst, { name: name.value, host: host.value, compose: ta.value }), { kind: 'pri', icon: 'pobierz', disabled: true });
    const check = btn('Sprawdź plik', () => busy(check, async () => {
      try {
        const r = await api('POST', 'api/sklep/compose/sprawdz', { compose: ta.value, host: host.value });
        out.replaceChildren(h('div', { class: 'fx-list' }, r.checks.length ? r.checks.map((c) => h('div', { class: `fx-c ${c.k}` }, h('span', { class: 'fx-s', 'aria-hidden': 'true' }, ico(c.k === 'ok' ? 'tak' : 'wykrzyknik', 14)), h('div', { class: 'stack grow', style: 'gap:3px;min-width:0' }, h('b', null, c.title), h('span', { class: 'small fx-text' }, c.text))))
          : h('div', { class: 'fx-c ok' }, h('span', { class: 'fx-s' }, ico('tak', 14)), h('b', null, 'Nic do poprawiania'))),
          h('details', { class: 'small' }, h('summary', null, 'Plik po poprawkach'), h('pre', { class: 'logbox', style: 'max-height:260px' }, r.text)));
        checked = ta.value; inst.disabled = false;
      } catch (e) { out.replaceChildren(h('div', { class: 'alert error' }, h('span', { class: 'tag' }, 'NIE'), h('span', { class: 'txt' }, e.message))); inst.disabled = true; }
    }), { icon: 'sprawdz' });
    ta.addEventListener('input', () => { inst.disabled = ta.value !== checked; });
    return h('section', { class: 'card stack', style: 'gap:12px' }, h('div', { class: 'card-h', style: 'margin:0' }, h('h2', null, 'Własna aplikacja — wklej docker-compose.yml'), swap),
      h('div', { class: 'form-grid' }, field('Nazwa', name), field('Adres', host, h('span', { class: 'small muted' }, 'z certyfikatem https'))),
      field('Plik compose', ta), out, h('div', { class: 'acts', style: 'justify-content:flex-start' }, check, inst),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Panel przestawi port na 127.0.0.1, doda limit pamięci, zamieni wolumeny na foldery w kopii i usunie groźne uprawnienia (privileged, cap_add). Nie zainstaluje dostępu do docker.sock, sieci hosta ani folderów spoza aplikacji.'));
  }
  const image = h('input', { class: 'input mono', id: 'wl-obraz', placeholder: 'np. louislam/uptime-kuma:2 albo ghcr.io/firma/aplikacja', autocapitalize: 'off', spellcheck: 'false' });
  const imgInfo = h('span', { class: 'small muted' }, 'Z Docker Hub, GitHuba (ghcr.io) albo innego rejestru.');
  let t = null;
  image.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => { if (!image.value.trim()) return; imgInfo.textContent = 'sprawdzam…'; try { const r = await api('GET', `api/sklep/obraz?nazwa=${encodeURIComponent(image.value.trim())}`); imgInfo.replaceChildren(r.ok ? h('span', { class: 'sym ok' }, ico('ok', 14)) : r.ok === false ? h('span', { class: 'sym bad' }, ico('blad', 14)) : '', r.text); } catch (e) { imgInfo.textContent = e.message; } }, 700); });
  const cport = h('input', { class: 'input', id: 'wl-port', type: 'number', min: 1, max: 65535, placeholder: 'np. 3000', inputmode: 'numeric' });
  const folder = h('input', { class: 'input mono', id: 'wl-folder', placeholder: 'np. /data (puste = bez danych)', autocapitalize: 'off', spellcheck: 'false' });
  const memOpts = [128, 256, 512, 768, 1024, 1536, 2048].filter((m) => m < d.freeMb);
  const mem = h('select', { class: 'input', id: 'wl-pamiec' }, memOpts.map((m) => h('option', { value: m, selected: m === 512 ? true : null }, `${m >= 1024 ? (m / 1024).toFixed(1).replace('.', ',').replace(',0', '') + ' GB' : m + ' MB'} — zostanie ${((d.freeMb - m) / 1024).toFixed(1).replace('.', ',')} GB`)));
  const env = h('textarea', { class: 'input mono', id: 'wl-zmienne', rows: 4, spellcheck: 'false', placeholder: 'NODE_ENV=production\nSECRET=…' });
  const inst = btn('Zainstaluj', () => submit(inst, { name: name.value, image: image.value, cport: Number(cport.value), host: host.value, folder: folder.value, mem: Number(mem.value), env: env.value }), { kind: 'pri', icon: 'pobierz', disabled: !dk.running });
  return h('section', { class: 'card stack', style: 'gap:12px' }, h('div', { class: 'card-h', style: 'margin:0' }, h('h2', null, 'Własna aplikacja'), swap),
    field('Obraz z Docker Hub albo GitHuba', image, imgInfo),
    h('div', { class: 'form-grid' }, field('Nazwa', name), field('Adres', host, h('span', { class: 'small muted' }, 'z certyfikatem https'))),
    h('div', { class: 'form-grid' }, field('Port w kontenerze', cport, h('span', { class: 'small muted' }, 'panel wystawi go tylko na 127.0.0.1')), field('Folder na dane', folder, h('span', { class: 'small muted' }, 'trafia do kopii co noc')), field('Pamięć najwyżej', mem)),
    field('Zmienne (NAZWA=wartość, jedna w wierszu)', env),
    h('div', { class: 'acts', style: 'justify-content:flex-start' }, inst),
    !dk.running ? h('p', { class: 'small fx-text', style: 'margin:0' }, 'Najpierw zainstaluj Dockera (wyżej).') : null);
}
