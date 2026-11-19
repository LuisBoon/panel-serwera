// Panel serwera — strona (bez budowania, bez bibliotek). Dane trafiają do DOM wyłącznie jako tekst.
const app = document.getElementById('app');
const state = { login: null, role: null, sites: [], counts: {}, alertsBad: false, page: null, timers: [], jobs: new Map(), cfg: { nazwa: 'serwer', moduly: {} }, srv: '', srvName: '', localCfg: null, localRole: null, group: null };
const NM = () => state.cfg?.nazwa || 'serwer';
// grupa serwerów: gdy wybrany jest inny serwer, zapytania /api idą przez ten panel do tamtego
const LOCAL_API = /^api\/(stan|wyloguj|wyloguj-wszedzie|logowanie|konfiguracja|zaproszenie|grupa)(\/|$|\?)/;
const apiPath = (p) => (state.srv && /^api\//.test(p) && !LOCAL_API.test(p) ? `zdalny/${state.srv}/${p}` : p);
const MOD = (m) => state.cfg?.moduly?.[m] !== false;
const isAdmin = () => state.role === 'wlasciciel' || state.role === 'admin';
async function loadMe() { const s = await api('GET', 'api/stan'); state.login = s.login; state.role = s.role; state.sites = s.sites || []; if (s.konfig) state.cfg = s.konfig; return s; }

/* ----------------------------------------------------------- pomocnicze */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'style') el.style.cssText = v; // CSSOM — dozwolone przez CSP (atrybut style już nie)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'href' && typeof v === 'string' && v.startsWith('api/')) el.setAttribute('href', apiPath(v));
    else el.setAttribute(k, v === true ? '' : v);
  }
  const plain = NO_SYM.has(tag);
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) { if (c instanceof Node) el.append(c); else if (plain) el.append(String(c)); else el.append(...withIcons(String(c))); }
  return el;
}
// ✓ ✗ ✕ ⚠ w tekstach interfejsu zamieniamy na ikony (samotny znak, np. w numerze kroku, na sam „ptaszek” albo „×”)
const SYM = { '✓': ['ok', 'ok'], '✗': ['blad', 'bad'], '✕': ['blad', 'bad'], '⚠': ['uwaga', 'warn'] };
const NO_SYM = new Set(['textarea', 'option', 'pre', 'code', 'title', 'script', 'style']);
function withIcons(str) {
  if (!/[✓✗✕⚠]/.test(str)) return [str];
  const t = str.trim();
  if (t.length === 1) return [h('span', { class: `sym lone ${SYM[t][1]}`, 'aria-label': t === '✓' ? 'gotowe' : 'błąd' }, ico(t === '✓' ? 'tak' : t === '⚠' ? 'uwaga' : 'x', 14))];
  return str.split(/([✓✗✕⚠])\s?/).filter(Boolean).map((part) => (SYM[part] ? h('span', { class: `sym ${SYM[part][1]}` }, ico(SYM[part][0], 16)) : part));
}
const NS = 'http://www.w3.org/2000/svg';
// Ikony: Lucide (https://lucide.dev), licencja ISC — Copyright (c) Lucide Icons and Contributors; część pochodzi
// z Feather (MIT, Copyright (c) 2013-present Cole Bemis). Jeden zestaw, kreska 1,75, siatka 24×24 — nie dorysowywać własnych.
// Ikony: Lucide (https://lucide.dev), licencja ISC — Copyright (c) Lucide Icons and Contributors; część pochodzi
// z Feather (MIT, Copyright (c) 2013-present Cole Bemis). Jeden zestaw, kreska 1,75, siatka 24×24 — nie dorysowywać własnych.
// Ikony: Lucide (https://lucide.dev), licencja ISC — Copyright (c) Lucide Icons and Contributors; część pochodzi
// z Feather (MIT, Copyright (c) 2013-present Cole Bemis). Jeden zestaw, kreska 1,75, siatka 24×24 — nie dorysowywać własnych.
// Ikony: Lucide (https://lucide.dev), licencja ISC — Copyright (c) Lucide Icons and Contributors; część pochodzi
// z Feather (MIT, Copyright (c) 2013-present Cole Bemis). Jeden zestaw, kreska 1,75, siatka 24×24 — nie dorysowywać własnych.
// Ikony: Lucide (https://lucide.dev), licencja ISC — Copyright (c) Lucide Icons and Contributors; część pochodzi
// z Feather (MIT, Copyright (c) 2013-present Cole Bemis). Jeden zestaw, kreska 1,75, siatka 24×24 — nie dorysowywać własnych.
const ICONS = {
  pulpit: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>', // layout-dashboard
  napraw: '<path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/>', // stethoscope
  serwery: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>', // network
  logo: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>', // server
  strony: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>', // globe
  statystyki: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>', // chart-column
  bazy: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>', // database
  kopie: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>', // archive
  awaria: '<circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/><circle cx="12" cy="12" r="4"/>', // life-buoy
  gry: '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>', // gamepad-2
  uslugi: '<path d="m10.852 14.772-.383.923"/><path d="M13.148 14.772a3 3 0 1 0-2.296-5.544l-.383-.923"/><path d="m13.148 9.228.383-.923"/><path d="m13.53 15.696-.382-.924a3 3 0 1 1-2.296-5.544"/><path d="m14.772 10.852.923-.383"/><path d="m14.772 13.148.923.383"/><path d="M4.5 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5"/><path d="M4.5 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-.5"/><path d="M6 18h.01"/><path d="M6 6h.01"/><path d="m9.228 10.852-.923-.383"/><path d="m9.228 13.148-.923.383"/>', // server-cog
  wydajnosc: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>', // gauge
  aktualizacje: '<circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4"/><path d="M12 16V8"/>', // circle-arrow-up
  autopilot: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>', // shield-check
  zapora: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 9v6"/><path d="M16 15v6"/><path d="M16 3v6"/><path d="M3 15h18"/><path d="M3 9h18"/><path d="M8 15v6"/><path d="M8 3v6"/>', // brick-wall
  dysk: '<path d="M10 16h.01"/><path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M21.946 12.013H2.054"/><path d="M6 16h.01"/>', // hard-drive
  logi: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>', // scroll-text
  ssl: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', // lock
  cron: '<path d="M16 14v2.2l1.6 1"/><path d="M16 2v3"/><path d="M21 7.338V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h2.338"/><path d="M3 9h5.859"/><path d="M8 2v3"/><circle cx="16" cy="16" r="6"/>', // calendar-clock
  terminal: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>', // square-terminal
  dostep: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>', // users
  dziennik: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>', // history
  ustawienia: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>', // settings
  pomoc: '<circle cx="12" cy="12" r="10"/><path d="M9 9.5a3 2.5 0 016 0c0 2-2 2-3 3.5"/><path d="M12 17h.01"/>', // circle-help
  bezpieczenstwo: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 22V2"/>', // shield-half
  sklep: '<path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5"/><path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244"/><path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05"/>', // store
  automatyzacja: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>', // workflow
  dokumenty: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8h8"/><path d="M7 12h10"/><path d="M7 16h6"/>', // scan-text
  przenies: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>', // arrow-right-left
  straznik: '<path d="M7 18v-6a5 5 0 1 1 10 0v6"/><path d="M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z"/><path d="M21 12h1"/><path d="M18.5 4.5 18 5"/><path d="M2 12h1"/><path d="M12 2v1"/><path d="m4.929 4.929.707.707"/><path d="M12 12v6"/>', // siren
  kontener: '<path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z"/><path d="M10 21.9V14L2.1 9.1"/><path d="m10 14 11.9-6.9"/><path d="M14 19.8v-8.1"/><path d="M18 17.5V9.4"/>', // container
  pakiet: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>', // package
  aktywnosc: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>', // activity
  dalejstrz: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>', // arrow-right
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>', // plus
  popraw: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>', // wrench
  restart: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>', // rotate-cw
  odswiez: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>', // refresh-cw
  sprawdz: '<path d="m8 11 2 2 4-4"/><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', // search-check
  stop: '<rect width="18" height="18" x="3" y="3" rx="2"/>', // square
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>', // play
  pobierz: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>', // download
  wgraj: '<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>', // upload
  edytuj: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>', // pencil
  kopiuj: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>', // copy
  usun: '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', // trash-2
  ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', // external-link
  przywroc: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>', // undo-2
  sprzataj: '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>', // sparkles
  zapisz: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>', // save
  wyslij: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>', // send
  chmura: '<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>', // cloud-upload
  git: '<path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>', // git-branch
  pliki: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>', // folder-open
  konto: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>', // user-round
  wyloguj: '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>', // log-out
  dzwonek: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>', // bell
  alarm: '<path d="M7 18v-6a5 5 0 1 1 10 0v6"/><path d="M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z"/><path d="M21 12h1"/><path d="M18.5 4.5 18 5"/><path d="M2 12h1"/><path d="M12 2v1"/><path d="m4.929 4.929.707.707"/><path d="M12 12v6"/>', // siren
  klucz: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>', // key-round
  aplikacja: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>', // code-xml
  wstecz: '<path d="m15 18-6-6 6-6"/>', // chevron-left
  dalej: '<path d="m9 18 6-6-6-6"/>', // chevron-right
  rozwin: '<path d="m6 9 6 6 6-6"/>', // chevron-down
  menu: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>', // menu
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', // x
  szukaj: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>', // search
  okno: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>', // app-window
  zip: '<path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 12v-1"/><path d="M8 18v-2"/><path d="M8 7V6"/><circle cx="8" cy="20" r="2"/>', // file-archive
  blog: '<path d="M15 18h-5"/><path d="M18 14h-8"/><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2"/><rect width="8" height="4" x="10" y="6" rx="1"/>', // newspaper
  przekierowanie: '<path d="M12 13v8"/><path d="M12 3v3"/><path d="M2.354 10.354a1.207 1.207 0 0 1 0-1.708l2.06-2.06A2 2 0 0 1 5.828 6h12.344a2 2 0 0 1 1.414.586l2.06 2.06a1.207 1.207 0 0 1 0 1.708l-2.06 2.06a2 2 0 0 1-1.414.586H5.828a2 2 0 0 1-1.414-.586z"/>', // signpost
  ok: '<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>', // circle-check
  blad: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>', // circle-x
  uwaga: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>', // triangle-alert
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>', // info
  tak: '<path d="M20 6 9 17l-5-5"/>', // check
  minus: '<path d="M5 12h14"/>', // minus
  wykrzyknik: '<path d="M12 6v8"/><path d="M12 18h.01"/>',
  literai: '<path d="M12 11v6"/><path d="M12 7h.01"/>',
};
/** Dodaje dzieci, spłaszczając tablice i pomijając puste (null/false). */
function put(box, ...kids) { for (const c of kids.flat(Infinity)) if (c != null && c !== false) box.append(c); }
function ico(name, size = 18) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.75');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}
function btn(label, onClick, { icon, kind = '', title, small, disabled } = {}) {
  const iconOnly = !label;
  return h('button', { type: 'button', class: `btn ${kind} ${small ? 'sm' : ''} ${iconOnly ? 'ico' : ''}`, onclick: onClick, 'aria-label': iconOnly ? title : null, title: title || null, disabled: disabled || null }, icon ? ico(icon, 16) : null, label || null);
}
function linkBtn(label, href, { icon, kind = '', small, blank } = {}) {
  return h('a', { class: `btn ${kind} ${small ? 'sm' : ''} ${label ? '' : 'ico'}`, href, target: blank ? '_blank' : null, rel: blank ? 'noopener noreferrer' : null, 'aria-label': label ? null : 'Otwórz' }, icon ? ico(icon, 16) : null, label || null);
}
async function busy(button, fn) {
  if (button) { button.disabled = true; button.dataset.l = button.textContent; }
  try { return await fn(); } finally { if (button && button.isConnected) button.disabled = false; }
}

const pad = (n) => String(n).padStart(2, '0');
function plural(n, one, few, many) { n = Math.abs(n); if (n === 1) return one; const d = n % 10, t = n % 100; return d >= 2 && d <= 4 && !(t >= 12 && t <= 14) ? few : many; }
function bytes(n) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = Number(n);
  while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const s = i === 0 || v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '');
  return s.replace('.', ',') + ' ' + u[i];
}
function bytesPair(a, b) { // „16,8 / 24,4 GB” zamiast dwóch jednostek
  const x = bytes(a).split(' '), y = bytes(b).split(' ');
  return x[1] === y[1] ? `${x[0]} / ${y[0]} ${y[1]}` : `${bytes(a)} / ${bytes(b)}`;
}
function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function when(ts, { time = true } = {}) {
  if (!ts) return '—';
  const d = new Date(ts), now = new Date();
  const hm = time ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
  const diff = Math.round((dayStart(d) - dayStart(now)) / 864e5);
  if (diff === 0) return 'dziś' + hm;
  if (diff === -1) return 'wczoraj' + hm;
  if (diff === 1) return 'jutro' + hm;
  return `${d.getDate()}.${pad(d.getMonth() + 1)}${d.getFullYear() !== now.getFullYear() ? '.' + d.getFullYear() : ''}${hm}`;
}
function dateFull(ts) { if (!ts) return '—'; const d = new Date(ts); return `${d.getDate()}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; }
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'przed chwilą';
  if (s < 3600) return `${Math.round(s / 60)} min temu`;
  if (s < 86400) return `${Math.round(s / 3600)} godz. temu`;
  const d = Math.round(s / 86400); return `${d} ${plural(d, 'dzień', 'dni', 'dni')} temu`;
}
function dur(sec) {
  const d = Math.floor(sec / 86400);
  if (d >= 1) return `${d} ${plural(d, 'dzień', 'dni', 'dni')}`;
  const hh = Math.floor(sec / 3600);
  return hh ? `${hh} godz.` : `${Math.max(1, Math.floor(sec / 60))} min`;
}
function daysLeft(ts) { return ts ? Math.floor((ts - Date.now()) / 864e5) : null; }
function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }

/* ----------------------------------------------------------------- API */

async function api(method, path, body) {
  const r = await fetch(apiPath(path), {
    method, credentials: 'same-origin',
    headers: { 'X-Panel': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch {}
  if (r.status === 401 && state.login && !path.startsWith('api/logowanie') && (!state.srv || LOCAL_API.test(path) || j?.error === 'Zaloguj się.')) { state.login = null; state.srv = ''; showLogin('Sesja wygasła — zaloguj się ponownie.'); throw new Error('Zaloguj się.'); }
  if (!r.ok) throw new Error(j?.error || `Błąd ${r.status}`);
  return j;
}

/* ---------------------------------------------------- okna i komunikaty */

let toastBox;
function toast(text, kind = '') {
  if (!toastBox || !toastBox.isConnected) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const t = h('div', { class: `toast ${kind}` }, text);
  toastBox.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 9000 : 4500);
}

function ask({ title, text, ok = 'Tak', danger = false, typed = null, extra = null }) {
  return new Promise((resolve) => {
    const inp = typed ? h('input', { class: 'input', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': `Wpisz ${typed}, aby potwierdzić` }) : null;
    const okBtn = h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'pri'}`, disabled: typed ? true : null }, ok);
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Anuluj');
    const bg = h('div', { class: 'modal-bg' },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h2', null, title), text ? h('p', null, text) : null, extra,
        typed ? h('label', { class: 'field' }, h('span', null, `Aby potwierdzić, wpisz: `, h('b', { class: 'mono' }, typed)), inp) : null,
        h('div', { class: 'acts' }, cancel, okBtn)));
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', esc); resolve(v); };
    const esc = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', esc);
    cancel.onclick = () => close(false);
    okBtn.onclick = () => close(typed ? inp.value.trim() : true);
    bg.addEventListener('click', (e) => { if (e.target === bg) close(false); });
    if (inp) inp.addEventListener('input', () => { okBtn.disabled = inp.value.trim() !== typed; });
    document.body.append(bg);
    (inp || okBtn).focus();
  });
}

/* ------------------------------------------------------- zadania w tle */

let jobsBox;
function watchJob(job, onDone) {
  if (!jobsBox || !jobsBox.isConnected) { jobsBox = h('div', { class: 'jobs', 'aria-live': 'polite' }); document.body.append(jobsBox); }
  if (state.jobs.has(job.id)) return;
  const status = h('span', { class: 'spin' });
  const label = h('b', { class: 'grow' }, job.label);
  const out = h('div', { class: 'out', hidden: true });
  const more = btn('Szczegóły', () => { out.hidden = !out.hidden; more.textContent = out.hidden ? 'Szczegóły' : 'Ukryj'; }, { small: true, kind: 'ghost' });
  const closeB = btn('', () => { card.remove(); state.jobs.delete(job.id); }, { icon: 'x', small: true, kind: 'ghost', title: 'Zamknij' });
  closeB.hidden = true;
  const card = h('div', { class: 'job' }, h('div', { class: 'job-h' }, status, label, more, closeB), out);
  jobsBox.append(card);
  state.jobs.set(job.id, card);
  const tick = async () => {
    let j;
    try { j = await api('GET', `api/zadania/${job.id}`); } catch { setTimeout(tick, 3000); return; }
    out.textContent = j.out || '…';
    out.scrollTop = out.scrollHeight;
    if (!j.end) { setTimeout(tick, 1500); return; }
    status.className = 'pill ' + (j.ok ? 'ok' : 'bad');
    status.textContent = j.ok ? 'OK' : 'BŁĄD';
    closeB.hidden = false;
    toast(j.ok ? `✓ ${j.label} — gotowe` : `✗ ${j.label} — nie udało się (szczegóły w okienku)`, j.ok ? 'ok' : 'bad');
    try { onDone?.(j); } catch {}
    if (!j.ok) { out.hidden = false; more.textContent = 'Ukryj'; }
    else setTimeout(() => { if (card.isConnected && out.hidden) { card.remove(); state.jobs.delete(job.id); } }, 15000);
    reload();
  };
  tick();
}

async function backupNow(ev) {
  const ok = await ask({ title: 'Zrobić kopię teraz?', text: 'Zrobię to samo co w nocy: zrzuty wszystkich baz, kod stron, konfigurację i migawkę przesłanych plików. Trwa to zwykle kilkanaście sekund.', ok: 'Zrób kopię' });
  if (!ok) return;
  try { const r = await api('POST', 'api/kopie/teraz'); watchJob(r.job); } catch (e) { toast(e.message, 'bad'); }
}

/* ----------------------------------------------------------- szkielet */

const NAV = [
  ['pulpit', 'Pulpit'], ['napraw', 'Coś nie działa?'], ['serwery', 'Wszystkie serwery'],
  ['-', 'Strony i dane'], ['strony', 'Strony'], ['sklep', 'Sklep z aplikacjami'], ['statystyki', 'Statystyki'], ['bazy', 'Bazy danych'], ['kopie', 'Kopie zapasowe'], ['awaria', 'Plan awaryjny'], ['gry', 'Serwery gier'],
  ['-', 'Serwer'], ['uslugi', 'Usługi'], ['wydajnosc', 'Wydajność'], ['aktualizacje', 'Aktualizacje'], ['autopilot', 'Autopilot'], ['bezpieczenstwo', 'Bezpieczeństwo'], ['zapora', 'Zapora'], ['dysk', 'Dysk'], ['logi', 'Logi'], ['ssl', 'Certyfikaty SSL'], ['cron', 'Harmonogram'],
  ['-', 'Narzędzia'], ['terminal', 'Terminal'], ['dostep', 'Dostęp'], ['dziennik', 'Dziennik zmian'], ['ustawienia', 'Ustawienia panelu'], ['pomoc', 'Pomoc'],
];
let shell = null;

function buildShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Menu panelu' });
  const side = h('aside', { class: 'side' },
    h('button', { type: 'button', class: `brand brand-btn ${state.srv ? 'remote' : ''}`, onclick: (e) => window.openServerMenu?.(e.currentTarget), 'aria-label': 'Wybierz serwer', title: 'Wybierz serwer' }, h('div', { class: 'brand-ico' }, ico(state.srv ? 'serwery' : 'logo', 20)), h('div', { style: 'min-width:0' }, h('b', { class: 'ell', style: 'display:block' }, state.srv ? state.srvName : NM()), h('span', { class: 'brand-sub' }, state.srv ? 'zdalnie · zmień' : 'panel serwera', state.srv || isAdmin() ? ico('rozwin', 14) : null))),
    isAdmin() ? h('a', { href: '#/utworz', class: 'btn pri create-btn', onclick: () => toggleMenu(false) }, ico('plus'), 'Utwórz') : null,
    nav,
    h('button', { type: 'button', class: 'btn ghost sm help-btn', onclick: () => { toggleMenu(false); window.openHelp?.(); } }, ico('pomoc', 16), 'Pomoc do tej strony'),
    h('div', { class: 'who' },
      h('b', null, `Zalogowany: ${state.login}`),
      h('span', null, { wlasciciel: 'właściciel', admin: 'administrator', podglad: 'tylko podgląd', strony: 'wybrane strony' }[state.role] || 'login + kod z aplikacji'),
      h('div', { class: 'acts' }, linkBtn('Konto', '#/konto', { small: true, icon: 'konto' }), btn('Wyloguj', logout, { small: true, icon: 'wyloguj' }))));
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const menuBtn = btn('', () => toggleMenu(), { icon: 'menu', title: 'Menu' });
  const top = h('div', { class: 'topbar' }, h('button', { type: 'button', class: 'brand brand-btn', onclick: (e) => window.openServerMenu?.(e.currentTarget), 'aria-label': 'Wybierz serwer' }, h('div', { class: 'brand-ico' }, ico(state.srv ? 'serwery' : 'logo', 18)), h('b', null, state.srv ? state.srvName : NM()), state.srv || isAdmin() ? ico('rozwin', 14) : null), h('div', { class: 'acts' }, btn('', () => window.openHelp?.(), { icon: 'pomoc', title: 'Pomoc' }), menuBtn));
  const scrim = h('div', { class: 'scrim', hidden: true, onclick: () => toggleMenu(false) });
  app.replaceChildren(h('div', { class: 'shell' }, top, side, scrim, main));
  shell = { nav, side, main, scrim };
  renderNav();
}
function toggleMenu(open) {
  const o = open ?? !shell.side.classList.contains('open');
  shell.side.classList.toggle('open', o);
  shell.scrim.hidden = !o;
}
const NAV_MOD = { sklep: 'sklep', strony: 'strony', statystyki: 'statystyki', bazy: 'bazy', kopie: 'kopie', awaria: 'kopie', gry: 'gry', autopilot: 'autopilot', zapora: 'zapora', terminal: 'terminal', dostep: 'dostep' };
function navFor() {
  if (state.role === 'strony') return [['strony', 'Moje strony'], ['statystyki', 'Statystyki']];
  const list = NAV.filter(([id]) => (!['terminal', 'dostep'].includes(id) || state.role === 'wlasciciel') && (!NAV_MOD[id] || MOD(NAV_MOD[id])) && (id !== 'serwery' || (!state.srv && isAdmin())) && (id !== 'ustawienia' || (!state.srv && state.role === 'wlasciciel')));
  return list.filter(([id], i) => id !== '-' || (list[i + 1] && list[i + 1][0] !== '-'));
}
function renderNav() {
  if (!shell) return;
  let cur = (location.hash.slice(2).split(/[/?]/)[0]) || 'pulpit';
  if (cur === 'strona' || cur === 'statusowa') cur = 'strony';
  shell.nav.replaceChildren(...navFor().map(([id, label]) => id === '-' ? h('div', { class: 'nav-sec' }, label) : h('a', { href: `#/${id}`, class: id === cur ? 'on' : '', 'aria-current': id === cur ? 'page' : null, onclick: () => toggleMenu(false) },
    ico(id), label,
    id === 'pulpit' && state.alertsBad ? h('span', { class: 'dot', title: 'Są błędy' }) : (state.counts[id] != null ? h('span', { class: 'cnt' }, state.counts[id]) : null))));
}

async function logout() {
  try { await api('POST', 'api/wyloguj'); } catch {}
  state.login = null; shell = null;
  showLogin();
}

/* ------------------------------------------------------------ routing */

const PAGES = {};
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [p, qs = ''] = raw.split('?');
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'pulpit', args: parts.slice(1), q: new URLSearchParams(qs) };
}
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
function every(ms, fn) { const t = setInterval(() => { if (!document.hidden) fn(); }, ms); state.timers.push(t); }

