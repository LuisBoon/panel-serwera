# Zmiany

## 1.7.0 — 19.11.2026

- **Domeny i poczta** — nowa strona: domeny z OVH z datą wygaśnięcia (alarm, gdy domena nie odnowi się sama),
  rekordy DNS do dodawania, zmiany i usuwania (z cofaniem w Dzienniku zmian), przekierowania poczty OVH
  (kontakt@domena → Twoja skrzynka, z próbnym mailem) i kontrola SPF, DKIM i DMARC z przyciskiem „Dodaj”.
  Klucz OVH obejmuje teraz też daty domen i pocztę (stary klucz działa dalej dla rekordów).
- **Mapa serwera** — schemat strona → program → dane → połączenia z zewnątrz; kliknięcie podświetla drogę,
  „Co padnie, jeśli wyłączę…” zaznacza wszystko, co zależy od usługi albo silnika bazy.
- **Próbne przywracanie kopii** — raz w tygodniu (i przyciskiem) nocna kopia jest odtwarzana w tymczasowej bazie
  i folderze: każdy zrzut MariaDB wczytany i policzony, archiwa przeczytane w całości, bazy SQLite ze środka
  sprawdzone, próbka plików z migawki porównana z oryginałem. Zepsuta kopia = alarm.
- **Strażnik plików stron** — co godzinę porównuje pliki .php, .js i .htaccess stron; zmiany z panelu i GitHuba
  (a także aktualizacje WordPressa, wtyczek i pliki cache) są znane, każda inna trafia do Bezpieczeństwa z podglądem
  kodu albo różnic i decyzją: usuń (kwarantanna), przywróć z nocnej kopii albo „to ja — zostaw”.
- **Ochrona przed botami** — kto dziś szukał dziur na stronach (wp-login, .env, .git, phpmyadmin…), blokada adresu
  jednym kliknięciem (fail2ban, porty 80 i 443) i automat: 10 prób w ciągu doby = blokada na dobę. Serwer w domu,
  serwery z grupy i Twoja lista nigdy nie są blokowane; strony z WordPressem mają regułę bez ścieżek WordPressa.
- **Własna aplikacja z Dockera** — w Sklepie półka „Własna”: obraz, port, adres, folder na dane, pamięć i zmienne
  (z podpowiedzią z Docker Hub) albo wklejony docker-compose.yml — panel przestawia porty na 127.0.0.1, dodaje limity
  pamięci, zamienia wolumeny na foldery w kopii, usuwa privileged/cap_add i odrzuca docker.sock, sieć hosta i obce foldery.
- **Serwery gier w Sklepie** — Minecraft Java (Paper), Minecraft Bedrock, Terraria (TShock), Valheim; wolny port,
  świat w nocnej kopii, adres do skopiowania, ostrzeżenie, gdy gra nie zmieści się w pamięci.
- **Hosting dla znajomych** — zaproszenie z pakietem (Mały, Średni, Własny). Znajomy dostaje stronę „Twój hosting”:
  zakłada strony (pliki, PHP z bazą, WordPress) pod *.login.domena (albo na swojej domenie), bazy, pliki i kopie
  tylko swoje, prośba o więcej miejsca. Jego PHP działa jako osobny użytkownik systemu w osobnej puli FPM
  (open_basedir, bez exec), Apache nie idzie za cudzymi dowiązaniami. Przekroczenie miejsca wstrzymuje wgrywanie.

## 1.6.0 — 19.11.2026

- **Bezpieczeństwo** — nowa strona: wynik 0–100 i lista spraw z przyciskiem „Napraw” (logowanie roota hasłem,
  zapora i porty widoczne z internetu, restart po aktualizacjach jądra, automatyczne poprawki, fail2ban, LLMNR,
  certyfikaty). Naprawy trafiają do dziennika zmian.
