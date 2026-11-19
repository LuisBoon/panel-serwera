#!/bin/bash
# Instalator panelu serwera — https://github.com/LuisBoon/panel-serwera
#
#   curl -fsSL https://raw.githubusercontent.com/LuisBoon/panel-serwera/main/instaluj.sh | sudo bash
#
# Bez pytań (np. w skrypcie):  ... | sudo PANEL_ADRES=panel.example.pl PANEL_EMAIL=ja@example.pl PANEL_BEZ_PYTAN=1 bash
# Działa na Debianie 12/13 i Ubuntu 22.04/24.04. Można uruchomić ponownie — nic nie psuje, najwyżej doinstaluje braki.
set -euo pipefail

REPO=${PANEL_REPO:-https://github.com/LuisBoon/panel-serwera.git}
DIR=/opt/panel-serwera
DATA=/var/lib/panel-serwera
PORT=${PANEL_PORT:-8099}
IP_PORT=8443
ADRES=${PANEL_ADRES:-}
EMAIL=${PANEL_EMAIL:-}

c_ok=$'\e[32m'; c_b=$'\e[1m'; c_d=$'\e[2m'; c_r=$'\e[31m'; c_0=$'\e[0m'
krok() { echo; echo "${c_b}▸ $*${c_0}"; }
ok() { echo "  ${c_ok}✓${c_0} $*"; }
blad() { echo "${c_r}✗ $*${c_0}" >&2; exit 1; }
pytaj() { # pytaj "Pytanie" domyślna → odpowiedź (z terminala, także przy curl | bash)
  local a=""; if [ "${PANEL_BEZ_PYTAN:-}" != 1 ] && [ -r /dev/tty ]; then read -r -p "  $1 " a </dev/tty || true; fi; echo "${a:-$2}"; }

[ "$(id -u)" = 0 ] || blad "Uruchom jako root (sudo bash)."
. /etc/os-release 2>/dev/null || true
case "${ID:-}" in debian|ubuntu) ;; *) blad "Ten instalator obsługuje Debiana i Ubuntu (masz: ${PRETTY_NAME:-nieznany system})." ;; esac
export DEBIAN_FRONTEND=noninteractive

echo "${c_b}Panel serwera — instalacja${c_0} ${c_d}(${PRETTY_NAME})${c_0}"

krok "Pakiety systemowe"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git apache2 certbot sqlite3 rsync zip unzip python3 cron ufw openssl rclone >/dev/null
ok "apache2, certbot, sqlite3, rsync, rclone, git"

krok "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node -v)"

krok "Kod panelu"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --tags --quiet origin
elif [ -e "$DIR" ]; then
  blad "$DIR już istnieje i nie jest kopią z GitHuba. Przenieś go (mv $DIR $DIR.stary) i uruchom instalator ponownie."
else
  git clone --quiet "$REPO" "$DIR"
