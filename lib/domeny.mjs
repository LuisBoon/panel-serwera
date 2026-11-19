// Domeny i poczta: domeny z OVH (kiedy wygasają, rekordy DNS do edycji, przekierowania poczty) i kontrola,
// czy maile z domeny nie trafiają do spamu (SPF, DKIM, DMARC). Kontrola DNS działa też bez klucza OVH.
import dns from 'node:dns/promises';
import * as OV from './ovh.mjs';
import * as S from './system.mjs';
import { cached } from './util.mjs';
import { C } from './config.mjs';

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'];
const DKIM_SEL = ['resend', 'default', 'google', 'selector1', 'selector2', 'k1', 'k2', 'mail', 'dkim', 'smtp', 's1', 's2', 'ovhmo-selector-1', 'ovhmo-selector-2', 'mxvault'];
const OVH_MX = [['mx1.mail.ovh.net', 1], ['mx2.mail.ovh.net', 5], ['mx3.mail.ovh.net', 100]];
let J = null;
export function init(opts = {}) { J = opts.journal || null; }

const lower = (s) => String(s || '').trim().toLowerCase().replace(/\.$/, '');
/** Domena „do zarządzania” z nazwy strony: ostatnie dwa człony (albo trzy przy .com.pl, .org.pl…). */
function apex(host) {
  const p = lower(host).split('.');
  if (p.length <= 2) return p.join('.');
  const two = p.slice(-2).join('.');
  return /^(com|org|net|edu|gov|info|biz|co)\.[a-z]{2}$/.test(two) ? p.slice(-3).join('.') : two;
}
async function txt(name) { try { return (await dns.resolveTxt(name)).map((r) => r.join('')); } catch { return []; } }
async function mx(name) { try { return (await dns.resolveMx(name)).sort((a, b) => a.priority - b.priority); } catch { return []; } }
async function cname(name) { try { return await dns.resolveCname(name); } catch { return []; } }

/** SPF, DKIM, DMARC i MX dla jednej domeny poczty. */
export async function mailChecks(name) {
  const [t, m, dm, dmApex] = await Promise.all([txt(name), mx(name), txt('_dmarc.' + name), name === apex(name) ? Promise.resolve([]) : txt('_dmarc.' + apex(name))]);
  const spf = t.find((x) => /^v=spf1\b/i.test(x));
  const dkim = [];
  await Promise.all(DKIM_SEL.map(async (s) => { const k = `${s}._domainkey.${name}`; const v = (await txt(k)).find((x) => /p=/.test(x)) || ((await cname(k))[0] ? 'cname' : null); if (v) dkim.push(s); }));
  const dmarc = dm.find((x) => /^v=DMARC1/i.test(x)) || dmApex.find((x) => /^v=DMARC1/i.test(x));
  const policy = dmarc ? (dmarc.match(/\bp=(\w+)/i) || [])[1] : null;
  return {
    name,
    mx: m.map((x) => ({ host: x.exchange, prio: x.priority })),
    ovhMx: m.some((x) => /mail\.ovh\.net$/i.test(x.exchange)),
    items: [
      spf ? { id: 'spf', k: 'ok', title: 'SPF', text: `kto może wysyłać: ${spf.replace(/^v=spf1\s*/i, '').slice(0, 120)}` }
        : { id: 'spf', k: m.length ? 'warn' : 'info', title: 'SPF — brak', text: 'Bez SPF serwery poczty nie wiedzą, kto może wysyłać w imieniu domeny.', fix: m.length ? 'spf' : null },
      dkim.length ? { id: 'dkim', k: 'ok', title: 'DKIM', text: `podpis: ${dkim.map((s) => s + '._domainkey').join(', ')}` }
        : { id: 'dkim', k: 'info', title: 'DKIM — nie znalazłem', text: 'Sprawdziłem typowe nazwy podpisu. Jeśli wysyłasz przez usługę (Resend, Google…), dodaj rekord, który ona podaje.' },
      dmarc ? { id: 'dmarc', k: 'ok', title: 'DMARC', text: `zasada: ${policy || '?'}${!dm.length ? ` (z ${apex(name)})` : ''}` }
        : { id: 'dmarc', k: m.length || spf ? 'warn' : 'info', title: 'DMARC — brak', text: 'Gmail i Outlook bardziej ufają domenie z DMARC.', fix: 'dmarc' },
    ],
  };
}

function inOvh(zone) { return OV.ready() && OV.info().zones.includes(zone); }
const isRights = (e) => e?.status === 403 || /not been granted|not allowed/i.test(e?.message || '');