let renderSeq = 0;
async function reload(quiet = true) {
  if (!state.login || !shell) return;
  const ae = document.activeElement;
  if (quiet && ae && shell.main.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && ae.type !== 'checkbox') return;
  if (quiet && document.querySelector('.modal-bg')) return;
  if (quiet && state.dirty) return;
  let { name, args, q } = parseHash();
  if (state.role === 'strony' && !['strony', 'strona', 'statystyki', 'konto'].includes(name)) name = 'strony';
  const page = PAGES[name] || PAGES.pulpit;
  const seq = ++renderSeq;
  const main = shell.main;
  const box = h('div', { style: 'display:contents' });
  try {
    await page(box, args, q, quiet);
    if (seq !== renderSeq) return;
    const y = window.scrollY;
    main.replaceChildren(...(state.srv && window.remoteBar ? [window.remoteBar()] : []), ...box.childNodes);
    if (quiet) window.scrollTo(0, y);
  } catch (e) {
    if (seq !== renderSeq || !state.login) return;
    if (!quiet || !main.childNodes.length) main.replaceChildren(h('div', { class: 'alert error' }, h('span', { class: 'tag' }, 'BŁĄD'), h('span', { class: 'txt' }, e.message)));
    else toast(e.message, 'bad');
  }
}
async function go() {
  if (!state.login) return;
  if (state.skipGo) { state.skipGo = false; return; }
  if (state.dirty && !confirm('Masz niezapisane zmiany w pliku. Wyjść bez zapisywania?')) { state.skipGo = true; history.back(); return; }
  state.dirty = false;
  if (state.cfg?.kreator && state.role === 'wlasciciel' && !state.srv && !/^#\/(ustawienia|konto)/.test(location.hash)) { location.hash = '#/ustawienia'; return; }
  if (!shell) buildShell();
  clearTimers();
  renderNav();
  shell.main.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spin' }), 'Ładuję…'));
  window.scrollTo(0, 0);
  await reload(false);
}
window.addEventListener('hashchange', go);

/* -------------------------------------------------------------- pulpit */

function sparkline(vals, color) {
  if (!vals || vals.length < 3) return null;
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', 'spark'); s.setAttribute('viewBox', `0 0 ${vals.length - 1} 100`); s.setAttribute('preserveAspectRatio', 'none');
  s.setAttribute('role', 'img'); s.setAttribute('aria-label', 'Wykres z ostatnich godzin');
  const pl = document.createElementNS(NS, 'polyline');
  pl.setAttribute('points', vals.map((v, i) => `${i},${100 - Math.max(2, Math.min(98, v))}`).join(' '));
  pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', color); pl.setAttribute('stroke-width', '2'); pl.setAttribute('vector-effect', 'non-scaling-stroke');
  s.append(pl);
  return s;
}
function bar(p, warnAt = 85, badAt = 93) {
  return h('div', { class: `bar ${p >= badAt ? 'bad' : p >= warnAt ? 'warn' : ''}`, role: 'meter', 'aria-valuenow': p, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${Math.max(1, Math.min(100, p))}%` }));
}
function gauge(label, value, barEl, sub, extra) {
  return h('div', { class: 'gauge' }, h('span', { class: 'l' }, label), h('span', { class: 'v' }, value), barEl, extra, h('span', { class: 'small muted' }, sub));
}
const LEVEL = { error: 'BŁĄD', warn: 'UWAGA', info: 'INFO', ok: 'OK' };
function alertsEl(list) {
  if (!list.length) return h('div', { class: 'alerts' }, h('div', { class: 'alert ok' }, h('span', { class: 'tag' }, 'OK'), h('span', { class: 'txt' }, 'Wszystko działa — żadnych problemów.')));
  return h('div', { class: 'alerts', 'aria-label': 'Alarmy' }, list.map((a) => h('div', { class: `alert ${a.level}` },
    h('span', { class: 'tag' }, LEVEL[a.level] || a.level), h('span', { class: 'txt' }, a.text), a.link ? h('a', { href: a.link, class: 'small', style: 'font-weight:600' }, 'Pokaż') : null)));
}
function svcDot(s) { return h('span', { class: `dot ${s.failed ? 'bad' : s.active ? '' : 'off'}`, title: s.failed ? 'padła' : s.active ? 'działa' : 'zatrzymana' }); }

async function svcAction(s, act, button) {
  const L = {
    restart: [`Uruchomić ponownie „${s.name}”?`, `Usługa ${s.unit} zrestartuje się — przez kilka sekund może nie odpowiadać.`, 'Restart'],
    przeladuj: [`Przeładować „${s.name}”?`, 'Konfiguracja zostanie wczytana ponownie bez przerywania połączeń.', 'Przeładuj'],
    stop: [`Zatrzymać „${s.name}”?`, `Usługa ${s.unit} przestanie działać, dopóki jej nie uruchomisz.`, 'Zatrzymaj'],
    start: [`Uruchomić „${s.name}”?`, '', 'Uruchom'],
  }[act];
  if (!(await ask({ title: L[0], text: L[1], ok: L[2], danger: act === 'stop' }))) return;
  await busy(button, async () => {
    try { const r = await api('POST', `api/uslugi/${encodeURIComponent(s.unit)}/${act}`); toast(`✓ ${s.name}: ${r.out && r.out.length < 120 ? r.out : 'gotowe'}`, 'ok'); }
    catch (e) { toast(e.message, 'bad'); }
  });
  reload();
}

PAGES.pulpit = async (box) => {
  const d = await api('GET', 'api/pulpit');
  state.counts.strony = d.sites.length; state.counts.uslugi = d.servicesCount;
  state.alertsBad = d.alerts.some((a) => a.level === 'error');
  renderNav();
  d.jobs.forEach(watchJob);
  const m = d.metrics;
  const memP = pct(m.mem.used, m.mem.total), diskP = pct(m.disk.used, m.disk.total);
  const b = d.backup;
  const lastBad = b.last && b.last.status === 'error';
  const sites = [...d.sites].filter((s) => s.enabled).sort((a, z) => (a.status === 'down' ? 0 : 1) - (z.status === 'down' ? 0 : 1) || a.name.localeCompare(z.name));
  put(box,
    h('div', { class: 'head' },
      h('div', null, h('h1', null, 'Pulpit'), h('div', { class: 'sub' }, `${m.ip || m.host} · ${m.os} · działa ${dur(m.uptime)} bez przerwy`)),
      h('div', { class: 'acts' }, linkBtn('Posprzątaj dysk', '#/dysk', { icon: 'sprzataj' }), btn('Zrób kopię teraz', backupNow, { kind: 'pri', icon: 'kopie' }))),
    alertsEl(d.alerts),
    h('section', { class: 'gauges', 'aria-label': 'Zasoby' },
      gauge('Procesor', `${Math.round(m.cpu.pct)}%`, bar(Math.round(m.cpu.pct), 70, 90), `${m.cpu.cores} ${plural(m.cpu.cores, 'rdzeń', 'rdzenie', 'rdzeni')} · obciążenie ${m.cpu.load[0].toFixed(2).replace('.', ',')}`, sparkline(m.history.map((x) => x.cpu), '#2bb39b')),
      gauge('Pamięć', bytesPair(m.mem.used, m.mem.total), bar(memP, 80, 92), `${bytes(m.mem.available)} dostępne`, sparkline(m.history.map((x) => x.mem), '#7dd3c0')),
      gauge('Dysk', bytesPair(m.disk.used, m.disk.total), bar(diskP), `${bytes(m.disk.free)} wolne`),
      gauge('Ostatnia kopia', b.lastOk ? when(b.lastOk.start) : 'brak', bar(lastBad ? 100 : b.lastOk ? 100 : 0, lastBad ? 0 : 101, 101),
        lastBad ? `ostatnia próba nieudana · następna ${when(b.next)}` : `następna ${when(b.next)}`)),
    h('div', { class: 'cols' },
      h('section', { class: 'card', 'aria-label': 'Usługi' },
        h('div', { class: 'card-h' }, h('h2', null, 'Usługi'), h('a', { href: '#/uslugi', class: 'small', style: 'font-weight:600' }, `Wszystkie ${d.servicesCount}`)),
        h('div', { class: 'rows' }, d.services.map((s) => h('div', { class: 'row' }, svcDot(s),
          h('div', { class: 'stack grow' }, h('span', { class: 't' }, s.name), h('span', { class: 's ell' }, `${s.unit}${s.since ? ' · od ' + when(s.since) : ''}`)),
          h('span', { class: 'small muted nowrap' }, bytes(s.mem)),
          (() => { const b2 = btn('', () => svcAction(s, s.unit === 'apache2' ? 'przeladuj' : 'restart', b2), { icon: 'restart', title: `Uruchom ponownie: ${s.name}` }); return b2; })())))),
      h('section', { class: 'card', 'aria-label': 'Strony' },
        h('div', { class: 'card-h' }, h('h2', null, 'Strony'), h('a', { href: '#/strony', class: 'small', style: 'font-weight:600' }, `Wszystkie ${d.sites.length}`)),
        h('div', { class: 'rows' }, sites.map((s) => h('div', { class: 'row' }, sitePill(s.status, s.code),
          h('a', { href: '#/strony', class: 'grow ell t', style: 'color:inherit' }, s.name),
          h('span', { class: 'small muted nowrap' }, s.certTo ? `SSL do ${when(s.certTo, { time: false })}` : '')))))),
  );
  every(10000, () => reload());
};

function sitePill(status, code) {
  const cls = { ok: 'ok', redirect: 'info', warn: 'warn', nodns: 'warn', down: 'bad', off: 'off' }[status] || 'off';
  return h('span', { class: `pill ${cls}`, title: { ok: 'działa', redirect: 'przekierowanie', warn: 'ostrzeżenie', nodns: 'brak wpisu DNS', down: 'nie działa', off: 'wyłączona' }[status] }, status === 'off' ? 'wył.' : status === 'nodns' ? 'DNS' : code ? String(code) : '✕');
}

/* -------------------------------------------------------------- strony */

PAGES.strony = async (box, args, q, quiet) => {
  const d = await api('GET', 'api/strony' + (q.has('odswiez') && !quiet ? '?odswiez' : ''));
  state.counts.strony = d.sites.length; renderNav();
  const rank = { down: 0, nodns: 1, warn: 1, ok: 2, redirect: 3, off: 4 };
  const list = [...d.sites].sort((a, z) => rank[a.status] - rank[z.status] || a.name.localeCompare(z.name));
  const toggle = async (s, b) => {
    const on = !s.enabled;
    if (!(await ask({ title: on ? `Włączyć ${s.name}?` : `Wyłączyć ${s.name}?`, text: on ? 'Strona znów zacznie odpowiadać.' : 'Strona przestanie się otwierać (Apache przestanie ją obsługiwać). Pliki zostają — możesz ją potem włączyć.', ok: on ? 'Włącz' : 'Wyłącz', danger: !on }))) return;
    await busy(b, async () => {
      try { await api('POST', `api/strony/${encodeURIComponent(s.name)}/${on ? 'wlacz' : 'wylacz'}`); toast(`✓ ${s.name} ${on ? 'włączona' : 'wyłączona'}`, 'ok'); }
      catch (e) { toast(e.message, 'bad'); }
    });
    location.hash = '#/strony?odswiez';
  };
  put(box,
    h('div', { class: 'head' },
      h('div', null, h('h1', null, 'Strony'), h('div', { class: 'sub' }, `${list.filter((s) => s.enabled).length} włączonych · stan sprawdzany co minutę`)),
      h('div', { class: 'acts' }, isAdmin() ? linkBtn('Strona statusu', '#/statusowa', { icon: 'ext' }) : null, (() => { const b = btn('Sprawdź teraz', () => busy(b, async () => { location.hash = '#/strony?odswiez'; if (q.has('odswiez')) await go(); }), { icon: 'odswiez' }); return b; })())),
    h('section', { class: 'card' }, h('div', { class: 'rows' }, list.map((s) => {
      const days = daysLeft(s.cert?.validTo);
      const target = s.services.length ? `aplikacja: ${s.services.join(', ')}` : s.dir ? `${s.dir}${s.size != null ? ' · ' + bytes(s.size) : ''}` : '';
      const tb = btn(s.enabled ? 'Wyłącz' : 'Włącz', () => toggle(s, tb), { small: true, kind: s.enabled ? '' : 'pri', disabled: s.enabled && (d.panelHosts || []).includes(s.name), title: (d.panelHosts || []).includes(s.name) ? 'Przez tę stronę działa panel' : null });
      return h('div', { class: 'row', style: 'flex-wrap:wrap' },
        sitePill(s.status, s.http?.code),
        h('div', { class: 'stack grow', style: 'flex-basis:240px' },
          h('a', { href: `${s.https ? 'https' : 'http'}://${s.name}/`, target: '_blank', rel: 'noopener noreferrer', class: 't', style: 'color:inherit' }, s.name, ' ', ico('ext', 13), d.created?.[s.name] ? h('span', { class: 'pill info', style: 'margin-left:8px;min-width:0' }, 'z panelu') : null),
          h('span', { class: 's' }, [target, s.aliases.length ? 'też: ' + s.aliases.join(', ') : '', s.http?.location ? '→ ' + s.http.location : '', s.http?.error ? (s.http.error === 'ENOTFOUND' ? 'brak wpisu DNS — dodaj rekord A w OVH' : 'błąd: ' + s.http.error) : ''].filter(Boolean).join(' · '))),
        h('div', { class: 'stack small', style: 'min-width:150px' },
          h('span', { class: days != null && days < 21 ? '' : 'muted', style: days != null && days < 21 ? 'color:var(--warn-ink)' : '' }, s.cert?.validTo ? `SSL do ${dateFull(s.cert.validTo)} (${days} ${plural(days, 'dzień', 'dni', 'dni')})` : s.https ? 'SSL: brak danych' : 'bez SSL'),
          h('span', { class: 'dim' }, [s.http ? `${s.http.ms} ms` : '', d.uptime?.[s.name] != null ? `dostępność 24 h: ${d.uptime[s.name].toFixed(d.uptime[s.name] >= 99.95 || d.uptime[s.name] === 0 ? 0 : 1).replace('.', ',')}%` : ''].filter(Boolean).join(' · '))),
        h('div', { class: 'acts' }, linkBtn('Zarządzaj', `#/strona/${encodeURIComponent(s.name)}`, { small: true, kind: 'pri' }), isAdmin() && s.logs[0] ? linkBtn('Logi', '#/logi?z=' + encodeURIComponent('f:' + s.logs[0]), { small: true, icon: 'logi' }) : null, isAdmin() ? tb : null));
    }))),
  );
};

/* -------------------------------------------------------------- usługi */

PAGES.uslugi = async (box) => {
  const d = await api('GET', 'api/uslugi');
  state.counts.uslugi = d.services.length; renderNav();
  const groups = [['app', 'Twoje aplikacje'], ['srv', 'Serwer'], ['other', 'Pozostałe']];
  const row = (s) => {
    const acts = [];
    const rb = btn('', () => svcAction(s, s.unit === 'apache2' ? 'przeladuj' : 'restart', rb), { icon: 'restart', small: true, title: s.unit === 'apache2' ? 'Przeładuj' : 'Uruchom ponownie' });
    if (s.active) acts.push(rb);
    if (s.active && s.canStop) { const sb = btn('', () => svcAction(s, 'stop', sb), { icon: 'stop', small: true, title: 'Zatrzymaj' }); acts.push(sb); }
    if (!s.active) { const st = btn('Uruchom', () => svcAction(s, 'start', st), { icon: 'play', small: true, kind: 'pri' }); acts.push(st); }
    acts.push(linkBtn('Logi', '#/logi?z=' + encodeURIComponent('j:' + s.unit), { small: true }));
    return h('div', { class: 'row', style: 'flex-wrap:wrap' }, svcDot(s),
      h('div', { class: 'stack grow', style: 'flex-basis:220px' },
        h('span', { class: 't' }, s.name, s.failed ? h('span', { class: 'pill bad', style: 'margin-left:8px' }, 'padła') : !s.active ? h('span', { class: 'pill off', style: 'margin-left:8px' }, 'zatrzymana') : null),
        h('span', { class: 's' }, `${s.unit} · ${s.desc}`)),
      h('div', { class: 'stack small', style: 'min-width:130px' },
        h('span', { class: 'muted' }, s.since ? `działa od ${when(s.since)}` : s.state),
        h('span', { class: 'dim' }, [s.mem != null ? bytes(s.mem) + ' RAM' : '', s.restarts ? `${s.restarts}× restart` : ''].filter(Boolean).join(' · '))),
      h('div', { class: 'acts' }, acts));
  };
  const tests = d.tests;
  const stopTests = async (pids, b) => {
    if (!(await ask({ title: pids ? 'Zatrzymać ten proces?' : `Zatrzymać wszystkie procesy testowe (${tests.length})?`, text: 'To kopie testowe uruchomione przy pracy nad stronami (z folderów tymczasowych). Prawdziwe strony i usługi działają dalej.', ok: 'Zatrzymaj', danger: true }))) return;
    await busy(b, async () => {
      try { const r = await api('POST', 'api/testowe/zatrzymaj', pids ? { pids } : {}); toast(`✓ Zatrzymano ${r.killed.length} ${plural(r.killed.length, 'proces', 'procesy', 'procesów')}`, 'ok'); }
      catch (e) { toast(e.message, 'bad'); }
    });
    setTimeout(() => reload(), 800);
  };
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Usługi'), h('div', { class: 'sub' }, `${d.services.filter((s) => s.active).length} działa · ${d.services.filter((s) => s.failed).length} padło`))),
    groups.map(([g, label]) => {
      const list = d.services.filter((s) => s.group === g);
      return list.length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, label)), h('div', { class: 'rows' }, list.map(row))) : null;
    }),
    h('section', { class: 'card' },
      h('div', { class: 'card-h' },
        h('div', null, h('h2', null, 'Procesy testowe'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Kopie stron uruchomione przy pracy z Claude (w /tmp). Zajmują pamięć, a nikt z nich nie korzysta.')),
        tests.length ? (() => { const b = btn(`Zatrzymaj wszystkie (${bytes(tests.reduce((a, p) => a + p.rss, 0))})`, () => stopTests(null, b), { small: true, kind: 'danger', icon: 'stop' }); return b; })() : null),
      tests.length ? h('div', { class: 'rows' }, tests.map((p) => {
        const b = btn('', () => stopTests([p.pid], b), { icon: 'stop', small: true, title: 'Zatrzymaj' });
        return h('div', { class: 'row' },
          h('div', { class: 'stack grow' }, h('span', { class: 'mono ell' }, p.what), h('span', { class: 's' }, `PID ${p.pid}${p.ports.length ? ' · port ' + p.ports.join(', ') : ''} · sesja ${p.session || '?'} · od ${when(p.start)}`)),
          h('span', { class: 'small muted nowrap' }, bytes(p.rss)), b);
      })) : h('div', { class: 'list-empty' }, 'Brak — nic testowego nie działa.')),
  );
  every(15000, () => reload());
};

/* --------------------------------------------------------------- bazy */

PAGES.bazy = async (box, args, q) => {
  const [type, id, sub, table] = args;
  if (type && id && sub === 'tabela' && table) return dbRowsPage(box, type, id, table, Number(q.get('od')) || 0);
  if (type && id) return dbTablesPage(box, type, id);
  const d = await api('GET', 'api/bazy');
  const showSys = q.has('systemowe');
  const dl = (type2, id2) => linkBtn('Pobierz', `api/bazy/${type2}/${encodeURIComponent(id2)}/pobierz`, { small: true, icon: 'pobierz' });
  const section = (title, sub2, items, render) => h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, title), sub2 ? h('div', { class: 'small muted', style: 'margin-top:4px' }, sub2) : null)), items.length ? h('div', { class: 'rows' }, items.map(render)) : h('div', { class: 'list-empty' }, 'Brak.'));
  const maria = d.maria.filter((x) => showSys || !x.system);
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Bazy danych'), h('div', { class: 'sub' }, 'Przeglądanie jest tylko do odczytu. Hasła, tokeny i klucze są ukryte.'))),
    section('MariaDB', 'bazy stron w PHP', maria, (x) => x.error ? h('div', { class: 'row' }, h('span', { class: 'pill bad' }, 'BŁĄD'), x.error) : h('div', { class: 'row', style: 'flex-wrap:wrap' },
      h('div', { class: 'stack grow', style: 'flex-basis:200px' }, h('a', { href: `#/bazy/mariadb/${encodeURIComponent(x.id)}`, class: 't', style: 'color:inherit' }, x.name, x.system ? h('span', { class: 'pill off', style: 'margin-left:8px' }, 'systemowa') : null), h('span', { class: 's' }, `${x.tables} ${plural(x.tables, 'tabela', 'tabele', 'tabel')}${x.changed ? ' · zmiana ' + when(x.changed) : ''}`)),
      h('span', { class: 'small muted nowrap', style: 'min-width:70px' }, bytes(x.size)),
      h('div', { class: 'acts' }, linkBtn('Tabele', `#/bazy/mariadb/${encodeURIComponent(x.id)}`, { small: true }), dl('mariadb', x.id)))),
    h('div', { class: 'acts' }, h('a', { href: showSys ? '#/bazy' : '#/bazy?systemowe', class: 'small' }, showSys ? 'Ukryj bazę systemową' : 'Pokaż bazę systemową (mysql)')),
    section('SQLite', 'bazy w jednym pliku (np. aplikacji)', d.lite, (x) => h('div', { class: 'row', style: 'flex-wrap:wrap' },
      h('div', { class: 'stack grow', style: 'flex-basis:200px' }, h('a', { href: `#/bazy/sqlite/${x.id}`, class: 't', style: 'color:inherit' }, x.name), h('span', { class: 's' }, `${x.path} · ${x.tables} ${plural(x.tables, 'tabela', 'tabele', 'tabel')} · zmiana ${when(x.changed)}`)),
      h('span', { class: 'small muted nowrap', style: 'min-width:70px' }, bytes(x.size)),
      h('div', { class: 'acts' }, linkBtn('Tabele', `#/bazy/sqlite/${x.id}`, { small: true }), dl('sqlite', x.id)))),
    section('Dane w plikach', 'gry i aplikacje trzymające dane w katalogach — do pobrania jako .tar.gz', d.files, (x) => h('div', { class: 'row', style: 'flex-wrap:wrap' },
      h('div', { class: 'stack grow', style: 'flex-basis:200px' }, h('span', { class: 't' }, x.name), h('span', { class: 's' }, `${x.path} · zmiana ${when(x.changed)}`)),
      h('span', { class: 'small muted nowrap', style: 'min-width:70px' }, bytes(x.size)),
      h('div', { class: 'acts' }, dl('pliki', x.id)))),
  );
};

function backLink(href, label) { return h('a', { href, class: 'small', style: 'display:inline-flex;align-items:center;gap:4px;min-height:32px' }, ico('wstecz', 16), label); }

async function dbTablesPage(box, type, id) {
  const d = await api('GET', `api/bazy/${type}/${encodeURIComponent(id)}/tabele`);
  put(box,
    backLink('#/bazy', 'Bazy danych'),
    h('div', { class: 'head' }, h('div', null, h('h1', null, id), h('div', { class: 'sub' }, `${type === 'mariadb' ? 'MariaDB' : 'SQLite'} · ${d.tables.length} ${plural(d.tables.length, 'tabela', 'tabele', 'tabel')}`)),
      h('div', { class: 'acts' }, linkBtn('Pobierz całą bazę', `api/bazy/${type}/${encodeURIComponent(id)}/pobierz`, { icon: 'pobierz' }))),
    h('section', { class: 'card' }, h('div', { class: 'rows' }, d.tables.map((t) => h('a', { class: 'row', href: `#/bazy/${type}/${encodeURIComponent(id)}/tabela/${encodeURIComponent(t.name)}`, style: 'color:inherit' },
      h('span', { class: 'grow t mono ell' }, t.name),
      h('span', { class: 'small muted nowrap' }, t.rows == null ? '' : `${t.approx ? '~' : ''}${t.rows.toLocaleString('pl-PL')} ${plural(t.rows, 'wiersz', 'wiersze', 'wierszy')}`),
      t.size != null ? h('span', { class: 'small dim nowrap', style: 'min-width:64px;text-align:right' }, bytes(t.size)) : null)))),
  );
}

async function dbRowsPage(box, type, id, table, od) {
  const d = await api('GET', `api/bazy/${type}/${encodeURIComponent(id)}/tabela/${encodeURIComponent(table)}?od=${od}`);
  const base = `#/bazy/${type}/${encodeURIComponent(id)}/tabela/${encodeURIComponent(table)}`;
  const to = Math.min(od + d.rows.length, od + d.limit);
  put(box,
    backLink(`#/bazy/${type}/${encodeURIComponent(id)}`, id),
    h('div', { class: 'head' }, h('div', null, h('h1', { class: 'mono', style: 'font-size:24px' }, table), h('div', { class: 'sub' }, d.rows.length ? `wiersze ${od + 1}–${to}${d.total != null ? ' z ' + d.total.toLocaleString('pl-PL') : ''}` : 'tabela jest pusta')),
      h('div', { class: 'acts' },
        od > 0 ? linkBtn('Poprzednie', `${base}?od=${Math.max(0, od - d.limit)}`, { small: true }) : null,
        d.rows.length === d.limit ? linkBtn('Następne', `${base}?od=${od + d.limit}`, { small: true }) : null)),
    d.rows.length ? h('div', { class: 'scroll', style: 'max-height:70vh' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, d.cols.map((c) => h('th', null, c)))),
      h('tbody', null, d.rows.map((r) => h('tr', null, r.map((v) => h('td', { class: v == null ? 'null' : '', title: v != null && v.length > 40 ? v : null }, v == null ? 'NULL' : v))))))) : null,
  );
}

/* --------------------------------------------------------------- kopie */

