#!/bin/bash
# Odinstalowanie panelu serwera. Strony, bazy, konta SFTP i kopie zapasowe ZOSTAJĄ.
#   panel-serwera odinstaluj              — usuwa panel, ustawienia przenosi do /var/lib/panel-serwera.odinstalowany-DATA
#   panel-serwera odinstaluj --wszystko   — dodatkowo usuwa ustawienia panelu, nocne kopie (skrypt i harmonogram, nie same kopie)
set -uo pipefail
DIR=/opt/panel-serwera
DATA=/var/lib/panel-serwera
ALL=0; [ "${1:-}" = "--wszystko" ] && ALL=1
[ "$(id -u)" = 0 ] || { echo "Uruchom jako root."; exit 1; }
ADRES=$(node -e "try{process.stdout.write(require('$DATA/konfiguracja.json').adres||'')}catch{}" 2>/dev/null)

echo "Odinstaluję panel serwera."
echo "  Zostają: strony (/var/www), bazy danych, konta SFTP, kopie w /var/backups$([ $ALL = 0 ] && echo ', nocne kopie (dalej działają)')."
[ $ALL = 1 ] && echo "  Usunę też: ustawienia i historię panelu ($DATA), skrypt i harmonogram nocnych kopii."
read -r -p "Kontynuować? [t/N] " a </dev/tty; [[ "$a" =~ ^[tT] ]] || { echo "Anulowano."; exit 1; }

systemctl disable --now panel-serwera 2>/dev/null
rm -f /etc/systemd/system/panel-serwera.service; rm -rf /etc/systemd/system/panel-serwera.service.d
systemctl daemon-reload
# strony Apache panelu (adres i https://IP:8443)
for s in panel-serwera-ip ${ADRES:+$ADRES $ADRES-le-ssl}; do
  [ -f "/etc/apache2/sites-available/$s.conf" ] && grep -q "Panel serwera" "/etc/apache2/sites-available/$s.conf" && { a2dissite -q "$s" >/dev/null 2>&1; rm -f "/etc/apache2/sites-available/$s.conf"; }
done
apache2ctl configtest >/dev/null 2>&1 && systemctl reload apache2
rm -f /etc/cron.d/panel-serwera /usr/local/sbin/panel-harmonogram /usr/local/bin/panel-serwera
if [ $ALL = 1 ]; then
  rm -f /etc/cron.d/panel-kopia /usr/local/sbin/panel-kopia.sh
  rm -rf "$DATA" /etc/ssl/panel-serwera
else
  [ -d "$DATA" ] && mv "$DATA" "$DATA.odinstalowany-$(date +%Y%m%d-%H%M)"
fi
rm -rf "$DIR"
echo "✓ Panel odinstalowany.$([ $ALL = 0 ] && echo " Ustawienia: $DATA.odinstalowany-* (przy ponownej instalacji przenieś je z powrotem do $DATA).")"
