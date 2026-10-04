#!/usr/bin/env bash
# Install, run, back up and check the organization memory engine (Hindsight + PostgreSQL 16).
# See doc/GS-MEMORY-ENGINE.md. G2 change list: GRE-649 section 5.3, approved by John on 4 Oct 2026 (GRE-674).
#
# Commands:
#   system-setup   (root)      user, packages, folders, systemd units. Never enables the engine at boot.
#   install        (gsmemory)  database cluster, pinned venv, models, secrets. Safe to run again.
#   link-claude    (gsmemory)  read a `claude setup-token` token on stdin; engine uses John's Claude plan.
#   backup         (gsmemory)  pg_dump to ~/gs-memory/backups and the Windows copy folder.
#   check          (any user)  bind, key and reachability checks. Exit 1 on any failure.
#   serve-postgres / serve-hindsight  (gsmemory) foreground processes used by the systemd units.
#
# Every path and port can be overridden for a sandbox run (see doc/GS-MEMORY-ENGINE.md, "Sandbox test").
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GS_MEMORY_USER="${GS_MEMORY_USER:-gsmemory}"
GS_MEMORY_HOME="${GS_MEMORY_HOME:-/home/$GS_MEMORY_USER}"
GS_MEMORY_ROOT="${GS_MEMORY_ROOT:-$GS_MEMORY_HOME/gs-memory}"
GS_MEMORY_PG_BIN="${GS_MEMORY_PG_BIN:-/usr/lib/postgresql/16/bin}"
GS_MEMORY_PG_PORT="${GS_MEMORY_PG_PORT:-15432}"
GS_MEMORY_API_PORT="${GS_MEMORY_API_PORT:-18888}"
GS_MEMORY_WINDOWS_BACKUPS="${GS_MEMORY_WINDOWS_BACKUPS:-/mnt/c/GreatstoneBackups/gs-memory}"
GS_MEMORY_BACKUP_KEEP="${GS_MEMORY_BACKUP_KEEP:-14}"
GS_MEMORY_PYTHON="${GS_MEMORY_PYTHON:-python3}"
GS_MEMORY_TORCH_INDEX="${GS_MEMORY_TORCH_INDEX:-https://download.pytorch.org/whl/cpu}"
GS_MEMORY_CLAUDE_MODEL="${GS_MEMORY_CLAUDE_MODEL:-claude-sonnet-5}"

# Ports that belong to live GSAM. The engine must never use them.
FORBIDDEN_PORTS=(3100 3200 54329)

APP="$GS_MEMORY_ROOT/app"
VENV="$APP/venv"
PGDATA="$GS_MEMORY_ROOT/pg/data"
PGRUN="$GS_MEMORY_ROOT/pg/run"
MODELS="$GS_MEMORY_ROOT/models"
SECRETS="$GS_MEMORY_ROOT/secrets"
BACKUPS="$GS_MEMORY_ROOT/backups"
LOGS="$GS_MEMORY_ROOT/logs"

DB_NAME=hindsight
DB_ROLE=hindsight

log() { printf '[gs-memory] %s\n' "$*"; }
die() { printf '[gs-memory] ERROR: %s\n' "$*" >&2; exit 1; }