function cloudCard(c) {
  const P = c.providers;
  const call = async (b, method, path, body, okMsg) => {
    await busy(b, async () => { try { const r = await api(method, path, body); if (r?.job) watchJob(r.job); else if (okMsg) toast(okMsg, 'ok'); } catch (e) { toast(e.message, 'bad'); } });
    reload();
  };
  const formBox = h('div', { class: 'stack', style: 'gap:12px' });
  const showForm = () => {
    let prov = c.provider || (c.groupServers?.length ? 'grupa' : 'b2');
    const fields = h('div', { class: 'form-grid' });
    const hint = h('div', { class: 'small muted' });
    const steps = h('ol', { class: 'small', style: 'margin:0;padding-left:20px;line-height:1.6;color:#c9d1dc' });
    const inputs = {};
    const draw = () => {
      hint.textContent = P[prov].hint;
      if (prov === 'grupa') {
        const gs = c.groupServers || [];
        const sel = h('select', { class: 'input', id: 'kopie-serwer', 'aria-label': 'Serwer na kopie' }, gs.map((x) => h('option', { value: x.id, selected: c.provider === 'grupa' && c.cfg.server === x.id || null }, `${x.nazwa} — ${x.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}`)));
        inputs.server = sel;
        fields.replaceChildren(gs.length ? h('label', { class: 'field' }, h('span', null, 'Serwer'), sel) : h('div', { class: 'small', style: 'color:var(--warn-ink)' }, 'Nie ma jeszcze drugiego serwera z prawem zarządzania. Połącz go na stronie ', h('a', { href: '#/serwery' }, 'Wszystkie serwery'), '.'));
        steps.replaceChildren(h('li', null, 'Na tamtym serwerze nic nie trzeba robić — ten panel sam poprosi o zamknięte konto na kopie.'), h('li', null, 'Kopie są szyfrowane tutaj; tamten serwer widzi tylko zaszyfrowane pliki.'), h('li', null, 'Najlepiej, gdy tamten serwer robi kopie u Ciebie — padnie jeden, kopia jest na drugim.'));
        return;
      }
      fields.replaceChildren(...P[prov].fields.map(([k, label, secret]) => {
        const i = h('input', { class: 'input', type: secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', value: c.provider === prov ? c.cfg[k] || '' : (k === 'port' ? (prov === 'sftp' ? '23' : '') : '') });
        inputs[k] = i;
        return h('label', { class: 'field' }, h('span', null, label), i);
      }));
      steps.replaceChildren(...(prov === 'b2' ? [
        h('li', null, 'Załóż darmowe konto na ', h('a', { href: 'https://www.backblaze.com/sign-up/cloud-storage', target: '_blank', rel: 'noopener noreferrer' }, 'backblaze.com'), ' (B2 Cloud Storage).'),
        h('li', null, 'Buckets → Create a Bucket: dowolna nazwa, Files in Bucket: Private.'),
        h('li', null, 'Application Keys → Add a New Application Key: dostęp tylko do tego koszyka, Read and Write.'),
        h('li', null, 'Skopiuj tutaj keyID i applicationKey (applicationKey pokazuje się tylko raz).')]
        : prov === 'sftp' ? [h('li', null, 'Hetzner Storage Box: włącz w ustawieniach SSH/SFTP, port 23, użytkownik u123456.'), h('li', null, 'NAS w domu: konto z dostępem SFTP i katalog na kopie.')]
        : [h('li', null, 'Utwórz prywatny koszyk i klucz z prawem zapisu tylko do niego.')]));
    };
    const pick = h('div', { class: 'acts', style: 'flex-wrap:wrap' }, Object.entries(P).map(([id, v]) => {
      const b = h('button', { type: 'button', class: `btn sm ${id === prov ? 'pri' : ''}` }, v.name.split(' (')[0]);
      b.onclick = () => { prov = id; [...pick.children].forEach((x) => x.classList.toggle('pri', x === b)); draw(); };
      return b;
    }));
    const go = h('button', { type: 'button', class: 'btn pri' }, 'Połącz i sprawdź');
    go.onclick = () => call(go, 'POST', 'api/chmura/ustaw', { provider: prov, cfg: Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])) }, '✓ Połączono — pierwsza wysyłka pójdzie dziś w nocy (albo kliknij „Wyślij teraz”)');
    draw();
    formBox.replaceChildren(pick, hint, steps, fields, h('div', { class: 'small muted' }, 'Przed wysłaniem wszystko jest szyfrowane na serwerze. Klucz do odszyfrowania pobierzesz po połączeniu — trzymaj go poza serwerem.'), h('div', null, go));
  };
  if (!c.configured) {
    showForm();
    return h('section', { class: 'card', id: 'chmura' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Kopie poza serwerem'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Teraz kopie leżą tylko na tym samym dysku co strony. Jeśli dysk padnie, przepadną razem z nimi. Podłącz miejsce w chmurze — kopie pójdą tam co noc, zaszyfrowane.'))), formBox);
  }
  const L = c.last, T = c.lastTest;
  const sendB = btn('Wyślij teraz', () => call(sendB, 'POST', 'api/chmura/wyslij'), { small: true, icon: 'chmura', kind: 'pri', disabled: c.busy });
  const testB = btn('Sprawdź kopię', () => call(testB, 'POST', 'api/chmura/sprawdz'), { small: true, icon: 'sprawdz', disabled: c.busy });
  const keyB = h('a', { class: 'btn sm', href: 'api/chmura/klucz' }, ico('pobierz', 16), 'Pakiet odzyskiwania');
  keyB.onclick = async (e) => { e.preventDefault(); if (await ask({ title: 'Pobrać pakiet odzyskiwania?', text: 'To plik z kluczami do Twoich kopii w chmurze. Zapisz go poza serwerem (np. w menedżerze haseł) — bez niego nie da się odszyfrować kopii, gdy serwera zabraknie. Nie wysyłaj go nikomu.', ok: 'Pobierz' })) location.href = apiPath('api/chmura/klucz'); };
  const media = h('input', { type: 'checkbox', checked: c.media });
  media.onchange = () => call(null, 'POST', 'api/chmura/opcje', { media: media.checked }, media.checked ? '✓ Pliki stron też idą do chmury' : 'Pliki stron nie będą wysyłane');
  const on = h('input', { type: 'checkbox', checked: c.enabled });
  on.onchange = () => call(null, 'POST', 'api/chmura/opcje', { enabled: on.checked }, on.checked ? '✓ Wysyłka co noc włączona' : 'Wysyłka wyłączona');
  const editB = btn('Zmień', () => { showForm(); editB.replaceWith(formBox); }, { small: true, kind: 'ghost' });
  const gb = (n) => n ? `${(n / 1073741824).toFixed(2).replace('.', ',')} GB` : '';
  return h('section', { class: 'card', id: 'chmura' },
    h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Kopie poza serwerem'), h('div', { class: 'small muted', style: 'margin-top:4px' }, `${P[c.provider]?.name.split(' (')[0]}${c.provider === 'grupa' && c.cfg.nazwa ? ': ' + c.cfg.nazwa : ''} · co noc o ${pad(c.hour)}:${pad(c.minute)} · zaszyfrowane · trzymane ${c.keepDays} dni`)), h('div', { class: 'acts' }, sendB, testB)),
    h('div', { class: 'rows' },
      h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('b', { class: 'grow' }, 'Ostatnia wysyłka'), L ? h('span', { class: 'small muted' }, `${when(L.start)}${L.total ? (c.provider === 'grupa' ? ' · na tamtym serwerze ' : ' · w chmurze ') + gb(L.total) : ''}`) : h('span', { class: 'small muted' }, 'jeszcze nie było'), L ? h('span', { class: `pill ${L.ok ? 'ok' : 'bad'}` }, L.ok ? 'OK' : 'BŁĄD') : null),
      L && !L.ok ? h('div', { class: 'row small', style: 'color:var(--bad-ink)' }, L.msg) : null,
      h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('b', { class: 'grow' }, 'Test odczytu'), T ? h('span', { class: 'small muted' }, `${when(T.start)}${T.file ? ' · ' + T.file : ''}`) : h('span', { class: 'small muted' }, 'co niedzielę rano — jeszcze nie było'), T ? h('span', { class: `pill ${T.ok ? 'ok' : 'bad'}` }, T.ok ? 'da się odczytać' : 'BŁĄD') : null),
      T && !T.ok ? h('div', { class: 'row small', style: 'color:var(--bad-ink)' }, T.msg) : null,
      h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('label', { class: 'check grow' }, on, h('b', null, 'Wysyłaj co noc')), h('label', { class: 'check' }, media, h('span', null, 'razem z plikami stron (migawka)'))),
      h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('span', { class: 'grow small muted', style: 'flex-basis:240px' }, 'Bez klucza kopii nie da się odszyfrować. Pobierz go raz i trzymaj poza serwerem.'), keyB, editB)));
}

PAGES.kopie = async (box) => {
  const d = await api('GET', 'api/kopie');
  d.jobs.filter((j) => !j.end).forEach(watchJob);
  const lastOk = d.runs.find((r) => r.status === 'ok');
  const s = d.settings;
  const runPill = (r) => h('span', { class: `pill ${r.status === 'ok' ? 'ok' : r.status === 'error' ? 'bad' : 'info'}` }, r.status === 'ok' ? 'OK' : r.status === 'error' ? 'BŁĄD' : 'TRWA');
  const del = async (f, b) => {
    if (!(await ask({ title: 'Usunąć tę kopię?', text: `${f.label}\n${f.path}\n\nTego nie da się cofnąć.`, ok: 'Usuń', danger: true }))) return;
    await busy(b, async () => { try { await api('POST', 'api/kopie/usun', { p: f.path }); toast('✓ Usunięto', 'ok'); } catch (e) { toast(e.message, 'bad'); } });
    reload();
  };
  const restore = async (f, b) => {
    let plan;
    try { plan = await api('POST', 'api/kopie/plan', { p: f.path }); } catch (e) { return toast(e.message, 'bad'); }
    const typed = await ask({ title: 'Przywrócić tę kopię?', text: plan.text + `\n\nKopia: ${f.name}`, ok: 'Przywróć', danger: true, typed: plan.confirm });
    if (!typed) return;
    await busy(b, async () => { try { const r = await api('POST', 'api/kopie/przywroc', { p: f.path, confirm: typed }); watchJob(r.job); } catch (e) { toast(e.message, 'bad'); } });
  };
  const fileRow = (f, canRestore) => {
    const db = btn('', () => del(f, db), { icon: 'usun', small: true, title: 'Usuń' });
    const rb = canRestore ? btn('Przywróć', () => restore(f, rb), { icon: 'przywroc', small: true }) : null;
    return h('div', { class: 'row', style: 'flex-wrap:wrap' },
      h('div', { class: 'stack grow', style: 'flex-basis:200px' }, h('span', { class: 't' }, f.label), h('span', { class: 's ell' }, (f.time && f.kind.startsWith('gibcord') ? when(f.time) + ' · ' : '') + f.name)),
      h('span', { class: 'small muted nowrap', style: 'min-width:64px' }, f.dir ? 'folder' : bytes(f.size)),
      h('div', { class: 'acts' }, rb, linkBtn('', `api/kopie/pobierz?p=${encodeURIComponent(f.path)}`, { icon: 'pobierz', small: true }), db));
  };
  const form = h('form', { class: 'form-grid', onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { await api('POST', 'api/kopie/ustawienia', Object.fromEntries([...fd].map(([k, v]) => [k, Number(v)]))); toast('✓ Zapisano ustawienia kopii', 'ok'); reload(); }
    catch (er) { toast(er.message, 'bad'); }
  } },
    h('label', { class: 'field' }, h('span', null, 'Zrzuty baz — ile dni trzymać'), h('input', { class: 'input', name: 'keepDb', type: 'number', min: 1, max: 90, value: s.keepDb, inputmode: 'numeric' })),
    h('label', { class: 'field' }, h('span', null, 'Kod i konfiguracja — ile dni'), h('input', { class: 'input', name: 'keepCode', type: 'number', min: 1, max: 90, value: s.keepCode, inputmode: 'numeric' })),
    h('label', { class: 'field' }, h('span', null, 'Migawki plików — ile sztuk'), h('input', { class: 'input', name: 'keepMedia', type: 'number', min: 1, max: 10, value: s.keepMedia, inputmode: 'numeric' })),
    h('label', { class: 'field' }, h('span', null, 'Nie rób kopii, gdy wolnego mniej niż (MB)'), h('input', { class: 'input', name: 'minFreeMb', type: 'number', min: 500, max: 20000, step: 100, value: s.minFreeMb, inputmode: 'numeric' })),
    h('div', { class: 'field', style: 'justify-content:flex-end;flex:0 0 auto' }, h('button', { class: 'btn pri', type: 'submit' }, 'Zapisz')));
  const f = d.files;
  put(box,
    h('div', { class: 'head' },
      h('div', null, h('h1', null, 'Kopie zapasowe'), h('div', { class: 'sub' }, `Codziennie o ${pad(s.hour)}:${pad(s.minute)} · ostatnia udana ${lastOk ? when(lastOk.start) : '—'} · następna ${when(d.next)}`)),
      h('div', { class: 'acts' }, btn('Zrób kopię teraz', backupNow, { kind: 'pri', icon: 'kopie' }))),
    d.runs[0]?.status === 'error' ? h('div', { class: 'alert warn' }, h('span', { class: 'tag' }, 'UWAGA'), h('span', { class: 'txt' }, `Ostatnia próba (${when(d.runs[0].start)}): ${d.runs[0].error}`)) : null,
    cloudCard(d.chmura),
    h('div', { class: 'cols' },
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Ostatnie przebiegi')),
        h('div', { class: 'rows' }, d.runs.slice(0, 10).map((r) => h('details', { class: 'row', style: 'display:block' },
          h('summary', { style: 'display:flex;align-items:center;gap:12px;cursor:pointer;min-height:36px' }, runPill(r), h('span', { class: 'grow' }, when(r.start)), h('span', { class: 'small muted' }, r.status === 'error' ? r.error.slice(0, 60) : r.size ? `razem ${r.size.replace('.', ',')}` : '')),
          h('div', { class: 'out' }, r.lines.join('\n')))))),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Ustawienia')), form,
        h('p', { class: 'small muted', style: 'margin:14px 0 0' }, `Migawki obejmują: ${s.mediaDirs.join(', ') || '—'} (na twardych linkach — niezmienione pliki nie zajmują miejsca drugi raz).`))),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Ręczne kopie komunikatora'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Robione przed każdym wdrożeniem nowej wersji (w /root). Bazę GibCorda można stąd przywrócić.'))),
      f.manual.length ? h('div', { class: 'rows' }, f.manual.map((x) => fileRow(x, x.kind === 'gibcord-db'))) : h('div', { class: 'list-empty' }, 'Brak.')),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Kopie nocne')),
      f.groups.length ? f.groups.map((g) => h('details', { class: 'row', style: 'display:block', open: g === f.groups[0] ? true : null },
        h('summary', { style: 'display:flex;align-items:center;gap:12px;cursor:pointer;min-height:40px' }, h('b', { class: 'grow' }, when(g.time)), h('span', { class: 'small muted' }, `${g.files.length} ${plural(g.files.length, 'plik', 'pliki', 'plików')} · ${bytes(g.size)}`)),
        h('div', { class: 'rows', style: 'padding-left:6px' }, g.files.map((x) => fileRow(x, x.kind === 'db'))))) : h('div', { class: 'list-empty' }, 'Brak kopii.')),
    f.trash?.length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Kopie usuniętych rzeczy'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Panel robi je przed usunięciem strony, aplikacji albo bazy.'))),
      h('div', { class: 'rows' }, f.trash.map((x) => fileRow(x, false)))) : null,
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Migawki przesłanych plików')),
      f.snaps.length ? h('div', { class: 'rows' }, f.snaps.map((x) => h('div', { class: 'row' },
        h('div', { class: 'stack grow' }, h('span', { class: 't' }, x.name), h('span', { class: 's' }, x.parts.join(', '))),
        linkBtn('', `api/kopie/pobierz?p=${encodeURIComponent(x.path)}`, { icon: 'pobierz', small: true })))) : h('div', { class: 'list-empty' }, 'Brak.')),
  );
};

/* ---------------------------------------------------------------- dysk */

