// Hosting dla znajomych (wariant A · pakiety): u właściciela — pakiet w zaproszeniu i zużycie przy koncie;
// u znajomego — strona „Twój hosting” z miejscem, stronami, bazami i prośbą o więcej.
const { h, put, api, btn, linkBtn, ico, busy, toast, ask, watchJob, when, PAGES, plural, reload } = window.P;
const gb = (mb) => mb >= 1024 ? `${(mb / 1024).toFixed(1).replace('.', ',').replace(',0', '')} GB` : `${Math.round(mb)} MB`;
const gbB = (b) => b < 1048576 ? (b ? '< 1 MB' : '0 MB') : gb(b / 1048576);
const pct = (a, b) => b ? Math.min(100, Math.round(a / b * 100)) : 0;
const bar = (p, count) => h('div', { class: `bar ${p >= 100 ? (count ? 'warn' : 'bad') : p >= 85 ? 'warn' : ''}`, role: 'meter', 'aria-valuenow': p, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${Math.max(2, p)}%` }));

/** Wybór pakietu (zaproszenie i zmiana pakietu). */
function packBox(d, cur) {
  let sel = cur?.pakiet || 'maly';
  const num = (id, v, lbl, min, max, step = 1) => h('label', { class: 'field' }, h('span', null, lbl), h('input', { class: 'input', id, type: 'number', min, max, step, value: v, inputmode: 'numeric' }));
  const custom = h('div', { class: 'form-grid hs-custom' }, num('hs-disk', cur?.disk || 1536, 'Miejsce (MB)', 100, 102400, 100), num('hs-sites', cur?.sites || 3, 'Strony', 1, 50), num('hs-dbs', cur?.dbs ?? 2, 'Bazy', 0, 50),
    h('label', { class: 'check', style: 'min-height:36px' }, h('input', { type: 'checkbox', id: 'hs-dom', checked: cur?.domains ? true : null }), h('span', { class: 'small' }, 'własne domeny')));
  const opts = [...Object.entries(d.packs).map(([id, p]) => [id, p.name, `${gb(p.disk)} · ${p.sites} ${plural(p.sites, 'strona', 'strony', 'stron')} · ${p.dbs} ${plural(p.dbs, 'baza', 'bazy', 'baz')}${p.domains ? ' · własne domeny' : ''}`]), ['wlasny', 'Własny', 'ustawisz sam']];
  const radios = opts.map(([id, name, desc]) => h('label', { class: `mv-opt hs-opt ${id === sel ? 'on' : ''}` }, h('input', { type: 'radio', name: 'hs-pakiet', value: id, checked: id === sel ? true : null, onchange: () => { sel = id; custom.hidden = id !== 'wlasny'; radios.forEach((r) => r.classList.toggle('on', r.querySelector('input').checked)); upd(); } }),
    h('div', { class: 'stack', style: 'gap:2px' }, h('b', null, name), h('span', { class: 'small muted' }, desc))));
  custom.hidden = sel !== 'wlasny';
  const left = h('span', { class: 'small' });
  const value = () => sel === 'wlasny' ? { pakiet: 'wlasny', disk: Number(custom.querySelector('#hs-disk').value), sites: Number(custom.querySelector('#hs-sites').value), dbs: Number(custom.querySelector('#hs-dbs').value), domains: custom.querySelector('#hs-dom').checked } : { pakiet: sel };
  const upd = () => { const v = value(); const disk = v.pakiet === 'wlasny' ? v.disk : d.packs[v.pakiet].disk; const free = d.diskFree / 1048576; left.className = `small ${free - disk < 2048 ? 'fx-text' : 'muted'}`; left.textContent = `Wolne na dysku: ${gb(free)} — po tym pakiecie (gdy się zapełni) ${gb(Math.max(0, free - disk))}.`; };
  custom.addEventListener('input', upd);
  upd();
  const el = h('div', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'sub-h' }, 'Pakiet'), h('div', { class: 'stack', style: 'gap:6px' }, radios), custom,
    h('span', { class: 'small muted' }, `Adresy stron: *.<login>.${d.domain || 'domena'}${'' } albo własna domena (jeśli pakiet pozwala).`), left);
  return { el, value };
}
async function editPack(u, d) {
  const pb = packBox(d, u.hosting?.limits);
  if (!(await ask({ title: `Pakiet: ${u.name || u.login}`, text: u.hosting ? `Teraz zajmuje ${gbB(u.hosting.usage.bytes)} · ${u.hosting.usage.sites} ${plural(u.hosting.usage.sites, 'strona', 'strony', 'stron')} · ${u.hosting.usage.dbs} ${plural(u.hosting.usage.dbs, 'baza', 'bazy', 'baz')}.` : '', ok: 'Zapisz', extra: pb.el }))) return;
  try { await api('POST', `api/konta/${encodeURIComponent(u.login)}`, pb.value()); toast('✓ Zmieniono pakiet', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); }
}
function packUsage(x) {
  const l = x.limits, u = x.usage;
  if (!l || !u) return null;
  const p = pct(u.bytes / 1048576, l.disk);
  return h('div', { class: 'stack hs-mini', style: 'gap:3px;margin-top:4px;max-width:420px' }, bar(p), h('span', { class: 'small muted' }, `pakiet ${l.name} · ${gbB(u.bytes)} z ${gb(l.disk)} · ${u.sites} z ${l.sites} ${plural(l.sites, 'strony', 'stron', 'stron')} · ${u.dbs} z ${l.dbs} ${plural(l.dbs, 'bazy', 'baz', 'baz')}`));
}
Object.assign(window.P, { packBox, editPack, packUsage });

/* ------------------------------------------------------------- Twój hosting */

async function newSite(d, b) {
  const l = d.limits;
  const kind = h('select', { class: 'input', id: 'hs-rodzaj' }, d.templates.map((t) => h('option', { value: t.id }, t.name + (t.db ? ' (zajmie bazę)' : ''))));
  const sub = h('input', { class: 'input', id: 'hs-adres', placeholder: 'np. sklep', autocapitalize: 'off', spellcheck: 'false' });
  const own = l.domains ? h('label', { class: 'check', style: 'min-height:36px' }, h('input', { type: 'checkbox', id: 'hs-wlasna' }), h('span', { class: 'small' }, 'moja własna domena (wpisz cały adres)')) : null;
  const suffix = h('span', { class: 'mono small' }, '.' + l.ns);
  if (own) own.querySelector('input').onchange = (e) => { suffix.hidden = e.target.checked; sub.placeholder = e.target.checked ? 'np. mojastrona.pl' : 'np. sklep'; };
  const extra = h('div', { class: 'stack', style: 'gap:12px' }, h('label', { class: 'field' }, h('span', null, 'Rodzaj'), kind),
    h('label', { class: 'field' }, h('span', null, 'Adres'), h('div', { class: 'dn-addr' }, sub, suffix)), own,
    h('span', { class: 'small muted' }, `Twoja strona dostanie certyfikat https, gdy adres zacznie wskazywać na serwer (${d.ip}).`));
  if (!(await ask({ title: 'Nowa strona', ok: 'Utwórz', extra }))) return;
  const host = own?.querySelector('input').checked ? sub.value.trim().toLowerCase() : `${sub.value.trim().toLowerCase().replace(/\.$/, '')}${sub.value.trim() ? '.' : ''}${l.ns}`;
  await busy(b, async () => {
    try {
      const r = await api('POST', 'api/hosting/strona', { template: kind.value, host });
      watchJob(r.job, (j) => { if (j.ok && j.result?.password) ask({ title: 'Dane bazy — zapisz je', text: `Baza: ${j.result.db}\nUżytkownik: ${j.result.dbuser}\nHasło: ${j.result.password}\nSerwer: localhost\n\nStrona sama z nich korzysta (config.php / WordPress). Później zobaczysz je przy bazie.`, ok: 'Zapisane' }); });
      toast('Tworzę stronę w tle — postęp w okienku na dole', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  });
}
async function newDb(b) {
  const nm = h('input', { class: 'input', id: 'hs-baza', placeholder: 'np. sklep', autocapitalize: 'off', spellcheck: 'false' });
  if (!(await ask({ title: 'Nowa baza MariaDB', ok: 'Utwórz', extra: h('label', { class: 'field' }, h('span', null, 'Nazwa (dostanie Twój przedrostek)'), nm) }))) return;
  await busy(b, async () => { try { const r = await api('POST', 'api/hosting/baza', { name: nm.value }); watchJob(r.job, (j) => { if (j.ok && j.result) ask({ title: 'Dane bazy — zapisz je', text: `Baza: ${j.result.db}\nUżytkownik: ${j.result.dbuser}\nHasło: ${j.result.password}\nSerwer: localhost`, ok: 'Zapisane' }); }); } catch (e) { toast(e.message, 'bad'); } });
}

PAGES.moje = async (box) => {
  const d = await api('GET', 'api/hosting/moje');
  d.jobs.filter((j) => !j.end).forEach((j) => watchJob(j));
  const l = d.limits, u = d.usage;
  const over = u.bytes > l.disk * 1048576;
  const tile = (icon, big, p, label, count) => h('div', { class: 'hs-tile' }, ico(icon, 18), h('b', null, big), bar(p, count), h('span', { class: 'small muted' }, label));
  const createB = btn('Utwórz stronę', () => newSite(d, createB), { kind: 'pri', icon: 'plus', disabled: u.sites >= l.sites || over });
  const dbB = btn('Nowa baza', () => newDb(dbB), { icon: 'bazy', disabled: u.dbs >= l.dbs || over });
  const askB = btn('Poproś o więcej miejsca', async () => {
    const ta = h('textarea', { class: 'input', id: 'hs-prosba', rows: 3, placeholder: 'np. potrzebuję jeszcze jednej strony na sklep' });
    if (!(await ask({ title: 'Prośba do właściciela serwera', text: 'Wiadomość przyjdzie do właściciela (GibCord, e-mail albo telefon) razem z tym, ile teraz zajmujesz.', ok: 'Wyślij', extra: ta }))) return;
    await busy(askB, async () => { try { await api('POST', 'api/hosting/prosba', { text: ta.value }); toast('✓ Wysłano', 'ok'); } catch (e) { toast(e.message, 'bad'); } });
  }, { icon: 'wyslij' });
  const siteRow = (s) => {
    const del = btn('', async () => {
      if (!(await ask({ title: `Usunąć ${s.host}?`, text: `Strona${s.db ? ' i jej baza' : ''} zniknie. Kopia trafi do kosza kopii właściciela serwera.`, ok: 'Usuń', danger: true, typed: s.host }))) return;
      await busy(del, async () => { try { const r = await api('POST', 'api/hosting/strona/usun', { host: s.host }); watchJob(r.job, () => reload()); } catch (e) { toast(e.message, 'bad'); } });
    }, { icon: 'usun', small: true, kind: 'ghost', title: 'Usuń stronę' });
    return h('div', { class: 'row', style: 'gap:12px;flex-wrap:wrap' }, h('span', { class: `sym ${s.ssl === 'gotowe' ? 'ok' : 'warn'}` }, ico(s.ssl === 'gotowe' ? 'ok' : 'uwaga', 18)),
      h('div', { class: 'stack grow', style: 'gap:2px;min-width:0;flex-basis:200px' }, h('a', { class: 't', href: `#/strona/${encodeURIComponent(s.host)}` }, s.host), h('span', { class: 's' }, `${{ pusta: 'pliki', php: 'PHP', wordpress: 'WordPress' }[s.kind] || s.kind}${s.db ? ' · baza ' + s.db : ''}${s.ssl === 'gotowe' ? ' · https' : s.ssl === 'czeka-dns' ? ' · czeka na DNS (adres → ' + d.ip + ')' : ''}`)),
      h('div', { class: 'acts' }, linkBtn('Pliki', `#/strona/${encodeURIComponent(s.host)}/pliki`, { small: true, icon: 'pliki' }), linkBtn('', `https://${s.host}/`, { small: true, icon: 'ext', blank: true }), del));
  };
  const dbRow = (x) => {
    const show = btn('Dane dostępu', async () => { try { const r = await api('GET', `api/hosting/baza/${encodeURIComponent(x.db)}/dostep`); await ask({ title: `Baza ${x.db}`, text: r.text || `Baza: ${r.db}\nUżytkownik: ${r.user}\nSerwer: localhost`, ok: 'Zamknij' }); } catch (e) { toast(e.message, 'bad'); } }, { small: true, icon: 'klucz' });
    const del = !x.site ? btn('', async () => { if (!(await ask({ title: `Usunąć bazę ${x.db}?`, text: 'Zrzut bazy trafi do kosza kopii właściciela serwera.', ok: 'Usuń', danger: true, typed: x.db }))) return; await busy(del, async () => { try { const r = await api('POST', 'api/hosting/baza/usun', { db: x.db }); watchJob(r.job, () => reload()); } catch (e) { toast(e.message, 'bad'); } }); }, { icon: 'usun', small: true, kind: 'ghost', title: 'Usuń bazę' }) : null;
    return h('div', { class: 'row', style: 'gap:12px;flex-wrap:wrap' }, ico('bazy', 18), h('div', { class: 'stack grow', style: 'gap:2px;min-width:0;flex-basis:200px' }, h('b', { class: 'mono' }, x.db), h('span', { class: 's' }, x.site ? `baza strony ${x.site}` : 'osobna baza')), h('div', { class: 'acts' }, show, del));
  };
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Twój hosting'), h('div', { class: 'sub' }, `Pakiet ${l.name} · strony pod *.${l.ns}${l.domains ? ' albo na Twojej domenie' : ''}`)),
      h('div', { class: 'acts' }, createB)),
    over ? h('div', { class: 'alert error' }, h('span', { class: 'tag' }, 'LIMIT'), h('span', { class: 'txt' }, 'Przekroczony limit miejsca — wgrywanie plików i nowe strony są wstrzymane. Usuń coś albo poproś o więcej.')) : null,
    h('div', { class: 'hs-tiles' }, tile('dysk', `${gbB(u.bytes)} z ${gb(l.disk)}`, pct(u.bytes / 1048576, l.disk), 'Twoje miejsce (pliki i bazy)'), tile('strony', `${u.sites} z ${l.sites}`, pct(u.sites, l.sites), 'strony', true), tile('bazy', `${u.dbs} z ${l.dbs}`, pct(u.dbs, Math.max(1, l.dbs)), 'bazy danych', true)),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Twoje strony')), d.sites.length ? h('div', { class: 'rows' }, d.sites.map(siteRow)) : h('div', { class: 'list-empty' }, 'Jeszcze nic — kliknij „Utwórz stronę”.')),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Bazy danych'), dbB), d.dbs.length ? h('div', { class: 'rows' }, d.dbs.map(dbRow)) : h('div', { class: 'list-empty' }, 'Brak baz.')),
    h('div', { class: 'acts', style: 'justify-content:flex-start' }, askB),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Widzisz tylko swoje strony, bazy i pliki. Kopie robią się same co noc. Twoje PHP działa w osobnym procesie, zamknięte w folderze strony.'));
};
