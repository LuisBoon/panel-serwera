// Grupa serwerów (wariant A): przełącznik serwerów, pasek „zarządzasz zdalnie”, strona „Wszystkie serwery”
// (pulpit zbiorczy, łączenie kodem, kto zarządza tym serwerem).
const { h, put, api, btn, linkBtn, ico, busy, toast, ask, when, bytes, plural, PAGES, state, isAdmin, every } = window.P;

async function loadGroup() {
  try { state.group = (await api('GET', 'api/grupa/stan')).servers; } catch { state.group = state.group || []; }
  return state.group;
}
/** Przełączenie na inny serwer z grupy ('' = ten). */
async function switchServer(id, name) {
  if (!id) {
    state.srv = ''; state.srvName = '';
    if (state.localCfg) state.cfg = state.localCfg;
    if (state.localRole) state.role = state.localRole;
  } else {
    if (!state.srv) { state.localCfg = state.cfg; state.localRole = state.role; }
    const r = await fetch(`zdalny/${id}/api/stan`, { credentials: 'same-origin', headers: { 'X-Panel': '1' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error || `Serwer nie odpowiada (${r.status}).`, 'bad'); return; }
    state.srv = id; state.srvName = name || j.konfig?.nazwa || 'serwer';
    state.cfg = j.konfig || { moduly: {} }; state.role = j.role || 'podglad';
  }
  window.P.buildShell();
  if (location.hash === '#/pulpit' || !location.hash) window.P.go(); else location.hash = '#/pulpit';
}
window.switchServer = switchServer;

window.openServerMenu = async (anchor) => {
  if (!isAdmin() && !state.srv) return;
  document.querySelector('.srv-menu-bg')?.remove();
  const list = h('div', { class: 'srv-menu', role: 'menu' }, h('div', { class: 'loading', style: 'padding:10px' }, h('span', { class: 'spin' }), 'Sprawdzam serwery…'));
  const bg = h('div', { class: 'srv-menu-bg' }, list);
  const r = anchor.getBoundingClientRect();
  list.style.cssText = `top:${Math.round(r.bottom + 6)}px;left:${Math.max(8, Math.round(r.left))}px`;
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) bg.remove(); });
  document.body.append(bg);
  const servers = await loadGroup();
  const item = (s) => h('button', { type: 'button', role: 'menuitem', class: `srv-item ${(s.id || '') === state.srv ? 'on' : ''}`, onclick: () => { bg.remove(); switchServer(s.id, s.nazwa); } },
    h('span', { class: `dot ${s.ok ? '' : 'b'}` }), h('span', { class: 'stack grow', style: 'min-width:0;gap:0' }, h('b', { class: 'ell' }, s.nazwa, s.id ? '' : ' (ten)'), h('small', { class: 'muted ell' }, s.ok ? (s.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '') : 'nie odpowiada')));
  list.replaceChildren(...servers.map(item),
    h('a', { class: 'srv-item', href: '#/serwery', onclick: () => { bg.remove(); if (state.srv) switchServer(''); } }, ico('serwery', 16), h('b', null, 'Wszystkie serwery')),
    servers.length < 2 ? h('div', { class: 'small muted', style: 'padding:6px 10px' }, 'Połącz kolejny serwer na stronie „Wszystkie serwery”.') : null);
};

window.remoteBar = () => h('div', { class: 'remote-bar' }, ico('serwery', 16), h('span', { class: 'grow' }, 'Zarządzasz serwerem ', h('b', null, state.srvName), ' przez ten panel', state.role === 'podglad' ? ' (tylko podgląd)' : '', '.'),
  btn(`Wróć do: ${state.localCfg?.nazwa || 'ten serwer'}`, () => switchServer(''), { small: true }));

/* ----------------------------------------------------------- Wszystkie serwery */