- **Sklep z aplikacjami** — Nextcloud, Vaultwarden, Uptime Kuma, Gitea, n8n, Umami i Paperless-ngx jednym kliknięciem:
  kontener Docker (port tylko na 127.0.0.1, limit pamięci), własny adres z certyfikatem, nocne kopie danych,
  aktualizacja i usuwanie przyciskiem. Docker instaluje się z panelu.
- **Kopie na drugi serwer z grupy** — nowy cel kopii poza serwerem: tamten panel zakłada zamknięte konto
  (tylko SFTP, tylko klucz), kopie są szyfrowane tutaj. Test odczytu działa też dla SFTP bez powłoki (np. Storage Box).
- **Strażnik grupy** — serwery z grupy pilnują się nawzajem; gdy któryś nie odpowiada dłużej niż próg, alarm idzie
  kanałami autopilota (GibCord, e-mail, telefon), a po powrocie — druga wiadomość z czasem przerwy.
- **Przenoszenie stron** — kreator w 4 krokach: serwer docelowy, co przenieść (pliki, baza z kontami i hasłami,
  ustawienia PHP), przeniesienie, przełączenie adresu (sam w OVH albo z instrukcją), certyfikat na nowym serwerze
  i wyłączenie starej kopii; usunięcie jej jednym kliknięciem (panel przypomina po 7 dniach).

## 1.5.1 — 19.11.2026

- **Porządek w ikonach**: cały panel na jednym zestawie (Lucide, kreska 1,75) — każda pozycja menu ma inną ikonę
  (Harmonogram i Dziennik zmian, Usługi i Wszystkie serwery nie są już takie same), dwa rozmiary (18 w menu,
  16 w przyciskach), ikony pasują do znaczenia („Sprawdź” ≠ „Uruchom ponownie”, „Wyślij do chmury”, „Zapisz wersję”).
- Znaki ✓ ✗ ⚠ w komunikatach i emoji 🔑 w tabelach zamienione na ikony; w kreatorze „Utwórz” ikony zamiast liter.
- Nowa ikona aplikacji i karty przeglądarki w tym samym stylu.

## 1.5.0 — 19.11.2026

Pierwsze wydanie publiczne.

- **Instalator jednym poleceniem** (`instaluj.sh`) i kreator pierwszego uruchomienia w przeglądarce: konto z 2FA,
  adres panelu z certyfikatem Let's Encrypt, wybór modułów.
- **Polecenie `panel-serwera`**: status, link, aktualizuj, logi, reset-logowania, odinstaluj.
- **Aktualizacje z GitHuba** — sprawdzanie nowej wersji i instalacja przyciskiem w Ustawieniach panelu.
- **Grupa serwerów** — łączenie paneli jednorazowym kodem, przełącznik serwerów w menu, strona „Wszystkie serwery”
  ze stanem każdego serwera, zarządzanie zdalne z prawami administratora albo podglądu, odbieranie dostępu.
- **Ustawienia panelu** — nazwa, domena, moduły (wyłączony terminal i SFTP są blokowane także po stronie serwera),
  serwer w domu, panel gier, GibCord, poczta SMTP.
- Ustawienia konkretnego serwera przeniesione z kodu do `konfiguracja.json`.
- Ogólny skrypt nocnych kopii (`skrypty/panel-kopia.sh`): MariaDB, PostgreSQL, MongoDB, SQLite, kod, konfiguracja,
  aplikacje, migawki mediów.

## 1.4.0

Bazy danych (MariaDB, PostgreSQL, MongoDB, Redis, SQLite) z kontami, podglądem i kopiami; „Coś nie działa?”
z naprawą; terminal w przeglądarce; aplikacje Node (zmienne, logi, wersje); wydajność z historią; aktualizacje
systemu; harmonogram; alarmy; konta SFTP i klucze SSH; plan awaryjny; dziennik zmian z cofaniem.

## 1.0–1.3

Strony i SSL, kreator stron, kopie zapasowe, autopilot, statystyki, zapora z bezpiecznikiem, strona statusu,
serwery gier, role i zaproszenia, powiadomienia.
