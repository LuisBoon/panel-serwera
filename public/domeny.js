// Domeny i poczta (wariant A · lista i karta domeny): domeny z OVH z datą wygaśnięcia, w karcie zakładki
// Rekordy DNS / Poczta / Ustawienia; kontrola SPF, DKIM i DMARC z „Napraw”.
const { h, put, api, btn, linkBtn, ico, busy, toast, ask, when, dateFull, PAGES, isAdmin, plural, reload } = window.P;
const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'];
const SYM = { ok: 'tak', bad: 'x', warn: 'wykrzyknik', info: 'literai' };
const ovhManager = (z) => `https://www.ovh.com/manager/#/web/domain/${encodeURIComponent(z)}/information`;

function expiryPill(d) {
  if (d.days == null) return d.ovh ? null : h('span', { class: 'pill' }, 'poza OVH');
  if (d.days < 0) return h('span', { class: 'pill bad' }, 'wygasła');
  if (!d.autoRenew && d.days <= 60) return h('span', { class: `pill ${d.days <= 7 ? 'bad' : 'warn'}` }, ico('cron', 13), ` wygasa za ${d.days} ${plural(d.days, 'dzień', 'dni', 'dni')}`);
  return h('span', { class: 'pill ok' }, `wygasa ${dateFull(d.expiration)}`);
}
function domSub(d) {
  if (!d.ovh) return 'nie w podłączonym OVH — tylko sprawdzanie poczty i DNS';
  const parts = ['OVH'];
  if (d.records != null) parts.push(`${d.records} ${plural(d.records, 'rekord', 'rekordy', 'rekordów')}`);
  parts.push(d.mailService ? (d.redirections ? `${d.redirections} ${plural(d.redirections, 'adres', 'adresy', 'adresów')} poczty` : 'poczta: brak adresów') : 'bez poczty w OVH');
  return parts.join(' · ');
}

