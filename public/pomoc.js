// Pomoc „Jak to zrobić?”: krótkie instrukcje do każdej strony panelu (przycisk „?”) i strona #/pomoc z wyszukiwarką.
// Do tego strona #/terminal (wejście do terminala) — sam terminal działa na osobnej stronie terminal.html.
const { h, put, api, btn, linkBtn, ico, when, bytes, PAGES, state } = window.P;

const HELP = {
  pulpit: [
    ['Co oznaczają kolory na pulpicie?', ['Zielone — wszystko działa. Żółte — warto zajrzeć, ale nic się nie pali. Czerwone — coś nie działa i trzeba to naprawić.', 'Kliknij alarm, żeby przejść do miejsca, gdzie go naprawisz.']],
    ['Coś nie działa, a nie wiem co', ['Wejdź w „Coś nie działa?” w menu.', 'Wybierz, co się dzieje, i której strony dotyczy — panel sprawdzi wszystko po kolei i podpowie naprawę.']],
  ],
  napraw: [
    ['Jak działa „Coś nie działa?”', ['Wybierasz objaw (np. „Strona się nie otwiera”) i stronę albo usługę.', 'Panel sprawdza DNS, zaporę, Apache, certyfikat, aplikację, PHP, bazę, dysk i pamięć.', 'Przy błędach jest przycisk naprawy — panel robi ją od razu i sprawdza jeszcze raz.', 'Każda naprawa trafia do Dziennika zmian.']],
    ['Panel mówi, że wszystko działa, a strona dalej nie działa', ['Otwórz stronę w trybie prywatnym przeglądarki (stara wersja może siedzieć w pamięci przeglądarki).', 'Sprawdź Logi → błędy strony.', 'Jeśli trzeba, w Terminalu możesz sprawdzić wszystko ręcznie.']],
  ],
  strony: [
    ['Jak dodać nową stronę?', ['Kliknij „Utwórz” w menu.', 'Wybierz rodzaj (pliki, PHP z bazą, aplikacja Node, przekierowanie), wpisz adres, kliknij Utwórz.', 'Jeśli domena jest w OVH i klucz jest podłączony, adres w DNS doda się sam. Certyfikat https też.']],
    ['Jak wyłączyć stronę na chwilę?', ['Na liście stron użyj przełącznika przy stronie — Apache przestanie ją pokazywać, pliki zostają.', 'Albo w karcie strony → Ochrona włącz przerwę techniczną z komunikatem dla odwiedzających.']],
  ],
  strona: [
    ['Jak zmienić plik na stronie?', ['Karta strony → Pliki → kliknij plik → Edytuj → Zapisz.', 'Przed każdym zapisem panel zachowuje poprzednią wersję pliku (przycisk „Wersje” przy pliku).']],
    ['Jak wgrać nową wersję strony?', ['Pliki → Wgraj (pojedyncze pliki) albo Wersje i GitHub → połącz repozytorium, a strona sama się zaktualizuje po wysłaniu zmian.', 'Przed wgraniem panel zapisuje wersję całej strony — cofniesz ją w zakładce Wersje.']],
    ['Jak cofnąć stronę do wczoraj?', ['Karta strony → Wersje i GitHub → wybierz wersję → Przywróć.', 'Pliki wgrane przez użytkowników (uploads) i baza nie są cofane.']],
    ['Jak postawić hasło na stronę?', ['Karta strony → Ochrona → Hasło: wpisz login i hasło → Włącz.', 'Przeglądarka zapyta o nie przy wejściu na stronę.']],
    ['Jak bezpiecznie testować zmiany?', ['Karta strony → Kopia testowa → Zrób kopię. Powstanie test-… z kopią plików i bazy, za hasłem.', 'Gdy wszystko działa, kliknij „Opublikuj”.']],
    ['Jak zmienić wersję PHP albo limit wgrywania?', ['Karta strony → Ustawienia → wybierz wersję PHP i limity → Zapisz.', 'Panel sprawdza konfigurację przed zapisem, a przy błędzie sam wraca do poprzedniej.']],
    ['Jak dodać drugi adres do strony (np. www)?', ['Karta strony → Ustawienia → Dodatkowe adresy → dodaj domenę.', 'Adres musi wskazywać na serwer (rekord A w OVH) — certyfikat rozszerzy się sam.']],
    ['Jak ustawić przekierowanie starego adresu?', ['Karta strony → Ustawienia → Przekierowania: skąd (np. /stara) → dokąd (np. /nowa) → Dodaj.']],
  ],
  bazy: [
    ['Jak założyć bazę dla nowej aplikacji?', ['Bazy danych → Nowa baza → wybierz silnik (zwykle MariaDB) → wpisz nazwę → Utwórz.', 'Panel założy też konto z hasłem i pokaże gotowy wpis do pliku .env — skopiuj go od razu, hasło widać tylko raz.']],
    ['Jak zmienić coś w danych?', ['Otwórz bazę → Tabele → wybierz tabelę → kliknij wiersz → popraw pola → Zapisz.', 'Przed pierwszą zmianą panel robi kopię tabeli, a każdą zmianę cofniesz w Dzienniku zmian.']],
    ['Jak uruchomić zapytanie SQL?', ['Otwórz bazę → Zapytanie SQL. Domyślnie działa „Tylko odczyt” (SELECT).', 'Żeby zmieniać dane, odznacz „Tylko odczyt”. Panel pokaże, ile wierszy się zmieni, poprosi o potwierdzenie i zrobi kopię bazy.']],
    ['Jak dać komuś dostęp do bazy?', ['Otwórz bazę → Kto ma dostęp → Nadaj dostęp → istniejące albo nowe konto, prawa pełne lub tylko odczyt.', 'Jeśli ma łączyć się z zewnątrz (np. z serwera gier w domu), wybierz „Też z serwera gier w domu” albo podaj adres IP.']],
    ['Zgubiłem hasło do bazy', ['Bazy danych → Konta → przy koncie „Zmień” → Nowe hasło.', 'Wpisz nowe hasło w ustawieniach aplikacji (np. plik .env albo config.php) — stare przestaje działać od razu.']],
    ['Jak wgrać bazę z pliku .sql?', ['Otwórz bazę → Kopie → Wgraj plik (.sql albo .sql.gz).', 'Przed wgraniem panel zapisze obecny stan, więc możesz wrócić.']],
    ['Jak zainstalować PostgreSQL albo MongoDB?', ['Bazy danych → Silniki → Zainstaluj. Trwa 1–3 minuty.', 'Silnik działa tylko lokalnie, z hasłem, i od razu trafia do nocnych kopii.']],
  ],
  kopie: [
    ['Kiedy robią się kopie?', ['Co noc o 3:30: wszystkie bazy, kod stron, konfiguracja i migawka przesłanych plików.', 'Dodatkowo przed każdą zmianą z panelu (plik, baza, wgranie) powstaje kopia „przed …”.']],
    ['Jak przywrócić bazę z kopii?', ['Kopie zapasowe → wybierz noc → Przywróć przy bazie (albo w karcie bazy → Kopie).', 'Wpisz nazwę bazy, żeby potwierdzić. Panel najpierw zapisze obecny stan.']],
    ['Kopie w chmurze', ['Kopie zapasowe → Kopie w chmurze: wklej klucz Backblaze B2 (10 GB za darmo).', 'Pobierz „Pakiet odzyskiwania” i trzymaj go poza serwerem — bez niego nie odszyfrujesz kopii.']],
    ['Co zrobić, gdy serwer padnie na dobre?', ['Plan awaryjny (w menu) → pobierz paczkę ratunkową. Razem z Pakietem odzyskiwania (Kopie → Kopie w chmurze) trzymaj ją poza serwerem.', 'Na nowym serwerze z Debianem uruchamiasz jeden skrypt z paczki — odtworzy strony, bazy i usługi z kopii w chmurze.']],
  ],
  uslugi: [
    ['Usługa padła — co robić?', ['Usługi → przy usłudze „Uruchom ponownie”.', 'Jeśli pada znowu: „Coś nie działa?” → „Aplikacja albo usługa nie działa” pokaże błędy z logu.']],
    ['Co to są procesy testowe?', ['To pozostałości po pracy Claude (np. przeglądarki do zrzutów). Można je bezpiecznie zatrzymać — autopilot robi to sam.']],
  ],
  aplikacja: [
    ['Jak zmienić ustawienia aplikacji (.env)?', ['Karta strony aplikacji → Zmienne → Zmień → Zapisz i uruchom ponownie.', 'Jeśli aplikacja nie wstanie w 30 sekund, panel sam przywróci poprzednie wartości.']],
    ['Jak zaktualizować aplikację?', ['Karta strony → Aplikacja → Aktualizuj z ZIP-a albo z GitHuba.', 'Poprzednia wersja zostaje — „Wróć do poprzedniej wersji” cofa jednym kliknięciem.']],
  ],
  wydajnosc: [
    ['Serwer zwalnia — co sprawdzić?', ['Wydajność → „Co zjada pamięć?” pokazuje, które programy zajmują najwięcej.', 'Procesy testowe i stare sesje można zatrzymać przyciskiem. Pod spodem są wykresy z 30 dni.']],
  ],
  aktualizacje: [
    ['Jak zainstalować poprawki?', ['Poprawki bezpieczeństwa instalują się same w nocy.', 'Aktualizacje → Zainstaluj teraz instaluje wszystkie oczekujące od razu.']],
    ['Kiedy restartować serwer?', ['Gdy panel pokazuje „wymagany restart” (np. po nowym jądrze).', 'Aktualizacje → Restart o wybranej godzinie (najlepiej w nocy). Po restarcie panel sprawdzi wszystkie strony i da znać (powiadomienia z Autopilota).']],
  ],
  cron: [
    ['Jak dodać zadanie, które ma się wykonywać samo?', ['Harmonogram → Nowe zadanie → co zrobić (polecenie, adres albo restart usługi) i kiedy.', '„Uruchom teraz” pokaże wynik od razu, żeby sprawdzić, czy działa.']],
  ],
  dysk: [
    ['Kończy się miejsce', ['Dysk → Posprzątaj usuwa bezpieczne rzeczy: pamięć apt, stare logi systemu, pozostałości przeglądarek.', 'Drzewo pokazuje, które katalogi są największe.', 'Stare kopie usuwasz w Kopiach zapasowych (albo zmniejsz liczbę trzymanych dni).']],
  ],
  logi: [
    ['Gdzie są błędy strony?', ['Logi → wybierz stronę → „błędy”. Najnowsze są na górze.', 'Albo w karcie strony → Szczegóły → Logi.']],
  ],
  ssl: [
    ['Certyfikat wygasa', ['Certyfikaty odnawiają się same (autopilot pilnuje tego codziennie).', 'Jeśli coś nie wyszło: Certyfikaty SSL → Odnów przy stronie.']],
  ],
  zapora: [
    ['Jak włączyć zaporę bezpiecznie?', ['Zapora → Włącz bezpieczny zestaw.', 'Przez 5 minut działa bezpiecznik: jeśli serwer przestanie być osiągalny, zapora sama się wyłączy.']],
    ['Jak wpuścić kogoś do bazy z zewnątrz?', ['Najprościej z Bazy danych → konto → „Skąd może się łączyć” — panel sam otworzy port tylko dla tego adresu.', 'Albo Zapora → Zaufane adresy → dodaj adres i port.']],
  ],
  autopilot: [
    ['Co robi autopilot?', ['Pilnuje stron i usług (restartuje padnięte), sprząta dysk, pilnuje kopii, certyfikatów i aktualizacji.', 'Wszystko, co zrobił sam, widać na osi czasu. Powiadomienia przychodzą e-mailem, pushem albo na GibCorda (jeśli jest podłączony).']],
    ['Jak dodać własny alarm?', ['Autopilot → Własne alarmy → Nowy alarm: jeśli (np. pamięć) jest powyżej (90%) przez (5 min) → powiadom.']],
  ],
  gry: [
    ['Serwer gry nie startuje', ['Serwery gier → Start przy serwerze.', 'Jeśli nie pomaga: „Coś nie działa?” → „Serwer gry nie startuje” sprawdzi panel gier i komputer w domu.']],
  ],
  dostep: [
    ['Jak dać komuś dostęp tylko do plików jednej strony?', ['Dostęp → Konta SFTP → Nowe konto → wybierz stronę.', 'Ta osoba zaloguje się programem do FTP (np. FileZilla, protokół SFTP, port 22) i zobaczy tylko pliki tej strony.']],
    ['Jak dodać klucz SSH?', ['Dostęp → Klucze SSH → wklej klucz publiczny (zaczyna się od ssh-ed25519 albo ssh-rsa).', 'Nie usuwaj ostatniego klucza, którym się logujesz — panel ostrzeże.']],
  ],
  dziennik: [
    ['Jak cofnąć zmianę?', ['Dziennik zmian → przy zmianie „Cofnij”.', 'Da się cofnąć zmiany plików, ustawień, danych w bazach, kont baz i wiele innych. Cofnięcie też trafia do dziennika.']],
  ],
  terminal: [
    ['Jak otworzyć terminal?', ['Terminal → Otwórz terminal → wpisz kod z aplikacji.', 'To pełna konsola root — działa tylko dla właściciela i zamyka się sama po 20 minutach bez pisania. Każda sesja jest zapisywana.']],
    ['Przydatne polecenia', ['systemctl status nazwa — stan usługi; systemctl restart nazwa — uruchomienie ponownie.', 'journalctl -u nazwa -n 50 — ostatnie wpisy logu usługi.', 'df -h — miejsce na dysku; free -h — pamięć; htop — procesy (q wychodzi).', 'tail -f /var/log/apache2/error.log — błędy na żywo (Ctrl+C kończy).']],
  ],
  utworz: [
    ['Jak postawić WordPressa?', ['Utwórz → WordPress → adres → Utwórz.', 'Panel założy bazę, pobierze WordPressa, ustawi SSL i pokaże login i hasło do panelu WordPressa.']],
  ],
  konto: [
    ['Jak zaprosić kogoś do panelu?', ['Konto → Osoby z dostępem → Zaproś → wybierz, co może (wszystko, tylko podgląd albo wybrane strony).', 'Wyślij tej osobie link — sama ustawi hasło i kod w telefonie.']],
    ['Zgubiłem telefon z kodami', ['Inna osoba z rolą właściciela może Ci pomóc. Jeśli jesteś jedynym właścicielem: w terminalu serwera (np. przez SSH) uruchom /opt/panel-serwera/reset-2fa.sh.']],
  ],
};
const PAGE_ALIAS = { strona: ['strona', 'aplikacja'], statystyki: ['strony'], statusowa: ['strony'], awaria: ['kopie'] };
const TITLES = { pulpit: 'Pulpit', napraw: 'Coś nie działa?', strony: 'Strony', strona: 'Karta strony', aplikacja: 'Aplikacje', bazy: 'Bazy danych', kopie: 'Kopie zapasowe', uslugi: 'Usługi', wydajnosc: 'Wydajność', aktualizacje: 'Aktualizacje', cron: 'Harmonogram', dysk: 'Dysk', logi: 'Logi', ssl: 'Certyfikaty SSL', zapora: 'Zapora', autopilot: 'Autopilot', gry: 'Serwery gier', dostep: 'Dostęp', dziennik: 'Dziennik zmian', terminal: 'Terminal', utworz: 'Utwórz', konto: 'Konto' };

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
function topicEl([q, steps], open = false) {
  return h('details', { class: 'help-t', open: open || null }, h('summary', null, q), h('ol', null, steps.map((s) => h('li', null, s))));
}
function search(text) {
  const t = norm(text.trim());
  const out = [];
  for (const [page, list] of Object.entries(HELP)) for (const x of list) if (norm(x[0] + ' ' + x[1].join(' ')).includes(t)) out.push([page, x]);
  return out;
}