/** Lista domen: z OVH (gdy podłączone) i z nazw stron na serwerze. */
export const list = cached(10 * 60e3, async () => {
  const ovh = OV.info();
  const fromSites = new Set(S.siteConfigs().map((s) => apex(s.name)).filter((x) => x.includes('.')));
  const names = [...new Set([...(ovh.connected ? ovh.zones : []), ...fromSites])].sort();
  let mailDomains = null, rightsMissing = false;
  if (ovh.connected) { try { mailDomains = await OV.api('GET', '/email/domain'); } catch (e) { if (isRights(e)) rightsMissing = true; } }
  const out = await Promise.all(names.map(async (name) => {
    const d = { name, ovh: inOvh(name), expiration: null, autoRenew: null, records: null, mailService: mailDomains ? mailDomains.includes(name) : null, redirections: null, error: null };
    if (d.ovh) {
      try { const si = await OV.api('GET', `/domain/${name}/serviceInfos`); d.expiration = si?.expiration ? Date.parse(si.expiration) : null; d.autoRenew = !!si?.renew?.automatic; } catch (e) { if (isRights(e)) rightsMissing = true; else if (e.status !== 404) d.error = e.message; }
      try { d.records = (await OV.api('GET', `/domain/zone/${name}/record`))?.length ?? null; } catch (e) { d.error = e.message; }
      if (d.mailService) { try { d.redirections = (await OV.api('GET', `/email/domain/${name}/redirection`))?.length ?? 0; } catch {} }
    }
    const m = await mx(name);
    d.mx = m.length > 0;
    d.days = d.expiration ? Math.floor((d.expiration - Date.now()) / 864e5) : null;
    return d;
  }));
  return { ovh: { ...ovh, tokenUrl: OV.TOKEN_URL, rightsMissing }, domains: out };
});

async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