PAGES.dysk = async (box, args, q) => {
  const dir = q.get('dir') || '/';
  const d = await api('GET', `api/dysk?dir=${encodeURIComponent(dir)}`);
  const m = d.metrics;
  const p = pct(m.used, m.total);
  const checks = d.clean.map((c) => h('input', { type: 'checkbox', value: c.id, checked: c.size > 1024 * 1024 && c.id !== 'kopie-reczne' ? true : null, disabled: c.size <= 0 ? true : null }));
  const doClean = async (b) => {
    const ids = checks.filter((c) => c.checked).map((c) => c.value);
    if (!ids.length) return toast('Nic nie zaznaczono.');
    const sum = d.clean.filter((c) => ids.includes(c.id)).reduce((a, c) => a + c.size, 0);
    if (!(await ask({ title: 'Posprzątać?', text: `Usunę zaznaczone rzeczy (ok. ${bytes(sum)}). To tylko pliki tymczasowe, pamięć podręczna i stare kopie — strony i dane zostają.`, ok: 'Posprzątaj' }))) return;
    await busy(b, async () => { try { const r = await api('POST', 'api/dysk/sprzataj', { ids }); watchJob(r.job); } catch (e) { toast(e.message, 'bad'); } });
  };
  const parts = dir === '/' ? [] : dir.split('/').filter(Boolean);
  const tree = d.tree;
  const max = tree.children[0]?.size || 1;
  const cb = btn('Posprzątaj zaznaczone', () => doClean(cb), { kind: 'pri', icon: 'sprzataj' });
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Dysk'), h('div', { class: 'sub' }, `${bytes(m.used)} z ${bytes(m.total)} zajęte · ${bytes(m.free)} wolne`))),
    h('section', { class: 'card' }, h('div', { style: 'display:flex;justify-content:space-between;gap:12px;margin-bottom:10px' }, h('b', { style: 'font-family:var(--head);font-size:22px' }, `${p}%`), h('span', { class: 'muted small' }, p >= 85 ? 'mało miejsca' : 'w porządku')), bar(p)),
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Co można bezpiecznie usunąć'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Pliki tymczasowe i pamięć podręczna — strony, bazy i nocne kopie zostają.')), cb),
      h('div', { class: 'rows' }, d.clean.map((c, i) => h('label', { class: 'row check', style: 'cursor:pointer' }, checks[i],
        h('div', { class: 'stack grow' }, h('span', { class: 't' }, c.name), h('span', { class: 's' }, c.desc)),
        h('b', { class: 'nowrap', style: c.size > 0 ? '' : 'color:var(--dim)' }, c.size > 0 ? bytes(c.size) : 'nic'))))),
    h('section', { class: 'card' },
      h('div', { class: 'card-h' },
        h('div', null, h('h2', null, 'Co zajmuje miejsce'), h('div', { class: 'small muted', style: 'margin-top:4px' }, d.du.busy ? 'Liczę… (to trwa do minuty)' : tree.at ? `policzone ${ago(tree.at)}` : 'jeszcze nie policzone')),
        (() => { const b = btn('Przelicz', async () => { await busy(b, () => api('POST', 'api/dysk/przelicz')); toast('Liczę od nowa — odśwież za chwilę.'); setTimeout(() => reload(), 20000); }, { small: true, icon: 'odswiez' }); return b; })()),
      h('div', { class: 'crumbs' }, h('a', { href: '#/dysk' }, '/'), parts.map((x, i) => [h('span', { class: 'dim' }, i ? '/' : ''), h('a', { href: '#/dysk?dir=' + encodeURIComponent('/' + parts.slice(0, i + 1).join('/')) }, x)]), tree.size != null ? h('span', { class: 'muted', style: 'margin-left:8px' }, `· ${bytes(tree.size)}`) : null),
      tree.children.length ? h('div', null, tree.children.map((c) => h('div', { class: 'du-row' },
        h('div', { class: 'nm ell mono' }, c.more ? h('a', { href: '#/dysk?dir=' + encodeURIComponent(c.path) }, c.name + '/') : h('span', null, c.name + '/')),
        h('div', { class: 'br' }, h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(1, c.size / max * 100)}%` }))),
        h('span', { class: 'sz small' }, bytes(c.size)))), tree.others ? h('div', { class: 'du-row' }, h('span', { class: 'nm muted' }, 'pozostałe'), h('div', { class: 'br' }), h('span', { class: 'sz small muted' }, bytes(tree.others))) : null)
        : h('div', { class: 'list-empty' }, d.du.busy || !tree.at ? 'Liczę rozmiary katalogów…' : 'Brak podkatalogów (albo za głęboko — pokazuję do 4 poziomów).')),
  );
  if (d.du.busy || !tree.at) every(8000, () => reload());
};

/* ---------------------------------------------------------------- logi */

let logSourcesCache = null;
PAGES.logi = async (box, args, q) => {
  if (!logSourcesCache) logSourcesCache = (await api('GET', 'api/logi/zrodla')).sources;
  const z = q.get('z') || 'panel', n = q.get('n') || '200', f = q.get('f') || '', auto = q.has('na-zywo');
  const d = await api('GET', `api/logi?z=${encodeURIComponent(z)}&n=${n}&f=${encodeURIComponent(f)}`);
  const sel = h('select', { class: 'input', 'aria-label': 'Źródło logów' });
  const groups = {};
  for (const s of logSourcesCache) (groups[s.group] ||= []).push(s);
  for (const [g, list] of Object.entries(groups)) sel.append(h('optgroup', { label: g }, list.map((s) => h('option', { value: s.id }, s.name))));
  if (!logSourcesCache.some((s) => s.id === z)) sel.append(h('option', { value: z }, z));
  sel.value = z;
  const nSel = h('select', { class: 'input', 'aria-label': 'Ile linii' }, ['100', '200', '500', '1000', '2000'].map((x) => h('option', { value: x }, `${x} linii`)));
  nSel.value = n;
  const fIn = h('input', { class: 'input', type: 'search', placeholder: 'Szukaj w logach…', value: f, 'aria-label': 'Filtr' });
  const liveC = h('input', { type: 'checkbox', checked: auto });
  const apply = () => { const p = new URLSearchParams({ z: sel.value, n: nSel.value }); if (fIn.value.trim()) p.set('f', fIn.value.trim()); if (liveC.checked) p.set('na-zywo', ''); location.hash = '#/logi?' + p.toString().replace(/=(&|$)/g, '$1'); };
  sel.onchange = apply; nSel.onchange = apply; liveC.onchange = apply;
  fIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  let body;
  if (d.audit) {
    body = d.audit.length ? h('div', { class: 'scroll' }, h('table', { class: 't logs-table' },
      h('thead', null, h('tr', null, ['Kiedy', 'Kto', 'Skąd', 'Co', 'Szczegóły', 'Wynik'].map((x) => h('th', null, x)))),
      h('tbody', null, d.audit.map((r) => h('tr', null, h('td', { class: 'nowrap' }, when(r.ts)), h('td', null, r.login || '—'), h('td', { class: 'mono' }, r.ip), h('td', { class: 'mono' }, r.action), h('td', null, r.detail), h('td', null, h('span', { class: `pill ${r.ok ? 'ok' : 'bad'}` }, r.ok ? 'OK' : 'nie'))))))) : h('div', { class: 'list-empty' }, 'Pusto.');
  } else {
    body = h('div', { class: 'logbox', role: 'log' }, d.lines.length ? d.lines.map((l) => {
      const c = /\b(error|err|fail(ed)?|fatal|crit|błąd|blad|emerg|denied|refused)\b/i.test(l) ? 'e' : /\b(warn(ing)?|ostrzezenie|uwaga|notice)\b/i.test(l) ? 'w' : '';
      return h('div', { class: c }, l);
    }) : 'Pusto.');
  }
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Logi'), h('div', { class: 'sub' }, d.audit ? 'Każde logowanie i każda akcja w panelu' : `${d.lines.length} ${plural(d.lines.length, 'linia', 'linie', 'linii')}${f ? ` z „${f}”` : ''} · najnowsze na dole`))),
    h('section', { class: 'card' }, h('div', { class: 'form-grid' },
      h('div', { style: 'flex:2 1 260px' }, sel), h('div', { style: 'flex:0 1 150px' }, nSel), h('div', { style: 'flex:2 1 200px' }, fIn),
      h('div', { class: 'acts', style: 'flex:0 0 auto' }, btn('Pokaż', apply, { kind: 'pri' }), h('label', { class: 'check small' }, liveC, 'na żywo')))),
    body,
  );
  if (!d.audit) requestAnimationFrame(() => { if (body.isConnected) body.scrollTop = body.scrollHeight; });
  if (auto) every(5000, () => reload());
};

/* ---------------------------------------------------------------- SSL */

PAGES.ssl = async (box, args, q, quiet) => {
  const d = await api('GET', 'api/ssl' + (q.has('odswiez') && !quiet ? '?odswiez' : ''));
  const toolOf = (name) => d.certs.find((c) => c.domains.includes(name) || c.name === name);
  const renew = async (c, b) => {
    if (!(await ask({ title: `Odnowić certyfikat ${c.name}?`, text: c.tool === 'certbot' ? 'Certbot odnowi go tylko, jeśli zostało mniej niż 30 dni — wcześniej powie, że jeszcze nie trzeba.' : 'acme.sh odnowi go, jeśli nadszedł termin.', ok: 'Odnów' }))) return;
    await busy(b, async () => { try { const r = await api('POST', `api/ssl/${encodeURIComponent(c.name)}/odnow`); watchJob(r.job); } catch (e) { toast(e.message, 'bad'); } });
  };
  const list = [...d.sites].sort((a, z) => (a.cert?.validTo || 0) - (z.cert?.validTo || 0));
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Certyfikaty SSL'), h('div', { class: 'sub' }, 'Odnawiają się same: ' + (d.auto.map((a) => `${a.cmd.includes('acme') ? 'acme.sh' : 'certbot'} ${a.human}`).filter((v, i, arr) => arr.indexOf(v) === i).join(', ') || 'brak automatu!'))),
      h('div', { class: 'acts' }, linkBtn('Sprawdź teraz', '#/ssl?odswiez', { icon: 'odswiez' }))),
    h('section', { class: 'card' }, h('div', { class: 'rows' }, list.map((s) => {
      const days = daysLeft(s.cert?.validTo);
      const c = toolOf(s.name);
      const cls = days == null ? 'off' : days < 7 ? 'bad' : days < 21 ? 'warn' : 'ok';
      const b = c ? btn('Odnów', () => renew(c, b), { small: true, icon: 'odswiez' }) : null;
      return h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('span', { class: `pill ${cls}` }, days == null ? '?' : `${days} d`),
        h('div', { class: 'stack grow', style: 'flex-basis:220px' }, h('span', { class: 't' }, s.name, !s.enabled ? h('span', { class: 'pill off', style: 'margin-left:8px' }, 'strona wyłączona') : null),
          h('span', { class: 's' }, s.cert?.error ? `błąd połączenia: ${s.cert.error}` : `ważny do ${dateFull(s.cert?.validTo)} · ${s.cert?.issuer || ''}${s.cert && !s.cert.matches ? ' · NIE PASUJE DO ADRESU' : ''}`)),
        h('span', { class: 'small muted', style: 'min-width:80px' }, c ? c.tool : 'nieznane'),
        b);
    }))),
  );
};

/* ---------------------------------------------------------- harmonogram */

PAGES.cron = async (box) => {
  const d = await api('GET', 'api/cron');
  const names = { hourly: 'co godzinę', daily: 'codziennie', weekly: 'co tydzień', monthly: 'co miesiąc' };
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Harmonogram'), h('div', { class: 'sub' }, 'Zadania, które serwer wykonuje sam o stałych porach (tylko podgląd).'))),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Zadania cron')),
      h('div', { class: 'rows' }, d.items.map((i) => h('div', { class: 'row', style: 'flex-wrap:wrap;align-items:flex-start' },
        h('span', { class: 'pill info', style: 'min-width:150px' }, i.human),
        h('div', { class: 'stack grow', style: 'flex-basis:260px' }, i.desc ? h('span', { class: 't' }, i.desc) : null, h('span', { class: 'mono s', style: 'overflow-wrap:anywhere' }, i.cmd), h('span', { class: 'small dim' }, `${i.source} · jako ${i.user}`)))))),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Zadania systemowe (run-parts)')),
      h('div', { class: 'rows' }, Object.entries(d.periodic).filter(([, l]) => l.length).map(([k, l]) => h('div', { class: 'row' }, h('span', { class: 'pill info', style: 'min-width:110px' }, names[k]), h('span', { class: 'mono s' }, l.join(', ')))))),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Timery systemd')),
      h('div', { class: 'rows' }, d.timers.map((t) => h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('div', { class: 'stack grow', style: 'flex-basis:220px' }, h('span', { class: 'mono t' }, t.unit), h('span', { class: 's' }, `uruchamia ${t.activates}`)),
        h('div', { class: 'stack small' }, h('span', null, `następne: ${t.next ? when(t.next) : '—'}`), h('span', { class: 'dim' }, `ostatnie: ${t.last ? when(t.last) : '—'}`)))))),
  );
};

/* --------------------------------------------------------------- konto */

async function accountsCard() {
  let d;
  try { d = await api('GET', 'api/konta'); } catch { return null; }
  const ROLE_SHORT = { wlasciciel: 'właściciel', admin: 'administrator', podglad: 'podgląd', strony: 'wybrane strony' };
  const roleSel = (val) => h('select', { class: 'input', 'aria-label': 'Rola' }, Object.entries(d.roles).map(([k, v]) => h('option', { value: k, selected: k === val ? true : null }, v)));
  const sitesBox = (chosen) => h('div', { class: 'site-picks' }, d.sites.map((n) => h('label', { class: 'check', style: 'min-height:36px' }, h('input', { type: 'checkbox', value: n, checked: chosen.includes(n) }), h('span', { class: 'small' }, n))));
  const picked = (box) => [...box.querySelectorAll('input:checked')].map((i) => i.value);
  const editUser = async (u) => {
    const rs = roleSel(u.role), sb = sitesBox(u.sites);
    sb.hidden = u.role !== 'strony'; rs.onchange = () => { sb.hidden = rs.value !== 'strony'; };
    if (!(await ask({ title: `Dostęp: ${u.name || u.login}`, ok: 'Zapisz', extra: h('div', { class: 'stack', style: 'gap:10px' }, rs, sb) }))) return;
    try { await api('POST', `api/konta/${enc(u.login)}`, { role: rs.value, sites: picked(sb) }); toast('✓ Zapisano', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); }
  };
  const removeUser = async (u) => {
    if (!(await ask({ title: `Usunąć konto ${u.login}?`, text: 'Ta osoba zostanie od razu wylogowana i nie zaloguje się więcej.', ok: 'Usuń', danger: true }))) return;
    try { await api('POST', `api/konta/${enc(u.login)}`, { usun: true }); toast('✓ Usunięto', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); }
  };
  const invite = async () => {
    const nm = h('input', { class: 'input', placeholder: 'np. Ania', 'aria-label': 'Imię' });
    const rs = roleSel('strony'), sb = sitesBox([]);
    rs.onchange = () => { sb.hidden = rs.value !== 'strony'; };
    if (!(await ask({ title: 'Zaproś osobę', ok: 'Utwórz link', extra: h('div', { class: 'stack', style: 'gap:10px' }, h('label', { class: 'field' }, h('span', null, 'Kto (imię albo nick)'), nm), h('label', { class: 'field' }, h('span', null, 'Co może'), rs), sb) }))) return;
    try {
      const r = await api('POST', 'api/konta/zapros', { name: nm.value, role: rs.value, sites: picked(sb) });
      const copy = btn('Kopiuj link', async () => { try { await navigator.clipboard.writeText(r.link); toast('✓ Skopiowano', 'ok'); } catch { toast('Zaznacz i skopiuj ręcznie', 'bad'); } }, { kind: 'pri', icon: 'kopiuj' });
      await ask({ title: 'Link z zaproszeniem', ok: 'Gotowe', extra: h('div', { class: 'stack', style: 'gap:10px' }, h('p', { class: 'small', style: 'margin:0' }, `Wyślij go ${nm.value} (np. komunikatorem). Działa 24 godziny i tylko raz. Osoba sama ustawi hasło i kod z aplikacji.`), h('div', { class: 'out', style: 'margin:0;overflow-wrap:anywhere' }, r.link), copy) });
      reload();
    } catch (e) { toast(e.message, 'bad'); }
  };
  return h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Osoby z dostępem'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Każdy ma własne hasło i kod z aplikacji. W Logach → Dziennik panelu widać, kto co zrobił.')), btn('Zaproś osobę', invite, { small: true, kind: 'pri', icon: 'plus' })),
    h('div', { class: 'rows' },
      d.users.map((u) => h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('div', { class: 'stack grow', style: 'flex-basis:220px' }, h('b', null, u.name ? `${u.name} (${u.login})` : u.login, u.login === d.me ? h('span', { class: 'pill ok', style: 'margin-left:8px' }, 'Ty') : null),
          h('span', { class: 's' }, `${ROLE_SHORT[u.role] || u.role}${u.sites.length ? ': ' + u.sites.join(', ') : ''} · ostatnio ${u.lastLogin ? ago(u.lastLogin) : 'nigdy'}`)),
        u.login === d.me ? null : h('div', { class: 'acts' }, btn('Zmień', () => editUser(u), { small: true }), btn('', () => removeUser(u), { small: true, icon: 'usun', title: 'Usuń konto', kind: 'ghost' })))),
      d.invites.map((z) => h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('div', { class: 'stack grow', style: 'flex-basis:220px' }, h('b', null, `${z.name} — zaproszenie`), h('span', { class: 's' }, `${ROLE_SHORT[z.role]}${z.sites.length ? ': ' + z.sites.join(', ') : ''} · ważne do ${when(z.expires)}`)),
        btn('Anuluj', async () => { try { await api('POST', 'api/konta/zaproszenie-usun', { id: z.id }); reload(); } catch (e) { toast(e.message, 'bad'); } }, { small: true, kind: 'ghost' })))));
}

PAGES.konto = async (box) => {
  const d = await api('GET', 'api/konto');
  const people = state.role === 'wlasciciel' ? await accountsCard() : null;
  const form = h('form', { class: 'form-grid', autocomplete: 'off', onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get('new') !== fd.get('new2')) return toast('Nowe hasła się różnią.', 'bad');
    try { await api('POST', 'api/konto/haslo', { old: fd.get('old'), new: fd.get('new') }); toast('✓ Hasło zmienione. Inne urządzenia zostały wylogowane.', 'ok'); e.target.reset(); }
    catch (er) { toast(er.message, 'bad'); }
  } },
    h('label', { class: 'field' }, h('span', null, 'Obecne hasło'), h('input', { class: 'input', type: 'password', name: 'old', autocomplete: 'current-password', required: true })),
    h('label', { class: 'field' }, h('span', null, 'Nowe hasło (min. 10 znaków)'), h('input', { class: 'input', type: 'password', name: 'new', autocomplete: 'new-password', minlength: 10, required: true })),
    h('label', { class: 'field' }, h('span', null, 'Powtórz nowe hasło'), h('input', { class: 'input', type: 'password', name: 'new2', autocomplete: 'new-password', minlength: 10, required: true })),
    h('div', { class: 'field', style: 'justify-content:flex-end;flex:0 0 auto' }, h('button', { class: 'btn pri', type: 'submit' }, 'Zmień hasło')));
  const allOut = btn('Wyloguj inne urządzenia', async () => {
    if (!(await ask({ title: 'Wylogować inne urządzenia?', text: 'Zostaniesz zalogowany tylko tutaj.', ok: 'Wyloguj' }))) return;
    try { await api('POST', 'api/wyloguj-wszedzie'); toast('✓ Gotowe', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); }
  }, { small: true });
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Konto'), h('div', { class: 'sub' }, `Login: ${d.login} · ${{ wlasciciel: 'właściciel', admin: 'administrator', podglad: 'tylko podgląd', strony: 'dostęp do: ' + state.sites.join(', ') }[state.role] || ''} · logowanie hasłem i kodem z aplikacji`)),
      h('div', { class: 'acts' }, btn('Wyloguj', logout, { icon: 'wyloguj' }))),
    people,
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Zmiana hasła')), form),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Zalogowane urządzenia'), allOut),
      h('div', { class: 'rows' }, d.sessions.map((s) => h('div', { class: 'row' },
        h('div', { class: 'stack grow' }, h('span', { class: 't ell' }, s.ua || 'nieznane urządzenie', s.current ? h('span', { class: 'pill ok', style: 'margin-left:8px' }, 'to urządzenie') : null), h('span', { class: 's' }, `${s.ip} · zalogowano ${when(s.created)} · ostatnio ${ago(s.last)}`)))))),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Zgubiony telefon z aplikacją?')),
      h('p', { class: 'small muted', style: 'margin:0' }, state.role === 'wlasciciel' ? 'Kod 2FA właściciela można zresetować tylko z serwera (SSH): sudo /opt/panel-serwera/reset-2fa.sh. Innym osobom: usuń konto i wyślij nowe zaproszenie.' : 'Poproś właściciela panelu o nowe zaproszenie.')),
  );
};

/* ------------------------------------------------------------- utwórz */

const TPL_LOOK = {
  pusta: { mark: 'Wkrótce', bg: '#1d2a3d', fg: '#cfe0ff', desc: 'Czysty adres z ładną stroną „Wkrótce” — pliki wgrasz później.', inc: 'folder · SSL · kopia' },
  php: { mark: 'PHP + DB', bg: '#1f6f62', fg: '#d9fff7', desc: 'Dla formularzy, prostych sklepów i systemów — z gotową bazą MariaDB.', inc: 'folder · baza · SSL · kopia' },
  node: { mark: 'node', bg: '#2a3d5c', fg: '#cfe0ff', desc: 'Serwer działający w tle (np. komunikator albo gra) z usługą, logami i restartem.', inc: 'usługa · port · proxy · SSL · kopia' },
  zip: { mark: 'ZIP', bg: '#463614', fg: '#ffe2a8', desc: 'Wgrywasz paczkę z komputera — panel rozpakuje i opublikuje.', inc: 'folder · SSL · kopia' },
  przekierowanie: { mark: '→', bg: '#3a1f3f', fg: '#f5c9ff', desc: 'Adres, który prowadzi pod inny (np. stary → nowy).', inc: 'konfiguracja · SSL' },
  baza: { mark: 'DB', bg: '#3a2a1a', fg: '#ffd3b0', desc: 'Sama baza MariaDB z osobnym użytkownikiem i silnym hasłem.', inc: 'baza · użytkownik · kopia' },
};
const SSL_LABEL = { gotowe: ['ok', 'SSL działa'], 'czeka-dns': ['warn', 'czeka na DNS'], blad: ['bad', 'błąd SSL'] };
const createState = { tpl: null, sub: '', domain: '', custom: false, name: '', target: '', db: false, soon: true, zip: null, zipInfo: null, more: false, check: null };
let checkTimer = null;

function credBox(text) {
  const pre = h('div', { class: 'out', style: 'max-height:none;user-select:all' }, text);
  return h('div', { class: 'stack', style: 'gap:8px' }, pre,
    h('div', { class: 'acts' },
      btn('Kopiuj', async () => { try { await navigator.clipboard.writeText(text); toast('✓ Skopiowano'); } catch { toast('Zaznacz i skopiuj ręcznie.'); } }, { small: true, icon: 'kopiuj' }),
      btn('Pobierz plik', () => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'dane-dostepowe.txt' }); document.body.append(a); a.click(); a.remove(); }, { small: true, icon: 'pobierz' })));
}

function showCreated(r, ip) {
  const lines = [];
  if (r.db) lines.push(`serwer: localhost\nbaza: ${r.db}\nużytkownik: ${r.dbuser}\nhasło: ${r.password}`);
  const extra = h('div', { class: 'stack', style: 'gap:12px' },
    r.host ? h('p', null, r.ssl === 'gotowe' ? 'Strona działa pod adresem:' : `Strona jest gotowa, ale adres jeszcze nie wskazuje na serwer. Dodaj w OVH rekord A: ${r.host} → ${ip}. Certyfikat i https włączę sam, gdy tylko DNS zacznie działać.`) : null,
    r.host ? h('a', { href: `${r.ssl === 'gotowe' ? 'https' : 'http'}://${r.host}/`, target: '_blank', rel: 'noopener noreferrer', class: 'btn pri', style: 'align-self:flex-start' }, ico('ext'), r.host) : null,
    r.dir ? h('p', { class: 'small muted' }, `Pliki strony: ${r.dir}`) : null,
    r.app_dir ? h('p', { class: 'small muted' }, `Kod aplikacji: ${r.app_dir}/server.mjs (port ${r.port}) — po zmianach zrób Restart w zakładce Usługi.`) : null,
    lines.length ? h('div', { class: 'stack', style: 'gap:6px' }, h('b', null, 'Dane do bazy — zapisz je teraz:'), credBox(lines.join('\n')), h('span', { class: 'small muted' }, 'Zapisałem je też na serwerze; w panelu: Utwórz → Utworzone → Dane dostępowe.')) : null);
  ask({ title: '✓ Gotowe', text: '', ok: 'Zamknij', extra });
}

const KINDS = [
  { id: 'strona', icon: 'okno', title: 'Strona internetowa', desc: 'pliki HTML lub PHP — wizytówka, sklep, blog', c: ['#1f6f62', '#d9fff7'] },
  { id: 'zip', icon: 'zip', title: 'Strona z pliku ZIP', desc: 'masz gotową stronę na komputerze — wgrasz paczkę', c: ['#463614', '#ffe2a8'] },
  { id: 'wordpress', icon: 'blog', title: 'WordPress', desc: 'gotowy blog albo strona firmowa — z bazą, SSL i kontem admina', c: ['#1d3550', '#cfe6ff'] },
  { id: 'node', icon: 'aplikacja', title: 'Aplikacja Node.js', desc: 'działa w tle, np. komunikator albo gra — z własną usługą i logami', c: ['#2a3d5c', '#cfe0ff'] },
  { id: 'baza', icon: 'bazy', title: 'Baza danych', desc: 'MariaDB z osobnym użytkownikiem i hasłem', c: ['#3a2a1a', '#ffd3b0'] },
  { id: 'przekierowanie', icon: 'przekierowanie', title: 'Przekierowanie', desc: 'adres, który prowadzi gdzie indziej', c: ['#3a1f3f', '#f5c9ff'] },
];
const STEPS = ['Co tworzysz', 'Adres', 'Ustawienia', 'Gotowe'];
const wz = { step: 1, kind: null, sub: '', domain: '', custom: false, name: '', target: '', php: false, db: false, soon: true, zip: null, zipInfo: null, check: null, job: null, result: null, render: null };
const wzTemplate = () => (wz.kind === 'strona' ? (wz.php ? 'php' : 'pusta') : wz.kind);
const wzHost = () => (wz.custom ? wz.sub.trim().toLowerCase() : `${wz.sub.trim().toLowerCase()}.${wz.domain}`);
function wzReset() { Object.assign(wz, { step: 1, kind: null, sub: '', custom: false, name: '', target: '', php: false, db: false, soon: true, zip: null, zipInfo: null, check: null, job: null, result: null }); }

function wzWill() {
  const slug = wz.check?.slug || (wz.kind === 'baza' ? (wz.name || 'nazwa') : (wz.sub ? wz.sub.trim().toLowerCase().replace(/\./g, '-') : 'nazwa'));
  const db = slug.replace(/-/g, '_');
  const L = [];
  if (wz.kind === 'strona') L.push(wz.php ? `folder /var/www/${slug} ze stroną startową w PHP` : `folder /var/www/${slug}${wz.soon ? ' z gotową stroną „Wkrótce”' : ''}`);
  if (wz.kind === 'zip') L.push(`rozpakowanie Twojej paczki do /var/www/${slug}`);
  if (wz.kind === 'wordpress') L.push(`WordPressa (wersja polska) w /var/www/${slug}, gotowego do logowania`);
  if (wz.kind === 'node') L.push(`aplikację /opt/${slug}/server.mjs i usługę, która wstaje sama po awarii`);
  if (wz.kind === 'przekierowanie') L.push(`przekierowanie ${wz.target ? 'na ' + wz.target : ''} (z zachowaniem ścieżek)`);
  if (wz.kind === 'baza' || wz.kind === 'wordpress' || ((wz.kind === 'strona' && wz.php) || wz.db)) L.push(`bazę ${db} z osobnym użytkownikiem i silnym hasłem`);
  if (wz.kind !== 'baza') L.push('konfigurację Apache (sprawdzoną przed włączeniem)', 'certyfikat SSL — odnawiany sam');
  if (wz.kind !== 'przekierowanie') L.push('wpis do nocnej kopii zapasowej');
  if (wz.kind !== 'baza') L.push('pilnowanie przez autopilota');
  return L;
}

function wzProgress() {
  // „Krok 4” w bocznym pudełku: zapowiedź albo postęp na żywo z wyjścia zadania
  const box = h('div', { class: 'card wz-end' }, h('span', { class: 'small', style: 'font-weight:700;letter-spacing:.05em;color:var(--muted)' }, wz.job ? 'KROK 4 — POSTĘP' : 'KROK 4 — TAK WYGLĄDA KONIEC'));
  if (!wz.job) {
    for (const t of wzWill().slice(0, 5)) box.append(h('div', { class: 'wz-line' }, h('span', null, t.replace(/ \(.*\)$/, '')), h('span', { style: 'color:var(--ok-ink);font-weight:600' }, 'gotowe')));
    return box;
  }
  const lines = (wz.job.out || '').split('\n').filter((l) => /^[▸✓✗]/.test(l));
  lines.forEach((l, i) => {
    const last = i === lines.length - 1;
    const err = l.startsWith('✗');
    const st = err ? h('span', { style: 'color:var(--bad-ink);font-weight:600' }, 'błąd') : l.startsWith('✓') ? h('span', { style: 'color:var(--ok-ink);font-weight:600' }, '✓') : last && !wz.job.end ? h('span', { class: 'spin' }) : h('span', { style: 'color:var(--ok-ink);font-weight:600' }, 'gotowe');
    box.append(h('div', { class: 'wz-line' }, h('span', null, l.replace(/^[▸✓✗]\s*/, '')), st));
  });
  if (!lines.length) box.append(h('div', { class: 'wz-line' }, h('span', null, 'zaczynam…'), h('span', { class: 'spin' })));
  return box;
}

async function wzPoll() {
  if (!wz.job || wz.job.end) return;
  try { wz.job = await api('GET', `api/zadania/${wz.job.id}`); } catch {}
  if (wz.job.end) { wz.result = wz.job.ok ? wz.job.result : null; toast(wz.job.ok ? '✓ Gotowe' : '✗ Nie udało się — szczegóły w kroku 4', wz.job.ok ? 'ok' : 'bad'); wz.render?.(); return reload(); }
  wz.render?.();
  if (!wz.job.end) setTimeout(wzPoll, 1000);
}

const ovhHas = (o, host) => !!(o?.connected && host && o.zones.some((z) => host === z || host.endsWith('.' + z)));
function ovhCard(o, ip) {
  if (!o) return null;
  if (o.connected) {
    const off = btn('Odłącz', async () => { if (await ask({ title: 'Odłączyć OVH?', text: 'Istniejące adresy zostają. Nowe strony trzeba będzie dodawać w OVH ręcznie.', ok: 'Odłącz', danger: true })) { try { await api('POST', 'api/ovh/odlacz'); reload(); } catch (e) { toast(e.message, 'bad'); } } }, { small: true, kind: 'ghost' });
    const wild = (z) => { const b = btn(`*.${z}`, async () => { if (!(await ask({ title: `Dodać *.${z}?`, text: `Wszystkie adresy typu cokolwiek.${z} będą od razu wskazywały na ten serwer (${ip}). Istniejące rekordy zostają.`, ok: 'Dodaj' }))) return; await busy(b, async () => { try { await api('POST', 'api/ovh/wildcard', { zone: z }); toast(`✓ Dodano *.${z}`, 'ok'); } catch (e) { toast(e.message, 'bad'); } }); }, { small: true }); return b; };
    return h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Domeny w OVH'), h('div', { class: 'small muted', style: 'margin-top:4px' }, `Połączone · ${o.zones.join(', ')} — nowe adresy dodaję sam, usuwam razem ze stroną.`)), off),
      h('div', { class: 'rows' },
        h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('span', { class: 'grow small muted', style: 'flex-basis:240px' }, 'Opcjonalnie: rekord „wszystko” — wtedy każdy nowy adres działa od razu, bez czekania.'), h('div', { class: 'acts' }, o.zones.map(wild))),
        o.added.length ? o.added.slice().reverse().slice(0, 5).map((a) => h('div', { class: 'row small' }, h('span', { class: 'grow mono' }, a.host), h('span', { class: 'muted' }, when(a.ts)))) : null));
  }
  const ak = h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Application Key' });
  const as = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': 'Application Secret' });
  const ck = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': 'Consumer Key' });
  const go = btn('Połącz', async () => { await busy(go, async () => { try { const r = await api('POST', 'api/ovh/polacz', { ak: ak.value, as: as.value, ck: ck.value }); toast(`✓ Połączono — domeny: ${r.zones.join(', ')}`, 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } }); }, { kind: 'pri' });
  return h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Podłącz OVH'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Wtedy nie musisz dodawać adresów ręcznie — kreator zrobi to sam.'))),
    h('ol', { class: 'small', style: 'margin:0 0 12px;padding-left:20px;line-height:1.7;color:#c9d1dc' },
      h('li', null, 'Otwórz ', h('a', { href: o.tokenUrl || 'https://eu.api.ovh.com/createToken/?GET=/domain/zone/*&POST=/domain/zone/*&PUT=/domain/zone/*&DELETE=/domain/zone/*', target: '_blank', rel: 'noopener noreferrer' }, 'stronę OVH do tworzenia klucza'), ' i zaloguj się.'),
      h('li', null, 'Nazwa: „panel serwera”, ważność: Unlimited. Uprawnienia są już wpisane (tylko strefy DNS).'),
      h('li', null, 'Wklej tutaj trzy wartości, które pokaże OVH.')),
    h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Application Key'), ak), h('label', { class: 'field' }, h('span', null, 'Application Secret'), as), h('label', { class: 'field' }, h('span', null, 'Consumer Key'), ck)),
    h('div', { style: 'margin-top:12px' }, go));
}

