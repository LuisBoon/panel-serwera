#!/bin/bash
# Odtworzenie serwera z kopii w chmurze na czystym Debianie 12 (paczka z panelu: Plan awaryjny).
# Użycie: bash odtworz.sh /ścieżka/do/pakietu-odzyskiwania.txt   |   bash odtworz.sh --certyfikaty
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG=/root/odtworz.log
exec > >(tee -a "$LOG") 2>&1
DEST=$(cat "$HERE/katalog-kopii.txt" 2>/dev/null || echo /var/backups/panel-serwera)
krok() { echo; echo "=== $* ==="; }
pytaj() { read -r -p "$1 [t/n] " a; [[ "$a" =~ ^[tTyY] ]]; }
[ "$(id -u)" = 0 ] || { echo "Uruchom jako root."; exit 1; }

if [ "${1:-}" = "--certyfikaty" ]; then
  krok "Certyfikaty https"
  apt-get install -y certbot python3-certbot-apache >/dev/null
  for d in $(grep -v '^#' "$HERE/dns.txt"); do
    ip=$(getent ahostsv4 "$d" | awk 'NR==1{print $1}')
    me=$(curl -fsS https://api.ipify.org || true)
    if [ "$ip" = "$me" ]; then certbot certonly --apache -d "$d" --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring || echo "!! $d: nie udało się"; else echo "-- $d: DNS jeszcze wskazuje na $ip (ten serwer: $me) — pomijam"; fi
  done
  systemctl reload apache2; exit 0
fi

KIT="${1:-}"
[ -f "$KIT" ] || { echo "Podaj ścieżkę do pakietu odzyskiwania (plik z panelu: Kopie → Kopie w chmurze)."; exit 1; }
grep -q '^=====$' "$KIT" && grep -q '^\[' "$KIT" || { echo "To nie wygląda na pakiet odzyskiwania (brak konfiguracji rclone między liniami =====)."; exit 1; }
. /etc/os-release; [ "$VERSION_ID" = "12" ] || pytaj "To nie Debian 12 ($PRETTY_NAME). Kontynuować mimo to?" || exit 1

krok "1/8 Podstawowe programy i rclone"
apt-get update && apt-get install -y curl gnupg ca-certificates rclone rsync sqlite3 unzip zip >/dev/null
mkdir -p /root/.config/rclone
# pakiet odzyskiwania zawiera konfigurację rclone (sekcje [cel] i [szyfr]) — wycinamy ją z pliku
awk '/^=====$/{n++; next} n==1' "$KIT" > /root/.config/rclone/rclone.conf
chmod 600 /root/.config/rclone/rclone.conf
REMOTE=$(grep -m1 '^\[szyfr' /root/.config/rclone/rclone.conf >/dev/null && echo szyfr: || echo cel:)
rclone lsd "$REMOTE" || { echo "Nie mogę odczytać kopii w chmurze — sprawdź pakiet odzyskiwania."; exit 1; }

krok "2/8 Pobieranie najnowszych kopii z chmury do $DEST"
mkdir -p "$DEST"/{bazy,kod,media}
LAST=$(rclone lsf "$REMOTE"kod/ | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}' | sort | tail -1)
echo "Najnowsza kopia: $LAST"
rclone copy "$REMOTE"kod/ "$DEST/kod/" --include "*_${LAST}*" --progress
rclone copy "$REMOTE"bazy/ "$DEST/bazy/" --include "*_${LAST}*" --progress
if rclone lsd "$REMOTE"media/biezace >/dev/null 2>&1 && pytaj "Pobrać też przesłane pliki stron (migawka — może być duża)?"; then rclone copy "$REMOTE"media/biezace "$DEST/media/biezace" --progress; fi

krok "3/8 Źródła pakietów i pakiety systemowe"
tar xzf "$DEST/kod/konfiguracja_${LAST}.tar.gz" -C / etc/apt 2>/dev/null || true
apt-get update
pytaj "Zainstalować pakiety z listy (pakiety.txt, $(wc -l < "$HERE/pakiety.txt") pozycji)?" && xargs -a "$HERE/pakiety.txt" apt-get install -y --ignore-missing || echo "!! część pakietów się nie zainstalowała — sprawdź log"
command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; }

