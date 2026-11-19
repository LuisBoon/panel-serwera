// Sklep z aplikacjami (wariant A · Półki): gotowe aplikacje w kontenerach Docker, z adresem, certyfikatem i kopiami.
const { h, put, api, btn, linkBtn, ico, busy, toast, ask, watchJob, when, PAGES, state, isAdmin } = window.P;
const CAT = { 'Pliki i zdjęcia': ['#1d3550', '#9cc7ff'], 'Hasła': ['#163a2f', '#8ff0d0'], 'Monitoring': ['#2f2a12', '#ffe08a'], 'Kod': ['#2a1f3d', '#d3b8ff'], 'Praca': ['#3a2216', '#ffc39b'] };
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
      const a = d.apps.find((y) => y.id === x.app) || { icon: x.icon, cat: '' };
      const pill = { dziala: ['ok', 'działa'], zatrzymana: ['bad', 'zatrzymana'], restartuje: ['warn', 'restartuje się'] }[x.state] || ['info', x.state];
      const act = (label, a2, icon, kind = '') => { const b = btn(label, () => run(b, `api/sklep/${encodeURIComponent(x.id)}/${a2}`), { small: true, icon, kind }); return b; };
      const logB = btn('Logi', async () => { try { const r = await api('GET', `api/sklep/${encodeURIComponent(x.id)}/logi`); await ask({ title: `Logi: ${x.name}`, text: '', ok: 'Zamknij', extra: h('pre', { class: 'logbox app-log', style: 'max-height:55vh' }, r.text || '(pusto)') }); } catch (e) { toast(e.message, 'bad'); } }, { small: true, icon: 'logi' });
      const delB = owner ? btn('', () => busy(delB, async () => {
        if (!(await ask({ title: `Usunąć ${x.name}?`, text: `Zatrzymam kontenery, usunę adres ${x.host} i dane aplikacji. Archiwum danych zostanie w koszu kopii.`, ok: 'Usuń', danger: true, typed: x.host }))) return;
        try { const r = await api('POST', `api/sklep/${encodeURIComponent(x.id)}/usun`, {}); watchJob(r.job, () => window.P.reload()); } catch (e) { toast(e.message, 'bad'); }
      }), { small: true, icon: 'usun', kind: 'ghost', title: 'Usuń aplikację' }) : null;
      return h('div', { class: 'row', style: 'flex-wrap:wrap;gap:12px' }, tile(a, 20),
        h('div', { class: 'stack grow', style: 'flex-basis:200px;gap:2px;min-width:0' }, h('span', { class: 't' }, x.name, ' ', h('span', { class: `pill ${pill[0]}` }, pill[1])), h('a', { class: 's', href: `https://${x.host}/`, target: '_blank', rel: 'noopener noreferrer' }, x.host),
          x.notes ? h('details', null, h('summary', { class: 'small' }, 'Pierwsze logowanie'), h('div', { class: 'small fx-text', style: 'margin-top:4px' }, x.notes)) : null),
        h('div', { class: 'acts', style: 'flex-wrap:wrap' }, linkBtn('Otwórz', `https://${x.host}/`, { small: true, icon: 'ext', blank: true }), isAdmin() ? act('Aktualizuj', 'aktualizuj', 'aktualizacje') : null, isAdmin() ? act('', 'restart', 'restart') : null, logB, delB));
    }))) : null;
  const cats = ['Wszystkie', ...new Set(d.apps.map((a) => a.cat))];
  const chips = h('div', { class: 'store-chips' }, cats.map((c) => h('button', { type: 'button', class: `store-chip ${c === filter ? 'on' : ''}`, onclick: () => { filter = c; window.P.reload(); } }, c)));
  const card = (a) => {
    const b = btn(a.installed ? 'Zainstaluj kolejną' : 'Zainstaluj', () => install(a, d, b), { small: true, icon: 'pobierz', kind: a.installed ? '' : 'pri', disabled: !dk.running || !isAdmin() });
    return h('section', { class: 'card app-card' }, h('div', { style: 'display:flex;gap:12px;align-items:flex-start' }, tile(a),
      h('div', { class: 'stack grow', style: 'gap:3px;min-width:0' }, h('b', null, a.name, a.installed ? h('span', { class: 'pill ok', style: 'margin-left:8px' }, 'zainstalowana') : null), h('span', { class: 'small', style: 'color:#c9d1dc' }, a.desc),
        h('span', { class: 'small muted' }, `${a.cat} · ok. ${a.ram} MB pamięci`), a.fit !== 'ok' ? h('span', { class: 'small', style: `color:var(--${a.fit === 'bad' ? 'bad' : 'warn'}-ink)` }, a.fit === 'bad' ? '✗ za mało wolnej pamięci na tym serwerze' : '⚠ na styk z wolną pamięcią') : null)),
      h('div', { class: 'acts', style: 'justify-content:space-between;flex-wrap:wrap' }, h('a', { class: 'small', href: a.url, target: '_blank', rel: 'noopener noreferrer' }, 'strona projektu'), b));
  };
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Sklep z aplikacjami'), h('div', { class: 'sub' }, `Gotowe aplikacje jednym kliknięciem — własny adres z certyfikatem, kopie co noc, aktualizacja przyciskiem. Wolna pamięć: ${(d.freeMb / 1024).toFixed(1).replace('.', ',')} GB.`))),
    dockerCard, installed, chips,
    h('div', { class: 'apps-grid' }, d.apps.filter((a) => filter === 'Wszystkie' || a.cat === filter).map(card)));
};

async function install(a, d, b) {
  const host = h('input', { class: 'input', id: 'sklep-adres', value: d.domain ? `${a.sub}.${d.domain}` : '', placeholder: 'np. hasla.mojserwer.pl', autocapitalize: 'off', spellcheck: 'false' });
  const extra = h('div', { class: 'stack', style: 'gap:8px' }, h('label', { class: 'field' }, h('span', null, 'Adres aplikacji'), host),
    h('span', { class: 'small muted' }, 'Rekord A tego adresu musi wskazywać na serwer (z OVH połączonym z panelem doda się sam). Certyfikat https pobierze się automatycznie.'));
  if (!(await ask({ title: `Zainstalować ${a.name}?`, text: `${a.desc} Zajmie ok. ${a.ram} MB pamięci.`, ok: 'Zainstaluj', extra }))) return;
  await busy(b, async () => { try { const r = await api('POST', 'api/sklep/zainstaluj', { app: a.id, host: host.value }); watchJob(r.job, () => window.P.reload()); toast('Instaluję w tle — postęp w okienku na dole', 'ok'); } catch (e) { toast(e.message, 'bad'); } });
}
