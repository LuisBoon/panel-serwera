// Próbne przywracanie (wariant A · karta w Kopiach): wynik ostatniej próby, co dokładnie sprawdzono, następny termin.
const { h, api, btn, ico, busy, toast, ask, watchJob, when, state, isAdmin, plural } = window.P;
const DAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const SYM = { ok: 'tak', bad: 'x', warn: 'wykrzyknik' };
const sec = (ms) => ms < 60e3 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60e3)} min`;

async function start(b, full) {
  if (full && !(await ask({ title: 'Pełna próba z plikami?', text: 'Oprócz baz i archiwów przeczytam do końca każdy plik z ostatniej migawki przesłanych plików i porównam go z oryginałem. Przy dużej migawce trwa to kilkadziesiąt minut i obciąża dysk — strony działają normalnie.', ok: 'Sprawdź wszystko' }))) return;
  await busy(b, async () => { try { const r = await api('POST', 'api/kopie/proba', { full }); watchJob(r.job, () => window.P.reload()); } catch (e) { toast(e.message, 'bad'); } });
}
async function schedule(s) {
  const on = h('input', { type: 'checkbox', checked: s.on ? true : null, id: 'proba-on' });
  const day = h('select', { class: 'input', id: 'proba-dzien', 'aria-label': 'Dzień tygodnia' }, [1, 2, 3, 4, 5, 6, 0].map((d) => h('option', { value: d, selected: d === s.day ? true : null }, DAYS[d])));
  const hour = h('select', { class: 'input', id: 'proba-godzina', 'aria-label': 'Godzina' }, Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: i === s.hour ? true : null }, `${String(i).padStart(2, '0')}:00`)));
  const extra = h('div', { class: 'stack', style: 'gap:12px' },
    h('label', { class: 'row', style: 'gap:10px;min-height:0;padding:0' }, on, h('span', null, 'Sprawdzaj co tydzień sam')),
    h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Dzień'), day), h('label', { class: 'field' }, h('span', null, 'Godzina'), hour)),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Najlepiej po nocnej kopii i w porze, gdy mało kto korzysta ze stron.'));
  if (!(await ask({ title: 'Termin próbnego przywrócenia', text: '', ok: 'Zapisz', extra }))) return;
  try { await api('POST', 'api/kopie/proba/ustawienia', { on: on.checked, day: Number(day.value), hour: Number(hour.value) }); toast('✓ Zapisano termin', 'ok'); window.P.reload(); }
  catch (e) { toast(e.message, 'bad'); }
}

window.probaCard = (p, jobs) => {
  if (!p) return null;
  const l = p.last, s = p.settings;
  const running = (jobs || []).some((j) => j.kind === 'proba' && !j.end);
  const tone = running ? 'info' : l ? l.level : 'info';
  const title = running ? 'Sprawdzam kopię…' : l ? l.title : 'Jeszcze nie sprawdzono, czy z kopii da się wstać';
  const sub = running ? 'próbne przywrócenie trwa — wynik pojawi się tutaj' : l ? `próbne przywrócenie${l.full ? ' (pełne)' : ''} · ${when(l.ts)} · trwało ${sec(l.took)}` : 'panel odtworzy kopię w osobnej bazie i folderze i sprawdzi każdy plik';
  const item = (x) => h('div', { class: `fx-c ${x.k}` }, h('span', { class: 'fx-s', 'aria-hidden': 'true' }, ico(SYM[x.k] || 'info', 14)),
    h('div', { class: 'stack grow', style: 'gap:3px;min-width:0' }, h('b', null, x.title), h('span', { class: 'small fx-text' }, x.detail),
      x.parts?.length > 1 ? h('details', { class: 'small' }, h('summary', null, `Każda baza osobno (${x.parts.length})`),
        h('div', { class: 'stack', style: 'gap:3px;margin-top:4px' }, x.parts.map((y) => h('span', { class: y.k === 'ok' ? 'muted' : 'fx-text' }, `${y.k === 'ok' ? '✓' : y.k === 'warn' ? '⚠' : '✗'} ${y.name} — ${y.text}`)))) : null));
  const startB = isAdmin() ? btn('Sprawdź teraz', () => start(startB, false), { kind: 'pri', icon: 'probka', disabled: running }) : null;
  const fullB = isAdmin() ? btn('Pełna próba z plikami', () => start(fullB, true), { icon: 'dysk', disabled: running }) : null;
  const setB = isAdmin() ? btn('Termin', () => schedule(s), { icon: 'cron' }) : null;
  return h('section', { class: 'card stack proba-card', style: 'gap:12px' },
    h('div', { class: 'proba-h' }, h('span', { class: `proba-i ${tone}` }, running ? h('span', { class: 'spin' }) : ico('proba', 26)),
      h('div', { class: 'stack grow', style: 'gap:2px;min-width:0' }, h('h2', { class: 'proba-t' }, title), h('span', { class: 'small muted' }, sub))),
    l && !running ? h('div', { class: 'fx-list' }, l.items.map(item)) : null,
    h('div', { class: 'proba-kv' },
      h('span', null, 'Następna próba'), h('b', null, s.on && p.next ? `${DAYS[new Date(p.next).getDay()]} ${when(p.next)}` : 'wyłączona — tylko ręcznie'),
      h('span', null, 'Gdy się nie uda'), h('b', null, 'alarm jak przy innych sprawach (Autopilot → powiadomienia)')),
    isAdmin() ? h('div', { class: 'acts', style: 'justify-content:flex-start;flex-wrap:wrap' }, startB, fullB, setB) : null,
    h('p', { class: 'small muted', style: 'margin:0' }, 'Wszystko dzieje się w osobnej, tymczasowej bazie i osobnym folderze — prawdziwe strony i bazy nic nie czują. Po próbie panel sprząta.'),
    p.history.length > 1 ? h('details', { class: 'small' }, h('summary', null, 'Poprzednie próby'),
      h('div', { class: 'stack', style: 'gap:3px;margin-top:4px' }, p.history.slice(1).map((x) => h('span', { class: x.level === 'bad' ? 'fx-text' : 'muted' }, `${x.level === 'ok' ? '✓' : x.level === 'warn' ? '⚠' : '✗'} ${when(x.ts)} — ${x.title}${x.full ? ' (pełna)' : ''}`)))) : null);
};