PAGES.utworz = async (box) => {
  const d = await api('GET', 'api/utworz');
  if (!wz.domain) wz.domain = d.domains[0] || state.cfg.domena || 'example.pl';
  const holder = h('div', { class: 'stack', style: 'gap:22px' });
  let checkT = null;
  const runCheck = () => {
    clearTimeout(checkT);
    const ready = wz.kind === 'baza' ? wz.name.trim() : wz.sub.trim();
    if (!ready) { wz.check = null; wz.render(); return; }
    checkT = setTimeout(async () => {
      try { wz.check = await api('GET', `api/utworz/sprawdz?szablon=${wzTemplate()}&adres=${encodeURIComponent(wz.kind === 'baza' ? '' : wzHost())}&nazwa=${encodeURIComponent(wz.name)}`); }
      catch (e) { wz.check = { ok: false, problems: [e.message] }; }
      wz.render();
    }, 350);
  };
  const go = (n) => { wz.step = n; wz.render(); if (n === 2 && !wz.check) runCheck(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const create = async (b) => {
    if (wz.kind === 'zip' && !wz.zip) return toast('Najpierw wgraj plik ZIP.', 'bad');
    if (wz.kind === 'przekierowanie' && !wz.target.trim()) return toast('Wpisz, dokąd ma prowadzić.', 'bad');
    await busy(b, async () => {
      try {
        const r = await api('POST', 'api/utworz', { szablon: wzTemplate(), adres: wz.kind === 'baza' ? '' : wzHost(), nazwa: wz.name, baza: wz.kind === 'strona' && wz.php ? wz.db !== false : wz.db, wkrotce: wz.soon, cel: wz.target, zip: wz.zip });
        wz.job = r.job; wz.step = 4; wz.render(); wzPoll();
      } catch (e) { toast(e.message, 'bad'); }
    });
  };

  const stepper = () => h('ol', { class: 'wz-steps', 'aria-label': 'Kroki' }, STEPS.map((label, i) => {
    const n = i + 1, on = wz.step === n, done = wz.step > n && !wz.job;
    const inner = [h('span', { class: 'wz-num' }, done ? '✓' : String(n)), label];
    return h('li', { class: `wz-step ${on ? 'on' : done ? 'done' : ''}` }, done ? h('button', { type: 'button', onclick: () => go(n) }, inner) : h('span', { 'aria-current': on ? 'step' : null }, inner));
  }));

  const nav = (back, next, nextOk, nextLabel) => h('div', { class: 'acts', style: 'justify-content:flex-end;padding-top:6px' },
    back ? btn(back === 'anuluj' ? 'Anuluj' : 'Wstecz', () => (back === 'anuluj' ? (wzReset(), wz.render()) : go(wz.step - 1))) : null,
    next ? (() => { const b = btn(nextLabel, () => (next === 'utworz' ? create(b) : go(wz.step + 1)), { kind: 'pri', disabled: !nextOk }); return b; })() : null);

  const step1 = () => h('section', { class: 'stack', style: 'gap:14px' },
    h('h2', { style: 'font-size:19px' }, 'Co chcesz utworzyć?'),
    h('div', { class: 'wz-kinds' }, KINDS.map((k) => h('button', { type: 'button', class: `wz-kind ${wz.kind === k.id ? 'on' : ''}`, 'aria-pressed': wz.kind === k.id ? 'true' : 'false', onclick: () => { wz.kind = k.id; wz.check = null; wz.php = false; wz.db = false; wz.render(); } },
      h('span', { class: 'wz-ico', style: `background:${k.c[0]};color:${k.c[1]}` }, ico(k.icon, 22)),
      h('span', { class: 'stack', style: 'gap:4px;text-align:left' }, h('b', { style: 'font-size:16px' }, k.title), h('span', { class: 'small muted', style: 'line-height:1.4' }, k.desc))))),
    nav(wz.kind ? 'anuluj' : null, 'dalej', !!wz.kind, wz.kind === 'baza' ? 'Dalej: nazwa' : 'Dalej: adres'));

  const step2 = () => {
    const c = wz.check;
    let status = h('span', { class: 'muted' }, wz.kind === 'baza' ? 'Wpisz nazwę bazy.' : 'Wpisz adres.');
    if (c && !c.ok) status = h('span', { style: 'color:var(--bad-ink)' }, '✗ ' + c.problems.join(' '));
    else if (c && wz.kind === 'baza') status = h('span', { style: 'color:var(--ok-ink)' }, '✓ nazwa wolna');
    else if (c && c.dns?.ok) status = h('span', { style: 'color:var(--ok-ink)' }, '✓ adres wolny · DNS już wskazuje na serwer — https od razu');
    else if (c && ovhHas(d.ovh, c.host)) status = h('span', { style: 'color:var(--ok-ink)' }, '✓ adres wolny · dodam go sam w OVH — zacznie działać w ciągu kilku minut, https włączę sam');
    else if (c) status = h('span', { style: 'color:var(--warn-ink)' }, `✓ adres wolny · ⚠ ${c.dns?.ips?.length ? 'adres wskazuje na ' + c.dns.ips.join(', ') : 'brak wpisu DNS'} — możesz tworzyć. Dodaj w OVH rekord A: ${c.host} → ${d.ip}, a https włączę sam.`);
    const inp = h('input', { class: 'input', value: wz.kind === 'baza' ? wz.name : wz.sub, placeholder: wz.kind === 'baza' ? 'np. sklep' : wz.custom ? 'np. sklep.mojafirma.pl' : 'np. sklep', autocapitalize: 'off', spellcheck: 'false', 'aria-label': wz.kind === 'baza' ? 'Nazwa bazy' : 'Adres', style: 'font-size:17px;min-height:52px' });
    inp.addEventListener('input', () => { if (wz.kind === 'baza') wz.name = inp.value; else wz.sub = inp.value; runCheck(); });
    const dom = h('select', { class: 'input', 'aria-label': 'Domena', style: 'width:auto;min-width:160px;min-height:52px' }, d.domains.map((x) => h('option', { value: x }, '.' + x)), h('option', { value: '*' }, 'własny adres…'));
    dom.value = wz.custom ? '*' : wz.domain;
    dom.onchange = () => { if (dom.value === '*') wz.custom = true; else { wz.custom = false; wz.domain = dom.value; } wz.render(); runCheck(); };
    setTimeout(() => { if (inp.isConnected && document.activeElement !== inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }, 50);
    return h('section', { class: 'stack', style: 'gap:14px' },
      h('h2', { style: 'font-size:19px' }, wz.kind === 'baza' ? 'Jak nazwać bazę?' : 'Pod jakim adresem?'),
      h('div', { class: 'card stack', style: 'gap:10px' },
        wz.kind === 'baza' ? inp : h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, h('div', { style: 'flex:1 1 200px' }, inp), wz.custom ? null : dom),
        wz.custom ? h('a', { href: '#/utworz', class: 'small', onclick: (e) => { e.preventDefault(); wz.custom = false; wz.render(); runCheck(); } }, 'wróć do listy domen') : null,
        h('div', { class: 'small', 'aria-live': 'polite' }, status)),
      nav('wstecz', 'dalej', !!c?.ok, 'Dalej: ustawienia'));
  };

  const step3 = () => {
    const opt = (label, desc, key, val) => {
      const c = h('input', { type: 'checkbox', checked: val ?? !!wz[key] });
      c.onchange = () => { wz[key] = c.checked; wz.render(); };
      return h('label', { class: 'row check' }, c, h('div', { class: 'stack' }, h('b', null, label), h('span', { class: 's' }, desc)));
    };
    const parts = [];
    if (wz.kind === 'strona') {
      const radio = (php, label, desc) => {
        const r = h('input', { type: 'radio', name: 'wz-php', checked: wz.php === php });
        r.onchange = () => { wz.php = php; if (php && wz.db === false) wz.db = true; wz.render(); };
        return h('label', { class: `wz-radio ${wz.php === php ? 'on' : ''}` }, r, h('div', { class: 'stack' }, h('b', null, label), h('span', { class: 's' }, desc)));
      };
      parts.push(h('div', { class: 'stack', style: 'gap:8px' }, h('b', null, 'Rodzaj strony'), h('div', { class: 'wz-radios' }, radio(false, 'Zwykła strona (HTML)', 'pliki wgrasz później, na start strona „Wkrótce”'), radio(true, 'Strona w PHP', 'np. formularze, logowanie, prosty sklep'))));
      parts.push(h('div', { class: 'rows' },
        opt('Baza danych MariaDB', wz.php ? 'dane do bazy trafią do config.php' : 'osobny użytkownik i silne hasło', 'db', wz.php ? wz.db !== false : !!wz.db),
        wz.php ? null : opt('Strona „Wkrótce” na start', 'żeby adres od razu coś pokazywał', 'soon')));
    }
    if (wz.kind === 'zip') {
      const zipIn = h('input', { type: 'file', accept: '.zip,application/zip', class: 'input', style: 'padding:10px' });
      const zs = h('div', { class: 'small muted' }, wz.zipInfo ? `✓ wgrano: ${wz.zipInfo.files} plików${wz.zipInfo.hasIndex ? '' : ' (uwaga: brak index.html — strona może pokazać błąd 403)'}` : 'Wybierz plik .zip ze stroną (do 300 MB). Jeśli wszystko jest w jednym folderze, panel sam go „rozpakuje wyżej”.');
      zipIn.onchange = () => {
        const f = zipIn.files[0]; if (!f) return;
        wz.zip = null; wz.zipInfo = null;
        const x = new XMLHttpRequest();
        x.open('POST', apiPath('api/utworz/zip')); x.setRequestHeader('X-Panel', '1'); x.setRequestHeader('Content-Type', 'application/zip');
        x.upload.onprogress = (e) => { if (e.lengthComputable) zs.textContent = `Wgrywam… ${Math.round(e.loaded / e.total * 100)}%`; };
        x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} if (x.status !== 200) { zs.replaceChildren(...withIcons('✗ ' + (j.error || 'nie udało się wgrać'))); return; } wz.zip = j.token; wz.zipInfo = j.info; wz.render(); };
        x.onerror = () => { zs.replaceChildren(...withIcons('✗ błąd połączenia')); };
        x.send(f);
      };
      parts.push(h('label', { class: 'field' }, h('b', null, 'Plik ZIP ze stroną'), zipIn, zs));
      parts.push(h('div', { class: 'rows' }, opt('Baza danych MariaDB', 'jeśli strona jej potrzebuje', 'db')));
    }
    if (wz.kind === 'node') parts.push(h('div', { class: 'rows' }, opt('Baza danych MariaDB', 'dla aplikacji, które trzymają dane w MariaDB', 'db'), h('div', { class: 'row small muted', style: 'display:block' }, 'Panel da aplikacji wolny port i folder na dane. Kod podmieniasz w /opt/…/server.mjs, a potem robisz Restart w zakładce Usługi.')));
    if (wz.kind === 'przekierowanie') {
      const t = h('input', { class: 'input', value: wz.target, placeholder: 'https://inna-strona.pl/', autocapitalize: 'off', 'aria-label': 'Dokąd prowadzi', style: 'min-height:52px;font-size:16px' });
      t.addEventListener('input', () => { wz.target = t.value; });
      t.addEventListener('change', () => wz.render());
      parts.push(h('label', { class: 'field' }, h('b', null, 'Dokąd ma prowadzić?'), t, h('span', { class: 'small muted' }, `np. ${wzHost()}/cokolwiek → https://cel/cokolwiek`)));
    }
    if (wz.kind === 'baza') parts.push(h('div', { class: 'small muted' }, 'Nic więcej nie trzeba ustawiać. Hasło wygeneruję i pokażę po utworzeniu.'));
    if (wz.kind === 'wordpress') parts.push(h('div', { class: 'small muted' }, 'Nic więcej nie trzeba ustawiać. Panel pobierze najnowszego WordPressa, założy bazę i konto administratora, a na koniec pokaże login i hasło. Trwa to 1–2 minuty.'));
    return h('section', { class: 'stack', style: 'gap:14px' },
      h('h2', { style: 'font-size:19px' }, 'Ustawienia'),
      h('div', { class: 'card stack', style: 'gap:16px' }, ...parts),
      nav('wstecz', 'utworz', true, wz.kind === 'baza' ? `Utwórz bazę ${wz.check?.slug?.replace(/-/g, '_') || ''}` : `Utwórz ${wzHost()}`));
  };

  const step4 = () => {
    const j = wz.job, r = wz.result;
    const kids = [h('h2', { style: 'font-size:19px' }, !j?.end ? 'Tworzę…' : j.ok ? '✓ Gotowe' : '✗ Coś poszło nie tak')];
    if (j?.end && j.ok && r) {
      if (r.host) kids.push(h('div', { class: 'card stack', style: 'gap:10px' },
        h('span', null, r.ssl === 'gotowe' ? 'Strona działa pod adresem:' : ovhHas(d.ovh, r.host) ? 'Strona jest gotowa. Adres dodałem w OVH — zacznie działać w ciągu kilku minut, wtedy sam włączę https.' : `Strona jest gotowa. Adres jeszcze nie wskazuje na serwer — dodaj w OVH rekord A: ${r.host} → ${d.ip}. Certyfikat i https włączę sam, gdy tylko DNS zacznie działać.`),
        h('a', { href: `${r.ssl === 'gotowe' ? 'https' : 'http'}://${r.host}/`, target: '_blank', rel: 'noopener noreferrer', class: 'btn pri', style: 'align-self:flex-start' }, ico('ext'), r.host),
        r.dir ? h('span', { class: 'small muted' }, `Pliki strony: ${r.dir}`) : null,
        r.app_dir ? h('span', { class: 'small muted' }, `Kod aplikacji: ${r.app_dir}/server.mjs (port ${r.port}) — po zmianach Restart w zakładce Usługi.`) : null));
      if (r.cms) kids.push(h('div', { class: 'card stack', style: 'gap:8px' }, h('b', null, 'Logowanie do WordPressa — zapisz je teraz:'), credBox(`adres: ${r.cms.url}\nlogin: ${r.cms.user}\nhasło: ${r.cms.pass}`), h('a', { href: r.cms.url, target: '_blank', rel: 'noopener noreferrer', class: 'btn sm', style: 'align-self:flex-start' }, ico('ext'), 'Otwórz panel WordPressa'), h('span', { class: 'small muted' }, 'Po zalogowaniu zmień w profilu adres e-mail administratora na swój.')));
      if (r.db) kids.push(h('div', { class: 'card stack', style: 'gap:8px' }, h('b', null, 'Dane do bazy — zapisz je teraz:'), credBox(`serwer: localhost\nbaza: ${r.db}\nużytkownik: ${r.dbuser}\nhasło: ${r.password}`), h('span', { class: 'small muted' }, 'Są też zapisane na serwerze: Utwórz → Utworzone w panelu → Dane dostępowe.')));
    }
    if (j?.end && !j.ok) kids.push(h('div', { class: 'out', style: 'max-height:none' }, j.out || ''), h('p', { class: 'small muted', style: 'margin:0' }, 'Panel cofnął to, co zdążył zrobić — nic nie zostało w połowie.'));
    if (j?.end) kids.push(h('div', { class: 'acts' }, btn(j.ok ? 'Utwórz kolejną rzecz' : 'Spróbuj jeszcze raz', () => { const keep = !j.ok; if (keep) { wz.job = null; wz.step = 3; } else wzReset(); wz.render(); reload(); }, { kind: 'pri', icon: j.ok ? 'plus' : 'restart' })));
    return h('section', { class: 'stack', style: 'gap:14px' }, ...kids);
  };

  const createdList = () => {
    const del = async (r, b) => {
      const typed = await ask({ title: `Usunąć ${r.host || r.slug}?`, text: `Panel najpierw zrobi kopię plików i bazy (w ${state.cfg.kopie || '/var/backups/panel-serwera'}/usuniete), a potem usunie stronę, aplikację, bazę i certyfikat.`, ok: 'Usuń', danger: true, typed: r.host || r.slug });
      if (!typed) return;
      await busy(b, async () => { try { const x = await api('POST', `api/utworz/${r.slug}/usun`, { confirm: typed }); watchJob(x.job); } catch (e) { toast(e.message, 'bad'); } });
    };
    const access = async (r) => { try { const x = await api('GET', `api/utworz/${r.slug}/dostep`); ask({ title: 'Dane dostępowe', text: '', ok: 'Zamknij', extra: credBox(x.text) }); } catch (e) { toast(e.message, 'bad'); } };
    const sslNow = async (r, b) => { await busy(b, async () => { try { const x = await api('POST', `api/utworz/${r.slug}/ssl`); watchJob(x.job); } catch (e) { toast(e.message, 'bad'); } }); };
    return h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Utworzone w panelu'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Wszystko, co powstało tutaj — z kopią przed usunięciem.'))),
      d.created.length ? h('div', { class: 'rows' }, d.created.map((r) => {
        const [cls, lab] = SSL_LABEL[r.ssl] || ['off', r.host ? '—' : 'bez adresu'];
        const db2 = btn('', () => del(r, db2), { icon: 'usun', small: true, title: 'Usuń' });
        const sb = r.host && r.ssl !== 'gotowe' ? btn('Sprawdź DNS i SSL', () => sslNow(r, sb), { small: true, icon: 'sprawdz' }) : null;
        return h('div', { class: 'row', style: 'flex-wrap:wrap' },
          h('span', { class: `pill ${r.host ? cls : 'info'}` }, r.host ? lab : 'baza'),
          h('div', { class: 'stack grow', style: 'flex-basis:220px' }, r.host ? h('a', { href: `${r.ssl === 'gotowe' ? 'https' : 'http'}://${r.host}/`, target: '_blank', rel: 'noopener noreferrer', class: 't', style: 'color:inherit' }, r.host, ' ', ico('ext', 13)) : h('span', { class: 't' }, r.slug),
            h('span', { class: 's' }, [d.templates[r.kind]?.name, r.dir, r.app_dir ? `${r.app_dir} · port ${r.port}` : '', r.db ? `baza ${r.db}` : '', r.target ? '→ ' + r.target : '', `utworzono ${when(r.created)}`].filter(Boolean).join(' · ')),
            r.ssl !== 'gotowe' && r.ssl_msg ? h('span', { class: 'small', style: 'color:var(--warn-ink)' }, r.ssl_msg) : null),
          h('div', { class: 'acts' }, sb, r.db ? btn('Dane dostępowe', () => access(r), { small: true }) : null, db2));
      })) : h('div', { class: 'list-empty' }, 'Jeszcze nic — zacznij od kroku 1 powyżej.'));
  };

  wz.render = () => {
    if (!holder.isConnected && wz.render.mounted) return;
    wz.render.mounted = true;
    const body = { 1: step1, 2: step2, 3: step3, 4: step4 }[wz.step]();
    holder.replaceChildren(
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Utwórz'), h('div', { class: 'sub' }, 'Krok po kroku — panel sam założy folder, konfigurację, certyfikat i kopię.'))),
      stepper(),
      h('div', { class: 'wz-grid' }, h('div', { class: 'wz-main' }, body),
        h('aside', { class: 'wz-side', 'aria-label': 'Co się stanie' },
          wz.kind ? h('div', { class: 'card stack', style: 'gap:10px' }, h('h3', null, 'Panel zrobi za Ciebie'), wzWill().map((t) => h('div', { class: 'wz-will' }, h('span', { 'aria-hidden': 'true', class: 'wz-tick' }, '✓'), h('span', null, t)))) : h('div', { class: 'card small muted' }, 'Wybierz, co tworzysz — tutaj zobaczysz, co dokładnie panel zrobi.'),
          wz.kind ? wzProgress() : null)),
      createdList(), ovhCard(d.ovh, d.ip));
  };
  wz.render.mounted = false;
  put(box, holder);
  wz.render();
  if (wz.job && !wz.job.end) wzPoll();
};

/* ------------------------------------------------------------ autopilot */

const RULES = [
  ['naprawa', 'Samonaprawa usług', 'Gdy aplikacja, gra albo baza padnie — restart (do 3 razy na godzinę). Jeśli nie pomoże — powiadomienie z ostatnimi liniami logu.'],
  ['strony', 'Pilnowanie stron', 'Co minutę sprawdza wszystkie strony. Gdy strona nie odpowiada 3 minuty — restart jej usługi (jeśli ma) i powiadomienie.'],
  ['dysk', 'Sprzątanie dysku', 'Po przekroczeniu progu usuwa pliki tymczasowe, stare logi i pamięć podręczną. Strony, bazy i kopie zostają nietknięte.'],
  ['kopie', 'Kopie zapasowe', 'Pilnuje nocnej kopii (bazy, kod stron, aplikacje). Gdy brakuje miejsca — najpierw sprząta i robi kopię jeszcze raz, zamiast ją pominąć.'],
  ['aktualizacje', 'Aktualizacje bezpieczeństwa', 'Codziennie instaluje poprawki systemu, a o 04:30 odświeża usługi, które wciąż używają starych plików (tak padł panel gier). Restart całego serwera tylko, gdy go zaplanujesz albo włączysz co tydzień.'],
  ['ssl', 'Certyfikaty SSL', 'Odnawia certyfikaty przed końcem i pobiera je dla nowych stron, gdy tylko DNS zacznie działać. Nie da się wyłączyć.'],
  ['testowe', 'Procesy testowe', 'Zatrzymuje kopie testowe stron (z /tmp), które działają dłużej niż ustawiony czas.'],
  ['ataki', 'Ochrona przed atakami', 'fail2ban blokuje adresy zgadujące hasła. Autopilot zgłasza tylko nietypowe ataki (nagły wzrost prób).'],
];
const LVL = { error: ['bad', 'BŁĄD'], warn: ['warn', 'UWAGA'], decision: ['warn', 'DECYZJA'], info: ['info', 'INFO'], ok: ['ok', 'OK'] };
const DOT = { error: 'var(--bad)', warn: 'var(--warn)', info: '#6ea8ff', ok: 'var(--acc)' };
const DAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];

function b64ToU8(s) { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); }
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return ask({ title: 'Push na tym urządzeniu', text: ios ? 'Na iPhonie powiadomienia działają, gdy panel jest dodany do ekranu początkowego:\n1. W Safari stuknij „Udostępnij” → „Do ekranu początkowego”.\n2. Otwórz panel z nowej ikonki i włącz push jeszcze raz.' : 'Ta przeglądarka nie obsługuje powiadomień push.', ok: 'Rozumiem' });
  }
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Nie zezwolono na powiadomienia — można to zmienić w ustawieniach przeglądarki.', 'bad');
  const { key } = await api('GET', 'api/autopilot/push');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) });
  await api('POST', 'api/autopilot/push', { sub: sub.toJSON() });
  await api('POST', 'api/autopilot/ustawienia', { notify: { pushOn: true } });
  toast('✓ Push włączony na tym urządzeniu', 'ok');
}
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await api('POST', 'api/autopilot/push-usun', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
  } catch {}
  toast('Push wyłączony na tym urządzeniu');
}

function reportCard(r) {
  if (!r) return null;
  const on = h('input', { type: 'checkbox', checked: r.enabled });
  on.onchange = async () => { try { await api('POST', 'api/raport/ustawienia', { enabled: on.checked }); toast(on.checked ? '✓ Raport w każdą niedzielę o 10:00' : 'Raport wyłączony', 'ok'); } catch (e) { toast(e.message, 'bad'); } };
  const prev = btn('Podgląd', async () => {
    await busy(prev, async () => {
      try { const x = await api('GET', 'api/raport'); await ask({ title: x.title, ok: 'Zamknij', extra: h('div', { class: 'out', style: 'max-height:60vh;white-space:pre-wrap' }, x.text) }); } catch (e) { toast(e.message, 'bad'); }
    });
  }, { small: true });
  const sendB = btn('Wyślij teraz', async () => {
    await busy(sendB, async () => {
      try { const x = await api('POST', 'api/raport/wyslij'); toast(x.results.length ? x.results.map((y) => `${y.via}: ${y.ok ? '✓ wysłano' : '✗ ' + y.error}`).join('\n') : 'Nie ma gdzie wysłać — ustaw e-mail albo push powyżej.', x.results.some((y) => y.ok) ? 'ok' : 'bad'); } catch (e) { toast(e.message, 'bad'); }
    });
  }, { small: true });
  return h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Raport tygodniowy'), h('div', { class: 'acts' }, prev, sendB)),
    h('label', { class: 'check' }, on, h('div', { class: 'stack', style: 'gap:2px' }, h('b', null, 'W niedzielę o 10:00'), h('span', { class: 's' }, `Krótkie podsumowanie tygodnia tam, gdzie powiadomienia.${r.last ? ' Ostatni: ' + when(r.last) : ''}`))));
}

