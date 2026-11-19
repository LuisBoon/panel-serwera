// Bezpieczeństwo (wariant A · Ocena i lista): wynik 0–100, sprawy od najważniejszych, przy każdej „Napraw”.
const { h, put, api, btn, linkBtn, ico, busy, toast, ask, watchJob, PAGES, state, isAdmin, plural, when, ago } = window.P;
const ICON = { ok: 'tak', bad: 'x', warn: 'wykrzyknik' };

async function runFix(b, f) {
  if (!(await ask({ title: f.label, text: f.confirm || 'Zrobić to teraz?', ok: f.label }))) return false;
  let ok = false;
  await busy(b, async () => {
    try {
      const r = await api('POST', 'api/bezpieczenstwo/napraw', { id: f.id });
      if (r.job) { watchJob(r.job, () => window.P.reload()); toast('Pracuję w tle…', 'ok'); } else { toast('✓ ' + (r.message || 'Gotowe'), 'ok'); }
      ok = true;
    } catch (e) { toast(e.message, 'bad'); }
  });
  return ok;
}

PAGES.bezpieczenstwo = async (box) => {
  const d = await api('GET', 'api/bezpieczenstwo');
  const owner = state.role === 'wlasciciel';
  const canFix = (f) => isAdmin() && (!f.owner || owner);
  const fixes = d.items.filter((i) => i.status !== 'ok' && i.fix && canFix(i.fix));
  const tone = d.score >= 80 ? 'ok' : d.score >= 50 ? 'warn' : 'bad';
  const head = d.bad ? `${d.bad} ${plural(d.bad, 'ważna sprawa', 'ważne sprawy', 'ważnych spraw')}` : d.warn ? `${d.warn} ${plural(d.warn, 'drobna sprawa', 'drobne sprawy', 'drobnych spraw')}` : 'Wszystko w porządku';
  const sub = d.bad && d.warn ? `i ${d.warn} ${plural(d.warn, 'drobna', 'drobne', 'drobnych')} · ` : '';
  const all = fixes.length > 1 ? btn('Napraw wszystko po kolei', async () => {
    for (const i of fixes) { if (!(await runFix(null, i.fix))) break; }
    window.P.reload();
  }, { kind: 'pri', icon: 'popraw' }) : null;
  const again = btn('Sprawdź jeszcze raz', () => window.P.reload(), { icon: 'odswiez' });
  const row = (i) => {
    const fb = i.fix && canFix(i.fix) ? btn(i.fix.label, async () => { if (await runFix(fb, i.fix)) window.P.reload(); }, { small: true, kind: 'pri', icon: 'popraw' }) : null;
    const lb = i.id === 'pliki' || i.id === 'boty' ? btn('Pokaż', () => document.getElementById(i.id === 'pliki' ? 'pliki-stron' : 'boty')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), { small: true, kind: i.id === 'pliki' ? 'pri' : '' })
      : i.link ? linkBtn(i.link.label, i.link.href, { small: true, kind: i.link.pri ? 'pri' : '' }) : null;
    return h('div', { class: `fx-c ${i.status}` }, h('span', { class: 'fx-s', 'aria-hidden': 'true' }, ico(ICON[i.status], 14)),
      h('div', { class: 'stack grow', style: 'gap:4px;min-width:0' }, h('b', null, i.title), i.text ? h('span', { class: 'small fx-text' }, i.text) : null,
        i.hint ? h('span', { class: 'small muted' }, i.hint) : null,
        i.banned?.length ? h('span', { class: 'small muted mono' }, 'zablokowane: ' + i.banned.join(', ')) : null,
        fb || lb ? h('div', { class: 'acts', style: 'margin-top:4px;flex-wrap:wrap' }, fb, lb) : null));
  };
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Bezpieczeństwo'), h('div', { class: 'sub' }, 'Logowanie, zapora, aktualizacje, ataki i certyfikaty — przy każdej sprawie przycisk, który ją naprawia.'))),
    h('section', { class: 'card sec-score' },
      h('div', { class: `sec-ring ${tone}`, style: `--p:${d.score}`, role: 'img', 'aria-label': `Wynik ${d.score} na 100` }, h('b', null, String(d.score)), h('small', null, '/100')),
      h('div', { class: 'stack', style: 'gap:6px;min-width:0' }, h('h2', { style: 'font-size:22px' }, head), h('span', { class: 'small muted' }, `${sub}${d.attempts.count} ${plural(d.attempts.count, 'próba', 'próby', 'prób')} zgadnięcia hasła SSH w ${d.attempts.days} dni · sprawdzono przed chwilą`),
        h('div', { class: 'acts', style: 'flex-wrap:wrap;margin-top:4px' }, all, again))),
    h('div', { class: 'fx-list' }, d.items.map(row)),
    d.pliki ? filesSection(d.pliki) : null,
    d.boty ? botsSection(d.boty, d.myIp) : null);
};

