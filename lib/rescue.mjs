// Plan awaryjny: stan gotowości (kopie, chmura) i paczka ratunkowa — instrukcja + skrypt, który na czystym
// Debianie 12 odtwarza serwer z kopii w chmurze, + spis tego, co jest na serwerze (pakiety, strony, usługi, DNS).
// Paczka nie zawiera haseł: klucze do kopii są w „Pakiecie odzyskiwania” (Kopie → Kopie w chmurze).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, readText, stamp } from './util.mjs';
import * as S from './system.mjs';
import * as D from './data.mjs';
import { C as CFG, publicUrl } from './config.mjs';

export async function status(O) {
  const runs = D.backupRuns(5);
  const lastOk = runs.find((r) => r.status === 'ok');
  const cloud = O.publicSettings();
  const conf = D.backupFiles().groups[0]?.files.some((f) => /konfiguracja/.test(f.label));
  const items = [
    { ok: !!lastOk && Date.now() - lastOk.start < 36 * 3600e3, text: 'Nocne kopie baz, stron, aplikacji i konfiguracji', desc: lastOk ? `ostatnia udana ${new Date(lastOk.start).toLocaleString('pl-PL')}` : 'brak udanej kopii', link: '#/kopie' },
    { ok: !!cloud.configured, text: 'Kopie poza serwerem (w chmurze)', desc: cloud.configured ? (cloud.last ? `ostatnia wysyłka ${new Date(cloud.last.start).toLocaleString('pl-PL')} — ${cloud.last.ok ? 'OK' : 'BŁĄD'}` : 'połączone, jeszcze nic nie wysłano') : 'Kopie leżą tylko na tym serwerze — gdy dysk padnie, przepadną. Podłącz chmurę.', link: '#/kopie' },
    { ok: !!cloud.lastTest?.ok, text: 'Sprawdzone, że kopię z chmury da się odczytać', desc: cloud.lastTest ? `test ${new Date(cloud.lastTest.start).toLocaleString('pl-PL')}` : 'test robi się co niedzielę po podłączeniu chmury', link: '#/kopie' },
    { ok: !!conf, text: 'Kopia konfiguracji serwera (Apache, PHP, usługi, harmonogram, certyfikaty, panel)', desc: conf ? 'w każdej nocnej kopii' : 'pojawi się po najbliższej nocnej kopii', link: '#/kopie' },
    { ok: null, text: 'Pakiet odzyskiwania (klucze do kopii w chmurze) zapisany poza serwerem', desc: 'Panel nie wie, czy go pobrałeś — pobierz w Kopie → Kopie w chmurze i trzymaj np. w menedżerze haseł.', link: '#/kopie' },
  ];
  return { items, cloud: { configured: cloud.configured, provider: cloud.provider } };
}

async function inventory() {
  const m = S.metrics();
  const manual = (await run('apt-mark', ['showmanual'])).out.trim();
  const sites = S.siteConfigs();
  const units = fs.readdirSync('/etc/systemd/system').filter((f) => f.endsWith('.service'));
  const enabled = [];
  for (const u of units) if ((await run('systemctl', ['is-enabled', u])).out.trim() === 'enabled') enabled.push(u);
  const ver = async (cmd, args) => (await run(cmd, args)).out.trim().split('\n')[0];
  const srcs = [readText('/etc/apt/sources.list'), ...(() => { try { return fs.readdirSync('/etc/apt/sources.list.d').map((f) => `# ${f}\n` + readText(path.join('/etc/apt/sources.list.d', f))); } catch { return []; } })()].join('\n');
  return {
    'pakiety.txt': manual + '\n',
    'zrodla-apt.txt': srcs,
    'uslugi.txt': enabled.join('\n') + '\n',
    'strony.txt': sites.map((s) => `${s.name}\t${s.enabled ? 'włączona' : 'wyłączona'}\t${s.root || s.proxies.join(' ') || '-'}\t${s.aliases.join(',')}`).join('\n') + '\n',
    'dns.txt': `# Po przeniesieniu na nowy serwer w OVH zmień rekordy A tych adresów na IP nowego serwera.\n# Stary serwer: ${m.ip}\n` + [...new Set(sites.flatMap((s) => [s.name, ...s.aliases]))].filter((n) => /\./.test(n)).sort().join('\n') + '\n',
    'wersje.txt': [`system: ${m.os}`, `jądro: ${os.release()}`, `node: ${await ver('node', ['--version'])}`, `php: ${await ver('php', ['-v'])}`, `mariadb: ${await ver('mariadb', ['--version'])}`, `apache: ${await ver('apache2', ['-v'])}`, `nazwa hosta: ${os.hostname()}`, `zrobiono: ${new Date().toISOString()}`].join('\n') + '\n',
  };
}