PAGES.autopilot = async (box) => {
  const d = await api('GET', 'api/autopilot');
  const s = d.settings;
  const save = async (patch, msg) => { try { await api('POST', 'api/autopilot/ustawienia', patch); if (msg) toast(msg, 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); reload(); } };
  const pctRing = Math.round(d.ring.ok / Math.max(1, d.ring.total) * 100);
  const human = d.todo.filter((t) => t.level !== 'info');
  const ring = h('div', { class: 'ring', role: 'img', 'aria-label': `${d.ring.ok} z ${d.ring.total} rzeczy w porządku`, style: `background:conic-gradient(var(--acc) 0 ${pctRing}%, var(--warn) ${pctRing}% 100%)` },
    h('div', { class: 'ring-in' }, h('b', null, `${d.ring.ok}/${d.ring.total}`), h('span', null, 'w porządku')));
  const onOff = h('input', { type: 'checkbox', checked: s.enabled });
  onOff.onchange = () => save({ enabled: onOff.checked }, onOff.checked ? '✓ Autopilot włączony' : 'Autopilot wyłączony');
  const todoAct = async (t, b) => {
    if (t.action === 'zaplanuj-restart' || t.action === 'anuluj-restart') {
      await busy(b, async () => { try { await api('POST', 'api/autopilot/restart', { anuluj: t.action === 'anuluj-restart' }); toast(t.action === 'anuluj-restart' ? 'Restart anulowany' : '✓ Restart zaplanowany na 05:00', 'ok'); } catch (e) { toast(e.message, 'bad'); } });
      reload();
    } else if (t.action === 'wlacz') save({ enabled: true }, '✓ Autopilot włączony');
    else if (t.action === 'odswiez-uslugi') {
      if (!(await ask({ title: 'Odświeżyć usługi teraz?', text: 'Usługi, które po aktualizacji działają na starych plikach, uruchomią się ponownie. Strony znikną na ok. 1 sekundę.', ok: 'Odśwież' }))) return;
      await busy(b, async () => { try { const r = await api('POST', 'api/autopilot/odswiez-uslugi'); watchJob(r.job); } catch (e) { toast(e.message, 'bad'); } });
    }
  };
  const R = d.rules;
  const ruleState = {
    naprawa: R.naprawa.ok ? ['ok', 'wszystkie działają'] : ['bad', `nie działa: ${R.naprawa.down.join(', ')}`],
    strony: R.strony.down.length ? ['warn', `problem: ${R.strony.down.join(', ')}`] : ['ok', `${R.strony.checked} stron odpowiada`],
    dysk: R.dysk.pct >= R.dysk.threshold ? ['warn', `dysk ${R.dysk.pct}% — sprzątam`] : ['ok', `dysk ${R.dysk.pct}% — nic do zrobienia`],
    kopie: R.kopie.last?.status === 'error' && (!R.kopie.lastOk || R.kopie.lastOk.start < R.kopie.last.start) ? ['bad', 'ostatnia nieudana'] : R.kopie.lastOk ? ['ok', `ostatnia: ${when(R.kopie.lastOk.end || R.kopie.lastOk.start)} OK`] : ['warn', 'brak udanej kopii'],
    aktualizacje: [R.aktualizacje.reboot || R.aktualizacje.stale?.length ? 'warn' : 'ok', `${R.aktualizacje.count ?? '?'} do zainstalowania · ${R.aktualizacje.reboot ? 'serwer czeka na restart' : 'restart niepotrzebny'}${R.aktualizacje.stale?.length ? ` · ${R.aktualizacje.stale.length} usług do odświeżenia (04:30)` : ''}`],
    ssl: ['ok', R.ssl.nearest ? `najbliższy: ${R.ssl.nearest.name} · ${dateFull(R.ssl.nearest.validTo)}` : 'brak danych'],
    testowe: [R.testowe.count ? 'info' : 'ok', R.testowe.count ? `teraz ${R.testowe.count} · ${bytes(R.testowe.rss)} RAM` : 'brak'],
    ataki: ['info', `${R.ataki.banned} zablokowanych teraz · ${R.ataki.total.toLocaleString('pl-PL')} łącznie`],
  };
  const extra = {
    dysk: () => { const sel = h('select', { class: 'input', style: 'width:auto', 'aria-label': 'Próg sprzątania' }, [75, 80, 85, 90].map((v) => h('option', { value: v }, `próg ${v}%`))); sel.value = s.diskThreshold; sel.onchange = () => save({ diskThreshold: Number(sel.value) }, '✓ Zapisano'); return sel; },
    testowe: () => { const sel = h('select', { class: 'input', style: 'width:auto', 'aria-label': 'Po ilu godzinach' }, [6, 12, 24, 48, 72].map((v) => h('option', { value: v }, `po ${v} h`))); sel.value = s.testMaxHours; sel.onchange = () => save({ testMaxHours: Number(sel.value) }, '✓ Zapisano'); return sel; },
    aktualizacje: () => {
      const c = h('input', { type: 'checkbox', checked: s.reboot.auto });
      c.onchange = () => save({ reboot: { auto: c.checked } }, c.checked ? '✓ Restart co tydzień włączony' : 'Restart co tydzień wyłączony');
      const day = h('select', { class: 'input', style: 'width:auto', 'aria-label': 'Dzień' }, DAYS.map((x, i) => h('option', { value: i }, x)));
      day.value = s.reboot.day; day.onchange = () => save({ reboot: { day: Number(day.value) } }, '✓ Zapisano');
      const hr = h('select', { class: 'input', style: 'width:auto', 'aria-label': 'Godzina' }, Array.from({ length: 24 }, (_, i) => h('option', { value: i }, `${pad(i)}:00`)));
      hr.value = s.reboot.hour; hr.onchange = () => save({ reboot: { hour: Number(hr.value) } }, '✓ Zapisano');
      return h('div', { class: 'acts' }, h('label', { class: 'check small' }, c, 'restart, gdy potrzebny:'), day, hr);
    },
    ataki: () => linkBtn('Zablokowane adresy', '#/autopilot?ataki', { small: true }),
  };
  const emailIn = h('input', { class: 'input', type: 'email', value: s.notify.email, placeholder: 'twoj@adres.pl', autocomplete: 'email', 'aria-label': 'Adres e-mail' });
  const emailOn = h('input', { type: 'checkbox', checked: s.notify.emailOn });
  const saveMail = h('button', { type: 'button', class: 'btn sm' }, 'Zapisz');
  saveMail.onclick = () => save({ notify: { email: emailIn.value.trim(), emailOn: emailIn.value.trim() ? true : false } }, '✓ Zapisano adres');
  emailOn.onchange = () => save({ notify: { emailOn: emailOn.checked, email: emailIn.value.trim() } });
  const gcOn = h('input', { type: 'checkbox', checked: d.notify.gibcordOn && d.notify.gibcordReady, disabled: d.notify.gibcordReady ? null : true });
  gcOn.onchange = () => save({ notify: { gibcordOn: gcOn.checked } }, gcOn.checked ? '✓ Powiadomienia na GibCordzie włączone' : 'Powiadomienia na GibCordzie wyłączone');
  const lvl = (v, label) => h('button', { type: 'button', class: `btn sm ${s.notify.level === v ? 'pri' : 'ghost'}`, onclick: () => save({ notify: { level: v } }) }, label);
  const testB = btn('Wyślij próbne powiadomienie', async () => {
    await busy(testB, async () => {
      try {
        const r = await api('POST', 'api/autopilot/test');
        if (!r.results.length) toast('Nie ma gdzie wysłać — wpisz e-mail albo włącz push.', 'bad');
        else toast(r.results.map((x) => `${x.via}: ${x.ok ? '✓ wysłano' : '✗ ' + x.error}`).join('\n'), r.results.every((x) => x.ok) ? 'ok' : 'bad');
      } catch (e) { toast(e.message, 'bad'); }
    });
  }, { small: true, icon: 'dzwonek' });
  let attacks = null;
  if (location.hash.includes('ataki')) {
    try { attacks = (await api('GET', 'api/autopilot/ataki')).jails; } catch {}
  }
  const unbanBtn = (jail, ip) => { const b = btn('Odblokuj', async () => { if (!(await ask({ title: `Odblokować ${ip}?`, text: `Adres znów będzie mógł próbować logowania (${jail}).`, ok: 'Odblokuj' }))) return; await busy(b, async () => { try { await api('POST', 'api/autopilot/ataki', { jail, ip, odblokuj: true }); toast('✓ Odblokowano', 'ok'); } catch (e) { toast(e.message, 'bad'); } }); reload(); }, { small: true }); return b; };
  const banIp = h('input', { class: 'input', placeholder: 'adres IP do zablokowania', 'aria-label': 'Adres IP' });
  const banB = btn('Zablokuj (SSH)', async () => { const ip = banIp.value.trim(); if (!ip) return; await busy(banB, async () => { try { await api('POST', 'api/autopilot/ataki', { jail: 'sshd', ip }); toast('✓ Zablokowano ' + ip, 'ok'); } catch (e) { toast(e.message, 'bad'); } }); reload(); }, { small: true, kind: 'danger' });

  put(box,
    h('section', { class: 'card ap-head' }, ring,
      h('div', { class: 'stack grow', style: 'gap:6px;flex-basis:260px' },
        h('h1', { style: 'font-size:26px' }, human.length ? `Serwer działa — ${human.length} ${plural(human.length, 'sprawa czeka', 'sprawy czekają', 'spraw czeka')} na Ciebie` : 'Wszystko w porządku — nic nie czeka na Ciebie'),
        h('span', { class: 'muted small' }, s.enabled ? 'Resztą autopilot zajmuje się sam. Poniżej widać, co zrobił i czego nie umie naprawić.' : 'Autopilot jest wyłączony — serwer niczego nie naprawia sam.')),
      h('label', { class: `check ap-switch ${s.enabled ? 'on' : ''}` }, onOff, h('b', null, s.enabled ? 'Autopilot włączony' : 'Autopilot wyłączony'))),
    d.todo.length ? h('section', { class: 'stack', style: 'gap:10px' }, h('h2', null, 'Do Ciebie'), d.todo.map((t) => {
      const [cls, tag] = LVL[t.level] || LVL.info;
      const b = t.action ? h('button', { type: 'button', class: 'btn sm' }, t.cta) : null;
      if (b) b.onclick = () => todoAct(t, b);
      return h('div', { class: `alert ${cls === 'bad' ? 'error' : cls}` }, h('span', { class: 'tag' }, tag),
        h('div', { class: 'stack txt', style: 'gap:2px' }, h('b', null, t.text), t.desc ? h('span', { class: 'small', style: 'color:#c9d1dc' }, t.desc) : null),
        b || (t.link ? (t.link.startsWith('#powiadomienia') ? h('a', { href: '#/autopilot', class: 'btn sm', onclick: (e) => { e.preventDefault(); document.getElementById('powiadomienia')?.scrollIntoView({ behavior: 'smooth' }); } }, t.cta) : linkBtn(t.cta, t.link, { small: true })) : null));
    })) : null,
    h('section', { class: 'gauges' },
      gauge('Strony działają', `${d.tiles.sites.ok} / ${d.tiles.sites.total}`, null, ''),
      gauge('Usługi działają', `${d.tiles.services.ok} / ${d.tiles.services.total}`, null, ''),
      gauge('Dysk', `${d.tiles.disk}%`, bar(d.tiles.disk), `próg sprzątania ${s.diskThreshold}%`),
      gauge('Ostatnia kopia', d.tiles.lastBackup ? when(d.tiles.lastBackup) : 'brak', null, '')),
    h('div', { class: 'cols' },
      h('section', { class: 'card', style: 'flex-basis:460px' }, h('div', { class: 'card-h' }, h('h2', null, 'Co się działo'), btn('Sprawdź teraz', async (e) => { const b = e.currentTarget; await busy(b, () => api('POST', 'api/autopilot/teraz')); reload(); }, { small: true, icon: 'odswiez' })),
        d.events.length ? h('div', { class: 'rows' }, d.events.map((e) => h(e.detail ? 'details' : 'div', { class: 'row', style: 'display:block' },
          h(e.detail ? 'summary' : 'div', { style: 'display:flex;gap:12px;align-items:flex-start;cursor:' + (e.detail ? 'pointer' : 'default') },
            h('span', { class: 'small muted', style: 'width:92px;flex:none' }, when(e.ts)),
            h('span', { 'aria-hidden': 'true', style: `width:10px;height:10px;border-radius:5px;flex:none;margin-top:5px;background:${DOT[e.level] || DOT.info}` }),
            h('span', { class: 'grow' }, e.text, e.auto ? h('span', { class: 'pill ok', style: 'margin-left:8px;min-width:0' }, 'sam') : null)),
          e.detail ? h('div', { class: 'out' }, e.detail) : null))) : h('div', { class: 'list-empty' }, 'Jeszcze nic — autopilot zapisuje tu wszystko, co sprawdził i zrobił.')),
      h('div', { class: 'stack', style: 'gap:16px;flex-basis:420px' },
        h('section', { class: 'card', id: 'powiadomienia' }, h('div', { class: 'card-h' }, h('h2', null, 'Gdzie mam Ci dać znać?'), h('div', { class: 'acts' }, lvl('wazne', 'Tylko ważne'), lvl('wszystko', 'Wszystko'))),
          h('div', { class: 'rows' },
            h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('label', { class: 'check', style: 'flex:0 0 auto' }, emailOn, h('b', null, 'E-mail')), h('div', { style: 'flex:1 1 200px' }, emailIn), saveMail,
              h('div', { class: 'small muted', style: 'flex-basis:100%' }, d.notify.mailReady ? 'Wysyłane z poczty skonfigurowanej na serwerze.' : 'Brak konfiguracji poczty na serwerze (pole „smtp” w konfiguracji panelu).')),
            h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { class: 'stack grow' }, h('b', null, 'Push na telefon'), h('span', { class: 's' }, `${d.notify.pushDevices} ${plural(d.notify.pushDevices, 'urządzenie', 'urządzenia', 'urządzeń')} · na iPhonie dodaj panel do ekranu początkowego`)),
              h('div', { class: 'acts' }, btn('Włącz tutaj', async (e) => { const b = e.currentTarget; await busy(b, async () => { try { await enablePush(); } catch (er) { toast(er.message, 'bad'); } }); reload(); }, { small: true, kind: 'pri' }), d.notify.pushDevices ? btn('Wyłącz tutaj', async () => { await disablePush(); reload(); }, { small: true }) : null)),
            (MOD('gibcord') ? h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('label', { class: 'check grow', style: 'flex-basis:240px' }, gcOn, h('div', { class: 'stack', style: 'gap:2px' }, h('b', null, 'GibCord'), h('span', { class: 's' }, d.notify.gibcordReady ? `Karta od „Serwer ${NM()}” do adminów GibCorda` : 'Wymaga GibCorda 5.10.4 lub nowszego i modułu GibCord w konfiguracji'))), testB) : h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('span', { class: 'grow small muted' }, 'Wyślij próbne powiadomienie na wszystkie włączone kanały.'), testB)))),
        reportCard(d.raport),
        h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Zasady')),
          h('div', { class: 'rows' }, RULES.map(([id, name, desc]) => {
            const c = h('input', { type: 'checkbox', checked: s.rules[id], disabled: id === 'ssl' || !s.enabled ? true : null });
            c.onchange = () => save({ rules: { [id]: c.checked } }, c.checked ? `✓ ${name}: włączone` : `${name}: wyłączone`);
            const [cls, txt] = ruleState[id];
            return h('div', { class: 'row', style: 'flex-wrap:wrap;align-items:flex-start' },
              h('label', { class: 'check', style: 'align-items:flex-start;flex:1 1 260px;min-height:0' }, c, h('div', { class: 'stack', style: 'gap:3px' }, h('b', null, name), h('span', { class: 's', style: 'line-height:1.45' }, desc))),
              h('div', { class: 'stack', style: 'gap:6px;align-items:flex-end;flex:0 1 auto' }, h('span', { class: `pill ${cls}`, style: 'white-space:normal;text-align:right' }, txt), extra[id] ? extra[id]() : null));
          })))),
    ),
    attacks ? h('section', { class: 'card', id: 'ataki' }, h('div', { class: 'card-h' }, h('h2', null, 'Zablokowane adresy (fail2ban)'), h('div', { class: 'acts' }, h('div', { style: 'width:200px' }, banIp), banB)),
      h('div', { class: 'rows' }, attacks.map((j) => h('div', { class: 'row', style: 'display:block' },
        h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;align-items:center' }, h('b', { class: 'mono' }, j.jail), h('span', { class: 'small muted' }, `teraz ${j.banned} · łącznie ${j.total.toLocaleString('pl-PL')} · nieudanych prób ${j.failed.toLocaleString('pl-PL')}`)),
        j.ips.length ? h('div', { class: 'rows', style: 'padding-left:8px' }, j.ips.map((ip) => h('div', { class: 'row' }, h('span', { class: 'mono grow' }, ip), unbanBtn(j.jail, ip)))) : null)))) : null,
  );
  if (window.AUTOPILOT_EXTRA) await window.AUTOPILOT_EXTRA(box);
  if (attacks) requestAnimationFrame(() => document.getElementById('ataki')?.scrollIntoView({ block: 'start' }));
  every(20000, () => reload());
};

/* -------------------------------------------------------- karta strony */

const SITE_TABS = [['przeglad', 'Przegląd'], ['pliki', 'Pliki'], ['wersje', 'Wersje i GitHub'], ['ochrona', 'Ochrona']];
function siteTabs(d) {
  const app = d.app && isAdmin() ? [['aplikacja', 'Aplikacja'], ['zmienne', 'Zmienne'], ['logi', 'Logi']] : [];
  return [SITE_TABS[0], ...app, ...SITE_TABS.slice(1).filter(([id]) => id !== 'pliki' || d.info.roots.length), ...(isAdmin() ? [['ustawienia', 'Ustawienia']] : [])];
}
const enc = encodeURIComponent;
window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

PAGES.strona = async (box, args, q, quiet) => {
  const name = args[0];
  const tab = args[1] || 'przeglad';
  if (quiet && state.dirty) return; // edytujesz plik — nie odświeżamy w tle
  const d = await api('GET', `api/strona/${enc(name)}`);
  d.jobs.filter((j) => !j.end).forEach((j) => watchJob(j));
  const st = d.status;
  const base = `#/strona/${enc(name)}`;
  const url = `${d.info.https ? 'https' : 'http'}://${name}/`;
  const days = daysLeft(st?.cert?.validTo);
  put(box,
    h('a', { href: '#/strony', class: 'small', style: 'font-weight:600' }, '‹ Strony'),
    h('div', { class: 'head' },
      h('div', null, h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, h('h1', { style: 'overflow-wrap:anywhere' }, name), st ? sitePill(st.status, st.code) : null,
        d.extras.password.on ? h('span', { class: 'pill warn' }, 'hasło') : null, d.extras.maintenance.on ? h('span', { class: 'pill warn' }, 'przerwa') : null),
        h('div', { class: 'sub' }, [{ pusta: 'strona', php: 'strona PHP', zip: 'strona z ZIP-a', node: 'aplikacja Node.js', przekierowanie: 'przekierowanie', aplikacja: 'aplikacja (proxy)', strona: 'strona' }[d.info.kind] || d.info.kind, d.info.roots[0]?.path, st?.cert?.validTo ? `SSL ${days} ${plural(days, 'dzień', 'dni', 'dni')}` : d.info.https ? '' : 'bez SSL'].filter(Boolean).join(' · '))),
      h('div', { class: 'acts' }, linkBtn('Otwórz stronę', url, { icon: 'ext', blank: true }), linkBtn('Statystyki', `#/statystyki/${enc(name)}`, { icon: 'statystyki' }), isAdmin() && d.info.root && !d.info.proxies?.length ? linkBtn('Przenieś', `#/przenies/${enc(name)}`, { icon: 'przenies' }) : null)),
    h('nav', { class: 'tabs', 'aria-label': 'Zakładki strony' }, siteTabs(d).map(([id, l]) => h('a', { href: `${base}/${id}`, class: id === tab ? 'on' : '', 'aria-current': id === tab ? 'page' : null }, l))),
  );
  if (window.SITE_EXTRA?.[tab]) return window.SITE_EXTRA[tab](box, name, d, q);
  if (tab === 'pliki') return siteFiles(box, name, d, q);
  if (tab === 'wersje') return siteVersions(box, name, d);
  if (tab === 'ochrona') return siteProtect(box, name, d);
  const up = d.uptime?.d7;
  const g = d.git;
  put(box,
    h('section', { class: 'gauges' },
      gauge('Stan', st ? ({ ok: 'Działa', redirect: 'Przekierowuje', warn: 'Uwaga', nodns: 'Brak DNS', down: 'Nie działa', off: 'Wyłączona' }[st.status] || st.status) : '—', null, st?.ms ? `odpowiedź ${st.ms} ms` : ''),
      gauge('Dostępność 7 dni', up ? `${up.pct.toFixed(up.pct >= 99.95 ? 0 : 1).replace('.', ',')}%` : '—', null, up ? `${up.checks} sprawdzeń` : 'jeszcze mierzę'),
      gauge('Osoby 7 dni', num(d.stats.visitors), null, `${num(d.stats.views)} odsłon`),
      gauge('Ostatnia zmiana', d.versions[0] ? when(d.versions[0].ts) : '—', null, d.versions[0] ? d.versions[0].label.slice(0, 40) : 'brak zapisanych wersji')),
    h('div', { class: 'cols' },
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Co mogę tu zrobić')),
        h('div', { class: 'rows' },
          d.info.roots.length ? h('a', { class: 'row', href: `${base}/pliki`, style: 'color:inherit' }, ico('pliki'), h('div', { class: 'stack grow' }, h('b', null, 'Pliki strony'), h('span', { class: 's' }, 'Przeglądaj, edytuj, wgrywaj — przed każdym zapisem zostaje poprzednia wersja')), h('span', { class: 'muted' }, '›')) : null,
          h('a', { class: 'row', href: `${base}/wersje`, style: 'color:inherit' }, ico('przywroc'), h('div', { class: 'stack grow' }, h('b', null, 'Wersje i GitHub'), h('span', { class: 's' }, g.repo ? `połączone z ${g.repo.replace(/^https:\/\/|^git@|\.git$/g, '')} · ${g.status === 'blad' ? 'ostatnia aktualizacja nie wyszła' : g.last ? 'ostatnio ' + when(g.last) : 'jeszcze nie wgrywano'}` : 'Połącz z repozytorium — strona sama się zaktualizuje po wysłaniu zmian')), h('span', { class: 'muted' }, '›')),
          h('a', { class: 'row', href: `${base}/ochrona`, style: 'color:inherit' }, ico('ssl'), h('div', { class: 'stack grow' }, h('b', null, 'Hasło i przerwa techniczna'), h('span', { class: 's' }, [d.extras.password.on ? `hasło włączone (${d.extras.password.user})` : 'bez hasła', d.extras.maintenance.on ? 'trwa przerwa techniczna' : ''].filter(Boolean).join(' · '))), h('span', { class: 'muted' }, '›')))),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Szczegóły')),
        h('div', { class: 'rows' },
          h('div', { class: 'row' }, h('span', { class: 'grow muted' }, 'Adres'), h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url)),
          st?.aliases?.length ? h('div', { class: 'row' }, h('span', { class: 'grow muted' }, 'Też pod'), h('span', null, st.aliases.join(', '))) : null,
          d.info.roots.map((r) => h('div', { class: 'row' }, h('span', { class: 'grow muted' }, r.label[0].toUpperCase() + r.label.slice(1)), h('span', { class: 'mono' }, r.path))),
          d.info.unit || st?.services?.length ? h('div', { class: 'row' }, h('span', { class: 'grow muted' }, 'Usługa'), h('a', { href: '#/uslugi' }, d.info.unit || st.services.join(', '))) : null,
          st?.cert?.validTo ? h('div', { class: 'row' }, h('span', { class: 'grow muted' }, 'Certyfikat SSL'), h('span', null, `do ${dateFull(st.cert.validTo)}`)) : null,
          st?.logs?.length ? h('div', { class: 'row' }, h('span', { class: 'grow muted' }, 'Logi'), h('div', { class: 'acts' }, st.logs.slice(0, 2).map((l) => linkBtn(/error/.test(l) ? 'błędy' : 'wejścia', '#/logi?z=' + enc('f:' + l), { small: true })))) : null))),
    stagingCard(name, d),
  );
};

function stagingCard(name, d) {
  if (!isAdmin()) return null;
  const base = `api/strona/${enc(name)}/kopia-testowa`;
  const run = async (b, akcja, extra = {}) => { await busy(b, async () => { try { const r = await api('POST', base, { akcja, ...extra }); watchJob(r.job, () => reload()); } catch (e) { toast(e.message, 'bad'); } }); };
  if (d.stagingOf) return h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'To jest kopia testowa')), h('p', { class: 'small', style: 'margin:0' }, 'Zmieniaj tu śmiało. Publikujesz ją z karty prawdziwej strony: ', h('a', { href: `#/strona/${enc(d.stagingOf)}` }, d.stagingOf), '.'));
  const st = d.staging;
  if (!st) {
    if (!d.info.roots.length || d.info.kind === 'aplikacja' || d.info.kind === 'node' || d.info.kind === 'przekierowanie') return null;
    const mk = btn('Zrób kopię testową', async () => {
      if (await ask({ title: 'Zrobić kopię testową?', text: 'Powstanie osobna strona test-… z kopią plików i bazy (jeśli strona jej używa), od razu za hasłem. Prawdziwa strona się nie zmienia. Gdy będzie gotowe — „Opublikuj” przeniesie pliki.', ok: 'Zrób kopię' })) run(mk, 'utworz');
    }, { small: true, kind: 'pri', icon: 'kopiuj' });
    return h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Kopia testowa'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Bezpieczne miejsce na zmiany: klon strony pod osobnym adresem, z własną bazą.')), mk));
  }
  const pub = btn('Opublikuj', async () => {
    const t = await ask({ title: `Opublikować kopię na ${name}?`, text: `Pliki z ${st.host} zastąpią pliki prawdziwej strony (najpierw zapiszę wersję, więc da się cofnąć).${st.testdb ? ` Baza zostaje bez zmian — zmiany w ${st.testdb} nie są przenoszone.` : ''}`, ok: 'Opublikuj', danger: true, typed: name });
    if (t) run(pub, 'opublikuj', { confirm: t });
  }, { small: true, kind: 'pri' });
  const del = btn('Usuń kopię', async () => { if (await ask({ title: 'Usunąć kopię testową?', text: `${st.host}${st.testdb ? ' i baza ' + st.testdb : ''} — przed usunięciem zrobię archiwum.`, ok: 'Usuń', danger: true })) run(del, 'usun'); }, { small: true, kind: 'ghost', icon: 'usun' });
  return h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Kopia testowa'), h('div', { class: 'small muted', style: 'margin-top:4px' }, `od ${when(st.created)}${st.testdb ? ` · baza ${st.testdb}` : ''}`)), h('div', { class: 'acts' }, pub, del)),
    h('div', { class: 'rows' },
      h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('a', { href: `#/strona/${enc(st.host)}`, class: 'grow', style: 'font-weight:600' }, st.host), linkBtn('Otwórz', st.url, { small: true, icon: 'ext', blank: true })),
      h('div', { class: 'row small' }, h('span', { class: 'grow muted' }, 'Hasło do kopii'), h('span', { class: 'mono' }, `${st.login} / ${st.pass}`)),
      st.files.length ? h('div', { class: 'row small muted' }, `Te pliki wskazują na bazę testową i nie są publikowane: ${st.files.join(', ')}`) : null));
}

function crumbs(name, root, rel) {
  const parts = rel ? rel.split('/') : [];
  const link = (i) => `#/strona/${enc(name)}/pliki?r=${enc(root)}&p=${enc(parts.slice(0, i).join('/'))}`;
  return h('div', { class: 'crumbs' }, h('a', { href: link(0) }, root.split('/').pop() || root), parts.map((p, i) => [h('span', { class: 'muted' }, '/'), i === parts.length - 1 ? h('b', null, p) : h('a', { href: link(i + 1) }, p)]));
}

async function siteFiles(box, name, d, q) {
  if (!d.info.roots.length) return put(box, h('section', { class: 'card' }, h('div', { class: 'list-empty' }, 'Ta strona nie ma własnych plików (np. przekierowanie albo aplikacja w innym miejscu).')));
  const root = q.get('r') || d.info.roots[0].path;
  const rel = q.get('p') || '';
  const fileRel = q.get('f');
  const L = await api('GET', `api/strona/${enc(name)}/pliki?r=${enc(root)}&p=${enc(rel)}`);
  const here = (p, f) => `#/strona/${enc(name)}/pliki?r=${enc(root)}&p=${enc(p)}${f ? '&f=' + enc(f) : ''}`;
  const post = async (act, body, okMsg) => { try { await api('POST', `api/strona/${enc(name)}/pliki/${act}`, { r: root, ...body }); if (okMsg) toast(okMsg, 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } };
  const askName = (title, value = '') => new Promise((res) => {
    const inp = h('input', { class: 'input', value, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Nazwa' });
    ask({ title, ok: 'Zapisz', extra: h('label', { class: 'field' }, h('span', null, 'Nazwa'), inp) }).then((ok) => res(ok ? inp.value.trim() : null));
    setTimeout(() => inp.focus(), 50);
  });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    for (const f of files) {
      toast(`Wgrywam ${f.name} (${bytes(f.size)})…`);
      try {
        const r = await fetch(apiPath(`api/strona/${enc(name)}/wgraj?r=${enc(root)}&p=${enc(rel)}&n=${enc(f.name)}`), { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/octet-stream' }, body: f, credentials: 'same-origin' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Błąd ${r.status}`);
        toast(`✓ ${f.name}`, 'ok');
      } catch (e) { toast(`${f.name}: ${e.message}`, 'bad'); }
    }
    reload();
  };
  const tools = h('div', { class: 'acts' },
    btn('Wgraj pliki', () => fileInput.click(), { small: true, kind: 'pri', icon: 'wgraj' }),
    btn('Nowy plik', async () => { const n = await askName('Nowy plik'); if (n) { await post('nowy', { p: rel, name: n }); location.hash = here(rel, rel ? rel + '/' + n : n); } }, { small: true, icon: 'plus' }),
    btn('Nowy folder', async () => { const n = await askName('Nowy folder'); if (n) post('folder', { p: rel, name: n }, '✓ Utworzono folder'); }, { small: true, icon: 'plus' }),
    linkBtn('Pobierz ZIP', `api/strona/${enc(name)}/pobierz?zip&r=${enc(root)}&p=${enc(rel)}`, { small: true, icon: 'pobierz' }),
    fileInput);
  const itemMenu = (it, full) => {
    const ren = btn('', async () => { const n = await askName(`Zmień nazwę: ${it.name}`, it.name); if (n && n !== it.name) post('nazwa', { p: full, name: n }, '✓ Zmieniono nazwę'); }, { small: true, kind: 'ghost', icon: 'edytuj', title: 'Zmień nazwę' });
    const del = btn('', async () => { if (await ask({ title: `Usunąć ${it.name}?`, text: 'Trafi do kosza panelu na 14 dni (da się odzyskać z serwera).', ok: 'Usuń', danger: true })) post('usun', { p: full }, `✓ ${it.name} w koszu`); }, { small: true, kind: 'ghost', icon: 'usun', title: 'Usuń' });
    const dl = it.dir ? null : linkBtn('', `api/strona/${enc(name)}/pobierz?r=${enc(root)}&p=${enc(full)}`, { small: true, icon: 'pobierz' });
    return h('div', { class: 'acts fm-acts' }, dl, ren, del);
  };
  const list = h('div', { class: 'fm-list' },
    rel ? h('a', { class: 'fm-item', href: here(rel.split('/').slice(0, -1).join('/')) }, h('span', { class: 'fm-ic dir' }, '‹'), h('span', { class: 'grow' }, 'wyżej')) : null,
    L.items.length ? L.items.map((it) => {
      const full = rel ? `${rel}/${it.name}` : it.name;
      const ext = it.dir ? 'DIR' : (it.name.includes('.') ? it.name.split('.').pop().slice(0, 4).toUpperCase() : 'PLIK');
      return h('div', { class: `fm-row ${full === fileRel ? 'on' : ''}` },
        h('a', { class: 'fm-item', href: it.dir ? here(full) : here(rel, full) },
          h('span', { class: `fm-ic ${it.dir ? 'dir' : ''}` }, ext),
          h('span', { class: 'stack grow', style: 'gap:1px' }, h('span', { class: 'ell' }, it.name), h('span', { class: 'small muted' }, it.dir ? 'folder' : `${bytes(it.size)} · ${when(it.mtime)}${it.secret ? ' · hasła' : ''}`))),
        itemMenu(it, full));
    }) : h('div', { class: 'list-empty', style: 'padding:14px' }, 'Pusty folder.'));
  const side = h('section', { class: 'card fm-side' }, h('div', { class: 'card-h', style: 'flex-wrap:wrap;gap:10px' }, crumbs(name, root, rel), d.info.roots.length > 1 ? h('div', { class: 'acts' }, d.info.roots.map((r) => linkBtn(r.label, `#/strona/${enc(name)}/pliki?r=${enc(r.path)}`, { small: true, kind: r.path === root ? 'pri' : '' }))) : null), tools, list);
  if (!fileRel) { state.dirty = false; put(box, h('div', { class: 'fm' }, side, h('section', { class: 'card fm-main fm-empty' }, h('div', { class: 'list-empty' }, 'Wybierz plik z listy, żeby go zobaczyć albo edytować.')))); return; }
  const f = await api('GET', `api/strona/${enc(name)}/plik?r=${enc(root)}&p=${enc(fileRel)}`);
  const editor = h('section', { class: 'card fm-main' });
  const head = (extra) => h('div', { class: 'card-h', style: 'flex-wrap:wrap;gap:10px' }, h('div', { class: 'stack', style: 'min-width:0' }, h('a', { href: here(rel), class: 'small fm-back' }, '‹ lista plików'), h('b', { class: 'ell' }, fileRel.split('/').pop()), h('span', { class: 'small muted' }, `${bytes(f.size)} · zmieniony ${when(f.mtime)}`)), extra);
  if (f.tooBig || f.binary) {
    const isImg = /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(fileRel);
    put(editor, head(linkBtn('Pobierz', `api/strona/${enc(name)}/pobierz?r=${enc(root)}&p=${enc(fileRel)}`, { small: true, icon: 'pobierz' })), h('div', { class: 'list-empty' }, f.tooBig ? 'Plik jest za duży do edycji w przeglądarce (powyżej 2 MB).' : isImg ? 'To obrazek — pobierz go albo podmień, wgrywając plik o tej samej nazwie.' : 'To plik binarny — można go pobrać albo podmienić.'));
    state.dirty = false;
    put(box, h('div', { class: 'fm file-open' }, side, editor));
    return;
  }
  const show = async () => {
    const ta = h('textarea', { class: 'code-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': `Treść pliku ${fileRel}`, wrap: 'off' });
    ta.value = f.text;
    const gutter = h('div', { class: 'code-gut', 'aria-hidden': 'true' });
    const lines = () => { const n = ta.value.split('\n').length; if (gutter.childElementCount !== n) gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); };
    lines();
    const status = h('span', { class: 'small muted' }, '');
    let mtime = f.mtime;
    const saveB = btn('Zapisz', () => save(), { small: true, kind: 'pri' });
    const undoB = btn('Cofnij zmiany', () => { ta.value = f.text; dirty(); lines(); }, { small: true });
    const dirty = () => { state.dirty = ta.value !== f.text; status.textContent = state.dirty ? 'niezapisane zmiany' : ''; saveB.disabled = !state.dirty; undoB.disabled = !state.dirty; };
    const save = async () => {
      if (!state.dirty) return;
      await busy(saveB, async () => {
        try { const r = await api('POST', `api/strona/${enc(name)}/plik`, { r: root, p: fileRel, text: ta.value, mtime }); mtime = r.mtime; f.text = ta.value; dirty(); toast('✓ Zapisano (poprzednia wersja pliku zachowana)', 'ok'); }
        catch (e) { toast(e.message, 'bad'); }
      });
    };
    ta.addEventListener('input', () => { dirty(); lines(); });
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); dirty(); }
    });
    const hist = f.history?.length ? h('select', { class: 'input', style: 'max-width:230px;min-height:36px', 'aria-label': 'Poprzednie wersje pliku' }, h('option', { value: '' }, `Poprzednie wersje (${f.history.length})`), f.history.map((v) => h('option', { value: v.id }, `${when(v.ts)} · ${bytes(v.size)}`))) : null;
    if (hist) hist.onchange = async () => {
      const id = hist.value; hist.value = '';
      if (!id) return;
      let txt = null;
      try { txt = (await api('GET', `api/strona/${enc(name)}/plik/wersja?r=${enc(root)}&p=${enc(fileRel)}&id=${enc(id)}`)).text; } catch (e) { return toast(e.message, 'bad'); }
      if (await ask({ title: 'Przywrócić tę wersję pliku?', ok: 'Przywróć', extra: h('div', { class: 'out', style: 'max-height:50vh' }, txt ?? '(plik binarny)') })) {
        try { await api('POST', `api/strona/${enc(name)}/plik/wersja`, { r: root, p: fileRel, id }); state.dirty = false; toast('✓ Przywrócono', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); }
      }
    };
    put(editor, head(h('div', { class: 'acts' }, status, hist, undoB, saveB)), h('div', { class: 'code' }, gutter, ta));
    dirty();
  };
  if (f.secret) {
    const showB = btn('Pokaż zawartość', () => { editor.replaceChildren(); show(); }, { small: true, kind: 'pri' });
    put(editor, head(null), h('div', { class: 'alert warn' }, h('span', { class: 'tag' }, 'HASŁA'), h('span', { class: 'txt' }, 'Ten plik zwykle zawiera hasła albo klucze. Otwórz go tylko wtedy, gdy nikt nie patrzy Ci w ekran.'), showB));
  } else await show();
  put(box, h('div', { class: 'fm file-open' }, side, editor));
}