PAGES.serwery = async (box) => {
  if (state.srv) { await switchServer(''); return; }
  const servers = await loadGroup();
  let g = { servers: [], access: [], roles: {}, me: {} };
  const owner = state.role === 'wlasciciel';
  if (owner) { try { g = await api('GET', 'api/grupa'); } catch {} }
  const tile = (s) => {
    const p = s.pulpit || {};
    const bar = (label, v) => v == null ? null : h('div', { class: 'srvt-m' }, h('span', null, label), h('i', null, h('b', { class: v >= 90 ? 'bad' : v >= 80 ? 'warn' : '', style: `width:${Math.max(2, Math.min(100, v))}%` })), h('span', { class: 'nowrap' }, `${v}%`));
    const manage = btn(s.id ? 'Zarządzaj' : 'To ten serwer', () => (s.id ? switchServer(s.id, s.nazwa) : (location.hash = '#/pulpit')), { small: true, kind: s.id ? 'pri' : '' });
    const del = s.id && owner ? btn('', () => busy(del, async () => {
      if (!(await ask({ title: `Odłączyć „${s.nazwa}”?`, text: 'Ten panel przestanie nim zarządzać, a tamten panel dostanie informację, że połączenie jest odwołane. Na tamtym serwerze nic się nie zmienia.', ok: 'Odłącz', danger: true }))) return;
      try { await api('POST', `api/grupa/${s.id}/odlacz`, {}); toast('✓ Odłączono', 'ok'); } catch (e) { toast(e.message, 'bad'); }
      window.P.reload();
    }), { small: true, icon: 'usun', kind: 'ghost', title: 'Odłącz' }) : null;
    return h('section', { class: `card srvt ${s.ok ? '' : 'down'}` },
      h('div', { class: 'srvt-h' }, h('span', { class: `dot ${s.ok ? '' : 'b'}` }), h('div', { class: 'stack grow', style: 'min-width:0;gap:0' }, h('b', { class: 'ell' }, s.nazwa, s.id ? '' : ' (ten)'), h('small', { class: 'muted ell' }, (s.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '') || 'ten serwer')),
        s.ok && (p.alerts || p.warns) ? h('span', { class: `pill ${p.alerts ? 'bad' : 'warn'}` }, p.alerts ? `${p.alerts} ${plural(p.alerts, 'błąd', 'błędy', 'błędów')}` : `${p.warns} ${plural(p.warns, 'uwaga', 'uwagi', 'uwag')}`) : s.ok ? h('span', { class: 'pill ok' }, 'OK') : h('span', { class: 'pill bad' }, 'nie odpowiada')),
      s.ok ? h('div', { class: 'stack', style: 'gap:6px' }, bar('Procesor', p.cpu != null ? Math.round(p.cpu) : null), bar('Pamięć', p.mem), bar('Dysk', p.disk),
        h('div', { class: 'small muted' }, [p.sites?.all != null ? `strony: ${p.sites.ok ?? '?'} z ${p.sites.all} działa` : null, s.version ? `panel ${s.version}` : null, s.rola && s.id ? (s.rola === 'podglad' ? 'tylko podgląd' : 'zarządzanie') : null].filter(Boolean).join(' · ')))
        : h('p', { class: 'small', style: 'margin:0;color:var(--bad-ink)' }, s.error || 'Brak odpowiedzi.'),
      h('div', { class: 'acts', style: 'flex-wrap:wrap' }, manage, s.id ? linkBtn('Jego panel', s.url, { small: true, icon: 'ext', blank: true }) : null, del));
  };
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Wszystkie serwery'), h('div', { class: 'sub' }, 'Serwery połączone z tym panelem. „Zarządzaj” przełącza cały panel na wybrany serwer.'))),
    h('div', { class: 'tiles' }, servers.map(tile)));
  if (!owner) return;
  // połącz kolejny serwer
  const url = h('input', { class: 'input', placeholder: 'https://panel.innyserwer.pl', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Adres panelu' });
  const code = h('input', { class: 'input mono', placeholder: 'XXXX-XXXX-XXXX', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Kod' });
  const go = btn('Połącz', () => busy(go, async () => {
    try { const r = await api('POST', 'api/grupa/polacz', { url: url.value, code: code.value }); toast(`✓ Połączono: ${r.nazwa}`, 'ok'); window.P.reload(); } catch (e) { toast(e.message, 'bad'); }
  }), { kind: 'pri', icon: 'plus' });
  // pozwól innemu panelowi
  const role = h('select', { class: 'input', style: 'width:auto' }, Object.entries(g.roles).map(([k, v]) => h('option', { value: k }, v)));
  const codeBox = h('div');
  const mk = btn('Utwórz kod', () => busy(mk, async () => {
    try {
      const r = await api('POST', 'api/grupa/kod', { rola: role.value });
      codeBox.replaceChildren(h('div', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'secret-box', style: 'font-size:22px;letter-spacing:.08em;text-align:center' }, r.code),
        h('p', { class: 'small muted', style: 'margin:0' }, `Na panelu, który ma zarządzać tym serwerem: Wszystkie serwery → Połącz serwer → adres `, h('b', { class: 'mono' }, g.me.url || location.origin + '/'), ` i ten kod. Kod działa 15 minut i tylko raz.`)));
    } catch (e) { toast(e.message, 'bad'); }
  }), { small: true });
  put(box,
    h('div', { class: 'cols' },
      h('section', { class: 'card stack', style: 'gap:12px' }, h('h2', null, 'Połącz serwer'),
        h('ol', { class: 'small', style: 'margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px;color:#c9d1dc' },
          h('li', null, 'Zainstaluj panel na tamtym serwerze (jedno polecenie — instrukcja na GitHubie).'),
          h('li', null, 'Na tamtym panelu: Wszystkie serwery → „Pozwól innemu panelowi zarządzać” → Utwórz kod.'),
          h('li', null, 'Wpisz tutaj adres tamtego panelu i kod.')),
        h('label', { class: 'field' }, h('span', null, 'Adres panelu'), url), h('label', { class: 'field' }, h('span', null, 'Kod'), code), h('div', null, go)),
      h('section', { class: 'card stack', style: 'gap:12px' }, h('h2', null, 'Pozwól innemu panelowi zarządzać tym serwerem'),
        h('p', { class: 'small muted', style: 'margin:0' }, 'Tamten panel dostanie dostęp bez logowania i kodu z aplikacji, ale nigdy do kont, terminala i kluczy SSH. Dostęp możesz odebrać w każdej chwili.'),
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, role, mk), codeBox)),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Kto zarządza tym serwerem'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Inne panele, które mają dostęp do tego serwera.'))),
      g.access.length ? h('div', { class: 'rows' }, g.access.map((a) => {
        const rv = btn('Odbierz dostęp', () => busy(rv, async () => { if (!(await ask({ title: `Odebrać dostęp panelowi „${a.nazwa}”?`, text: 'Tamten panel od razu straci dostęp do tego serwera.', ok: 'Odbierz', danger: true }))) return; await api('POST', `api/grupa/dostep/${a.id}/odwolaj`, {}); toast('✓ Odebrano', 'ok'); window.P.reload(); }), { small: true, kind: 'danger' });
        return h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { class: 'stack grow', style: 'flex-basis:220px' }, h('span', { class: 't' }, a.nazwa), h('span', { class: 's' }, `${g.roles[a.rola] || a.rola} · połączony ${when(a.created)}${a.last_used ? ' · ostatnio ' + when(a.last_used) + (a.ip ? ' z ' + a.ip : '') : ''}`)), rv);
      })) : h('div', { class: 'list-empty' }, 'Żaden inny panel nie zarządza tym serwerem.')));
  every(30000, () => window.P.reload());
};