async function recordForm(zone, rec) {
  const type = h('select', { class: 'input', id: 'dns-typ', disabled: rec ? true : null }, TYPES.map((t) => h('option', { value: t, selected: rec?.type === t ? true : null }, t)));
  const sub = h('input', { class: 'input', id: 'dns-nazwa', value: rec ? rec.sub || '@' : '', placeholder: 'np. sklep (albo @ dla samej domeny)', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
  const target = h('input', { class: 'input mono', id: 'dns-wartosc', value: rec ? String(rec.target).replace(/^"|"$/g, '') : '', placeholder: 'np. 203.0.113.7', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
  const ttl = h('input', { class: 'input', id: 'dns-ttl', type: 'number', min: 0, max: 86400, value: rec?.ttl ?? 0, inputmode: 'numeric' });
  const hint = h('p', { class: 'small muted', style: 'margin:0' });
  const hints = { A: 'Adres IPv4 serwera, np. 203.0.113.7.', AAAA: 'Adres IPv6.', CNAME: 'Inna nazwa, na którą ma wskazywać, np. example.pl.', MX: 'Priorytet i serwer poczty, np. „10 mx1.mail.ovh.net”.', TXT: 'Dowolny tekst, np. weryfikacja domeny albo SPF.', SRV: 'Priorytet, waga, port i host, np. „0 5 25565 mc.example.pl.”.', CAA: 'Np. 0 issue "letsencrypt.org".' };
  const upd = () => { hint.textContent = hints[type.value] + ` Pełna nazwa: ${sub.value && sub.value !== '@' ? sub.value + '.' : ''}${zone}`; };
  type.addEventListener('change', upd); sub.addEventListener('input', upd); upd();
  const extra = h('div', { class: 'stack', style: 'gap:12px' }, h('div', { class: 'form-grid' }, h('label', { class: 'field', style: 'flex:0 1 110px' }, h('span', null, 'Rodzaj'), type), h('label', { class: 'field' }, h('span', null, 'Nazwa'), sub)),
    h('label', { class: 'field' }, h('span', null, 'Wartość'), target), h('label', { class: 'field', style: 'max-width:180px' }, h('span', null, 'TTL (sekundy, 0 = domyślny)'), ttl), hint);
  if (!(await ask({ title: rec ? `Zmień rekord ${rec.type}` : 'Nowy rekord DNS', text: 'Zmiana działa w OVH od razu; w internecie rozchodzi się zwykle w kilka minut.', ok: 'Zapisz', extra }))) return false;
  try { await api('POST', `api/domeny/${encodeURIComponent(zone)}/rekord`, { id: rec?.id, type: type.value, sub: sub.value.trim(), target: target.value.trim(), ttl: ttl.value }); toast('✓ Zapisano rekord (można cofnąć w Dzienniku zmian)', 'ok'); return true; }
  catch (e) { toast(e.message, 'bad'); return false; }
}

function recordsTab(d) {
  if (!d.ovh) return h('p', { class: 'small muted', style: 'margin:0' }, 'Ta domena nie jest w podłączonym OVH — rekordy edytujesz u jej dostawcy.');
  if (!d.records) return h('p', { class: 'fx-text', style: 'margin:0' }, d.error || 'Nie udało się pobrać rekordów.');
  const z = d.name;
  const edit = d.canEdit && isAdmin();
  const row = (r) => {
    const eb = edit && !r.locked ? btn('', async () => { if (await recordForm(z, r)) reload(); }, { icon: 'edytuj', small: true, kind: 'ghost', title: 'Zmień' }) : null;
    const db = edit && !r.locked ? btn('', async () => {
      if (!(await ask({ title: `Usunąć rekord ${r.type} ${r.sub || '@'}?`, text: `${r.sub ? r.sub + '.' : ''}${z} → ${r.target}${r.note ? `\n(${r.note})` : ''}\n\nMożna cofnąć w Dzienniku zmian.`, ok: 'Usuń', danger: true }))) return;
      await busy(db, async () => { try { await api('POST', `api/domeny/${encodeURIComponent(z)}/rekord/${r.id}/usun`); toast('✓ Usunięto', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } });
    }, { icon: 'usun', small: true, kind: 'ghost', title: 'Usuń' }) : null;
    return h('div', { class: 'dn-tr' }, h('b', { class: 'mono dn-n' }, r.sub || '@'), h('span', { class: 'dn-t' }, r.type), h('span', { class: 'mono dn-v', title: r.target }, r.target),
      h('span', { class: `dn-note small ${/inny adres/.test(r.note) ? 'fx-text' : 'muted'}` }, r.note), h('span', { class: 'dn-a' }, eb, db));
  };
  const add = edit ? btn('Dodaj rekord', async () => { if (await recordForm(z, null)) reload(); }, { icon: 'plus', small: true }) : null;
  return h('div', { class: 'stack', style: 'gap:10px' },
    h('div', { class: 'dn-tbl', role: 'table', 'aria-label': `Rekordy DNS ${z}` }, d.records.map(row)),
    h('div', { class: 'acts', style: 'justify-content:flex-start' }, add, h('span', { class: 'small muted' }, `IP tego serwera: ${d.ip}`)));
}

async function newAddress(z, b) {
  const local = h('input', { class: 'input', id: 'poczta-adres', placeholder: 'np. kontakt', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const to = h('input', { class: 'input', id: 'poczta-cel', type: 'email', placeholder: 'np. twoja.skrzynka@gmail.com', autocomplete: 'off' });
  const extra = h('div', { class: 'stack', style: 'gap:12px' }, h('label', { class: 'field' }, h('span', null, 'Adres w domenie'), h('div', { class: 'dn-addr' }, local, h('span', { class: 'mono' }, '@' + z))),
    h('label', { class: 'field' }, h('span', null, 'Przekierowuj na'), to));
  if (!(await ask({ title: 'Nowy adres poczty', text: 'Poczta wysłana na ten adres przyjdzie do wskazanej skrzynki. OVH robi to za darmo — nie potrzeba własnego serwera poczty.', ok: 'Utwórz', extra }))) return;
  const send = (mxOvh) => api('POST', `api/domeny/${encodeURIComponent(z)}/poczta`, { from: local.value.trim(), to: to.value.trim(), mxOvh });
  await busy(b, async () => {
    try { const r = await send(false); toast(`✓ ${r.address} działa — przekierowanie rusza zwykle w kilka minut`, 'ok'); reload(); }
    catch (e) {
      if (e.message !== 'mx') return toast(e.message, 'bad');
      if (!(await ask({ title: `Skierować pocztę ${z} do OVH?`, text: `Domena ${z} nie ma jeszcze serwera poczty (rekordu MX). Dodam rekordy MX OVH (mx1/mx2/mx3.mail.ovh.net) — dopiero wtedy przekierowania zaczną działać.`, ok: 'Dodaj i utwórz adres' }))) return;
      try { const r = await send(true); toast(`✓ ${r.address} działa — rekordy MX dodane, przekierowanie rusza zwykle w kilka–kilkanaście minut`, 'ok'); reload(); } catch (e2) { toast(e2.message, 'bad'); }
    }
  });
}

function mailTab(d) {
  const z = d.name, edit = d.canEdit && isAdmin();
  const parts = [];
  if (d.ovh && d.mailService) {
    const redirs = d.redirections || [];
    parts.push(h('div', { class: 'sub-h' }, 'Przekierowania — poczta przychodzi do Ciebie'));
    parts.push(redirs.length ? h('div', { class: 'stack', style: 'gap:6px' }, redirs.map((r) => {
      const del = edit ? btn('', async () => { if (!(await ask({ title: `Usunąć ${r.from}?`, text: `Poczta na ${r.from} przestanie przychodzić do ${r.to}.`, ok: 'Usuń', danger: true }))) return; await busy(del, async () => { try { await api('POST', `api/domeny/${encodeURIComponent(z)}/poczta/${encodeURIComponent(r.id)}/usun`); toast('✓ Usunięto', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } }); }, { icon: 'usun', small: true, kind: 'ghost', title: 'Usuń' }) : null;
      return h('div', { class: 'dn-mrow' }, ico('malpa', 16), h('b', { class: 'mono ell' }, r.from), ico('dalejstrz', 14), h('span', { class: 'grow ell' }, r.to), del);
    })) : h('p', { class: 'small muted', style: 'margin:0' }, 'Jeszcze nie ma żadnego adresu.'));
    const nb = edit ? btn('Nowy adres', () => newAddress(z, nb), { icon: 'plus', kind: 'pri', small: true }) : null;
    const tb = edit && redirs.length ? btn('Wyślij próbny mail', async () => {
      const sel = h('select', { class: 'input', id: 'proba-na' }, redirs.map((r) => h('option', { value: r.from }, r.from)));
      if (!(await ask({ title: 'Próbny mail', text: 'Wyślę krótki mail przez pocztę panelu — sprawdź, czy dotarł do skrzynki docelowej (także w spamie).', ok: 'Wyślij', extra: h('label', { class: 'field' }, h('span', null, 'Na adres'), sel) }))) return;
      await busy(tb, async () => { try { await api('POST', `api/domeny/${encodeURIComponent(z)}/proba-poczty`, { to: sel.value }); toast(`✓ Wysłano na ${sel.value}`, 'ok'); } catch (e) { toast(e.message, 'bad'); } });
    }, { icon: 'wyslij', small: true }) : null;
    if (nb || tb) parts.push(h('div', { class: 'acts', style: 'justify-content:flex-start' }, nb, tb));
  } else if (d.ovh) parts.push(h('p', { class: 'small muted', style: 'margin:0' }, 'Ta domena nie ma usługi poczty w OVH. Darmowe przekierowania włączysz w panelu OVH (Poczta → MX Plan / „Email Free”), potem odśwież tę stronę.'));
  for (const m of d.mail) {
    parts.push(h('div', { class: 'sub-h' }, d.mail.length > 1 ? `Czy maile z ${m.name} nie trafiają do spamu` : 'Czy Twoje maile nie trafiają do spamu'));
    if (!m.mx.length) parts.push(h('p', { class: 'small muted', style: 'margin:0' }, `${m.name} nie odbiera poczty (brak rekordu MX).`));
    else parts.push(h('p', { class: 'small muted', style: 'margin:0' }, `Poczta przychodzi do: ${m.mx.map((x) => x.host).join(', ')}`));
    parts.push(h('div', { class: 'fx-list' }, m.items.map((i) => {
      const fb = i.fix && edit && i.k !== 'ok' ? btn('Dodaj', async () => {
        if (!(await ask({ title: `Dodać ${i.fix.toUpperCase()} dla ${m.name}?`, text: i.fix === 'dmarc' ? 'Dodam rekord DMARC z zasadą „p=none” — serwery poczty dostają informację o domenie, ale nic nie jest blokowane. Można zaostrzyć później.' : 'Dodam rekord SPF: wysyłać mogą serwery z rekordów A i MX domeny (i OVH, jeśli poczta jest w OVH).', ok: 'Dodaj' }))) return;
        await busy(fb, async () => { try { await api('POST', `api/domeny/${encodeURIComponent(z)}/napraw`, { name: m.name, what: i.fix }); toast('✓ Dodano — sprawdzenie pokaże zmianę po kilku minutach', 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } });
      }, { icon: 'popraw', small: true, kind: 'pri' }) : null;
      return h('div', { class: `fx-c ${i.k}` }, h('span', { class: 'fx-s', 'aria-hidden': 'true' }, ico(SYM[i.k], 14)), h('div', { class: 'stack grow', style: 'gap:3px;min-width:0' }, h('b', null, i.title), h('span', { class: 'small fx-text' }, i.text)), fb);
    })));
  }
  return h('div', { class: 'stack', style: 'gap:10px' }, parts);
}

function settingsTab(d, o) {
  const z = d.name;
  const ns = (d.records || []).filter((r) => r.type === 'NS' && !r.sub).map((r) => r.target.replace(/\.$/, ''));
  const kv = (k, v) => [h('span', null, k), h('b', null, v)];
  const wild = isAdmin() && d.ovh ? (() => { const b = btn(`Dodaj *.${z}`, async () => { if (!(await ask({ title: `Dodać *.${z}?`, text: `Każdy adres typu cokolwiek.${z} będzie od razu wskazywał na ten serwer (${d.ip}). Istniejące rekordy zostają.`, ok: 'Dodaj' }))) return; await busy(b, async () => { try { await api('POST', 'api/ovh/wildcard', { zone: z }); toast(`✓ Dodano *.${z}`, 'ok'); reload(); } catch (e) { toast(e.message, 'bad'); } }); }, { small: true, icon: 'plus' }); return b; })() : null;
  const off = isAdmin() && o.connected ? btn('Odłącz OVH', async () => { if (!(await ask({ title: 'Odłączyć OVH?', text: 'Domeny, rekordy i poczta zostają w OVH bez zmian — panel przestanie tylko nimi zarządzać.', ok: 'Odłącz', danger: true }))) return; try { await api('POST', 'api/ovh/odlacz'); reload(); } catch (e) { toast(e.message, 'bad'); } }, { small: true, kind: 'ghost' }) : null;
  return h('div', { class: 'stack', style: 'gap:12px' },
    h('div', { class: 'proba-kv' },
      kv('Wygasa', d.expiration ? `${dateFull(d.expiration)} (za ${d.days} ${plural(d.days, 'dzień', 'dni', 'dni')})` : '— (nie wiem: domena poza OVH albo klucz bez tego prawa)'),
      kv('Odnawia się sama', d.autoRenew == null ? '—' : d.autoRenew ? 'tak' : h('span', { class: 'fx-text' }, 'nie — odnów ją w OVH przed terminem')),
      kv('Serwery nazw', ns.length ? ns.join(', ') : '—'),
      kv('Rekordy', d.records != null ? String(d.records.length ?? d.records) : '—')),
    h('div', { class: 'acts', style: 'justify-content:flex-start;flex-wrap:wrap' }, d.ovh ? linkBtn('Otwórz w OVH', ovhManager(z), { small: true, icon: 'ext', blank: true }) : null, wild, off),
    h('p', { class: 'small muted', style: 'margin:0' }, '„*.' + z + '” sprawia, że każda nowa subdomena działa od razu, bez czekania na nowy rekord.'));
}

PAGES.domeny = async (box, args) => {
  const l = await api('GET', 'api/domeny');
  const o = l.ovh;
  const zone = args[0] || l.domains.find((d) => d.ovh)?.name || l.domains[0]?.name;
  const tab = ['rekordy', 'poczta', 'ustawienia'].includes(args[1]) ? args[1] : 'poczta';
  const d = zone ? await api('GET', `api/domeny/${encodeURIComponent(zone)}`) : null;
  const tabs = [['rekordy', 'Rekordy DNS'], ['poczta', 'Poczta'], ['ustawienia', 'Ustawienia']];
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Domeny i poczta'), h('div', { class: 'sub' }, 'Kiedy domeny wygasają, ich rekordy DNS i adresy poczty — bez wchodzenia do OVH.')),
      h('div', { class: 'acts' }, (() => { const b = btn('Odśwież', () => busy(b, async () => { try { await api('GET', 'api/domeny?odswiez=1'); reload(); } catch (e) { toast(e.message, 'bad'); } }), { icon: 'odswiez' }); return b; })())),
    !o.connected ? window.P.ovhCard({ ...o, added: [] }, d?.ip) : null,
    o.connected && o.rightsMissing ? h('div', { class: 'alert warn' }, h('span', { class: 'tag' }, 'KLUCZ'), h('span', { class: 'txt' }, 'Klucz OVH jest sprzed wersji 1.7 — widzi tylko rekordy DNS, bez dat wygaśnięcia i poczty. Odłącz OVH w Ustawieniach domeny i podłącz nowy klucz (link poda formularz).')) : null,
    h('div', { class: 'dn-list' }, l.domains.map((x) => h('a', { class: `dn-dom ${x.name === zone ? 'sel' : ''}`, href: `#/domeny/${encodeURIComponent(x.name)}/${tab}` },
      h('span', { class: `dn-gi ${x.days != null && !x.autoRenew && x.days <= 60 ? 'warn' : ''}` }, ico('domeny', 20)),
      h('div', { class: 'stack grow', style: 'gap:2px;min-width:0' }, h('b', { class: 'ell' }, x.name), h('span', { class: 'small muted' }, domSub(x))), expiryPill(x)))),
    d ? h('section', { class: 'card stack', style: 'gap:12px' },
      h('div', { class: 'card-h', style: 'margin:0' }, h('h2', null, d.name), d.error ? h('span', { class: 'small fx-text' }, d.error) : null),
      h('div', { class: 'dn-tabs', role: 'tablist' }, tabs.map(([id, label]) => h('a', { role: 'tab', class: id === tab ? 'on' : '', 'aria-selected': id === tab ? 'true' : 'false', href: `#/domeny/${encodeURIComponent(d.name)}/${id}` }, label))),
      tab === 'rekordy' ? recordsTab(d) : tab === 'ustawienia' ? settingsTab(d, o) : mailTab(d)) : h('div', { class: 'list-empty' }, 'Brak domen.'));
};