async function siteVersions(box, name, d) {
  const g = d.git;
  const base = `api/strona/${enc(name)}`;
  const restore = async (v, b) => {
    if (!(await ask({ title: 'Przywrócić tę wersję?', text: `${v.label}\n${when(v.ts)}\n\nObecny stan zapiszę jako nową wersję, więc da się wrócić. Foldery uploads, node_modules, cache i logi zostają bez zmian.`, ok: 'Przywróć', danger: true }))) return;
    await busy(b, async () => { try { const r = await api('POST', `${base}/wersje/${v.id}/przywroc`); watchJob(r.job); } catch (e) { toast(e.message, 'bad'); } });
  };
  const snapB = btn('Zapisz wersję teraz', async () => { await busy(snapB, async () => { try { await api('POST', `${base}/wersje`, { label: 'Zapisane ręcznie' }); toast('✓ Zapisano wersję', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } }); }, { small: true, icon: 'zapisz' });
  const SRC = { github: 'z GitHuba', panel: 'z panelu' };
  const versionsCard = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Wersje'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Panel zapisuje stronę przed każdą zmianą z GitHuba i przed przywróceniem. Trzyma 10 ostatnich.')), snapB),
    d.versions.length ? h('div', { class: 'rows' }, d.versions.map((v, i) => {
      const b = btn('Przywróć', () => restore(v, b), { small: true, icon: 'przywroc' });
      return h('div', { class: 'row', style: 'flex-wrap:wrap' }, i === 0 ? h('span', { class: 'pill info' }, 'najnowsza') : null, h('div', { class: 'stack grow', style: 'flex-basis:220px' }, h('b', null, v.label), h('span', { class: 's' }, `${when(v.ts)} · ${SRC[v.source] || v.source}${v.who ? ' · ' + v.who : ''} · ${bytes(v.size)}`)), b);
    })) : h('div', { class: 'list-empty' }, 'Jeszcze nie ma zapisanych wersji.'));
  let gitCard;
  if (!g.repo) {
    const repo = h('input', { class: 'input', placeholder: 'https://github.com/uzytkownik/strona', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Adres repozytorium' });
    const branch = h('input', { class: 'input', value: 'main', 'aria-label': 'Gałąź', autocapitalize: 'off' });
    const sub = h('input', { class: 'input', placeholder: 'np. public (puste = całe repozytorium)', 'aria-label': 'Folder w repozytorium', autocapitalize: 'off' });
    const keyBox = h('div', { class: 'stack', style: 'gap:8px' });
    const keyB = btn('Repozytorium jest prywatne', async () => {
      await busy(keyB, async () => {
        try {
          const r = await api('POST', `${base}/git`, { klucz: true });
          const copy = btn('Kopiuj klucz', async () => { try { await navigator.clipboard.writeText(r.publicKey); toast('✓ Skopiowano', 'ok'); } catch { toast('Zaznacz i skopiuj ręcznie', 'bad'); } }, { small: true, icon: 'kopiuj' });
          keyBox.replaceChildren(h('ol', { class: 'small', style: 'margin:0;padding-left:20px;line-height:1.6;color:#c9d1dc' },
            h('li', null, 'W GitHubie otwórz repozytorium → Settings → Deploy keys → Add deploy key.'),
            h('li', null, 'Wklej poniższy klucz, NIE zaznaczaj „Allow write access”.'),
            h('li', null, 'Tutaj wpisz adres w postaci git@github.com:konto/repozytorium.git')),
            h('div', { class: 'out', style: 'margin:0;overflow-wrap:anywhere' }, r.publicKey), h('div', null, copy));
        } catch (e) { toast(e.message, 'bad'); }
      });
    }, { small: true, kind: 'ghost' });
    const auto = h('input', { type: 'checkbox', checked: true });
    const del = h('input', { type: 'checkbox' });
    const go = btn('Połącz', async () => {
      await busy(go, async () => { try { await api('POST', `${base}/git`, { repo: repo.value.trim(), branch: branch.value.trim(), subdir: sub.value.trim(), auto: auto.checked, del: del.checked }); toast('✓ Połączono — teraz kliknij „Wgraj teraz”', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } });
    }, { kind: 'pri' });
    gitCard = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Połącz z GitHubem'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Wysyłasz zmiany do repozytorium — strona sama się aktualizuje w kilka sekund. Działa też z GitLabem i Codebergiem.'))),
      h('div', { class: 'stack', style: 'gap:12px' },
        h('label', { class: 'field' }, h('span', null, 'Adres repozytorium'), repo),
        h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Gałąź'), branch), h('label', { class: 'field', style: 'flex-grow:2' }, h('span', null, 'Folder z plikami strony'), sub)),
        h('label', { class: 'check' }, auto, h('span', null, 'Aktualizuj sama po każdym wysłaniu zmian (webhook)')),
        h('label', { class: 'check' }, del, h('span', null, 'Usuwaj pliki, których nie ma w repozytorium (bez uploads, .env, config.php)')),
        h('div', { class: 'acts' }, go, keyB), keyBox));
  } else {
    const deployB = btn('Wgraj teraz', async () => { await busy(deployB, async () => { try { const r = await api('POST', `${base}/git/wdroz`, { force: false }); watchJob(r.job); } catch (e) { toast(e.message, 'bad'); } }); }, { small: true, kind: 'pri', icon: 'git' });
    const offB = btn('Odłącz', async () => { if (await ask({ title: 'Odłączyć repozytorium?', text: 'Pliki strony zostają. Panel przestanie je aktualizować z repozytorium.', ok: 'Odłącz', danger: true })) { try { await api('POST', `${base}/git`, { usun: true }); toast('Odłączono', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } } }, { small: true, kind: 'ghost' });
    const cp = (txt, label) => btn(label, async () => { try { await navigator.clipboard.writeText(txt); toast('✓ Skopiowano', 'ok'); } catch { toast('Nie udało się skopiować', 'bad'); } }, { small: true, icon: 'kopiuj' });
    gitCard = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'GitHub'), h('div', { class: 'small muted', style: 'margin-top:4px' }, `${g.repo} · gałąź ${g.branch}${g.subdir ? ' · folder ' + g.subdir : ''}`)), h('div', { class: 'acts' }, deployB, offB)),
      h('div', { class: 'rows' },
        h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('b', { class: 'grow' }, 'Na stronie'), h('span', { class: 'small muted' }, g.msg ? `„${g.msg}” (${(g.sha || '').slice(0, 7)})` : 'jeszcze nic nie wgrano'), h('span', { class: `pill ${g.status === 'ok' ? 'ok' : g.status === 'blad' ? 'bad' : 'off'}` }, g.status === 'ok' ? when(g.last) : g.status === 'blad' ? 'BŁĄD' : 'czeka')),
        g.err ? h('div', { class: 'row small', style: 'color:var(--bad-ink)' }, g.err) : null,
        g.auto ? h('div', { class: 'row', style: 'flex-wrap:wrap;align-items:flex-start' }, h('div', { class: 'stack grow', style: 'flex-basis:260px;gap:4px' }, h('b', null, 'Automatyczna aktualizacja'),
          h('span', { class: 's' }, 'W GitHubie: repozytorium → Settings → Webhooks → Add webhook. Payload URL i Secret skopiuj stąd, Content type: application/json, tylko zdarzenie „push”.')),
          h('div', { class: 'acts' }, cp(g.hookUrl, 'Kopiuj adres'), cp(g.secret, 'Kopiuj sekret'))) : h('div', { class: 'row small muted' }, 'Aktualizacja tylko ręcznie (przyciskiem).')));
  }
  put(box, h('div', { class: 'cols' }, gitCard, versionsCard));
}

async function siteProtect(box, name, d) {
  const base = `api/strona/${enc(name)}`;
  const P = d.extras.password, M = d.extras.maintenance;
  if (d.panelHost) return put(box, h('div', { class: 'alert info' }, h('span', { class: 'tag' }, 'INFO'), h('span', { class: 'txt' }, 'Przez tę stronę działa panel — hasło i przerwa są tu wyłączone, żeby się nie odciąć.')));
  const user = h('input', { class: 'input', value: P.user || 'gosc', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Login' });
  const pass = h('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: P.on ? 'nowe hasło (puste = bez zmian)' : 'hasło (min. 6 znaków)', 'aria-label': 'Hasło' });
  const genB = btn('Wymyśl', () => { const a = new Uint8Array(9); crypto.getRandomValues(a); pass.value = [...a].map((x) => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join(''); }, { small: true, kind: 'ghost' });
  const passB = btn(P.on ? 'Zapisz' : 'Włącz hasło', async () => { await busy(passB, async () => { try { await api('POST', `${base}/haslo`, { on: true, user: user.value.trim(), pass: pass.value }); toast(`✓ Hasło ${P.on ? 'zmienione' : 'włączone'} — login: ${user.value.trim()}`, 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } }); }, { small: true, kind: 'pri' });
  const passOff = P.on ? btn('Wyłącz hasło', async () => { await busy(passOff, async () => { try { await api('POST', `${base}/haslo`, { on: false }); toast('Hasło wyłączone — strona znów otwarta dla wszystkich', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } }); }, { small: true }) : null;
  const txt = h('input', { class: 'input', value: M.text || 'Trwają prace na stronie. Wracamy za chwilę.', 'aria-label': 'Komunikat dla odwiedzających' });
  const mOn = btn(M.on ? 'Zapisz komunikat' : 'Włącz przerwę', async () => { await busy(mOn, async () => { try { await api('POST', `${base}/przerwa`, { on: true, text: txt.value }); toast('✓ Przerwa techniczna włączona', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } }); }, { small: true, kind: M.on ? '' : 'pri' });
  const mOff = M.on ? btn('Zakończ przerwę', async () => { await busy(mOff, async () => { try { await api('POST', `${base}/przerwa`, { on: false }); toast('✓ Strona znów dostępna dla wszystkich', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } }); }, { small: true, kind: 'pri' }) : null;
  put(box, h('div', { class: 'cols' },
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Hasło na stronę'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Wejście tylko po wpisaniu loginu i hasła — dobre na wersje testowe i rzeczy „tylko dla swoich”.')), h('span', { class: `pill ${P.on ? 'warn' : 'off'}` }, P.on ? 'włączone' : 'wyłączone')),
      h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Login'), user), h('label', { class: 'field', style: 'flex-grow:2' }, h('span', null, 'Hasło'), pass)),
      h('div', { class: 'acts', style: 'margin-top:12px' }, passB, genB, passOff)),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Przerwa techniczna'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Ludzie widzą komunikat zamiast strony (wyszukiwarki dostają „wróć później”). Ty możesz ją dalej oglądać przez link podglądu.')), h('span', { class: `pill ${M.on ? 'warn' : 'off'}` }, M.on ? 'trwa' : 'wyłączona')),
      h('label', { class: 'field' }, h('span', null, 'Komunikat'), txt),
      M.on && M.preview ? h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('span', { class: 'grow small muted' }, 'Twój link podglądu (ustawia ciasteczko na 7 dni):'), linkBtn('Otwórz jako właściciel', M.preview, { small: true, blank: true, icon: 'ext' })) : null,
      h('div', { class: 'acts', style: 'margin-top:12px' }, mOff, mOn))));
}

/* ---------------------------------------------------------- statystyki */

function miniBars(vals, { labels, tall } = {}) {
  const max = Math.max(1, ...vals);
  return h('div', { class: `mbars ${tall ? 'tall' : ''}`, role: 'img', 'aria-label': `Wykres: ${vals.join(', ')}` },
    vals.map((v, i) => h('div', { class: 'mb' }, h('i', { style: `height:${Math.max(v ? 4 : 2, Math.round(v / max * 100))}%`, title: String(v) }), labels && tall && labels[i] ? h('span', null, labels[i]) : null)));
}
const DOW = ['nd', 'pn', 'wt', 'śr', 'czw', 'pt', 'sob'];
const dayLabel = (d, n) => { const t = new Date(d + 'T12:00'); return n <= 7 ? DOW[t.getDay()] : `${t.getDate()}.${pad(t.getMonth() + 1)}`; };
const changePill = (c) => c == null ? null : h('span', { class: `pill ${c > 0 ? 'ok' : c < 0 ? 'warn' : 'off'}` }, `${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c)}%`);
const num = (n) => Number(n || 0).toLocaleString('pl-PL');

PAGES.statystyki = async (box, args, q) => {
  const dni = Number(q.get('dni')) || 7;
  const chips = (base) => h('div', { class: 'acts' }, [[1, 'Dziś'], [7, '7 dni'], [30, '30 dni'], [90, '90 dni']].map(([v, l]) => linkBtn(l, `${base}?dni=${v}`, { small: true, kind: v === dni ? 'pri' : '' })));
  const sub = 'Z logów serwera — bez ciasteczek i bez śledzenia. Boty i skanery odfiltrowane, liczby w przybliżeniu.';
  if (args[0]) {
    const d = await api('GET', `api/statystyki/${encodeURIComponent(args[0])}?dni=${dni}`);
    const list = (title, rows, empty, fmt = (r) => r.key) => h('section', { class: 'card', style: 'flex-basis:300px' }, h('div', { class: 'card-h' }, h('h2', null, title)),
      rows.length ? h('div', { class: 'rows' }, rows.map((r) => h('div', { class: 'row' }, h('span', { class: 'grow ell mono small' }, fmt(r)), h('b', null, num(r.n))))) : h('div', { class: 'list-empty' }, empty));
    put(box,
      h('a', { href: `#/statystyki?dni=${dni}`, class: 'small', style: 'font-weight:600' }, '‹ Wszystkie strony'),
      h('div', { class: 'head' }, h('div', null, h('h1', null, d.site), h('div', { class: 'sub' }, d.last ? `Ostatnia odsłona: ${when(Date.parse(d.last + 'T12:00'), { time: false })}` : 'Brak odwiedzin.')), chips(`#/statystyki/${encodeURIComponent(d.site)}`)),
      h('section', { class: 'gauges' },
        gauge('Osoby', num(d.visitors), null, d.change == null ? 'każda liczona raz dziennie' : `${d.change > 0 ? '+' : ''}${d.change}% do poprzedniego okresu`),
        gauge('Odsłony stron', num(d.views), null, d.visitors ? `${(d.views / d.visitors).toFixed(1).replace('.', ',')} na osobę` : ''),
        gauge('Z telefonu', d.mobilePct == null ? '—' : `${d.mobilePct}%`, null, 'odsłon'),
        gauge('Nieistniejące strony', num(d.e404), null, d.e5xx ? `i ${d.e5xx} błędów serwera` : 'błędów serwera: 0')),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, dni === 1 ? 'Osoby — ostatnie 7 dni' : 'Osoby dziennie')),
        miniBars(d.series.map((x) => x.visitors), { labels: d.series.map((x, i, a) => a.length > 14 && (a.length - 1 - i) % Math.ceil(a.length / 10) ? '' : dayLabel(x.day, a.length)), tall: true })),
      h('div', { class: 'cols' },
        list('Najczęściej oglądane', d.paths, 'Brak odsłon.'),
        list('Skąd przychodzą', d.refs, 'Wszyscy wpisują adres sami albo mają zakładkę.'),
        list('Linki, które nie działają', d.notFound, 'Nikt nie trafił na nieistniejącą stronę.')));
    return;
  }
  const d = await api('GET', `api/statystyki?dni=${dni}`);
  const t = d.total || d.sites.reduce((a, x) => { for (const k of ['visitors', 'views', 'hits', 'bytes', 'e404', 'e5xx']) a[k] += x[k]; return a; }, { visitors: 0, views: 0, hits: 0, bytes: 0, e404: 0, e5xx: 0, change: null });
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Statystyki'), h('div', { class: 'sub' }, sub + (d.since ? ` Dane od ${dateFull(Date.parse(d.since + 'T12:00'))}.` : ''))), chips('#/statystyki')),
    h('section', { class: 'gauges' },
      gauge('Osoby', num(t.visitors), null, t.change == null ? 'każda liczona raz dziennie' : `${t.change > 0 ? '+' : ''}${t.change}% do poprzedniego okresu`),
      gauge('Odsłony stron', num(t.views), null, `wszystkich zapytań: ${num(t.hits)}`),
      gauge('Wysłane dane', bytes(t.bytes), null, 'razem z botami'),
      gauge('Błędy', num(t.e404 + t.e5xx), null, `${num(t.e404)} × nie ma strony · ${num(t.e5xx)} × błąd serwera`)),
    d.tips.length ? h('section', { class: 'stack', style: 'gap:8px' }, d.tips.map((x) => h('div', { class: 'alert info' }, h('span', { class: 'tag' }, x.kind === '404' ? 'LINK' : 'CISZA'), h('span', { class: 'txt' }, x.text),
      linkBtn('Szczegóły', `#/statystyki/${encodeURIComponent(x.site)}?dni=${dni}`, { small: true })))) : null,
    d.sites.length ? h('div', { class: 'tiles' }, d.sites.map((x) => h('a', { class: 'tile', href: `#/statystyki/${encodeURIComponent(x.name)}?dni=${dni}` },
      h('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:center' }, h('b', { class: 'ell' }, x.name), changePill(x.change)),
      h('span', { class: 'big' }, num(x.visitors)),
      h('span', { class: 'small muted' }, `${plural(x.visitors, 'osoba', 'osoby', 'osób')} · ${num(x.views)} odsłon`),
      miniBars(x.series)))) : h('section', { class: 'card' }, h('div', { class: 'list-empty' }, 'Jeszcze nic nie policzyłem — dane pojawią się za kilka minut.')),
  );
};

/* -------------------------------------------------------- serwery gier */

PAGES.gry = async (box, args, q) => {
  const d = await api('GET', 'api/gry' + (q.has('odswiez') ? '?odswiez' : ''));
  if (!d.connected) {
    const key = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'ptlc_…', 'aria-label': 'Klucz API' });
    const go = btn('Połącz', async () => { await busy(go, async () => { try { await api('POST', 'api/gry/polacz', { key: key.value }); toast('✓ Połączono z panelem gier', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } }); }, { kind: 'pri' });
    return put(box,
      h('div', { class: 'head' }, h('div', null, h('h1', null, 'Serwery gier'), h('div', { class: 'sub' }, `Stan serwerów z Pterodactyla (${(d.url || '').replace(/^https?:\/\//, '')}) i przyciski Start / Stop / Restart.`))),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Połącz z panelem gier')),
        h('ol', { class: 'small', style: 'margin:0 0 12px;padding-left:20px;line-height:1.7;color:#c9d1dc' },
          h('li', null, 'Zaloguj się na ', h('a', { href: `${d.url}/account/api`, target: '_blank', rel: 'noopener noreferrer' }, `${(d.url || 'panel gier').replace(/^https?:\/\//, '')} → Konto → API Credentials`), '.'),
          h('li', null, `Opis: „panel serwera”, Allowed IPs: ${d.ip || 'adres IP tego serwera'} (tylko ten serwer).`),
          h('li', null, 'Skopiuj klucz (zaczyna się od ptlc_, pokazuje się tylko raz) i wklej tutaj.')),
        h('div', { class: 'form-grid' }, h('label', { class: 'field', style: 'flex-grow:3' }, h('span', null, 'Klucz API konta'), key), h('div', { class: 'field', style: 'justify-content:flex-end;flex:0 0 auto' }, go))));
  }
  const act = async (sv, sig, b) => {
    const L = { start: ['Uruchomić', 'Uruchom'], stop: ['Zatrzymać', 'Zatrzymaj'], restart: ['Zrestartować', 'Restart'] }[sig];
    if (!(await ask({ title: `${L[0]} ${sv.name}?`, text: sig === 'start' ? '' : `Gracze na serwerze${sv.players?.online ? ` (${sv.players.online})` : ''} zostaną rozłączeni.`, ok: L[1], danger: sig === 'stop' }))) return;
    await busy(b, async () => { try { await api('POST', `api/gry/${sv.id}/${sig}`); toast(`✓ ${sv.name}: ${L[1].toLowerCase()} — za chwilę zmieni się stan`, 'ok'); setTimeout(() => reload(), 4000); } catch (e) { toast(e.message, 'bad'); } });
  };
  const ST = { running: ['ok', 'działa'], starting: ['warn', 'uruchamia się'], stopping: ['warn', 'zatrzymuje się'], offline: ['off', 'wyłączony'], nieznany: ['bad', 'brak połączenia z węzłem'] };
  const off = btn('Odłącz', async () => { if (await ask({ title: 'Odłączyć panel gier?', ok: 'Odłącz', danger: true })) { await api('POST', 'api/gry/odlacz'); reload(); } }, { small: true, kind: 'ghost' });
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Serwery gier'), h('div', { class: 'sub' }, `Z Pterodactyla jako ${d.user} · stan odświeżany co 20 s`)), h('div', { class: 'acts' }, linkBtn('Panel gier', d.url, { icon: 'ext', blank: true }), linkBtn('Odśwież', '#/gry?odswiez', { icon: 'restart' }), off)),
    d.error ? h('div', { class: 'alert error' }, h('span', { class: 'tag' }, 'BŁĄD'), h('span', { class: 'txt' }, d.error)) : null,
    d.servers.length ? h('div', { class: 'tiles' }, d.servers.map((sv) => {
      const [cls, txt] = ST[sv.state] || ['off', sv.state];
      const mem = sv.memory != null && sv.state === 'running' ? `${bytes(sv.memory)}${sv.limits?.memory ? ' / ' + bytes(sv.limits.memory * 1048576) : ''} RAM` : null;
      const b1 = sv.state === 'offline' ? btn('Uruchom', () => act(sv, 'start', b1), { small: true, kind: 'pri', icon: 'play' }) : null;
      const b2 = sv.state === 'running' ? btn('Restart', () => act(sv, 'restart', b2), { small: true, icon: 'restart' }) : null;
      const b3 = sv.state === 'running' || sv.state === 'starting' ? btn('Stop', () => act(sv, 'stop', b3), { small: true, icon: 'stop' }) : null;
      return h('div', { class: 'tile', style: 'cursor:default' },
        h('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:center' }, h('b', { class: 'ell' }, sv.name), h('span', { class: `pill ${cls}` }, txt)),
        h('span', { class: 'small muted' }, [sv.players ? `${sv.players.online}${sv.players.max ? ' / ' + sv.players.max : ''} ${plural(sv.players.online, 'gracz', 'graczy', 'graczy')}` : sv.state === 'running' ? 'graczy nie widać z zewnątrz' : '', mem, sv.cpu != null && sv.state === 'running' ? `CPU ${Math.round(sv.cpu)}%` : null, sv.uptime && sv.state === 'running' ? `od ${dur(sv.uptime / 1000)}` : null].filter(Boolean).join(' · ') || ' '),
        h('span', { class: 'small dim mono ell' }, sv.address || ''),
        sv.suspended ? h('span', { class: 'pill bad' }, 'zawieszony') : null,
        h('div', { class: 'acts', style: 'margin-top:6px' }, b1, b2, b3, linkBtn('Konsola', sv.link, { small: true, icon: 'ext', blank: true })));
    })) : h('section', { class: 'card' }, h('div', { class: 'list-empty' }, 'Na tym koncie nie ma serwerów.')),
  );
  every(20000, () => reload());
};

