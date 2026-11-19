// Bezpieczeństwo (wariant A · Ocena i lista): wynik 0–100, sprawy od najważniejszych, przy każdej „Napraw”.
const { h, put, api, btn, linkBtn, ico, busy, toast, ask, watchJob, PAGES, state, isAdmin, plural } = window.P;
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
    const lb = i.link ? linkBtn(i.link.label, i.link.href, { small: true, kind: i.link.pri ? 'pri' : '' }) : null;
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
    h('div', { class: 'fx-list' }, d.items.map(row)));
};
