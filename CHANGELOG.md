# Zmiany

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
