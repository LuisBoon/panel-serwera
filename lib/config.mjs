// Konfiguracja instalacji: plik DATA_DIR/konfiguracja.json (tworzy go instalator, zmienia kreator i panel).
// Wszystko, co różni jeden serwer od drugiego (nazwa, adres, moduły, serwer w domu, GibCord, panel gier,
// znane aplikacje, katalog kopii) jest tutaj — kod panelu nie zawiera nazw ani adresów konkretnego serwera.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || '/var/lib/panel-serwera';
export const FILE = path.join(DATA_DIR, 'konfiguracja.json');

export const MODULES = {
  strony: ['Strony i SSL', 'zakładanie stron, certyfikaty, pliki, wersje, GitHub', true],
  bazy: ['Bazy danych', 'MariaDB, PostgreSQL, MongoDB, Redis, SQLite', true],
  kopie: ['Kopie zapasowe', 'nocne kopie, przywracanie, kopie w chmurze, plan awaryjny', true],
  autopilot: ['Autopilot', 'sam naprawia usługi, pilnuje dysku, kopii, certyfikatów i aktualizacji', true],
  statystyki: ['Statystyki odwiedzin', 'z logów Apache, bez ciasteczek', true],
  zapora: ['Zapora', 'bezpieczny zestaw reguł ufw z bezpiecznikiem', true],
  terminal: ['Terminal w przeglądarce', 'pełna konsola dla właściciela (z kodem 2FA)', true],
  dostep: ['Konta SFTP i klucze SSH', 'dostęp do plików jednej strony dla innych osób', true],
  status: ['Publiczna strona statusu', 'adres /status/ z historią dostępności', false],
  gry: ['Serwery gier (Pterodactyl)', 'stan i przyciski serwerów z panelu Pterodactyl', false],
  gibcord: ['Powiadomienia GibCord', 'wiadomości od bota na komunikatorze GibCord', false],
  ovh: ['Domeny w OVH', 'automatyczne rekordy DNS dla nowych stron', false],
};

const host = os.hostname().split('.')[0];
export const DEFAULTS = {
  nazwa: host,                      // „Serwer <nazwa>” w aplikacji z kodami, wiadomościach i na stronie statusu
  adres: '',                        // adres panelu, np. panel.example.pl (bez https://)
  domena: '',                       // główna domena dla nowych stron, np. example.pl
  moduly: Object.fromEntries(Object.entries(MODULES).map(([k, v]) => [k, v[2]])),
  kopie: { katalog: '/var/backups/panel-serwera', skrypt: '/usr/local/sbin/panel-kopia.sh', log: '/var/log/panel-kopia.log', cron: '/etc/cron.d/panel-kopia' },
  dom: null,                        // serwer w domu z dynamicznym IP: { host: 'node1.example.pl', opis: 'serwer w domu', porty: '3306' }
  gibcord: null,                    // { url: 'http://127.0.0.1:8084', tokenFile, baza, usluga, domena, smtp: '/etc/systemd/system/dc.service.d/smtp.conf' }
  gry: null,                        // { panel: 'https://panel.example.pl', baza: 'panel' }
  aplikacje: {},                    // usługa systemd → [nazwa, opis, 'app'|'srv']
  bazySqlite: [],                   // [{ id, name, path, service }]
  katalogiDanych: [],               // [{ id, name, path, service }]
  logi: [],                         // [[ścieżka, opis]]
  smtp: null,                       // { host, port, secure, user, pass, from } — gdy nie ma GibCorda z pocztą
  zapora: { uslugi: {}, zaufane: [] }, // dodatkowe usługi { id: { name, specs[] } } i zaufane adresy
  status: null,                     // { title, services: [...] } — domyślne usługi strony statusu
};

let cfg = null, mtime = 0;
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  return out;
}
export function load() {
  let raw = {};
  try { const st = fs.statSync(FILE); mtime = st.mtimeMs; raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  cfg = merge(DEFAULTS, raw);
  return cfg;
}
/** Bieżąca konfiguracja (plik czytany ponownie, gdy ktoś go zmienił). */
export function C() {
  if (!cfg) return load();
  try { if (fs.statSync(FILE).mtimeMs !== mtime) load(); } catch {}
  return cfg;
}
export function save(patch) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const next = merge(raw, patch);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
  return load();
}
export const on = (m) => !!C().moduly?.[m];
/** Adres panelu z https:// i ukośnikiem na końcu (PUBLIC_URL ma pierwszeństwo). */
export function publicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/?$/, '/');
  const a = C().adres;
  return a ? `https://${a.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/` : '';
}
/** To, co strona panelu musi wiedzieć o instalacji (bez sekretów). */
export function publicInfo() {
  const c = C();
  return { nazwa: c.nazwa, adres: c.adres, domena: c.domena, kreator: !!c.kreator, moduly: c.moduly, dom: c.dom ? { host: c.dom.host, opis: c.dom.opis || 'serwer w domu' } : null, gibcord: !!c.gibcord, gry: !!c.gry, kopie: c.kopie.katalog };
}