/* ---------------------------------------------------- strażnik plików stron (wariant A · alarm z decyzją) */
const KIND = { nowy: 'nowy plik', zmieniony: 'zmieniony plik', usuniety: 'usunięty plik' };
function codeBox(pv) {
  const cls = (l) => pv.kind === 'diff' ? (l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : '') : pv.kind === 'tresc' && pv.bad ? 'add' : '';
  return h('div', { class: 'stack', style: 'gap:4px' }, h('span', { class: 'small muted' }, pv.note),
    pv.lines.length ? h('div', { class: 'pf-code', role: 'region', 'aria-label': 'Podgląd pliku', tabindex: '0' }, pv.lines.map((l) => h('div', { class: `pf-l ${cls(l)}` }, l || ' '))) : null);
}
async function decide(b, c, act) {
  const T = {
    usun: [`Usunąć ${c.path}?`, 'Plik trafi do kwarantanny panelu — strona przestanie go widzieć. Gdyby był potrzebny, przywrócisz go z Dziennika zmian.', 'Usuń'],
    przywroc: [`Przywrócić ${c.path} z kopii?`, 'Wstawię wersję z ostatniej nocnej kopii, a obecną przeniosę do kwarantanny (do odzyskania z Dziennika zmian).', 'Przywróć'],
    zostaw: [`Zostawić ${c.path}?`, 'Uznam, że to Twoja zmiana, i nie będę już o nią pytać.', 'Zostaw'],
  }[act];
  if (!(await ask({ title: T[0], text: T[1], ok: T[2], danger: act === 'usun' }))) return;
  await busy(b, async () => { try { const r = await api('POST', `api/pliki/${c.id}/${act}`); toast('✓ ' + r.message, 'ok'); window.P.reload(); } catch (e) { toast(e.message, 'bad'); } });
}
function changeCard(c, auto) {
  const box = h('div');
  const load = async (b) => busy(b, async () => { try { box.replaceChildren(codeBox(await api('GET', `api/pliki/${c.id}/podglad`))); if (b) b.remove(); } catch (e) { toast(e.message, 'bad'); } });
  const showB = btn(c.kind === 'zmieniony' ? 'Pokaż zmiany' : 'Pokaż kod', () => load(showB), { small: true, icon: 'oko' });
  if (auto) setTimeout(() => load(showB), 0);
  const a = isAdmin();
  const b1 = a && c.kind === 'nowy' ? btn('Usuń', () => decide(b1, c, 'usun'), { small: true, icon: 'usun', kind: c.bad ? 'pri' : '' }) : null;
  const b2 = a && c.kind !== 'nowy' ? btn('Przywróć z kopii', () => decide(b2, c, 'przywroc'), { small: true, icon: 'proba', kind: c.bad ? 'pri' : '' }) : null;
  const b3 = a && c.kind === 'zmieniony' && c.bad ? btn('Usuń', () => decide(b3, c, 'usun'), { small: true, icon: 'usun' }) : null;
  const b4 = a ? btn('To ja — zostaw', () => decide(b4, c, 'zostaw'), { small: true, icon: 'tak' }) : null;
  return h('div', { class: `fx-c ${c.bad ? 'bad' : 'warn'}` }, h('span', { class: 'fx-s', 'aria-hidden': 'true' }, ico(c.bad ? 'x' : 'wykrzyknik', 14)),
    h('div', { class: 'stack grow', style: 'gap:6px;min-width:0' },
      h('div', { class: 'stack', style: 'gap:2px;min-width:0' }, h('b', null, `${c.site} — ${KIND[c.kind] || c.kind}`),
        h('span', { class: 'small mono ell' }, c.path), h('span', { class: 'small muted' }, `${c.kind === 'usuniety' ? 'zniknął' : c.kind === 'nowy' ? 'pojawił się' : 'zmieniony'} ${when(c.ts)} · nie przez panel ani GitHub`),
        c.bad ? h('span', { class: 'small fx-text', style: 'font-weight:600' }, `wygląda groźnie: ${c.bad}`) : null),
      box,
      h('div', { class: 'acts', style: 'justify-content:flex-start;flex-wrap:wrap' }, showB, b1, b2, b3, b4)));
}
function filesSection(d) {
  const a = isAdmin();
  const scanB = a ? btn('Sprawdź teraz', () => busy(scanB, async () => { try { const r = await api('POST', 'api/pliki/skanuj', {}); toast(r.fresh ? `Nowe zmiany: ${r.fresh}` : '✓ Bez nowych zmian', r.fresh ? 'bad' : 'ok'); window.P.reload(); } catch (e) { toast(e.message, 'bad'); } }), { small: true, icon: 'odswiez' }) : null;
  const sw = (on, label, fn) => { const i = h('input', { type: 'checkbox', class: 'sw', checked: on ? true : null, disabled: a ? null : true, 'aria-label': label, onchange: async () => { try { await fn(i.checked); window.P.reload(); } catch (e) { toast(e.message, 'bad'); i.checked = !i.checked; } } }); return i; };
  const open = d.open;
  const bySite = new Map();
  for (const c of open) { if (!bySite.has(c.site)) bySite.set(c.site, []); bySite.get(c.site).push(c); }
  const many = [...bySite.entries()].filter(([, l]) => l.filter((x) => !x.bad).length > 3);
  const acceptAll = (site, list, b) => busy(b, async () => {
    if (!(await ask({ title: `Zostawić ${list.length} zmian na ${site}?`, text: 'Uznam wszystkie zwykłe (niepodejrzane) zmiany na tej stronie za Twoje. Podejrzane pliki zostaną na liście.', ok: 'Zostaw wszystkie' }))) return;
    for (const c of list) { try { await api('POST', `api/pliki/${c.id}/zostaw`); } catch {} }
    window.P.reload();
  });
  const siteRow = (x) => {
    const t = !x.watch ? 'nie pilnowana' : x.files == null ? 'czeka na pierwsze sprawdzenie' : `${x.files.toLocaleString('pl-PL')} ${plural(x.files, 'plik', 'pliki', 'plików')}${x.last ? ` · ostatnia zmiana ${when(x.last.ts, { time: false })}${x.last.status === 'znana' && (x.last.by || x.last.why) ? ` (${x.last.why || x.last.by})` : ''}` : x.since ? ` · bez zmian od ${when(x.since, { time: false })}` : ''}`;
    return h('div', { class: `row pf-site ${x.watch ? '' : 'off'}`, style: 'gap:12px;flex-wrap:wrap' }, h('span', { class: `sym ${x.watch ? 'ok' : ''}` }, ico(x.watch ? 'ok' : 'minus', 18)),
      h('div', { class: 'stack grow', style: 'gap:1px;min-width:0;flex-basis:200px' }, h('span', { class: 't ell' }, x.name, x.also?.length ? h('span', { class: 'muted', style: 'font-weight:400' }, ` · też ${x.also.join(', ')}`) : null), h('span', { class: 's' }, t)),
      h('label', { class: 'pf-sw small muted' }, sw(x.watch, `Pilnuj ${x.name}`, (v) => api('POST', 'api/pliki/ustawienia', { site: x.name, watch: v })), 'pilnuj'));
  };
  return h('section', { class: 'card stack', id: 'pliki-stron', style: 'gap:12px;scroll-margin-top:80px' },
    h('div', { class: 'card-h', style: 'margin:0' }, h('div', { class: 'stack', style: 'gap:2px' }, h('h2', null, 'Pliki stron'), h('span', { class: 'small muted' }, 'Strażnik sprawdza co godzinę nowe, zmienione i usunięte pliki .php, .js i .htaccess. Zmiany z panelu i GitHuba są znane i nie alarmują.')),
      h('div', { class: 'acts' }, scanB, h('label', { class: 'pf-sw small' }, sw(d.settings.on, 'Strażnik plików włączony', (v) => api('POST', 'api/pliki/ustawienia', { on: v })), 'włączony'))),
    open.length ? h('div', { class: 'fx-list' }, many.map(([site, list]) => { const b = btn(`Zostaw wszystkie zwykłe zmiany na ${site} (${list.filter((x) => !x.bad).length})`, () => acceptAll(site, list.filter((x) => !x.bad), b), { small: true, icon: 'tak' }); return a ? h('div', null, b) : null; }),
      open.slice(0, 40).map((c, i) => changeCard(c, c.bad && i < 3)), open.length > 40 ? h('p', { class: 'small muted', style: 'margin:0' }, `…i ${open.length - 40} więcej`) : null)
      : h('div', { class: 'alert ok' }, h('span', { class: 'tag' }, 'OK'), h('span', { class: 'txt' }, d.settings.on ? 'Żadnych nieznanych zmian w plikach stron.' : 'Strażnik plików jest wyłączony.')),
    h('div', { class: 'sub-h' }, 'Pilnowane strony'),
    h('div', { class: 'rows' }, d.sites.map(siteRow)),
    d.history.length ? h('details', { class: 'small' }, h('summary', null, `Ostatnie zmiany (${d.history.length})`),
      h('div', { class: 'stack', style: 'gap:3px;margin-top:6px' }, d.history.map((c) => h('span', { class: 'muted' }, `${when(c.ts)} · ${c.site} · `, h('span', { class: 'mono' }, c.path), ` — ${KIND[c.kind] || c.kind}, ${{ znana: c.why || (c.by ? `panel (${c.by})` : 'znana'), zaakceptowana: `zostawiona (${c.by})`, usunieta: `usunięta (${c.by})`, przywrocona: `przywrócona z kopii (${c.by})` }[c.status] || c.status}`)))) : null);
}

