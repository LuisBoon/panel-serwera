#!/bin/bash
#
# Nocna kopia zapasowa serwera — instalowana przez panel serwera (github.com/LuisBoon/panel-serwera).
#
# Co robi:
#   1. Zrzuca bazy MariaDB/MySQL, PostgreSQL, MongoDB i SQLite (gzip)     -> rotacja KEEP_DB dni
#   2. Pakuje kod stron (/var/www), konfigurację serwera i aplikacje      -> rotacja KEEP_CODE dni
#   3. Robi migawki katalogów z mediami na twardych linkach              -> KEEP_MEDIA migawek
#
# Kopia leży na tym samym dysku — przed awarią dysku chroni dopiero kopia w chmurze (panel: Kopie → W chmurze).
# Liczby niżej zmienia panel (Kopie zapasowe → Ustawienia). Ręcznie: panel-kopia.sh   Log: /var/log/panel-kopia.log

set -uo pipefail

DEST=/var/backups/panel-serwera
LOG=/var/log/panel-kopia.log
PANEL_DATA=/var/lib/panel-serwera
STAMP=$(date +%Y-%m-%d_%H%M)
TODAY=$(date +%Y-%m-%d)

KEEP_DB=14        # ile dni trzymać zrzuty baz
KEEP_CODE=14      # ile dni trzymać archiwa kodu
KEEP_MEDIA=3      # ile migawek mediów
MIN_FREE_MB=2048  # poniżej tego progu kopia się nie wykona

# Katalogi z mediami (duże, rzadko zmieniane pliki) — migawka na twardych linkach zamiast kopii.
# Wpisz po jednym w linii, np.:
#     /var/www/sklep/uploads
MEDIA_DIRS=(
)

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
fail() { log "BLAD: $*"; exit 1; }

mkdir -p "$DEST"/{bazy,kod,media} || fail "nie moge utworzyc $DEST"
chmod 700 "$DEST"
log "=== start backupu ==="

FREE_MB=$(df -Pm / | awk 'NR==2 {print $4}')
[ "$FREE_MB" -lt "$MIN_FREE_MB" ] && fail "za malo miejsca na dysku (${FREE_MB} MB, wymagane min. ${MIN_FREE_MB} MB)"
log "wolne miejsce: ${FREE_MB} MB"