const README = (m) => `PLAN AWARYJNY — serwer ${CFG().nazwa}
================================
Zrobione: ${new Date().toLocaleString('pl-PL')} (stary serwer: ${m.ip})

Ta paczka pozwala postawić cały serwer od nowa, gdyby ten padł na dobre
(awaria dysku, utrata VPS-a). Dane (bazy, strony, aplikacje, konfiguracja)
są w nocnych kopiach w chmurze. Ta paczka to instrukcja + skrypt + spis.

Czego potrzebujesz
------------------
1. Nowy serwer VPS z czystym Debianem 12 (min. 2 rdzenie, 4 GB RAM, 30 GB dysku).
2. Pakiet odzyskiwania (plik z kluczami do kopii w chmurze) — pobrany w panelu:
   Kopie zapasowe → Kopie w chmurze → „Pakiet odzyskiwania”.
   BEZ NIEGO NIE DA SIĘ ODSZYFROWAĆ KOPII.
3. Dostęp do OVH (żeby przestawić domeny na nowy serwer).

Krok po kroku
-------------
1. Zaloguj się na nowy serwer jako root (SSH).
2. Wgraj na niego tę paczkę i pakiet odzyskiwania, np. do /root:
     scp plan-awaryjny-*.tar.gz pakiet-odzyskiwania*.txt root@NOWY_IP:/root/
3. Rozpakuj i uruchom:
     cd /root && tar xzf plan-awaryjny-*.tar.gz && cd plan-awaryjny
     bash odtworz.sh /root/pakiet-odzyskiwania-....txt
   Skrypt pyta o potwierdzenie przed każdym dużym krokiem. Trwa 15–40 minut.
4. W OVH zmień rekordy A wszystkich adresów z pliku dns.txt na IP nowego serwera.
5. Gdy DNS zacznie działać (zwykle 5–60 min), uruchom:
     bash odtworz.sh --certyfikaty
   — pobierze certyfikaty https dla wszystkich stron.
6. Wejdź na ${publicUrl() || 'adres panelu'} — panel powinien działać z tym samym
   kontem i kodem z aplikacji. „Coś nie działa?” sprawdzi resztę.

Co odtwarza skrypt
------------------
- pakiety systemowe (pakiety.txt) i źródła apt (PHP z repozytorium sury itp.),
- konfigurację: Apache, PHP, MariaDB, usługi systemd, harmonogram, pocztę,
  zaporę, fail2ban, skrypty z /usr/local/sbin, certyfikaty,
- bazy MariaDB (z kontami i hasłami), PostgreSQL/MongoDB jeśli były,
- kod stron (/var/www), aplikacje z /opt (razem z panelem) z danymi,
- przesłane pliki stron (ostatnia migawka mediów, jeśli była w chmurze).

Czego NIE odtwarza
------------------
${CFG().dom ? `- ${CFG().dom.opis || 'serwera w domu'} (${CFG().dom.host}) — działa osobno, trzeba tylko przestawić DNS,\n` : ''}${CFG().gibcord ? '- klucza GIPHY w GibCordzie (wpisz go ponownie w panelu: karta strony GibCorda → Zmienne),\n' : ''}- zmian zrobionych po ostatniej nocnej kopii.

Gdy coś pójdzie nie tak, skrypt zapisuje wszystko do /root/odtworz.log.
`;

const SCRIPT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'odtworz.sh');
const scriptBody = () => readText(SCRIPT_FILE);

/** Paczka .tar.gz do pobrania (strumień). */
export async function rescuePackage(tmpDir) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'awaria-'));
  const root = path.join(dir, 'plan-awaryjny');
  fs.mkdirSync(root);
  const inv = await inventory();
  for (const [f, t] of Object.entries(inv)) fs.writeFileSync(path.join(root, f), t);
  fs.writeFileSync(path.join(root, 'CZYTAJ-MNIE.txt'), README(S.metrics()));
  fs.writeFileSync(path.join(root, 'odtworz.sh'), scriptBody(), { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'katalog-kopii.txt'), CFG().kopie.katalog + '\n');
  const tar = spawn('tar', ['czf', '-', '-C', dir, 'plan-awaryjny'], { stdio: ['ignore', 'pipe', 'ignore'] });
  tar.on('close', () => fs.rm(dir, { recursive: true, force: true }, () => {}));
  return { name: `plan-awaryjny-${stamp()}.tar.gz`, stream: tar.stdout, type: 'application/gzip' };
}
export const scriptText = scriptBody;