/** Panel pomocy z boku — tematy dla bieżącej strony + wyszukiwarka. */
window.openHelp = () => {
  document.querySelector('.help-bg')?.remove();
  const page = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]) || 'pulpit';
  const keys = PAGE_ALIAS[page] || [page];
  const topics = keys.flatMap((k) => HELP[k] || []);
  const list = h('div', { class: 'stack', style: 'gap:8px' });
  const show = (text) => {
    if (text.trim().length < 2) { list.replaceChildren(...(topics.length ? topics.map((t, i) => topicEl(t, i === 0)) : [h('p', { class: 'small muted' }, 'Do tej strony nie ma jeszcze instrukcji — poszukaj wyżej.')])); return; }
    const r = search(text);
    list.replaceChildren(...(r.length ? r.slice(0, 12).map(([p, t]) => h('div', { class: 'stack', style: 'gap:2px' }, h('span', { class: 'small dim' }, TITLES[p] || p), topicEl(t))) : [h('p', { class: 'small muted' }, 'Nic nie znalazłem. Spróbuj innego słowa (np. „hasło”, „kopia”, „baza”).')]));
  };
  const inp = h('input', { class: 'input', type: 'search', placeholder: 'Szukaj w pomocy…', 'aria-label': 'Szukaj w pomocy' });
  inp.oninput = () => show(inp.value);
  const close = () => { bg.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const panel = h('aside', { class: 'help-panel', role: 'dialog', 'aria-label': 'Pomoc' },
    h('div', { style: 'display:flex;align-items:center;gap:10px' }, h('h2', { class: 'grow' }, `Pomoc: ${TITLES[page] || 'panel'}`), btn('', close, { icon: 'x', title: 'Zamknij', kind: 'ghost' })),
    inp, list,
    h('a', { href: '#/pomoc', class: 'small', onclick: close }, 'Wszystkie instrukcje →'));
  const bg = h('div', { class: 'help-bg' }, panel);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  document.addEventListener('keydown', esc);
  document.body.append(bg);
  show('');
  setTimeout(() => inp.focus(), 30);
};