/* ---------------------------------------------------- ochrona przed botami (wariant A · kto puka) */
const KLABEL = { 'wp-login': 'wp-login', xmlrpc: 'xmlrpc', 'wp-admin': 'wp-admin', '.env': '.env', '.git': '.git', phpmyadmin: 'phpmyadmin', phpunit: 'phpunit', 'cgi-bin': 'cgi-bin', klucze: 'klucze (.aws/.ssh)', kopie: 'kopie (.sql/.bak)', shell: 'powłoki PHP', routery: 'routery', inne: 'inne' };
const nf = (n) => Number(n).toLocaleString('pl-PL');
async function botCall(b, path, body, msg) {
  await busy(b, async () => { try { await api('POST', path, body); if (msg) toast('✓ ' + msg, 'ok'); window.P.reload(); } catch (e) { toast(e.message, 'bad'); } });
}
function botsSection(d, myIp) {
  if (d.error) return h('section', { class: 'card', id: 'boty' }, h('h2', null, 'Boty i skanery'), h('p', { class: 'small fx-text' }, d.error));
  const a = isAdmin();
  const s = d.settings;
  const mineSet = new Set(d.blocked.map((x) => x.ip));
  const row = (x) => {
    const panelBan = mineSet.has(x.ip) || x.banned.some((j) => j.startsWith('panel-'));
    const otherBan = !panelBan && x.banned.length;
    const blockB = a && !panelBan ? btn('Zablokuj', () => { ask({ title: `Zablokować ${x.ip}?`, text: `Ten adres nie wejdzie na żadną stronę (porty 80 i 443), dopóki go nie odblokujesz. Dziś: ${nf(x.n)} prób (${x.kinds.slice(0, 3).map((k) => KLABEL[k] || k).join(', ')}).`, ok: 'Zablokuj' }).then((ok) => ok && botCall(blockB, 'api/boty/zablokuj', { ip: x.ip, note: x.kinds.slice(0, 3).join(', ') }, `Zablokowano ${x.ip}`)); }, { small: true, icon: 'zablokuj' }) : null;
    const unB = a && panelBan ? btn('Odblokuj', () => botCall(unB, 'api/boty/odblokuj', { ip: x.ip }, `Odblokowano ${x.ip}`), { small: true, kind: 'ghost' }) : null;
    return h('div', { class: 'row bt-row', style: 'gap:12px;flex-wrap:wrap' }, h('span', { class: `bt-i ${panelBan || otherBan ? 'off' : 'bad'}` }, ico('bot', 18)),
      h('div', { class: 'stack grow', style: 'gap:2px;min-width:0;flex-basis:200px' }, h('b', { class: 'mono' }, x.ip),
        h('span', { class: 's small muted' }, `${nf(x.n)} ${plural(x.n, 'próba', 'próby', 'prób')} · ${x.kinds.slice(0, 4).map((k) => KLABEL[k] || k).join(', ')}${x.sites.length ? ' · ' + x.sites.slice(0, 2).join(', ') : ''}`)),
      panelBan ? h('span', { class: 'pill bad' }, 'zablokowany') : otherBan ? h('span', { class: 'pill info', title: x.banned.join(', ') }, 'blokuje go fail2ban') : null,
      h('div', { class: 'acts' }, blockB, unB));
  };
  const trustRow = (t) => h('div', { class: 'row bt-row', style: 'gap:12px;flex-wrap:wrap' }, h('span', { class: 'bt-i ok' }, ico('dom', 18)),
    h('div', { class: 'stack grow', style: 'gap:2px;min-width:0;flex-basis:200px' }, h('b', { class: 'mono' }, t.ip), h('span', { class: 's small muted' }, `${nf(t.n)} zapytań · ${t.label} — zaufany, nie liczy się`)),
    h('span', { class: 'pill ok' }, ico('zaufany', 13), ' zaufany'));
  const auto = h('input', { type: 'checkbox', checked: s.auto ? true : null, disabled: a ? null : true, 'aria-label': 'Blokuj skanery automatycznie',
    onchange: async () => { const want = auto.checked; auto.checked = !want; if (want && !(await ask({ title: 'Blokować skanery automatycznie?', text: `Adres, który w ciągu doby ${s.limit} razy szuka dziur (wp-login, .env, .git, phpmyadmin…), dostanie blokadę stron na dobę — przy kolejnych razach dłuższą. Zaufane adresy (serwer w domu, serwery z grupy, Twoja lista) nigdy. Dziś zablokowałoby to ${d.wouldBlock} ${plural(d.wouldBlock, 'adres', 'adresy', 'adresów')}.`, ok: 'Włącz' }))) return; await botCall(auto, 'api/boty/automat', { on: want }, want ? 'Automat włączony' : 'Automat wyłączony'); } });
  const more = d.scanners.length > 8;
  const list = h('div', { class: 'rows' }, d.scanners.slice(0, 8).map(row), d.trustedSeen.map(trustRow));
  const moreB = more ? btn(`Pokaż wszystkie (${d.scanners.length})`, () => { list.replaceChildren(...d.scanners.map(row), ...d.trustedSeen.map(trustRow)); moreB.remove(); }, { small: true, kind: 'ghost' }) : null;
  const chip = (t) => h('span', { class: 'bt-chip' }, ico(t.kind === 'dom' ? 'dom' : t.kind === 'grupa' ? 'serwery' : 'zaufany', 13), ` ${t.label} · `, h('span', { class: 'mono' }, t.ip),
    a && t.kind === 'lista' ? h('button', { type: 'button', class: 'bt-x', 'aria-label': `Usuń ${t.ip} z zaufanych`, onclick: (e) => botCall(e.currentTarget, 'api/boty/zaufany', { ip: t.ip, add: false }, 'Usunięto z zaufanych') }, ico('x', 12)) : null);
  const addMine = a && !d.trusted.some((t) => t.ip === myIp) && myIp ? btn(`Dodaj mój adres (${myIp})`, (e) => botCall(e.currentTarget, 'api/boty/zaufany', { mine: true }, 'Twój adres jest zaufany'), { small: true, icon: 'plus' }) : null;
  const addOther = a ? btn('Dodaj adres…', async (e) => {
    const b = e.currentTarget;
    const ipI = h('input', { class: 'input', id: 'bt-ip', placeholder: 'np. 203.0.113.7', autocomplete: 'off', inputmode: 'decimal' }), noteI = h('input', { class: 'input', id: 'bt-opis', placeholder: 'np. biuro', maxlength: 60 });
    if (!(await ask({ title: 'Zawsze wpuszczaj adres', text: 'Ten adres nigdy nie zostanie zablokowany — ani automatycznie, ani przez fail2ban przy stronach.', ok: 'Dodaj', extra: h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Adres IP'), ipI), h('label', { class: 'field' }, h('span', null, 'Opis'), noteI)) }))) return;
    botCall(b, 'api/boty/zaufany', { ip: ipI.value.trim(), note: noteI.value.trim() }, 'Dodano do zaufanych');
  }, { small: true, icon: 'plus', kind: 'ghost' }) : null;
  return h('section', { class: 'card stack', id: 'boty', style: 'gap:12px;scroll-margin-top:80px' },
    h('div', { class: 'card-h', style: 'margin:0' }, h('h2', null, 'Boty i skanery'),
      h('div', { class: 'acts' }, (() => { const b = btn('Odśwież', () => busy(b, async () => { try { await api('GET', 'api/boty?odswiez=1'); window.P.reload(); } catch (e) { toast(e.message, 'bad'); } }), { small: true, icon: 'odswiez' }); return b; })())),
    h('div', { class: 'bt-head' }, h('div', { class: 'stack', style: 'gap:2px' }, h('b', { class: 'bt-big' }, nf(d.attempts)),
      h('span', { class: 'small muted' }, `${plural(d.attempts, 'próba', 'próby', 'prób')} szukania dziur dziś · ${d.addresses} ${plural(d.addresses, 'adres', 'adresy', 'adresów')} · z ${nf(d.total)} wszystkich zapytań`)),
      d.attempts ? h('span', { class: 'pill warn' }, ico('bot', 13), ' skanery') : h('span', { class: 'pill ok' }, 'spokojnie')),
    d.scanners.length || d.trustedSeen.length ? h('div', { class: 'sub-h' }, 'Kto puka najczęściej') : null,
    list, moreB,
    h('label', { class: 'bt-auto' }, auto, h('div', { class: 'stack', style: 'gap:2px' }, h('b', null, `Blokuj skanery same (po ${s.limit} próbach w ciągu doby)`),
      h('span', { class: 'small muted' }, s.auto ? (d.jails.skanery ? 'Działa — blokada na dobę, przy powtórkach dłużej.' : 'Włączony, ale fail2ban go jeszcze nie wczytał — kliknij Odśwież za chwilę.') : `Wyłączony · dziś zablokowałby ${d.wouldBlock} ${plural(d.wouldBlock, 'adres', 'adresy', 'adresów')}.`))),
    h('details', { class: 'small' }, h('summary', null, 'Więcej: zawsze wpuszczani i zablokowani ręcznie'),
      h('div', { class: 'stack', style: 'gap:10px;margin-top:8px' },
        h('div', { class: 'sub-h' }, 'Zawsze wpuszczaj'),
        h('div', { class: 'bt-chips' }, d.trusted.length ? d.trusted.map(chip) : h('span', { class: 'muted' }, 'Tylko ten serwer.')),
        a ? h('div', { class: 'acts', style: 'justify-content:flex-start' }, addMine, addOther) : null,
        h('div', { class: 'sub-h' }, `Zablokowane ręcznie (${d.blocked.length})`),
        d.blocked.length ? h('div', { class: 'rows' }, d.blocked.map((x) => { const b = a ? btn('Odblokuj', () => botCall(b, 'api/boty/odblokuj', { ip: x.ip }, `Odblokowano ${x.ip}`), { small: true, kind: 'ghost' }) : null; return h('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap' }, h('b', { class: 'mono grow' }, x.ip), h('span', { class: 'small muted' }, `${when(x.ts)} · ${x.by}${x.note ? ' · ' + x.note : ''}`), b); })) : h('span', { class: 'muted' }, 'Nikt.'),
        d.f2b ? null : h('p', { class: 'fx-text', style: 'margin:0' }, 'Na serwerze nie ma fail2ban — blokowanie nie zadziała. Zainstaluj go wyżej („Napraw” przy ochronie logowania).'))));
}
