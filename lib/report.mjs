// Raport tygodniowy: w niedzielę rano krótkie podsumowanie tygodnia mailem / pushem (i na GibCordzie, gdy podłączony).
import * as S from './system.mjs';
import * as D from './data.mjs';
import { publicUrl } from './config.mjs';

let db, AP, ST, O, F;
const DEFAULTS = { enabled: true, day: 0, hour: 10, last: null };

export function init(ctx) { ({ db, AP, ST, O, F } = ctx); }
export function settings() {
  const r = db.prepare("SELECT v FROM ustawienia WHERE k='raport'").get();
  let s = {}; try { s = r ? JSON.parse(r.v) : {}; } catch {}
  return { ...DEFAULTS, ...s };
}
export function save(patch) {
  const s = { ...settings(), ...patch };
  s.enabled = !!s.enabled;
  s.hour = Math.max(0, Math.min(23, Math.round(Number(s.hour) || 10)));
  s.day = Math.max(0, Math.min(6, Math.round(Number(s.day) || 0)));
  db.prepare("INSERT OR REPLACE INTO ustawienia(k,v) VALUES('raport',?)").run(JSON.stringify(s));
  return s;
}

const pl = (n, a, b, c) => { n = Math.abs(n); if (n === 1) return a; const d = n % 10, t = n % 100; return d >= 2 && d <= 4 && !(t >= 12 && t <= 14) ? b : c; };
const fmtDay = (t) => { const d = new Date(t); return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`; };

export async function build() {
  const now = Date.now(), weekAgo = now - 7 * 864e5;
  const lines = [];
  const title = `Tydzień na serwerze (${fmtDay(weekAgo)}–${fmtDay(now)})`;
  const P = publicUrl();
  const stats = [], sections = [];
  const pct = (x) => `${x >= 99.995 ? '100' : x.toFixed(x >= 99.5 ? 2 : 1).replace('.', ',')}%`;
  // strony
  const sites = (await S.sites()).filter((s) => s.enabled && s.status !== 'off' && s.status !== 'nodns');
  const up = sites.map((s) => ({ name: s.name, u: AP.uptime(s.name).d7 })).filter((x) => x.u);
  const worst = up.filter((x) => x.u.pct < 99.5).sort((a, b) => a.u.pct - b.u.pct);
  const avg = up.length ? up.reduce((a, x) => a + x.u.pct, 0) / up.length : null;
  if (avg == null) { lines.push('STRONY: brak pomiarów z tego tygodnia.'); stats.push({ label: 'Strony', value: '—', note: 'brak pomiarów' }); }
  else {
    lines.push(`STRONY: działały ${avg.toFixed(2).replace('.', ',')}% czasu${worst.length ? ` — najsłabiej: ${worst.slice(0, 3).map((x) => `${x.name} ${x.u.pct.toFixed(1).replace('.', ',')}%`).join(', ')}` : ' — bez przerw wartych uwagi'}.`);
    stats.push({ label: 'Strony', value: pct(avg), note: worst.length ? `najsłabiej ${worst[0].name}` : 'bez przerw', level: worst.length ? (avg < 98 ? 'error' : 'warn') : 'ok' });
    if (worst.length) sections.push({ title: 'Przerwy w działaniu', items: worst.slice(0, 4).map((x) => ({ text: `${x.name}: ${x.u.pct.toFixed(1).replace('.', ',')}% czasu`, level: 'warn', url: `${P}#/strona/${encodeURIComponent(x.name)}` })) });
  }
  // odwiedziny
  try {
    const st = ST.week();
    const top = st.sites.slice(0, 3).map((x) => `${x.name} ${x.visitors}`).join(', ');
    lines.push(`ODWIEDZINY: ${st.total.visitors} ${pl(st.total.visitors, 'osoba', 'osoby', 'osób')}${st.total.change != null ? ` (${st.total.change > 0 ? '+' : ''}${st.total.change}% do poprzedniego tygodnia)` : ''}. Najwięcej: ${top || '—'}.`);
    stats.push({ label: 'Odwiedziny', value: String(st.total.visitors), note: st.total.change != null ? `${st.total.change > 0 ? '+' : ''}${st.total.change}% do poprzedniego tygodnia` : pl(st.total.visitors, 'osoba', 'osoby', 'osób') });
    const items = st.sites.slice(0, 3).map((x) => ({ text: `${x.name} — ${x.visitors} ${pl(x.visitors, 'osoba', 'osoby', 'osób')}` }));
    const t404 = st.tips.find((x) => x.kind === '404');
    if (t404) { lines.push(`  Uwaga: ${t404.text}.`); items.push({ text: t404.text, level: 'warn' }); }
    if (items.length) sections.push({ title: 'Najwięcej odwiedzin', items });
  } catch {}
  // kopie
  const runs = D.backupRuns(30).filter((r) => r.start >= weekAgo);
  const ok = runs.filter((r) => r.status === 'ok').length;
  const cloud = O.publicSettings();
  lines.push(`KOPIE: ${ok} z ${runs.length} nocnych kopii udanych.${cloud.configured ? (cloud.last ? ` Chmura: ostatnio ${fmtDay(cloud.last.start)} ${cloud.last.ok ? 'OK' : 'BŁĄD — ' + cloud.last.msg}${cloud.lastTest ? `, test odczytu ${cloud.lastTest.ok ? 'OK' : 'nie przeszedł'}` : ''}.` : ' Chmura: jeszcze nic nie wysłano.') : ' Kopie są tylko na tym serwerze (chmura nieustawiona).'}`);
  stats.push({ label: 'Kopie', value: `${ok} z ${runs.length}`, level: runs.length && ok === runs.length && cloud.configured && cloud.last?.ok ? 'ok' : 'warn',
    note: cloud.configured ? (cloud.last ? `chmura ${cloud.last.ok ? 'OK' : 'BŁĄD'}${cloud.lastTest ? `, test ${cloud.lastTest.ok ? 'OK' : 'nie przeszedł'}` : ''}` : 'chmura: jeszcze nic') : 'tylko na serwerze' });
  // dysk
  const m = S.metrics();
  const dp = Math.round(m.disk.used / m.disk.total * 100);
  lines.push(`DYSK: ${dp}% zajęte, wolne ${(m.disk.free / 1073741824).toFixed(1).replace('.', ',')} GB.`);
  stats.push({ label: 'Dysk', value: `${dp}%`, note: `wolne ${(m.disk.free / 1073741824).toFixed(1).replace('.', ',')} GB`, level: dp >= 90 ? 'error' : dp >= 80 ? 'warn' : 'ok' });
  // autopilot
  const ev = AP.events(500).filter((e) => e.ts >= weekAgo);
  const auto = ev.filter((e) => e.auto);
  lines.push(`AUTOPILOT: zrobił sam ${auto.length} ${pl(auto.length, 'rzecz', 'rzeczy', 'rzeczy')}.`);
  for (const e of auto.slice(0, 6)) lines.push(`  • ${fmtDay(e.ts)} ${e.text}`);
  const errs = ev.filter((e) => e.level === 'error');
  if (errs.length) { lines.push(`PROBLEMY (${errs.length}):`); for (const e of errs.slice(0, 5)) lines.push(`  • ${fmtDay(e.ts)} ${e.text}`); }
  // bezpieczeństwo
  const sec = [];
  try {
    const fw = await F.status();
    const jails = await AP.fail2ban();
    const banned = jails.reduce((a, j) => a + j.banned, 0);
    lines.push(`BEZPIECZEŃSTWO: zapora ${fw.active ? 'włączona' : 'WYŁĄCZONA'}; fail2ban blokuje teraz ${banned} adresów.`);
    sec.push({ text: fw.active ? 'Zapora włączona' : 'Zapora wyłączona', level: fw.active ? 'ok' : 'warn', url: fw.active ? null : `${P}#/zapora`, cta: 'Włącz' });
    sec.push({ text: `Ochrona logowania blokuje teraz ${banned} ${pl(banned, 'adres', 'adresy', 'adresów')}` });
  } catch {}
  // sprawy
  const stA = await AP.status();
  const todo = stA.todo.filter((t) => t.level === 'error' || t.level === 'decision');
  if (todo.length) { lines.push(`CZEKA NA CIEBIE (${todo.length}):`); for (const t of todo.slice(0, 5)) lines.push(`  • ${t.text}`); }
  else lines.push('NIC NIE CZEKA NA CIEBIE.');
  if (todo.length) sections.unshift({ title: 'Czeka na Ciebie', todo: true, items: todo.slice(0, 5).map((t) => ({ text: t.text, level: t.level === 'error' ? 'error' : 'warn', url: `${P}${t.link || '#/autopilot'}` })) });
  if (errs.length) sections.push({ title: `Problemy w tym tygodniu (${errs.length})`, items: errs.slice(0, 5).map((e) => ({ text: `${fmtDay(e.ts)} ${e.text}`, level: 'error' })) });
  if (sec.length) sections.push({ title: 'Bezpieczeństwo', items: sec });
  sections.push({ title: `Autopilot zrobił sam (${auto.length})`, items: auto.length ? auto.slice(0, 5).map((e) => ({ text: `${fmtDay(e.ts)} ${e.text}` })) : [{ text: 'Nic nie wymagało naprawy.' }] });
  const level = errs.length || todo.some((t) => t.level === 'error') ? 'warn' : 'ok';
  const badge = todo.length ? { text: `${todo.length} ${pl(todo.length, 'sprawa czeka', 'sprawy czekają', 'spraw czeka')}`, level: 'warn' } : errs.length ? { text: 'były problemy', level: 'warn' } : { text: 'Wszystko działa', level: 'ok' };
  const card = { level, title: 'Tydzień na serwerze', subtitle: `${fmtDay(weekAgo)} – ${fmtDay(now)}`, badge, stats, sections, buttons: [{ label: 'Otwórz panel', url: `${P}#/pulpit` }] };
  return { title, text: lines.join('\n'), level, card };
}

export async function sendNow() {
  const r = await build();
  const res = await AP.sendNotification(r.title, r.text, r.level, { force: false, card: r.card, link: '#/pulpit' });
  save({ last: Date.now() });
  return { ...r, results: res };
}

/** Zasada autopilota: raz w tygodniu o wybranej porze. */
export async function rule() {
  const s = settings();
  if (!s.enabled) return;
  const now = new Date();
  if (now.getDay() !== s.day || now.getHours() < s.hour) return;
  const slot = new Date(now); slot.setHours(s.hour, 0, 0, 0);
  if (s.last && s.last >= slot.getTime()) return;
  const r = await sendNow();
  AP.event('raport', 'info', 'Wysłano raport tygodniowy', { detail: r.text, auto: true });
}