PAGES.pomoc = async (box, args, q) => {
  const inp = h('input', { class: 'input', type: 'search', placeholder: 'Czego szukasz? np. hasło do bazy, kopia, certyfikat', value: q.get('q') || '', 'aria-label': 'Szukaj w pomocy' });
  const out = h('div', { class: 'stack', style: 'gap:16px' });
  const draw = () => {
    const t = inp.value;
    if (t.trim().length >= 2) {
      const r = search(t);
      out.replaceChildren(h('section', { class: 'card stack', style: 'gap:8px' }, r.length ? r.map(([p, x]) => h('div', { class: 'stack', style: 'gap:2px' }, h('span', { class: 'small dim' }, TITLES[p] || p), topicEl(x))) : h('p', { class: 'muted', style: 'margin:0' }, 'Nic nie znalazłem.')));
      return;
    }
    out.replaceChildren(...Object.entries(HELP).map(([p, list]) => h('section', { class: 'card stack', style: 'gap:8px' }, h('h2', null, TITLES[p] || p), list.map((x) => topicEl(x)))));
  };
  inp.oninput = draw;
  draw();
  put(box, h('div', { class: 'head' }, h('div', null, h('h1', null, 'Pomoc'), h('div', { class: 'sub' }, 'Krótkie instrukcje do wszystkiego, co robisz w panelu. Na każdej stronie przycisk „Pomoc” pokazuje te, które jej dotyczą.'))),
    h('div', { class: 'card', style: 'padding:12px' }, inp), out);
  setTimeout(() => inp.focus(), 50);
};