# --- 1. bazy danych --------------------------------------------------------
if command -v mysqldump >/dev/null 2>&1 && mysql -N -B -e "SELECT 1" >/dev/null 2>&1; then
    for db in $(mysql -N -B -e "SHOW DATABASES;" | grep -Ev '^(information_schema|performance_schema|sys)$'); do
        out="$DEST/bazy/${db}_${STAMP}.sql.gz"
        tables=$(mysql -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$db';" 2>/dev/null); tables=${tables:-0}
        if mysqldump --single-transaction --quick --routines --events --default-character-set=utf8mb4 "$db" 2>>"$LOG" | gzip -9 > "$out"; then
            size=$(stat -c%s "$out")
            if [ "$tables" -gt 0 ] && [ "$size" -lt 1024 ]; then log "OSTRZEZENIE: baza $db ma $tables tabel, ale zrzut ma tylko ${size} B"
            else log "baza $db -> $(du -h "$out" | cut -f1) ($tables tabel)"; fi
        else log "BLAD: nie udalo sie zrzucic bazy $db"; rm -f "$out"; fi
    done
fi
if command -v pg_dump >/dev/null 2>&1 && systemctl is-active -q postgresql 2>/dev/null; then
    for db in $(runuser -u postgres -- psql -At -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'" 2>/dev/null); do
        out="$DEST/bazy/pg-${db}_${STAMP}.sql.gz"
        if runuser -u postgres -- pg_dump --clean --if-exists "$db" 2>>"$LOG" | gzip -9 > "$out"; then log "baza PostgreSQL $db -> $(du -h "$out" | cut -f1)"
        else log "BLAD: nie udalo sie zrzucic bazy PostgreSQL $db"; rm -f "$out"; fi
    done
fi
if command -v mongodump >/dev/null 2>&1 && [ -f "$PANEL_DATA/mongo-kopie.yml" ] && systemctl is-active -q mongod 2>/dev/null; then
    out="$DEST/bazy/mongo-wszystkie_${STAMP}.archive.gz"
    if mongodump --config="$PANEL_DATA/mongo-kopie.yml" --archive --gzip --quiet > "$out" 2>>"$LOG"; then log "bazy MongoDB -> $(du -h "$out" | cut -f1)"
    else log "BLAD: nie udalo sie zrzucic baz MongoDB"; rm -f "$out"; fi
fi
if [ -d /var/lib/bazy-sqlite ]; then
    for f in /var/lib/bazy-sqlite/*.sqlite; do
        [ -f "$f" ] || continue
        n=$(basename "$f" .sqlite); out="$DEST/bazy/sqlite-${n}_${STAMP}.sql.gz"
        if sqlite3 "$f" .dump 2>>"$LOG" | gzip -9 > "$out"; then log "baza SQLite $n -> $(du -h "$out" | cut -f1)"; else log "BLAD: nie udalo sie zrzucic bazy SQLite $n"; rm -f "$out"; fi
    done
fi

# --- 2. kod stron, konfiguracja, aplikacje --------------------------------
if [ -d /var/www ]; then
    out="$DEST/kod/www_${STAMP}.tar.gz"
    tar czf "$out" --exclude='*/uploads' --exclude='*/node_modules' --exclude='*/cache/*' --exclude='*/storage/logs/*' -C / var/www 2>/dev/null
    [ -s "$out" ] && log "kod stron -> $(du -h "$out" | cut -f1)" || log "BLAD: archiwum kodu puste"
fi
out="$DEST/kod/konfiguracja_${STAMP}.tar.gz"
CONF_PATHS=()
for p in etc/apache2 etc/nginx etc/php etc/fail2ban etc/logrotate.d etc/mysql etc/letsencrypt \
         etc/systemd/system etc/cron.d etc/redis etc/ssh etc/ufw etc/default \
         etc/apt/sources.list etc/apt/sources.list.d etc/apt/keyrings \
         etc/postgresql etc/mongod.conf usr/local/sbin root/.ssh/authorized_keys var/lib/panel-serwera/konfiguracja.json; do
    [ -e "/$p" ] && CONF_PATHS+=("$p")
done
tar czf "$out" -C / "${CONF_PATHS[@]}" 2>/dev/null
[ -s "$out" ] && log "konfiguracja -> $(du -h "$out" | cut -f1)" || log "OSTRZEZENIE: archiwum konfiguracji puste"

# Aplikacje Node.js założone w panelu i katalogi danych spoza /var/www — lista: nazwa kod [dane]
backup_app() {
    local name="$1" src="$2" data="${3:-}"
    [ -d "/$src" ] || return 0
    local out="$DEST/kod/${name}_${STAMP}.tar.gz"
    tar czf "$out" -C / --exclude='*/node_modules' "$src" $([ -n "$data" ] && [ -d "/$data" ] && echo "$data") 2>/dev/null
    [ -s "$out" ] && log "$name (kod + dane) -> $(du -h "$out" | cut -f1)" || log "OSTRZEZENIE: archiwum $name puste"
}
if [ -f "$PANEL_DATA/kopie-aplikacji.txt" ]; then
    while read -r name src data; do
        [ -z "$name" ] && continue; [[ "$name" == \#* ]] && continue
        backup_app "$name" "$src" "$data"
    done < "$PANEL_DATA/kopie-aplikacji.txt"
fi

# --- 3. migawki mediów (twarde linki) -------------------------------------
SNAP="$DEST/media/$TODAY"
PREV=$(find "$DEST/media" -maxdepth 1 -mindepth 1 -type d ! -name "$TODAY" | sort | tail -1)
for src in "${MEDIA_DIRS[@]}"; do
    [ -d "$src" ] || continue
    name=$(echo "${src#/var/www/}" | tr '/' '_'); target="$SNAP/$name"; mkdir -p "$target"
    link_args=(--link-dest="$src"); [ -n "$PREV" ] && [ -d "$PREV/$name" ] && link_args+=(--link-dest="$PREV/$name")
    if rsync -a --delete "${link_args[@]}" "$src/" "$target/" 2>>"$LOG"; then log "media $name -> $(find "$target" -type f | wc -l) plikow (twarde linki)"
    else log "BLAD: rsync nie powiodl sie dla $src"; fi
done

# --- 4. rotacja ------------------------------------------------------------
find "$DEST/bazy" \( -name "*.sql.gz" -o -name "*.archive.gz" \) -mtime +$KEEP_DB -delete 2>/dev/null
find "$DEST/kod" -name "*.tar.gz" -mtime +$KEEP_CODE -delete 2>/dev/null
mapfile -t SNAPS < <(find "$DEST/media" -maxdepth 1 -mindepth 1 -type d | sort -r)
if [ "${#SNAPS[@]}" -gt "$KEEP_MEDIA" ]; then
    for old in "${SNAPS[@]:$KEEP_MEDIA}"; do rm -rf "$old" && log "usunieto stara migawke: $(basename "$old")"; done
fi

log "rozmiar backupu: $(du -sh "$DEST" | cut -f1) | wolne na dysku: $(df -Pm / | awk 'NR==2 {print $4}') MB"
log "=== koniec backupu ==="
exit 0