krok "4/8 Konfiguracja serwera"
pytaj "Rozpakować konfigurację (Apache, PHP, usługi, harmonogram, poczta, zapora, certyfikaty)?" || exit 1
tar xzf "$DEST/kod/konfiguracja_${LAST}.tar.gz" -C / --exclude='etc/ssh/ssh_host_*' --exclude='etc/default/grub*'
systemctl daemon-reload

krok "5/8 Kod stron i aplikacje"
tar xzf "$DEST/kod/www_${LAST}.tar.gz" -C /
for f in "$DEST"/kod/*_"${LAST}".tar.gz; do
  case "$(basename "$f")" in www_*|konfiguracja_*) continue;; esac
  echo "-- $(basename "$f")"; tar xzf "$f" -C /
done
if [ -d "$DEST/media/biezace" ]; then for d in "$DEST/media/biezace"/*/; do n=$(basename "$d"); dst="/var/www/${n//_//}"; echo "-- pliki: $dst"; mkdir -p "$dst"; rsync -a "$d" "$dst/"; done; fi
chown -R www-data:www-data /var/www
for d in /opt/*/ /opt/*/server/; do [ -f "$d/package.json" ] && grep -q '"dependencies"' "$d/package.json" && (cd "$d" && npm install --omit=dev --no-audit --no-fund) || true; done

krok "6/8 Bazy danych"
systemctl enable --now mariadb
if [ -f "$DEST/bazy/mysql_${LAST}.sql.gz" ]; then echo "-- konta i hasła MariaDB"; mysql -e "CREATE DATABASE IF NOT EXISTS mysql"; gunzip -c "$DEST/bazy/mysql_${LAST}.sql.gz" | mysql mysql && mysql -e "FLUSH PRIVILEGES"; fi
for f in "$DEST"/bazy/*_"${LAST}".sql.gz; do
  b=$(basename "$f"); db="${b%_${LAST}.sql.gz}"
  case "$db" in mysql|pg-*|sqlite-*|mongo-*) continue;; esac
  echo "-- $db"; mysql -e "CREATE DATABASE IF NOT EXISTS \`$db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" && gunzip -c "$f" | mysql "$db" || echo "!! $db: błąd"
done
for f in "$DEST"/bazy/pg-*_"${LAST}".sql.gz; do [ -f "$f" ] || continue; command -v psql >/dev/null || apt-get install -y postgresql; b=$(basename "$f"); db="${b#pg-}"; db="${db%_${LAST}.sql.gz}"; runuser -u postgres -- createdb "$db" 2>/dev/null; gunzip -c "$f" | runuser -u postgres -- psql -q -d "$db" || echo "!! $db: błąd"; done
for f in "$DEST"/bazy/sqlite-*_"${LAST}".sql.gz; do [ -f "$f" ] || continue; b=$(basename "$f"); n="${b#sqlite-}"; n="${n%_${LAST}.sql.gz}"; mkdir -p /var/lib/bazy-sqlite; gunzip -c "$f" | sqlite3 "/var/lib/bazy-sqlite/$n.sqlite"; chown -R www-data: /var/lib/bazy-sqlite; done
f="$DEST/bazy/mongo-wszystkie_${LAST}.archive.gz"; [ -f "$f" ] && echo "!! Są kopie MongoDB — zainstaluj MongoDB w panelu (Bazy → Silniki), potem: mongorestore --archive=$f --gzip"

krok "7/8 Usługi"
for u in $(cat "$HERE/uslugi.txt"); do systemctl enable "$u" 2>/dev/null; done
systemctl restart apache2 || { echo "!! Apache nie wstał — pewnie brakuje certyfikatów. Strony https ruszą po kroku --certyfikaty."; a2dissite '*-le-ssl' >/dev/null 2>&1; systemctl restart apache2; }
for u in $(cat "$HERE/uslugi.txt"); do systemctl restart "$u" 2>/dev/null && echo "ok   $u" || echo "!!   $u nie wstał"; done
command -v ufw >/dev/null && ufw status | head -1

krok "8/8 Gotowe"
echo "Teraz: w OVH przestaw rekordy A (dns.txt) na $(curl -fsS https://api.ipify.org || echo 'IP tego serwera'),"
echo "a gdy zaczną działać: bash $HERE/odtworz.sh --certyfikaty"
echo "Log: $LOG"