PAGES.terminal = async (box) => {
  let d = null;
  try { d = await api('GET', 'api/terminal'); } catch (e) {
    put(box, h('div', { class: 'head' }, h('div', null, h('h1', null, 'Terminal'))), h('div', { class: 'alert info' }, h('span', { class: 'tag' }, 'INFO'), h('span', { class: 'txt' }, 'Terminal jest dostępny tylko dla właściciela panelu.')));
    return;
  }
  put(box,
    h('div', { class: 'head' }, h('div', null, h('h1', null, 'Terminal'), h('div', { class: 'sub' }, 'Pełna konsola serwera w przeglądarce — na wszystko, czego nie ma w panelu.')),
      h('div', { class: 'acts' }, linkBtn('Otwórz terminal', './terminal.html', { kind: 'pri', icon: 'terminal' }))),
    h('div', { class: 'cols' },
      h('section', { class: 'card stack', style: 'gap:10px' }, h('h2', null, 'Zanim otworzysz'),
        h('ul', { class: 'small', style: 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;color:#c9d1dc' },
          h('li', null, 'Działa jako root — polecenia wykonują się od razu, bez pytania.'),
          h('li', null, 'Przy każdym otwarciu panel prosi o kod z aplikacji.'),
          h('li', null, 'Sesja zamyka się sama po 20 minutach bez pisania (najdłużej 3 godziny).'),
          h('li', null, 'Wszystko, co pojawia się na ekranie, jest zapisywane (lista niżej, 30 dni).')),
        h('div', null, btn('Przydatne polecenia', () => window.openHelp(), { small: true, icon: 'pomoc' }))),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Ostatnie sesje')),
        d.sessions.length ? h('div', { class: 'alert warn', style: 'margin-bottom:10px' }, h('span', { class: 'tag' }, 'OTWARTA'), h('span', { class: 'txt' }, d.sessions.map((s) => `${s.login} z ${s.ip}, od ${when(s.started)}`).join('; '))) : null,
        d.logs.length ? h('div', { class: 'rows' }, d.logs.map((l) => h('div', { class: 'row' }, h('span', { class: 'grow' }, when(l.time)), h('span', { class: 'small muted' }, bytes(l.size)), linkBtn('Pobierz zapis', `api/terminal/zapis/${encodeURIComponent(l.name)}`, { small: true, icon: 'pobierz' })))) : h('div', { class: 'list-empty' }, 'Jeszcze nie było sesji.'))));
};