fi
TAG=$(git -C "$DIR" tag -l 'v*' --sort=-v:refname | head -1)
if [ -n "$TAG" ]; then git -C "$DIR" -c advice.detachedHead=false checkout --quiet "$TAG"; fi
(cd "$DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
ok "$(node -p "require('$DIR/package.json').version") w $DIR"

krok "Dane i ustawienia"
install -d -m 700 "$DATA"
if [ ! -f "$DATA/konfiguracja.json" ]; then
  NAZWA=$(hostname -s | tr -cd 'A-Za-z0-9._-' | cut -c1-40); [ ${#NAZWA} -ge 2 ] || NAZWA=serwer
  printf '{\n  "nazwa": "%s",\n  "kreator": true\n}\n' "$NAZWA" > "$DATA/konfiguracja.json"
  chmod 600 "$DATA/konfiguracja.json"
  ok "nowe ustawienia ($DATA/konfiguracja.json)"
else ok "ustawienia zostają ($DATA/konfiguracja.json)"; fi

krok "Nocne kopie zapasowe"
if [ ! -f /usr/local/sbin/panel-kopia.sh ]; then
  install -m 755 "$DIR/skrypty/panel-kopia.sh" /usr/local/sbin/panel-kopia.sh
  echo "30 3 * * * root /usr/local/sbin/panel-kopia.sh" > /etc/cron.d/panel-kopia
  ok "codziennie o 3:30 do /var/backups/panel-serwera"
else ok "skrypt kopii już jest — nie zmieniam"; fi

krok "Usługa systemowa"
cat > /etc/systemd/system/panel-serwera.service <<UNIT
[Unit]
Description=Panel serwera (strony, usługi, bazy, kopie)
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.mjs
Environment=NODE_ENV=production PORT=$PORT HOST=127.0.0.1 DATA_DIR=$DATA
# panel zarządza całym serwerem, więc działa jako root — ale słucha tylko lokalnie (127.0.0.1)
User=root
UMask=0077
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
[ -f /etc/systemd/system/panel-serwera.service.d/override.conf ] && ok "(własne zmiany w panel-serwera.service.d zostają)"
ln -sf "$DIR/bin/panel-serwera" /usr/local/bin/panel-serwera
systemctl daemon-reload
systemctl enable -q panel-serwera
systemctl restart panel-serwera
for i in $(seq 1 20); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/stan" -H 'x-panel: 1' 2>/dev/null && break; sleep 0.5; done
systemctl is-active -q panel-serwera || blad "Panel się nie uruchomił: journalctl -u panel-serwera -n 50"
ok "panel-serwera działa (127.0.0.1:$PORT), polecenie: panel-serwera"

krok "Dostęp z przeglądarki"
a2enmod -q proxy proxy_http headers rewrite ssl >/dev/null
# 1) zawsze: https://IP:8443 z certyfikatem własnym — żeby dało się wejść, zanim będzie domena
install -d -m 700 /etc/ssl/panel-serwera
if [ ! -f /etc/ssl/panel-serwera/cert.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=panel-serwera" -keyout /etc/ssl/panel-serwera/key.pem -out /etc/ssl/panel-serwera/cert.pem 2>/dev/null
fi
cat > /etc/apache2/sites-available/panel-serwera-ip.conf <<VH
# Panel serwera pod https://<IP>:$IP_PORT/ (certyfikat własny — przeglądarka ostrzeże, to normalne). Utworzone przez instalator.
Listen $IP_PORT
<VirtualHost *:$IP_PORT>
    SSLEngine on
    SSLCertificateFile /etc/ssl/panel-serwera/cert.pem
    SSLCertificateKeyFile /etc/ssl/panel-serwera/key.pem
    ProxyPass / http://127.0.0.1:$PORT/
    ProxyPassReverse / http://127.0.0.1:$PORT/
    RequestHeader set X-Panel-Base "/"
    ErrorLog \${APACHE_LOG_DIR}/panel_error.log
    CustomLog \${APACHE_LOG_DIR}/panel_access.log combined
</VirtualHost>
VH
a2ensite -q panel-serwera-ip >/dev/null
apache2ctl configtest >/dev/null 2>&1 || blad "Konfiguracja Apache nie przechodzi testu: apache2ctl configtest"
systemctl reload apache2 || systemctl restart apache2
if ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$IP_PORT/tcp" comment 'panel serwera' >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ok "zapora: otwarte 80, 443, $IP_PORT"
fi
IP=$(curl -fsS -4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
ok "https://$IP:$IP_PORT/"

# 2) opcjonalnie: własny adres z certyfikatem Let's Encrypt
CUR=$(node -e "try{process.stdout.write(require('$DATA/konfiguracja.json').adres||'')}catch{}")
if [ -z "$ADRES" ] && [ -z "$CUR" ]; then
  echo "  Możesz od razu ustawić adres panelu (np. panel.twojadomena.pl — rekord A musi wskazywać na $IP)."
  ADRES=$(pytaj "Adres panelu (Enter = pomiń, ustawisz później w przeglądarce):" "")
  [ -n "$ADRES" ] && EMAIL=$(pytaj "E-mail do powiadomień o certyfikacie (Enter = bez):" "")
fi
if [ -n "$ADRES" ]; then
  if (cd "$DIR" && DATA_DIR=$DATA PORT=$PORT node --disable-warning=ExperimentalWarning bin/adres.mjs "$ADRES" "$EMAIL" | sed 's/^/  /'); then CUR=$ADRES
  else echo "  Adres ustawisz później w panelu: Ustawienia panelu → Adres panelu."; fi
fi

CODE=$(cat "$DATA/kod-konfiguracji.txt" 2>/dev/null || true)
echo
echo "${c_b}${c_ok}Gotowe!${c_0}"
if [ -n "$CODE" ]; then
  echo "Otwórz w przeglądarce i załóż konto (potrzebna aplikacja z kodami, np. Google Authenticator):"
  [ -n "$CUR" ] && echo "  ${c_b}https://$CUR/#setup=$CODE${c_0}"
  echo "  ${c_b}https://$IP:$IP_PORT/#setup=$CODE${c_0}  ${c_d}(certyfikat własny — kliknij „Zaawansowane → Przejdź”)${c_0}"
else
  echo "Panel był już skonfigurowany: ${c_b}https://${CUR:-$IP:$IP_PORT}/${c_0}"
fi
echo "${c_d}Polecenia: panel-serwera status | link | aktualizuj | logi | odinstaluj${c_0}"
