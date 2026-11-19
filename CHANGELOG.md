# Zmiany

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
