# Panel serwera

Panel do zarządzania serwerem Linux **po polsku** — dla osób, które chcą prowadzić własny serwer ze stronami,
bazami i aplikacjami bez ciągłego siedzenia w konsoli. Działa w przeglądarce i na telefonie.

- **Strony i SSL** — kreator stron (pusta, PHP z bazą, WordPress, z pliku ZIP, aplikacja Node, przekierowanie), certyfikaty Let's Encrypt,
  pliki z edytorem i wersjami, wdrożenia z GitHuba, hasło na stronę, przerwa techniczna, ustawienia PHP.
- **Bazy danych** — MariaDB, PostgreSQL, MongoDB, Redis i SQLite: zakładanie, konta, podgląd tabel, zapytania,
  kopie, przywracanie, klonowanie, instalacja silnika jednym kliknięciem.
- **Kopie zapasowe** — nocne kopie (bazy, kod, konfiguracja, migawki mediów), przywracanie, kopie w chmurze (rclone),
  **plan awaryjny** — paczka, z której stawia się serwer od zera.
- **Autopilot** — sam podnosi usługi, które padły, pilnuje dysku, kopii, certyfikatów i aktualizacji; raporty i alarmy
  na e-mail, push albo komunikator GibCord.
- **„Coś nie działa?”** — diagnoza typowych problemów z przyciskiem „Napraw”.
- **Serwer** — usługi, wydajność z historią, aktualizacje systemu, harmonogram zadań, logi, dysk i sprzątanie,
  zapora ufw z bezpiecznikiem, terminal w przeglądarce, konta SFTP i klucze SSH.
- **Grupa serwerów** — kilka serwerów z panelem łączysz kodem i zarządzasz wszystkimi z jednego miejsca.
- **Bezpieczeństwo** — logowanie z kodem z aplikacji (2FA), role (właściciel, administrator, podgląd, dostęp do
  wybranych stron), dziennik zmian z cofaniem, blokada po nieudanych logowaniach.

## Instalacja

Na czystym (albo już używanym) serwerze z **Debianem 12/13** lub **Ubuntu 22.04/24.04**, jako root:

```bash
curl -fsSL https://raw.githubusercontent.com/LuisBoon/panel-serwera/main/instaluj.sh | sudo bash
```

Instalator doinstaluje brakujące pakiety (Apache, certbot, Node.js 22, sqlite3, rsync, rclone), pobierze panel do
`/opt/panel-serwera`, uruchomi go jako usługę i na końcu wypisze link w rodzaju:

```
https://panel.twojadomena.pl/#setup=AB12CD34
https://203.0.113.7:8443/#setup=AB12CD34   (certyfikat własny — przeglądarka ostrzeże, to normalne)
```

Otwórz link, załóż konto (hasło + kod z aplikacji, np. Google Authenticator), a kreator poprowadzi przez adres
panelu z certyfikatem i wybór modułów. Wszystko da się potem zmienić w **Narzędzia → Ustawienia panelu**.

Instalacja bez pytań:

```bash
curl -fsSL https://raw.githubusercontent.com/LuisBoon/panel-serwera/main/instaluj.sh \
  | sudo PANEL_ADRES=panel.twojadomena.pl PANEL_EMAIL=ty@twojadomena.pl PANEL_BEZ_PYTAN=1 bash
```

Rekord A domeny panelu musi już wskazywać na serwer — inaczej adres ustawisz później w przeglądarce.

## Polecenie `panel-serwera`

| Polecenie | Co robi |
|---|---|
| `panel-serwera status` | czy panel działa, wersja i adres |
| `panel-serwera link` | link do pierwszej konfiguracji (jeśli konto nie jest jeszcze założone) |
| `panel-serwera aktualizuj` | instaluje najnowszą wersję z GitHuba (to samo robi przycisk w Ustawieniach panelu) |
| `panel-serwera logi [N]` | ostatnie wpisy z dziennika usługi |
| `panel-serwera reset-logowania` | zgubiony telefon albo hasło — usuwa konta panelu, strony i ustawienia zostają |
| `panel-serwera odinstaluj` | usuwa panel; strony, bazy i kopie zostają (`--wszystko` usuwa też ustawienia panelu) |

## Grupa serwerów

1. Zainstaluj panel na każdym serwerze.
2. Na serwerze, którym chcesz zarządzać: **Wszystkie serwery → Pozwól innemu panelowi zarządzać → Utwórz kod**
   (do wyboru: zarządzanie albo tylko podgląd).
3. Na serwerze „głównym”: **Wszystkie serwery → Połącz serwer** — adres tamtego panelu i kod.

Potem przełączasz serwery z menu w lewym górnym rogu, a strona „Wszystkie serwery” pokazuje stan wszystkich naraz.
Połączony panel dostaje token z prawami administratora albo podglądu — nigdy właściciela, więc konta, terminal
i klucze SSH zostają dostępne tylko lokalnie. Dostęp można odebrać jednym kliknięciem po każdej stronie.
Panele w internecie łączą się tylko przez https (http działa wyłącznie w sieci lokalnej i Tailscale).

## Jak to działa

- Node.js 22, bez frameworków: `node:http`, `node:sqlite`, interfejs w czystym JavaScripcie (`public/`).
- Panel słucha tylko na `127.0.0.1:8099`; z zewnątrz jest dostępny przez Apache (vhost panelu z certyfikatem
  oraz `https://IP:8443` z certyfikatem własnym).
- Działa jako root, bo zarządza całym serwerem — dlatego logowanie zawsze wymaga kodu z aplikacji (2FA).
- Dane panelu: `/var/lib/panel-serwera` (`panel.sqlite`, `konfiguracja.json`, historia, wersje plików).
- Kopie: skrypt `/usr/local/sbin/panel-kopia.sh` uruchamiany z `/etc/cron.d/panel-kopia`, kopie w
  `/var/backups/panel-serwera`.

### `konfiguracja.json`

Wszystko, czym jeden serwer różni się od drugiego, jest w `/var/lib/panel-serwera/konfiguracja.json` — kod panelu
nie zawiera nazw ani adresów konkretnego serwera. Większość pól zmienia się w Ustawieniach panelu; rzadziej
używane (własne aplikacje, dodatkowe usługi w zaporze, katalogi danych do kopii) można dopisać ręcznie:

```json
{
  "nazwa": "mojserwer",
  "adres": "panel.mojserwer.pl",
  "domena": "mojserwer.pl",
  "moduly": { "gry": true, "status": true },
  "aplikacje": { "moja-aplikacja": ["Moja aplikacja", "sklep w Node", "app"] },
  "zapora": { "uslugi": { "turn": { "name": "TURN (rozmowy)", "specs": ["3478", "49160:49200/udp"] } } }
}
```

Pełna lista pól z opisami: [`lib/config.mjs`](lib/config.mjs). Plik jest czytany na bieżąco — nie trzeba restartu.

## Rozwój

```bash
git clone https://github.com/LuisBoon/panel-serwera && cd panel-serwera
npm install
DATA_DIR=$PWD/dane PORT=8199 COOKIE_SECURE=0 AUTOPILOT=0 npm start   # kopia testowa: http://127.0.0.1:8199/
npm run check                                                          # test składni wszystkich plików
```

Kopia z `AUTOPILOT=0` nie uruchamia autopilota i nie zmienia zapory serwera. Zgłoszenia i pomysły: zakładka *Issues*.

## Licencja

MIT — zobacz [LICENSE](LICENSE).