/** Szczegóły domeny: rekordy (z OVH), przekierowania, kontrola poczty dla domeny i subdomen z MX. */
export async function detail(zone) {
  zone = lower(zone);
  const all = await list();
  const d = all.domains.find((x) => x.name === zone);
  if (!d) throw new Error('Nie ma takiej domeny.');
  const ip = S.metrics().ip;
  const sites = new Set(S.siteConfigs().map((s) => s.name));
  let records = null, redirections = null, error = null;
  if (d.ovh) {
    try {
      const ids = (await OV.api('GET', `/domain/zone/${zone}/record`)) || [];
      records = (await pool(ids.slice(0, 300), 8, (id) => OV.api('GET', `/domain/zone/${zone}/record/${id}`).catch(() => null))).filter(Boolean)
        .map((r) => ({ id: r.id, type: r.fieldType, sub: r.subDomain || '', target: r.target, ttl: r.ttl, note: noteOf(r, zone, ip, sites), locked: r.fieldType === 'NS' || r.fieldType === 'SOA' }))
        .sort((a, b) => (a.sub === '' ? 0 : 1) - (b.sub === '' ? 0 : 1) || a.sub.replace(/^_/, '').localeCompare(b.sub.replace(/^_/, '')) || TYPES.indexOf(a.type) - TYPES.indexOf(b.type));
    } catch (e) { error = e.message; }
    if (d.mailService) {
      try { const ids = (await OV.api('GET', `/email/domain/${zone}/redirection`)) || []; redirections = (await pool(ids, 6, (id) => OV.api('GET', `/email/domain/${zone}/redirection/${id}`).catch(() => null))).filter(Boolean).map((r) => ({ id: r.id, from: r.from, to: r.to })); } catch (e) { if (!isRights(e)) error = error || e.message; }
    }
  }
  // domeny poczty: główna + subdomeny z MX (z rekordów OVH albo z nazw stron)
  const subs = new Set([zone]);
  for (const r of records || []) if (r.type === 'MX' && r.sub && !r.sub.includes('*')) subs.add(`${r.sub}.${zone}`);
  if (!records) for (const s of sites) if (s.endsWith('.' + zone) && (await mx(s)).length) subs.add(s);
  const mail = await Promise.all([...subs].map((n) => mailChecks(n)));
  return { ...d, records, redirections, mail, ip, error, canEdit: d.ovh && !all.ovh.rightsMissing };
}
function noteOf(r, zone, ip, sites) {
  const host = r.subDomain ? `${r.subDomain}.${zone}` : zone;
  if (r.fieldType === 'A' && r.target === ip) return sites.has(host) ? 'strona na tym serwerze' : 'ten serwer';
  if (r.fieldType === 'A' && sites.has(host)) return 'strona — inny adres niż ten serwer!';
  if (C().dom?.host && host === C().dom.host) return C().dom.opis || 'serwer w domu';
  if (r.fieldType === 'MX') return 'poczta';
  if (r.fieldType === 'TXT' && /^"?v=spf1/i.test(r.target)) return 'SPF';
  if (r.fieldType === 'TXT' && /^_dmarc/.test(r.subDomain)) return 'DMARC';
  if (/_domainkey/.test(r.subDomain)) return 'DKIM';
  if (r.fieldType === 'NS') return 'serwery nazw (tylko w OVH)';
  if (r.subDomain === '*') return 'wszystkie subdomeny';
  return '';
}

function need(zone) {
  zone = lower(zone);
  if (!inOvh(zone)) throw new Error('Ta domena nie jest w podłączonym OVH.');
  return zone;
}
function checkRecord({ type, sub, target, ttl }) {
  type = String(type || '').toUpperCase();
  if (!TYPES.includes(type)) throw new Error(`Rodzaj rekordu: ${TYPES.join(', ')}.`);
  sub = lower(sub === '@' ? '' : sub);
  if (sub && !/^(\*|[a-z0-9_]([a-z0-9_-]{0,62}))(\.[a-z0-9_]([a-z0-9_-]{0,62}))*$/.test(sub)) throw new Error('Nieprawidłowa nazwa (subdomena).');
  target = String(target || '').trim();
  if (!target || target.length > 1000) throw new Error('Wpisz wartość rekordu.');
  if (type === 'A' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(target)) throw new Error('Rekord A: adres IPv4, np. 203.0.113.7.');
  if (type === 'AAAA' && !/^[0-9a-f:]+$/i.test(target)) throw new Error('Rekord AAAA: adres IPv6.');
  if (type === 'CNAME' && !/^[a-z0-9.-]+\.?$/i.test(target)) throw new Error('Rekord CNAME: nazwa hosta, np. inny.example.pl.');
  if (type === 'MX' && !/^\d{1,5} [a-z0-9.-]+\.?$/i.test(target)) throw new Error('Rekord MX: „priorytet host”, np. „10 mx1.mail.ovh.net.”.');
  if (type === 'TXT' && !/^"/.test(target)) target = `"${target.replace(/"/g, '\\"')}"`;
  if ((type === 'CNAME' || type === 'MX') && !target.endsWith('.')) target += '.';
  const t = ttl == null || ttl === '' ? 0 : Number(ttl);
  if (!Number.isInteger(t) || t < 0 || t > 86400) throw new Error('TTL: 0–86400 sekund (0 = domyślny).');
  return { fieldType: type, subDomain: sub, target, ttl: t };
}
const refresh = (zone) => OV.api('POST', `/domain/zone/${zone}/refresh`);
const reset = () => list(true).catch(() => {});

export async function saveRecord(zone, b, who) {
  zone = need(zone);
  const r = checkRecord(b);
  if (b.id) {
    const old = await OV.api('GET', `/domain/zone/${zone}/record/${Number(b.id)}`);
    if (old.fieldType === 'NS' || old.fieldType === 'SOA') throw new Error('Rekordów NS zmieniaj w OVH — ich błąd odcina całą domenę.');
    if (old.fieldType !== r.fieldType) throw new Error('Rodzaju rekordu nie da się zmienić — usuń go i dodaj nowy.');
    await OV.api('PUT', `/domain/zone/${zone}/record/${old.id}`, { subDomain: r.subDomain, target: r.target, ttl: r.ttl });
    await refresh(zone);
    J?.add(who, 'domeny', `${zone}: zmieniono rekord ${r.fieldType} ${r.subDomain || '@'} → ${r.target}`, { type: 'dns-rekord', data: { zone, op: 'put', id: old.id, prev: { subDomain: old.subDomain, target: old.target, ttl: old.ttl } } }, '#/domeny/' + zone);
  } else {
    const made = await OV.api('POST', `/domain/zone/${zone}/record`, r);
    await refresh(zone);
    J?.add(who, 'domeny', `${zone}: dodano rekord ${r.fieldType} ${r.subDomain || '@'} → ${r.target}`, { type: 'dns-rekord', data: { zone, op: 'del', id: made?.id } }, '#/domeny/' + zone);
  }
  reset();
  return { ok: true };
}
export async function deleteRecord(zone, id, who) {
  zone = need(zone);
  const old = await OV.api('GET', `/domain/zone/${zone}/record/${Number(id)}`);
  if (old.fieldType === 'NS' || old.fieldType === 'SOA') throw new Error('Rekordów NS zmieniaj w OVH — ich błąd odcina całą domenę.');
  await OV.api('DELETE', `/domain/zone/${zone}/record/${old.id}`);
  await refresh(zone);
  J?.add(who, 'domeny', `${zone}: usunięto rekord ${old.fieldType} ${old.subDomain || '@'} → ${old.target}`, { type: 'dns-rekord', data: { zone, op: 'add', rec: { fieldType: old.fieldType, subDomain: old.subDomain, target: old.target, ttl: old.ttl } } }, '#/domeny/' + zone);
  reset();
  return { ok: true };
}
/** Cofnięcie z Dziennika zmian. */
export async function undoRecord(d) {
  if (d.op === 'del' && d.id) await OV.api('DELETE', `/domain/zone/${d.zone}/record/${d.id}`);
  if (d.op === 'put') await OV.api('PUT', `/domain/zone/${d.zone}/record/${d.id}`, d.prev);
  if (d.op === 'add') await OV.api('POST', `/domain/zone/${d.zone}/record`, d.rec);
  await refresh(d.zone);
  reset();
}

/** Naprawa poczty jednym kliknięciem: DMARC (p=none — tylko raporty, nic nie blokuje) albo SPF dla poczty w OVH. */
export async function fixMail(zone, name, what, who) {
  zone = need(zone);
  name = lower(name || zone);
  if (name !== zone && !name.endsWith('.' + zone)) throw new Error('Nieprawidłowa nazwa.');
  const sub = name === zone ? '' : name.slice(0, -(zone.length + 1));
  if (what === 'dmarc') return saveRecord(zone, { type: 'TXT', sub: sub ? `_dmarc.${sub}` : '_dmarc', target: 'v=DMARC1; p=none; adkim=r; aspf=r' }, who);
  if (what === 'spf') {
    const m = await mx(name);
    const inc = m.some((x) => /mail\.ovh\.net$/i.test(x.exchange)) ? ' include:mx.ovh.com' : '';
    return saveRecord(zone, { type: 'TXT', sub, target: `v=spf1 a mx${inc} ~all` }, who);
  }
  throw new Error('Nieznana naprawa.');
}

/* ---------------------------------------------------------- przekierowania poczty */

const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/i;
export async function addRedirect(zone, { from, to, mxOvh }, who) {
  zone = need(zone);
  const local = lower(from).replace(new RegExp(`@${zone.replace(/\./g, '\\.')}$`), '');
  if (!/^[a-z0-9._+-]{1,64}$/.test(local)) throw new Error('Adres: litery, cyfry, kropka, myślnik (np. kontakt).');
  to = String(to || '').trim();
  if (!EMAIL.test(to)) throw new Error('Wpisz poprawny adres, na który ma przychodzić poczta.');
  if (lower(to) === `${local}@${zone}`) throw new Error('Adres nie może przekierowywać sam na siebie.');
  const m = await mx(zone);
  if (!m.some((x) => /mail\.ovh\.net$/i.test(x.exchange))) {
    if (m.length && !mxOvh) throw new Error(`Poczta ${zone} idzie teraz gdzie indziej (${m.map((x) => x.exchange).join(', ')}) — przekierowanie OVH nie zadziała. Zmień MX w zakładce Rekordy, jeśli na pewno chcesz.`);
    if (!mxOvh) { const e = new Error('mx'); e.needMx = true; throw e; }
    for (const [host, prio] of OVH_MX) await OV.api('POST', `/domain/zone/${zone}/record`, { fieldType: 'MX', subDomain: '', target: `${prio} ${host}.`, ttl: 0 });
    await refresh(zone);
    J?.add(who, 'domeny', `${zone}: poczta kierowana do OVH (rekordy MX)`, null, '#/domeny/' + zone);
  }
  await OV.api('POST', `/email/domain/${zone}/redirection`, { from: `${local}@${zone}`, to, localCopy: false });
  J?.add(who, 'domeny', `${zone}: przekierowanie ${local}@${zone} → ${to}`, null, '#/domeny/' + zone);
  reset();
  return { ok: true, address: `${local}@${zone}` };
}
export async function deleteRedirect(zone, id, who) {
  zone = need(zone);
  const r = await OV.api('GET', `/email/domain/${zone}/redirection/${encodeURIComponent(id)}`);
  await OV.api('DELETE', `/email/domain/${zone}/redirection/${encodeURIComponent(id)}`);
  J?.add(who, 'domeny', `${zone}: usunięto przekierowanie ${r.from} → ${r.to}`, null, '#/domeny/' + zone);
  reset();
  return { ok: true };
}

/** Alarmy: domeny wygasające bez automatycznego odnowienia (albo tuż przed terminem). */
export async function alerts() {
  if (!OV.ready()) return [];
  let l; try { l = await list(); } catch { return []; }
  const out = [];
  for (const d of l.domains) {
    if (d.days == null) continue;
    if (d.days < 0) out.push({ level: 'error', text: `Domena ${d.name} wygasła`, link: '#/domeny/' + d.name });
    else if (!d.autoRenew && d.days <= 30) out.push({ level: d.days <= 7 ? 'error' : 'warn', text: `Domena ${d.name} wygasa za ${d.days} dni i nie odnowi się sama`, link: '#/domeny/' + d.name });
    else if (d.days <= 3) out.push({ level: 'warn', text: `Domena ${d.name} wygasa za ${d.days} dni — sprawdź płatność w OVH`, link: '#/domeny/' + d.name });
  }
  return out;
}