guard_paths_and_ports() {
  case "$GS_MEMORY_ROOT" in
    */GSAM|*/GSAM/*) die "GS_MEMORY_ROOT must not be under ~/GSAM/ ($GS_MEMORY_ROOT)";;
  esac
  local p
  for p in "${FORBIDDEN_PORTS[@]}"; do
    [[ "$GS_MEMORY_PG_PORT" != "$p" && "$GS_MEMORY_API_PORT" != "$p" ]] || die "port $p belongs to live GSAM"
  done
}

require_user() {
  [[ "$(id -un)" == "$1" ]] || die "run this command as '$1' (now: $(id -un))"
}

new_secret() { "$GS_MEMORY_PYTHON" -c 'import secrets; print(secrets.token_urlsafe(32))'; }

pg() { "$GS_MEMORY_PG_BIN/$1" "${@:2}"; }

# --------------------------------------------------------------------------------------------
# system-setup (root). Items 1, 2, 3 and 6 of the G2 change list.
cmd_system_setup() {
  require_user root
  guard_paths_and_ports

  if ! id "$GS_MEMORY_USER" >/dev/null 2>&1; then
    log "create system user $GS_MEMORY_USER (home $GS_MEMORY_HOME, no login shell)"
    useradd --system --create-home --home-dir "$GS_MEMORY_HOME" --shell /usr/sbin/nologin "$GS_MEMORY_USER"
  fi
  chmod 0700 "$GS_MEMORY_HOME"

  if [[ ! -x "$GS_MEMORY_PG_BIN/postgres" ]] || ! dpkg -s postgresql-16-pgvector >/dev/null 2>&1; then
    log "install postgresql-16 and postgresql-16-pgvector"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-16 postgresql-16-pgvector python3-venv
  fi
  # The package creates a default cluster on 5432. Only our cluster may run.
  if command -v pg_lsclusters >/dev/null && pg_lsclusters -h 2>/dev/null | awk '{print $1" "$2}' | grep -qx '16 main'; then
    log "drop the default postgresql@16-main cluster"
    pg_dropcluster --stop 16 main
  fi
  systemctl disable --now postgresql.service >/dev/null 2>&1 || true

  install -d -o "$GS_MEMORY_USER" -g "$GS_MEMORY_USER" -m 0700 \
    "$GS_MEMORY_ROOT" "$APP" "$GS_MEMORY_ROOT/pg" "$PGRUN" "$MODELS" "$SECRETS" "$BACKUPS" "$LOGS"

  # The engine user cannot read the repo checkout (its parent home is 0750), so it gets its own copy.
  log "copy setup files to $APP/setup"
  rm -rf "$APP/setup"
  install -d -o "$GS_MEMORY_USER" -g "$GS_MEMORY_USER" -m 0700 "$APP/setup"
  cp -r "$SCRIPT_DIR/." "$APP/setup/"
  chown -R "$GS_MEMORY_USER:$GS_MEMORY_USER" "$APP/setup"

  install -d -m 0755 "$GS_MEMORY_WINDOWS_BACKUPS"

  log "install systemd units (not enabled; the engine is started by hand)"
  local unit
  for unit in gs-memory-postgres.service gs-memory-hindsight.service gs-memory-backup.service gs-memory-backup.timer; do
    sed -e "s#@USER@#$GS_MEMORY_USER#g" -e "s#@ROOT@#$GS_MEMORY_ROOT#g" \
      "$SCRIPT_DIR/units/$unit" > "/etc/systemd/system/$unit"
    chmod 0644 "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  # Only the backup timer is enabled. It skips quietly when the database is not running.
  systemctl enable --now gs-memory-backup.timer
  log "system setup done. Next: sudo -u $GS_MEMORY_USER $APP/setup/gs-memory.sh install"
}

# --------------------------------------------------------------------------------------------
# install (gsmemory). Items 4, 5 and 7 of the G2 change list.
cmd_install() {
  guard_paths_and_ports
  umask 077
  mkdir -p "$APP" "$GS_MEMORY_ROOT/pg" "$PGRUN" "$MODELS" "$SECRETS" "$BACKUPS" "$LOGS" "$GS_MEMORY_ROOT/home"
  chmod 0700 "$GS_MEMORY_ROOT" "$PGRUN" "$SECRETS" "$BACKUPS"

  # Secrets: generated once, never printed, never leave this folder except through `gateway-key`.
  if [[ ! -s "$SECRETS/db.env" ]]; then
    printf 'GS_MEMORY_DB_PASSWORD=%s\n' "$(new_secret)" > "$SECRETS/db.env"
  fi
  if [[ ! -s "$SECRETS/engine.env" ]]; then
    printf 'HINDSIGHT_API_TENANT_API_KEY=%s\n' "$(new_secret)" > "$SECRETS/engine.env"
  fi
  chmod 0600 "$SECRETS"/*.env
  # shellcheck disable=SC1091
  source "$SECRETS/db.env"

  install_cluster
  install_venv
  install_models
  write_hindsight_env
  log "install done. Start with: sudo systemctl start gs-memory-hindsight (it starts gs-memory-postgres)"
}

install_cluster() {
  if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
    log "initdb $PGDATA"
    local pwfile
    pwfile="$(mktemp "$SECRETS/.pw.XXXXXX")"
    new_secret > "$pwfile"
    # Superuser = the OS user, peer auth on the private socket only. The engine role is not a superuser.
    pg initdb -D "$PGDATA" -U "$(id -un)" --auth-local=peer --auth-host=reject --pwfile="$pwfile" \
      --encoding=UTF8 --locale=C.UTF-8 >/dev/null
    rm -f "$pwfile"
  fi
  cat > "$PGDATA/postgresql.auto.conf" <<EOF
# Written by scripts/gs-memory/gs-memory.sh. Changes here are overwritten on the next install.
listen_addresses = '127.0.0.1'
port = $GS_MEMORY_PG_PORT
unix_socket_directories = '$PGRUN'
unix_socket_permissions = 0700
shared_buffers = '1GB'
password_encryption = 'scram-sha-256'
log_destination = 'stderr'
logging_collector = off
EOF
  cat > "$PGDATA/pg_hba.conf" <<EOF
# Written by scripts/gs-memory/gs-memory.sh.
# TYPE  DATABASE    USER          ADDRESS        METHOD
local   all         $(id -un)     peer
host    $DB_NAME    $DB_ROLE      127.0.0.1/32   scram-sha-256
host    all         all           0.0.0.0/0      reject
host    all         all           ::/0           reject
EOF

  local started_here=0
  if ! pg pg_isready -q -h "$PGRUN" -p "$GS_MEMORY_PG_PORT"; then
    pg pg_ctl -D "$PGDATA" -l "$LOGS/install-postgres.log" -w start >/dev/null
    started_here=1
  fi
  local psqlc=(pg psql -X -q -v ON_ERROR_STOP=1 -h "$PGRUN" -p "$GS_MEMORY_PG_PORT" -d postgres)
  "${psqlc[@]}" -v pw="$GS_MEMORY_DB_PASSWORD" <<SQL
SELECT format('CREATE ROLE %I LOGIN', '$DB_ROLE') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DB_ROLE')\gexec
ALTER ROLE $DB_ROLE WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
SELECT format('CREATE DATABASE %I OWNER %I', '$DB_NAME', '$DB_ROLE') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$DB_NAME')\gexec
SQL
  pg psql -X -q -v ON_ERROR_STOP=1 -h "$PGRUN" -p "$GS_MEMORY_PG_PORT" -d "$DB_NAME" \
    -c "CREATE EXTENSION IF NOT EXISTS vector" -c "REVOKE ALL ON DATABASE $DB_NAME FROM PUBLIC"
  if [[ "$started_here" == 1 ]]; then
    pg pg_ctl -D "$PGDATA" -w stop >/dev/null
  fi
}

install_venv() {
  local stamp="$VENV/.gs-memory-lock.sha256" want
  want="$(sha256sum "$SCRIPT_DIR/requirements.lock" | cut -d' ' -f1)"
  if [[ -f "$stamp" && "$(cat "$stamp")" == "$want" ]]; then
    log "venv already matches requirements.lock"
    return
  fi
  log "build venv from requirements.lock (hashes required, wheels only)"
  rm -rf "$VENV.new"
  "$GS_MEMORY_PYTHON" -m venv "$VENV.new"
  "$VENV.new/bin/pip" install -q --no-deps --require-hashes --only-binary=:all: \
    --extra-index-url "$GS_MEMORY_TORCH_INDEX" -r "$SCRIPT_DIR/requirements.lock"
  echo "$want" > "$VENV.new/.gs-memory-lock.sha256"
  rm -rf "$VENV"
  mv "$VENV.new" "$VENV"
  # venv scripts hold the build path in their shebang; rewrite it after the move.
  grep -rlI "^#!$VENV.new/bin/" "$VENV/bin" | xargs -r sed -i "1s#^\#!$VENV.new/bin/#\#!$VENV/bin/#"
  sed -i "s#$VENV.new#$VENV#g" "$VENV/bin/activate" "$VENV/pyvenv.cfg" 2>/dev/null || true
}

install_models() {
  # The only planned download from Hugging Face. After this the engine runs with HF_HUB_OFFLINE=1.
  log "download local embedding and reranker models to $MODELS"
  HF_HOME="$MODELS" HF_HUB_DISABLE_TELEMETRY=1 "$VENV/bin/python" - <<'PY'
from sentence_transformers import CrossEncoder, SentenceTransformer
SentenceTransformer("BAAI/bge-small-en-v1.5", device="cpu")
CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2", device="cpu")
PY
}

write_hindsight_env() {
  sed -e "s#@ROOT@#$GS_MEMORY_ROOT#g" -e "s#@API_PORT@#$GS_MEMORY_API_PORT#g" \
    -e "s#@PG_PORT@#$GS_MEMORY_PG_PORT#g" -e "s#@DB_NAME@#$DB_NAME#g" -e "s#@DB_ROLE@#$DB_ROLE#g" \
    "$SCRIPT_DIR/hindsight.env" > "$APP/hindsight.env"
  chmod 0600 "$APP/hindsight.env"
}

# --------------------------------------------------------------------------------------------
# link-claude (gsmemory). Reads one token on stdin; never echoes it.
cmd_link_claude() {
  umask 077
  local token
  if [[ -t 0 ]]; then
    read -r -s -p "Paste the token from 'claude setup-token': " token; echo
  else
    read -r token
  fi
  [[ "$token" =~ ^[A-Za-z0-9._-]{20,}$ ]] || die "that does not look like a setup token"
  cat > "$SECRETS/claude.env" <<EOF
# Claude plan link for memory extraction (John's Max plan, internal use only). Never an API key.
HINDSIGHT_API_LLM_PROVIDER=claude-code
HINDSIGHT_API_LLM_MODEL=$GS_MEMORY_CLAUDE_MODEL
CLAUDE_CODE_OAUTH_TOKEN=$token
EOF
  chmod 0600 "$SECRETS/claude.env"
  log "Claude plan linked. Restart the engine: sudo systemctl restart gs-memory-hindsight"
}

cmd_unlink_claude() {
  rm -f "$SECRETS/claude.env"
  log "Claude plan unlinked (engine falls back to provider 'none'). Restart the engine."
}

# --------------------------------------------------------------------------------------------
# serve-* (gsmemory). Foreground processes for systemd, or for a sandbox run.
cmd_serve_postgres() {
  guard_paths_and_ports
  exec "$GS_MEMORY_PG_BIN/postgres" -D "$PGDATA"
}

cmd_serve_hindsight() {
  guard_paths_and_ports
  set -a
  # shellcheck disable=SC1090,SC1091
  source "$APP/hindsight.env"
  source "$SECRETS/db.env"
  source "$SECRETS/engine.env"
  [[ -f "$SECRETS/claude.env" ]] && source "$SECRETS/claude.env"
  set +a
  # Never let a paid API key reach the engine or the Claude CLI it spawns.
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY HINDSIGHT_API_LLM_API_KEY
  export HINDSIGHT_API_DATABASE_URL="postgresql://$DB_ROLE:$GS_MEMORY_DB_PASSWORD@127.0.0.1:$GS_MEMORY_PG_PORT/$DB_NAME"
  unset GS_MEMORY_DB_PASSWORD
  exec "$VENV/bin/hindsight-api"
}

# --------------------------------------------------------------------------------------------
# backup (gsmemory). Nightly local dump. The off-disk copy waits for John's choice (GRE-674).
cmd_backup() {
  umask 077
  if ! pg pg_isready -q -h "$PGRUN" -p "$GS_MEMORY_PG_PORT"; then
    log "database not running; no backup tonight"
    return 0
  fi
  local stamp file
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$BACKUPS/hindsight-$stamp.dump"
  pg pg_dump -h "$PGRUN" -p "$GS_MEMORY_PG_PORT" -d "$DB_NAME" -Fc -f "$file.part"
  mv "$file.part" "$file"
  sha256sum "$file" | sed "s#$BACKUPS/##" > "$file.sha256"
  log "dump written: $file ($(du -h "$file" | cut -f1))"
  if [[ -d "$GS_MEMORY_WINDOWS_BACKUPS" && -w "$GS_MEMORY_WINDOWS_BACKUPS" ]]; then
    cp "$file" "$file.sha256" "$GS_MEMORY_WINDOWS_BACKUPS/"
    log "copied to $GS_MEMORY_WINDOWS_BACKUPS"
    prune "$GS_MEMORY_WINDOWS_BACKUPS"
  else
    log "WARNING: $GS_MEMORY_WINDOWS_BACKUPS missing or not writable; local copy only"
  fi
  prune "$BACKUPS"
}

prune() {
  local dir="$1" old
  # Newest first; keep the first GS_MEMORY_BACKUP_KEEP dumps.
  mapfile -t old < <(ls -1t "$dir"/hindsight-*.dump 2>/dev/null | tail -n +"$((GS_MEMORY_BACKUP_KEEP + 1))")
  local f
  for f in "${old[@]}"; do rm -f "$f" "$f.sha256"; done
}

# --------------------------------------------------------------------------------------------
# restore-test (gsmemory). Restores the newest dump into a throwaway cluster on a free port, then removes it.
cmd_restore_test() {
  local dump="${1:-$(ls -1t "$BACKUPS"/hindsight-*.dump 2>/dev/null | head -1)}"
  [[ -n "$dump" && -f "$dump" ]] || die "no dump found in $BACKUPS"
  (cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256" >/dev/null) || die "checksum mismatch: $dump"
  local tmp port
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/gs-memory-restore.XXXXXX")"
  port="$("$GS_MEMORY_PYTHON" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
  trap 'pg pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"' RETURN
  pg initdb -D "$tmp/data" -U "$(id -un)" --auth-local=peer --auth-host=reject >/dev/null
  pg pg_ctl -D "$tmp/data" -o "-c listen_addresses='' -c port=$port -c unix_socket_directories=$tmp" -l "$tmp/log" -w start >/dev/null
  pg createdb -h "$tmp" -p "$port" "$DB_NAME"
  pg pg_restore -h "$tmp" -p "$port" -d "$DB_NAME" --no-owner "$dump"
  local tables
  tables="$(pg psql -X -At -h "$tmp" -p "$port" -d "$DB_NAME" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  log "restore test passed: $(basename "$dump") -> $tables tables in a throwaway cluster"
}

# --------------------------------------------------------------------------------------------
# gateway-key (root or gsmemory). Prints the engine key once, for the GSAM server's secret store only.
cmd_gateway_key() {
  [[ -t 1 ]] && die "pipe this into the GSAM secret store; it will not print to a terminal"
  # shellcheck disable=SC1091
  source "$SECRETS/engine.env"
  printf '%s' "$HINDSIGHT_API_TENANT_API_KEY"
}

# --------------------------------------------------------------------------------------------
# check (any user). Proves the G2 isolation lenses. Run it as an agent user to get agent-side evidence.
cmd_check() {
  local fail=0 key="${GS_MEMORY_CHECK_KEY:-}"
  ok() { printf '  PASS  %s\n' "$*"; }
  bad() { printf '  FAIL  %s\n' "$*"; fail=1; }
  echo "gs-memory check as $(id -un) on $(hostname) at $(date -u +%FT%TZ)"

  local listen
  listen="$(ss -Hltn "( sport = :$GS_MEMORY_API_PORT or sport = :$GS_MEMORY_PG_PORT )" | awk '{print $4}' | sort -u)"
  if [[ -z "$listen" ]]; then
    bad "nothing listens on $GS_MEMORY_API_PORT or $GS_MEMORY_PG_PORT (engine not started?)"
  else
    local addr
    while read -r addr; do
      case "$addr" in
        127.0.0.1:*) ok "listens on $addr only (loopback)";;
        *) bad "listens on $addr (not loopback)";;
      esac
    done <<<"$listen"
  fi

  local ip
  for ip in $(ip -o addr show 2>/dev/null | awk '$4 !~ /^127\.|^::1/ {split($4,a,"/"); print a[1]}'); do
    local port
    for port in "$GS_MEMORY_API_PORT" "$GS_MEMORY_PG_PORT"; do
      if timeout 3 bash -c ">/dev/tcp/${ip%%%*}/$port" 2>/dev/null; then
        bad "port $port reachable on $ip"
      else
        ok "port $port refused on $ip"
      fi
    done
  done

  local base="http://127.0.0.1:$GS_MEMORY_API_PORT" code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base/v1/default/banks" || true)"
  [[ "$code" == 401 || "$code" == 403 ]] && ok "engine API without key -> $code" || bad "engine API without key -> $code"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong-key' "$base/v1/default/banks" || true)"
  [[ "$code" == 401 || "$code" == 403 ]] && ok "engine API with a wrong key -> $code" || bad "engine API with a wrong key -> $code"
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base/mcp/" || true)"
  [[ "$code" == 404 || "$code" == 401 || "$code" == 403 || "$code" == 405 ]] && ok "MCP endpoint -> $code" || bad "MCP endpoint -> $code (expected off)"
  if [[ -n "$key" ]]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" "$base/v1/default/banks" || true)"
    [[ "$code" == 200 ]] && ok "engine API with the gateway key -> 200" || bad "engine API with the gateway key -> $code"
  fi

  if [[ "$(id -un)" != "$GS_MEMORY_USER" ]]; then
    if ls "$SECRETS" >/dev/null 2>&1 || ls "$GS_MEMORY_ROOT" >/dev/null 2>&1; then
      bad "$(id -un) can list $GS_MEMORY_ROOT"
    else
      ok "$(id -un) cannot read $GS_MEMORY_ROOT (secrets, data, backups)"
    fi
    if command -v psql >/dev/null || [[ -x "$GS_MEMORY_PG_BIN/psql" ]]; then
      local psql_bin out
      psql_bin="$(command -v psql || echo "$GS_MEMORY_PG_BIN/psql")"
      out="$(PGCONNECT_TIMEOUT=3 PGPASSWORD=guess "$psql_bin" -X -At -h 127.0.0.1 -p "$GS_MEMORY_PG_PORT" -U "$DB_ROLE" -d "$DB_NAME" -c 'select 1' 2>&1 || true)"
      [[ "$out" != 1 ]] && ok "database login without the password refused" || bad "database login without the password worked"
    fi
  fi
  [[ "$fail" == 0 ]] && echo "RESULT: PASS" || echo "RESULT: FAIL"
  return "$fail"
}

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
  system-setup) cmd_system_setup;;
  install) cmd_install;;
  link-claude) cmd_link_claude;;
  unlink-claude) cmd_unlink_claude;;
  serve-postgres) cmd_serve_postgres;;
  serve-hindsight) cmd_serve_hindsight;;
  backup) cmd_backup;;
  restore-test) shift; cmd_restore_test "$@";;
  gateway-key) cmd_gateway_key;;
  check) cmd_check;;
  *) usage; exit 2;;
esac