/* ------------------------------------------------------ strona statusu */

PAGES.statusowa = async (box) => {
  const d = await api('GET', 'api/status-strona');
  const s = d.settings;
  const save = async (patch, msg) => { try { await api('POST', 'api/status-strona', patch); if (msg) toast(msg, 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } };
  const on = h('input', { type: 'checkbox', checked: s.enabled });
  on.onchange = () => save({ enabled: on.checked }, on.checked ? '✓ Strona statusu włączona' : 'Strona statusu wyłączona');
  const editors = s.services.map((x) => {
    const nm = h('input', { class: 'input', value: x.name, 'aria-label': 'Nazwa usługi' });
    const sites = h('div', { class: 'site-picks' }, d.sites.map((n) => h('label', { class: 'check', style: 'min-height:34px' }, h('input', { type: 'checkbox', value: n, checked: x.sites.includes(n) }), h('span', { class: 'small' }, n))));
    const units = h('div', { class: 'site-picks' }, d.units.map((u) => h('label', { class: 'check', style: 'min-height:34px' }, h('input', { type: 'checkbox', value: u.unit, checked: x.units.includes(u.unit) }), h('span', { class: 'small' }, u.name))));
    const el = h('details', { class: 'row', style: 'display:block' }, h('summary', { style: 'display:flex;gap:12px;align-items:center;cursor:pointer;min-height:44px' }, h('b', { class: 'grow' }, x.name), h('span', { class: 'small muted' }, [...x.sites, ...x.units].join(', '))),
      h('div', { class: 'stack', style: 'gap:10px;padding:6px 0 10px' }, h('label', { class: 'field' }, h('span', null, 'Nazwa na stronie'), nm), h('span', { class: 'small muted' }, 'Sprawdzane adresy:'), sites, h('span', { class: 'small muted' }, 'i usługi serwera (gdy padną, pokażę „Nie działa”):'), units,
        h('div', null, btn('Usuń z listy', () => save({ services: s.services.filter((y) => y.id !== x.id) }, 'Usunięto'), { small: true, kind: 'ghost', icon: 'usun' }))));
    return { el, get: () => ({ id: x.id, name: nm.value, sites: [...sites.querySelectorAll('input:checked')].map((i) => i.value), units: [...units.querySelectorAll('input:checked')].map((i) => i.value) }) };
  });
  const saveAll = btn('Zapisz listę', () => save({ services: editors.map((e) => e.get()) }, '✓ Zapisano'), { small: true, kind: 'pri' });
  const addSvc = btn('Dodaj usługę', () => save({ services: [...s.services, { id: 'u' + Date.now().toString(36), name: 'Nowa usługa', sites: [d.sites[0]], units: [] }] }), { small: true, icon: 'plus' });
  const nt = h('input', { class: 'input', placeholder: 'np. W sobotę 10:00–11:00 przerwa w GibCordzie (aktualizacja)', 'aria-label': 'Komunikat' });
  const lv = h('select', { class: 'input', style: 'max-width:180px', 'aria-label': 'Rodzaj' }, h('option', { value: 'info' }, 'informacja'), h('option', { value: 'warn' }, 'uwaga'), h('option', { value: 'ok' }, 'rozwiązane'));
  const addN = btn('Opublikuj', () => { if (nt.value.trim()) save({ komunikat: nt.value, level: lv.value }, '✓ Komunikat jest na stronie'); }, { small: true, kind: 'pri' });
  put(box,
    h('a', { href: '#/strony', class: 'small', style: 'font-weight:600' }, '‹ Strony'),
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Strona statusu'), h('div', { class: 'sub' }, 'Publiczna strona dla użytkowników GibCorda i gier: czy wszystko działa i historia przerw. Bez adresów i szczegółów technicznych.')),
      h('div', { class: 'acts' }, h('label', { class: `check ap-switch ${s.enabled ? 'on' : ''}` }, on, h('b', null, s.enabled ? 'Włączona' : 'Wyłączona')), linkBtn('Otwórz', d.url, { icon: 'ext', blank: true }))),
    h('div', { class: 'alert info' }, h('span', { class: 'tag' }, 'ADRES'), h('span', { class: 'txt' }, d.url + ' — możesz go wkleić na GibCordzie (np. w #ogłoszenia).')),
    h('div', { class: 'cols' },
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Co pokazuję'), h('div', { class: 'acts' }, addSvc, saveAll)), h('div', { class: 'rows' }, editors.map((e) => e.el))),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Komunikaty')),
        h('div', { class: 'form-grid' }, h('div', { style: 'flex:3 1 260px' }, nt), lv, addN),
        h('div', { class: 'rows', style: 'margin-top:8px' }, s.notices.length ? s.notices.slice().reverse().map((n) => h('div', { class: 'row' }, h('span', { class: `pill ${n.level === 'warn' ? 'warn' : n.level === 'ok' ? 'ok' : 'info'}` }, when(n.ts, { time: false })), h('span', { class: 'grow' }, n.text), btn('', () => save({ usunKomunikat: n.ts }, 'Usunięto'), { small: true, kind: 'ghost', icon: 'usun', title: 'Usuń' }))) : h('div', { class: 'list-empty' }, 'Brak — przerwy z historii pokazuję sam.')))),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Tak to teraz wygląda')),
      h('div', { class: 'rows' }, d.preview.services.map((x) => h('div', { class: 'row' }, h('b', { class: 'grow' }, x.name), h('span', { class: `pill ${x.state === 'ok' ? 'ok' : x.state === 'off' ? 'off' : 'bad'}` }, x.state === 'ok' ? 'Działa' : x.state === 'off' ? 'Wyłączone' : 'Nie działa'), h('span', { class: 'small muted', style: 'min-width:90px;text-align:right' }, x.avg == null ? '—' : `${x.avg.toFixed(2).replace('.', ',')}%`))))),
  );
};

/* -------------------------------------------------------------- zapora */

PAGES.zapora = async (box) => {
  const d = await api('GET', 'api/zapora');
  const s = d.settings;
  const call = async (b, path, body, okMsg) => {
    await busy(b, async () => { try { const r = await api('POST', path, body); if (r?.job) watchJob(r.job, () => reload()); else if (okMsg) toast(okMsg, 'ok'); } catch (e) { toast(e.message, 'bad'); } });
    reload();
  };
  const enableB = btn(d.active ? 'Zastosuj ponownie' : 'Włącz bezpieczny zestaw', async () => {
    const ok = await ask({ title: 'Włączyć zaporę?', ok: 'Włącz',
      text: `Z internetu zostaną otwarte tylko: strony, SSH${Object.entries(d.serviceNames || {}).filter(([k]) => !['ssh', 'www', 'tailscale'].includes(k) && s.services[k]).map(([, n]) => ', ' + n.toLowerCase()).join('')}${s.services.tailscale ? ', Tailscale' : ''}. Baza danych tylko dla: ${s.trusted.map((t) => t.host).join(', ') || 'nikogo z zewnątrz'} i sieci Tailscale. Bezpiecznik: jeśli przez ${Math.round(d.undoSeconds / 60)} min nie potwierdzę, że serwer jest osiągalny, zapora sama się wyłączy.` });
    if (ok) call(enableB, 'api/zapora/wlacz');
  }, { kind: d.active ? '' : 'pri', icon: 'zapora' });
  const confirmB = btn('Działa, zostaw', () => call(confirmB, 'api/zapora/potwierdz', null, '✓ Zapora zostaje włączona'), { kind: 'pri', small: true });
  const offB = btn('Wyłącz zaporę', async () => {
    const t = await ask({ title: 'Wyłączyć zaporę?', text: 'Wszystkie usługi znów będą widoczne z internetu — także baza danych.', ok: 'Wyłącz', danger: true, typed: 'wyłącz' });
    if (t) call(offB, 'api/zapora/wylacz', { confirm: t }, 'Zapora wyłączona');
  }, { small: true, kind: 'danger' });
  const left = d.undoAt ? Math.max(0, Math.round((d.undoAt - Date.now()) / 1000)) : 0;

  const svcRow = (v) => {
    const c = h('input', { type: 'checkbox', checked: v.on, disabled: v.locked ? true : null, 'aria-label': v.name });
    c.onchange = () => call(null, 'api/zapora/usluga', { id: v.id, on: c.checked }, c.checked ? `✓ ${v.name}: otwarte` : `${v.name}: zamknięte`);
    return h('div', { class: 'row', style: 'flex-wrap:wrap' },
      h('label', { class: 'check', style: 'flex:1 1 260px' }, c, h('div', { class: 'stack', style: 'gap:2px' }, h('b', null, v.name), h('span', { class: 's mono' }, v.specs.join(', ')))),
      h('span', { class: `pill ${v.on ? 'ok' : 'off'}` }, v.locked ? 'zawsze otwarte' : v.on ? 'otwarte dla wszystkich' : 'zamknięte'));
  };
  const tHost = h('input', { class: 'input', placeholder: 'np. dom.example.pl albo IP', 'aria-label': 'Nazwa albo adres IP' });
  const tPorts = h('input', { class: 'input', value: '3306', 'aria-label': 'Porty', inputmode: 'numeric' });
  const tNote = h('input', { class: 'input', placeholder: 'opis (dla siebie)', 'aria-label': 'Opis' });
  const tAdd = btn('Dodaj', () => call(tAdd, 'api/zapora/zaufane', { host: tHost.value, ports: tPorts.value, note: tNote.value }, '✓ Dodano zaufany adres'), { small: true, kind: 'pri' });
  const cPort = h('input', { class: 'input', placeholder: 'port, np. 8080', inputmode: 'numeric', 'aria-label': 'Port' });
  const cProto = h('select', { class: 'input', 'aria-label': 'Protokół' }, h('option', { value: 'tcp' }, 'TCP'), h('option', { value: 'udp' }, 'UDP'), h('option', { value: 'all' }, 'TCP i UDP'));
  const cFrom = h('input', { class: 'input', placeholder: 'skąd (puste = wszyscy)', 'aria-label': 'Skąd' });
  const cNote = h('input', { class: 'input', placeholder: 'opis', 'aria-label': 'Opis' });
  const cAdd = btn('Otwórz port', () => call(cAdd, 'api/zapora/wlasne', { port: cPort.value, proto: cProto.value, from: cFrom.value, note: cNote.value }, '✓ Dodano regułę'), { small: true, kind: 'pri' });

  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Zapora'),
      h('div', { class: 'sub' }, d.active ? 'Włączona — z internetu widać tylko to, co poniżej jest otwarte.' : 'Wyłączona — wszystko, co działa na serwerze, jest widoczne z internetu.')),
      h('div', { class: 'acts' }, enableB, d.active ? offB : null)),
    d.undoAt ? h('div', { class: 'alert warn' }, h('span', { class: 'tag' }, 'CZEKAM'), h('span', { class: 'txt' }, `Sprawdzam, czy z internetu dalej da się wejść. Bez potwierdzenia zapora wyłączy się sama za ok. ${Math.ceil(left / 60)} min.`), confirmB) : null,
    !d.active && d.risky.length ? h('div', { class: 'alert error' }, h('span', { class: 'tag' }, 'RYZYKO'),
      h('div', { class: 'stack txt', style: 'gap:2px' }, h('b', null, `Z internetu widać: ${[...new Set(d.risky.map((p) => p.label))].join(', ')}`),
        h('span', { class: 'small', style: 'color:#c9d1dc' }, d.risky.some((p) => p.port === 3306) ? `Baza danych dostała ${d.attacks} prób logowania od obcych w tym tygodniu. Zapora zostawi ją tylko dla zaufanych adresów.` : 'Te usługi nie powinny być dostępne dla wszystkich.'))) : null,
    h('div', { class: 'cols' },
      h('section', { class: 'card', style: 'flex-basis:460px' }, h('div', { class: 'card-h' }, h('h2', null, 'Otwarte dla wszystkich')),
        h('div', { class: 'rows' }, d.services.map(svcRow))),
      h('div', { class: 'stack', style: 'gap:16px;flex-basis:420px' },
        h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Zaufane adresy'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Mają dostęp do wybranych portów (np. bazy). Nazwa jest sprawdzana co 5 minut — gdy zmieni się domowe IP, zapora sama wpuści nowe.'))),
          h('div', { class: 'rows' }, s.trusted.map((t) => {
            const rm = btn('', () => call(rm, 'api/zapora/zaufane', { host: t.host, usun: true }, 'Usunięto'), { icon: 'usun', small: true, kind: 'ghost', title: 'Usuń' });
            return h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { class: 'stack grow', style: 'flex-basis:200px' }, h('b', null, t.host), h('span', { class: 's' }, `${t.ip || 'adres sprawdzę przy włączaniu'} · port ${t.ports}${t.note ? ' · ' + t.note : ''}`)), rm);
          }), h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { style: 'flex:2 1 200px' }, tHost), h('div', { style: 'flex:1 1 90px' }, tPorts), h('div', { style: 'flex:2 1 160px' }, tNote), tAdd),
          h('div', { class: 'row small muted' }, 'Sieć Tailscale (Twój komputer) ma dostęp do wszystkiego.'))),
        h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Własne reguły')),
          h('div', { class: 'rows' }, s.custom.map((c) => {
            const rm = btn('', () => call(rm, 'api/zapora/wlasne', { id: c.id, usun: true }, 'Usunięto'), { icon: 'usun', small: true, kind: 'ghost', title: 'Usuń' });
            return h('div', { class: 'row' }, h('div', { class: 'stack grow' }, h('b', { class: 'mono' }, `${c.port} ${c.proto === 'all' ? 'TCP+UDP' : c.proto.toUpperCase()}`), h('span', { class: 's' }, `${c.from === 'any' ? 'dla wszystkich' : 'tylko ' + c.from}${c.note ? ' · ' + c.note : ''}`)), rm);
          }), h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { style: 'flex:1 1 110px' }, cPort), h('div', { style: 'flex:1 1 110px' }, cProto), h('div', { style: 'flex:2 1 160px' }, cFrom), h('div', { style: 'flex:2 1 160px' }, cNote), cAdd))))),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Co nasłuchuje na serwerze'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Programy, które czekają na połączenia z internetu, i czy zapora je przepuszcza.'))),
      h('div', { class: 'rows' }, d.ports.map((p) => h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('b', { class: 'mono', style: 'min-width:90px' }, `${p.port}/${p.proto}`),
        h('span', { class: 'grow', style: 'flex-basis:200px' }, p.label || p.by || p.proc, h('span', { class: 'small muted' }, ` · ${p.proc}`)),
        h('span', { class: `pill ${p.open ? (p.label ? 'bad' : 'ok') : p.limited ? 'warn' : 'off'}` }, p.open ? (d.active ? 'otwarte' : 'widoczne (zapora wyłączona)') : p.limited ? p.limited : 'zamknięte'))))),
    d.otherRules.length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Inne reguły (dodane ręcznie)')), h('div', { class: 'rows' }, d.otherRules.map((r) => h('div', { class: 'row mono small' }, r)))) : null,
  );
  if (d.undoAt || d.jobs?.some((j) => !j.end)) every(5000, () => reload());
};

/* --------------------------------------------- logowanie i konfiguracja */

function loginCard(...kids) { app.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'login' }, h('div', { class: 'brand', style: 'padding:0' }, h('div', { class: 'brand-ico' }, ico('logo', 20)), h('div', null, h('b', null, NM()), h('span', null, 'panel serwera'))), ...kids))); }

function showLogin(msg) {
  shell = null; clearTimers();
  const err = h('div', { class: 'err', hidden: !msg, role: 'alert' }, msg || '');
  const login = h('input', { class: 'input', name: 'login', autocomplete: 'username', autocapitalize: 'off', required: true });
  const pass = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const code = h('input', { class: 'input', name: 'totp', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]{6,7}', maxlength: 7, required: true, placeholder: '123456' });
  const go2 = h('button', { class: 'btn pri', type: 'submit' }, 'Zaloguj');
  loginCard(h('h1', { style: 'font-size:24px' }, 'Zaloguj się'), err,
    h('form', { style: 'display:flex;flex-direction:column;gap:14px', onsubmit: async (e) => {
      e.preventDefault(); err.hidden = true;
      await busy(go2, async () => {
        try { await api('POST', 'api/logowanie', { login: login.value, password: pass.value, totp: code.value }); await loadMe(); if (!location.hash) location.hash = '#/pulpit'; go(); }
        catch (er) { err.textContent = er.message; err.hidden = false; code.value = ''; code.focus(); }
      });
    } },
      h('label', { class: 'field' }, h('span', null, 'Login'), login),
      h('label', { class: 'field' }, h('span', null, 'Hasło'), pass),
      h('label', { class: 'field' }, h('span', null, 'Kod z aplikacji (6 cyfr)'), code), go2),
    h('p', { class: 'small muted', style: 'margin:0' }, `Kod znajdziesz w aplikacji uwierzytelniającej (Google Authenticator, Microsoft Authenticator itp.) pod nazwą „Serwer ${NM()}”.`));
  login.focus();
}

function showSetup() {
  const fromHash = (location.hash.match(/setup=([A-Za-z0-9_-]+)/) || [])[1] || '';
  const err = h('div', { class: 'err', hidden: true, role: 'alert' });
  const codeIn = h('input', { class: 'input', value: fromHash, autocomplete: 'off', required: true, 'aria-label': 'Kod konfiguracji' });
  const login = h('input', { class: 'input', autocomplete: 'username', autocapitalize: 'off', required: true, minlength: 3, value: 'bonkus' });
  const p1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
  const p2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
  const next = h('button', { class: 'btn pri', type: 'submit' }, 'Dalej');
  loginCard(h('h1', { style: 'font-size:24px' }, 'Pierwsze uruchomienie'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Ustaw login i hasło do panelu. W następnym kroku połączysz go z aplikacją na telefonie (kod 2FA).'), err,
    h('form', { style: 'display:flex;flex-direction:column;gap:14px', onsubmit: async (e) => {
      e.preventDefault(); err.hidden = true;
      if (p1.value !== p2.value) { err.textContent = 'Hasła się różnią.'; err.hidden = false; return; }
      await busy(next, async () => {
        try { const r = await api('POST', 'api/konfiguracja/start', { code: codeIn.value.trim(), login: login.value, password: p1.value }); showSetup2(codeIn.value.trim(), login.value.trim().toLowerCase(), r); }
        catch (er) { err.textContent = er.message; err.hidden = false; }
      });
    } },
      fromHash ? null : h('label', { class: 'field' }, h('span', null, 'Kod konfiguracji (z serwera)'), codeIn),
      h('label', { class: 'field' }, h('span', null, 'Login'), login),
      h('label', { class: 'field' }, h('span', null, 'Hasło (min. 10 znaków)'), p1),
      h('label', { class: 'field' }, h('span', null, 'Powtórz hasło'), p2), next));
}

function showSetup2(code, login, r) {
  const err = h('div', { class: 'err', hidden: true, role: 'alert' });
  const totp = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, required: true, placeholder: '123456', 'aria-label': 'Kod z aplikacji' });
  const fin = h('button', { class: 'btn pri', type: 'submit' }, 'Zakończ i wejdź do panelu');
  loginCard(h('h1', { style: 'font-size:24px' }, 'Połącz z telefonem'),
    h('p', { class: 'small', style: 'margin:0' }, '1. Otwórz aplikację uwierzytelniającą (np. Google Authenticator albo Microsoft Authenticator) i dodaj konto, skanując kod:'),
    h('img', { class: 'qr', alt: 'Kod QR do aplikacji uwierzytelniającej', src: 'data:image/svg+xml;utf8,' + encodeURIComponent(r.qr) }),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Na tym samym telefonie? Otwórz link albo wpisz klucz ręcznie:'),
    h('a', { href: r.uri, class: 'btn sm', style: 'align-self:center' }, 'Otwórz w aplikacji'),
    h('div', { class: 'secret' }, r.secret),
    h('p', { class: 'small', style: 'margin:0' }, '2. Wpisz 6-cyfrowy kod, który pokazała aplikacja:'), err,
    h('form', { style: 'display:flex;flex-direction:column;gap:14px', onsubmit: async (e) => {
      e.preventDefault(); err.hidden = true;
      await busy(fin, async () => {
        try { await api('POST', 'api/konfiguracja/koniec', { code, login, totp: totp.value }); await loadMe(); history.replaceState(null, '', location.pathname + '#/pulpit'); go(); toast('✓ Panel skonfigurowany. Od teraz logujesz się hasłem i kodem z aplikacji.', 'ok'); }
        catch (er) { err.textContent = er.message; err.hidden = false; totp.value = ''; totp.focus(); }
      });
    } }, totp, fin));
}

async function showInvite(token) {
  let z;
  try { z = await api('GET', `api/zaproszenie/${token}`); }
  catch (e) { return loginCard(h('h1', { style: 'font-size:24px' }, 'Zaproszenie'), h('div', { class: 'err', role: 'alert' }, e.message), h('a', { href: location.pathname, class: 'btn' }, 'Przejdź do logowania')); }
  const err = h('div', { class: 'err', hidden: true, role: 'alert' });
  const login = h('input', { class: 'input', autocomplete: 'username', autocapitalize: 'off', required: true, minlength: 3, value: z.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '').slice(0, 20) });
  const p1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
  const p2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
  const next = h('button', { class: 'btn pri', type: 'submit' }, 'Dalej');
  loginCard(h('h1', { style: 'font-size:24px' }, `Cześć, ${z.name}!`),
    h('p', { class: 'small', style: 'margin:0;color:#c9d1dc' }, `${z.by} zaprasza Cię do panelu serwera ${NM()}.`),
    h('div', { class: 'alert info' }, h('span', { class: 'tag' }, 'DOSTĘP'), h('span', { class: 'txt' }, z.roleText + (z.sites.length ? `: ${z.sites.join(', ')}` : ''))),
    h('p', { class: 'small muted', style: 'margin:0' }, `Ustaw login i hasło. Potem połączysz konto z aplikacją na telefonie (kod 2FA). Link działa do ${when(z.expires)}.`), err,
    h('form', { style: 'display:flex;flex-direction:column;gap:14px', onsubmit: async (e) => {
      e.preventDefault(); err.hidden = true;
      if (p1.value !== p2.value) { err.textContent = 'Hasła się różnią.'; err.hidden = false; return; }
      await busy(next, async () => {
        try { const r = await api('POST', 'api/zaproszenie/start', { token, login: login.value, password: p1.value }); showInvite2(token, r); }
        catch (er) { err.textContent = er.message; err.hidden = false; }
      });
    } },
      h('label', { class: 'field' }, h('span', null, 'Login'), login),
      h('label', { class: 'field' }, h('span', null, 'Hasło (min. 10 znaków)'), p1),
      h('label', { class: 'field' }, h('span', null, 'Powtórz hasło'), p2), next));
}
function showInvite2(token, r) {
  const err = h('div', { class: 'err', hidden: true, role: 'alert' });
  const totp = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, required: true, placeholder: '123456', 'aria-label': 'Kod z aplikacji' });
  const fin = h('button', { class: 'btn pri', type: 'submit' }, 'Zakończ i wejdź do panelu');
  loginCard(h('h1', { style: 'font-size:24px' }, 'Połącz z telefonem'),
    h('p', { class: 'small', style: 'margin:0' }, '1. Otwórz aplikację uwierzytelniającą (np. Google Authenticator albo Microsoft Authenticator) i zeskanuj kod:'),
    h('img', { class: 'qr', alt: 'Kod QR do aplikacji uwierzytelniającej', src: 'data:image/svg+xml;utf8,' + encodeURIComponent(r.qr) }),
    h('a', { href: r.uri, class: 'btn sm', style: 'align-self:center' }, 'Otwórz w aplikacji (ten telefon)'),
    h('div', { class: 'secret' }, r.secret),
    h('p', { class: 'small', style: 'margin:0' }, '2. Wpisz 6-cyfrowy kod z aplikacji:'), err,
    h('form', { style: 'display:flex;flex-direction:column;gap:14px', onsubmit: async (e) => {
      e.preventDefault(); err.hidden = true;
      await busy(fin, async () => {
        try { await api('POST', 'api/zaproszenie/koniec', { token, totp: totp.value }); await loadMe(); history.replaceState(null, '', location.pathname + '#/pulpit'); go(); toast('✓ Konto gotowe. Logujesz się loginem, hasłem i kodem z aplikacji.', 'ok'); }
        catch (er) { err.textContent = er.message; err.hidden = false; totp.value = ''; totp.focus(); }
      });
    } }, totp, fin));
}

/* --------------------------------------------------------------- start */

(async () => {
  try {
    const inv = (location.hash.match(/zaproszenie=([A-Za-z0-9_-]+)/) || [])[1];
    if (inv) return showInvite(inv);
    const s = await loadMe();
    if (s.setup) return showSetup();
    if (!s.login) return showLogin();
    go();
  } catch (e) {
    app.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'login' }, h('h1', null, 'Panel nie odpowiada'), h('p', null, e.message))));
  }
})();

/* --------------------------------- wspólne dla kolejnych plików (bazy.js itd.) */
window.P = { apiPath, NM, MOD, buildShell: () => buildShell(), renderNav: () => renderNav(), h, put, api, btn, linkBtn, ico, ICONS, busy, toast, ask, watchJob, when, dateFull, ago, bytes, plural, pad, reload, go, every, PAGES, state, isAdmin, backLink, num, sitePill };
