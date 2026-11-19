// Ustawienia panelu (i kreator pierwszego uruchomienia po instalacji): nazwa, adres z certyfikatem, moduły,
// integracje (serwer w domu, panel gier, GibCord, poczta), aktualizacja panelu z GitHuba.
const { h, put, api, btn, linkBtn, busy, toast, ask, watchJob, when, PAGES, state, loadMe } = window.P;

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('span', { class: 'small muted' }, hint) : null);
const inp = (value, attrs = {}) => h('input', { class: 'input', value: value ?? '', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', ...attrs });

PAGES.ustawienia = async (box) => {
  if (state.role !== 'wlasciciel') { put(box, h('div', { class: 'alert info' }, h('span', { class: 'tag' }, 'INFO'), h('span', { class: 'txt' }, 'Ustawienia panelu zmienia tylko właściciel.'))); return; }
  const d = await api('GET', 'api/ustawienia');
  d.jobs?.filter((j) => !j.end).forEach((j) => watchJob(j, () => window.P.reload()));
  const c = d.config;
  const wizard = !!c.kreator;
  const saveB = (label, get, after) => { const b = btn(label, () => busy(b, async () => {
    try { const r = await api('POST', 'api/ustawienia', get()); state.cfg = r.konfig; toast('✓ Zapisano', 'ok'); window.P.buildShell(); after?.(); window.P.reload(); } catch (e) { toast(e.message, 'bad'); }
  }), { kind: 'pri', small: true }); return b; };

  // 1. serwer
  const nazwa = inp(c.nazwa), domena = inp(c.domena, { placeholder: 'np. mojserwer.pl' });
  // 2. adres panelu
  const adres = inp(c.adres, { placeholder: 'np. panel.mojserwer.pl' }), email = inp('', { placeholder: 'np. ja@mojserwer.pl (opcjonalnie)', type: 'email' });
  const setAddr = btn('Ustaw adres i certyfikat', () => busy(setAddr, async () => {
    try { const r = await api('POST', 'api/ustawienia/adres', { domena: adres.value, email: email.value }); watchJob(r.job, (j) => { if (j.ok && j.result?.url) toast(`✓ Panel działa pod ${j.result.url}`, 'ok'); }); } catch (e) { toast(e.message, 'bad'); }
  }), { kind: 'pri', small: true });
  // 3. moduły
  const mods = {};
  const modList = h('div', { class: 'mod-grid' }, Object.entries(c.MODULES).map(([k, [name, desc]]) => {
    const cb = h('input', { type: 'checkbox', checked: !!c.moduly[k] }); mods[k] = cb;
    return h('label', { class: 'check mod-item' }, cb, h('span', { class: 'stack', style: 'gap:1px' }, h('b', null, name), h('span', { class: 'small muted' }, desc)));
  }));
  // 4. integracje
  const domHost = inp(c.dom?.host, { placeholder: 'np. dom.mojserwer.pl' }), domOpis = inp(c.dom?.opis, { placeholder: 'np. serwer gier w domu' });
  const gryUrl = inp(c.gry?.panel, { placeholder: 'https://panel.mojserwer.pl' }), gryDb = inp(c.gry?.baza, { placeholder: 'panel' });
  const gcUrl = inp(c.gibcord?.url, { placeholder: 'http://127.0.0.1:8084' }), gcTok = inp(c.gibcord?.tokenFile, { placeholder: '/var/lib/dc/serwer-bot.token' }), gcUnit = inp(c.gibcord?.usluga, { placeholder: 'dc' }), gcDom = inp(c.gibcord?.domena, { placeholder: 'gibcord.mojserwer.pl' });
  const sHost = inp(c.smtp?.host, { placeholder: 'smtp.example.com' }), sPort = inp(c.smtp?.port || '', { placeholder: '465', inputmode: 'numeric' }), sUser = inp(c.smtp?.user), sPass = inp(c.smtp?.pass, { type: 'password' }), sFrom = inp(c.smtp?.from, { placeholder: 'Serwer <noreply@mojserwer.pl>' });
  // 5. aktualizacja
  const upd = d.update ? btn(`Zainstaluj ${d.latest.version}`, () => busy(upd, async () => {
    if (!(await ask({ title: `Zainstalować wersję ${d.latest.version}?`, text: 'Panel pobierze nową wersję z GitHuba i uruchomi się ponownie (około minuty). Ustawienia i dane zostają.', ok: 'Zainstaluj' }))) return;
    try { await api('POST', 'api/ustawienia/aktualizuj', {}); toast('Aktualizuję… strona odświeży się sama', 'ok'); const t0 = Date.now(); const tick = async () => { try { const s = await api('GET', 'api/stan'); if (s.version === d.latest.version) { location.reload(); return; } } catch {} if (Date.now() - t0 < 300e3) setTimeout(tick, 4000); }; setTimeout(tick, 8000); }
    catch (e) { toast(e.message, 'bad'); }
  }), { kind: 'pri', small: true }) : null;

  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, wizard ? 'Witaj w panelu!' : 'Ustawienia panelu'), h('div', { class: 'sub' }, wizard ? 'Panel jest zainstalowany. Ustaw adres, wybierz moduły i kliknij „Gotowe” — resztę możesz zmienić później w Narzędzia → Ustawienia panelu.' : `Wersja ${d.version} · ustawienia zapisane w /var/lib/panel-serwera/konfiguracja.json`))),
    wizard ? h('ol', { class: 'wz-steps' }, ['Konto', 'Adres', 'Moduły', 'Gotowe'].map((l, i) => h('li', { class: `wz-step ${i === 0 ? 'done' : i === 1 ? 'on' : ''}` }, h('span', null, h('span', { class: 'wz-num' }, i === 0 ? '✓' : String(i + 1)), l)))) : null,
    h('div', { class: 'cols' },
      h('section', { class: 'card stack', style: 'gap:12px' }, h('h2', null, 'Serwer'),
        field('Nazwa serwera', nazwa, 'Widać ją w menu, w aplikacji z kodami („Serwer …”) i w powiadomieniach.'),
        field('Główna domena stron', domena, 'Nowe strony w kreatorze dostaną adres w tej domenie, np. sklep.mojserwer.pl.'),
        h('div', null, saveB('Zapisz', () => ({ nazwa: nazwa.value, domena: domena.value })))),
      h('section', { class: 'card stack', style: 'gap:12px' }, h('h2', null, 'Adres panelu'),
        c.adres ? h('div', { class: `alert ${d.dns?.ok ? 'ok' : 'warn'}` }, h('span', { class: 'tag' }, d.dns?.ok ? 'OK' : 'DNS'), h('span', { class: 'txt' }, d.dns?.ok ? `Panel działa pod https://${c.adres}/` : `${c.adres} nie wskazuje na ten serwer (${d.ip}).`)) : h('p', { class: 'small muted', style: 'margin:0' }, `Teraz otwierasz panel pod adresem IP. Dodaj u operatora domeny rekord A: panel.twojadomena.pl → ${d.ip}, wpisz go niżej, a panel sam pobierze certyfikat https.`),
        field('Adres', adres), field('E-mail do powiadomień o certyfikacie', email),
        h('div', null, setAddr))),
    h('section', { class: 'card stack', style: 'gap:12px' }, h('div', { class: 'card-h' }, h('div', null, h('h2', null, 'Moduły'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Wyłączone moduły znikają z menu. Dane zostają — możesz je włączyć z powrotem.'))),
      modList, h('div', null, saveB('Zapisz moduły', () => ({ moduly: Object.fromEntries(Object.entries(mods).map(([k, cb]) => [k, cb.checked])) })))),
    h('section', { class: 'card stack', style: 'gap:12px' }, h('h2', null, 'Integracje'),
      h('details', { open: !!c.dom || null }, h('summary', null, h('b', null, 'Serwer w domu (dynamiczne IP)')),
        h('div', { class: 'stack', style: 'gap:10px;margin-top:10px' }, h('p', { class: 'small muted', style: 'margin:0' }, 'Np. komputer z serwerami gier. Zapora i konta baz same nadążają za zmianą jego adresu.'),
          h('div', { class: 'form-grid' }, field('Nazwa (DNS)', domHost), field('Opis', domOpis)), h('div', null, saveB('Zapisz', () => ({ dom: domHost.value ? { host: domHost.value, opis: domOpis.value } : null }))))),
      h('details', { open: !!c.gry || null }, h('summary', null, h('b', null, 'Panel gier (Pterodactyl)')),
        h('div', { class: 'stack', style: 'gap:10px;margin-top:10px' }, h('div', { class: 'form-grid' }, field('Adres panelu gier', gryUrl), field('Baza panelu gier (do diagnozy)', gryDb)), h('div', null, saveB('Zapisz', () => ({ gry: gryUrl.value ? { panel: gryUrl.value, baza: gryDb.value } : null }))))),
      h('details', { open: !!c.gibcord || null }, h('summary', null, h('b', null, 'GibCord (powiadomienia od bota)')),
        h('div', { class: 'stack', style: 'gap:10px;margin-top:10px' }, h('p', { class: 'small muted', style: 'margin:0' }, 'Komunikator GibCord 5.10.4+ na tym serwerze: raporty i alarmy przychodzą jako karty do adminów.'),
          h('div', { class: 'form-grid' }, field('Adres API', gcUrl), field('Plik z tokenem bota', gcTok), field('Usługa', gcUnit), field('Domena', gcDom)), h('div', null, saveB('Zapisz', () => ({ gibcord: gcUrl.value ? { url: gcUrl.value, tokenFile: gcTok.value, usluga: gcUnit.value, domena: gcDom.value } : null }))))),
      h('details', { open: !!c.smtp || null }, h('summary', null, h('b', null, 'Poczta (SMTP) do powiadomień')),
        h('div', { class: 'stack', style: 'gap:10px;margin-top:10px' }, h('div', { class: 'form-grid' }, field('Serwer', sHost), field('Port', sPort), field('Login', sUser), field('Hasło', sPass), field('Nadawca', sFrom)),
          h('div', null, saveB('Zapisz', () => ({ smtp: sHost.value ? { host: sHost.value, port: sPort.value, user: sUser.value, pass: sPass.value, from: sFrom.value } : null })))))),
    h('section', { class: 'card stack', style: 'gap:10px' }, h('h2', null, 'Aktualizacja panelu'),
      h('div', { class: 'row', style: 'padding:0;flex-wrap:wrap' }, h('span', { class: 'grow' }, `Masz wersję ${d.version}. `, d.latest?.version ? (d.update ? h('b', null, `Jest nowa: ${d.latest.version}.`) : 'To najnowsza wersja.') : h('span', { class: 'muted' }, 'Nie udało się sprawdzić GitHuba.')), upd, linkBtn('GitHub', `https://github.com/${d.repo}`, { small: true, icon: 'ext', blank: true })),
      d.update && d.latest.notes ? h('details', null, h('summary', { class: 'small' }, 'Co nowego'), h('div', { class: 'logbox app-log', style: 'margin-top:6px;max-height:240px' }, d.latest.notes)) : null,
      !d.cli ? h('p', { class: 'small muted', style: 'margin:0' }, 'Ten panel nie był instalowany instalatorem — aktualizacja z przycisku zadziała po instalacji przez instaluj.sh.') : h('p', { class: 'small muted', style: 'margin:0' }, 'W terminalu: panel-serwera aktualizuj · odinstalowanie: panel-serwera odinstaluj (strony i bazy zostają).')),
    wizard ? h('div', { class: 'acts', style: 'justify-content:flex-end' }, (() => { const b = btn('Gotowe — przejdź do panelu', () => busy(b, async () => { const r = await api('POST', 'api/ustawienia', { kreator: false }); state.cfg = r.konfig; window.P.buildShell(); location.hash = '#/pulpit'; }), { kind: 'pri' }); return b; })()) : null);
};
