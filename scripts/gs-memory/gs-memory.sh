#!/usr/bin/env bash
# Install, run, back up and check the organization memory engine (Hindsight + PostgreSQL 16).
# See doc/GS-MEMORY-ENGINE.md. G2 change list: GRE-649 section 5.3, approved by John on 4 Oct 2026 (GRE-674).
#
# Commands:
#   preflight      (any user)  read-only checks before system-setup. PASS/FAIL per line, exit 1 on any FAIL.
#   system-setup   (root)      user, packages, folders, systemd units. Never enables the engine at boot.
#                              Stops with an error if a PostgreSQL cluster exists or postgresql.service is active.
#                              --allow-disable-default-postgres: stop and disable postgresql.service, then go on.
#                              No cluster is ever dropped.
#   install        (gsmemory)  database cluster, pinned venv, models, extension, secrets. Safe to run again.
#   link-gateway   (root)      copy the key and assertion secret to the GSAM user's ~/gs-memory/secrets/gateway.env.
#   link-claude    (gsmemory)  read a `claude setup-token` token on stdin; engine uses John's Claude plan.
#   backup         (gsmemory)  pg_dump to ~/gs-memory/backups and the Windows copy folder. Exit 1 if the copy fails.
#   check          (any user)  bind, key and reachability checks. Exit 1 on any failure.
#   serve-postgres / serve-hindsight  (gsmemory) foreground processes used by the systemd units.
#
# Every path and port can be overridden for a sandbox run (see doc/GS-MEMORY-ENGINE.md, "Sandbox test").
set -euo pipefail

# Fixed locale. A sudo or ssh session passes the caller's locale (a Mac sends LC_CTYPE=UTF-8, which
# does not exist on Ubuntu), and initdb then stops with "invalid locale settings". C.UTF-8 is always there.
export LANG=C.UTF-8 LC_ALL=C.UTF-8
unset LANGUAGE LC_CTYPE LC_MESSAGES LC_COLLATE LC_NUMERIC LC_TIME LC_MONETARY

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GS_MEMORY_USER="${GS_MEMORY_USER:-gsmemory}"
GS_MEMORY_HOME="${GS_MEMORY_HOME:-/home/$GS_MEMORY_USER}"
GS_MEMORY_ROOT="${GS_MEMORY_ROOT:-$GS_MEMORY_HOME/gs-memory}"
GS_MEMORY_PG_BIN="${GS_MEMORY_PG_BIN:-/usr/lib/postgresql/16/bin}"
GS_MEMORY_PG_PORT="${GS_MEMORY_PG_PORT:-15432}"
GS_MEMORY_API_PORT="${GS_MEMORY_API_PORT:-18888}"
GS_MEMORY_WINDOWS_BACKUPS="${GS_MEMORY_WINDOWS_BACKUPS:-/mnt/c/GreatstoneBackups/gs-memory}"
GS_MEMORY_BACKUP_KEEP="${GS_MEMORY_BACKUP_KEEP:-14}"
# Deleted memory must leave every backup within 90 days (G1 decision 7, GRE-887). A dump older than
# this is removed whatever GS_MEMORY_BACKUP_KEEP says. It can be set lower, never higher.
GS_MEMORY_BACKUP_MAX_AGE_DAYS="${GS_MEMORY_BACKUP_MAX_AGE_DAYS:-90}"
(( GS_MEMORY_BACKUP_MAX_AGE_DAYS > 0 && GS_MEMORY_BACKUP_MAX_AGE_DAYS <= 90 )) 2>/dev/null || GS_MEMORY_BACKUP_MAX_AGE_DAYS=90
GS_MEMORY_PYTHON="${GS_MEMORY_PYTHON:-python3}"
GS_MEMORY_TORCH_INDEX="${GS_MEMORY_TORCH_INDEX:-https://download.pytorch.org/whl/cpu}"
GS_MEMORY_CLAUDE_MODEL="${GS_MEMORY_CLAUDE_MODEL:-claude-sonnet-5}"
GS_MEMORY_SYSTEMD_DIR="${GS_MEMORY_SYSTEMD_DIR:-/etc/systemd/system}"
# The user the GSAM server runs as, and where it reads the engine secrets (server/src/services/memory-gateway/hindsight.ts).
GS_MEMORY_GSAM_USER="${GS_MEMORY_GSAM_USER:-${SUDO_USER:-$(id -un)}}"
GS_MEMORY_GATEWAY_ENV="${GS_MEMORY_GATEWAY_ENV:-$(getent passwd "$GS_MEMORY_GSAM_USER" | cut -d: -f6)/gs-memory/secrets/gateway.env}"

# Ports that belong to live GSAM. The engine must never use them.
FORBIDDEN_PORTS=(3100 3200 54329)

APP="$GS_MEMORY_ROOT/app"
VENV="$APP/venv"
EXTENSION="$APP/extension"
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
  case "$GS_MEMORY_GATEWAY_ENV" in
    */GSAM/*) die "GS_MEMORY_GATEWAY_ENV must not be under ~/GSAM/ ($GS_MEMORY_GATEWAY_ENV)";;
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
  local allow_disable=0 arg
  for arg in "$@"; do
    case "$arg" in
      --allow-disable-default-postgres) allow_disable=1;;
      *) die "unknown option for system-setup: $arg";;
    esac
  done
  require_user root
  guard_paths_and_ports
  # Before any change: an existing PostgreSQL on this PC stops the run unless John opts in.
  guard_existing_postgres "$allow_disable"

  if ! id "$GS_MEMORY_USER" >/dev/null 2>&1; then
    log "create system user $GS_MEMORY_USER (home $GS_MEMORY_HOME, no login shell)"
    useradd --system --create-home --home-dir "$GS_MEMORY_HOME" --shell /usr/sbin/nologin "$GS_MEMORY_USER"
  fi
  chmod 0700 "$GS_MEMORY_HOME"

  if [[ ! -x "$GS_MEMORY_PG_BIN/postgres" ]] || ! dpkg -s postgresql-16-pgvector >/dev/null 2>&1; then
    install_postgres_packages
  fi
  # The package enables the postgresql.service umbrella. The guard above proved it runs no cluster of ours
  # to keep (none exist, or John opted in), so turn it off again. Clusters are never dropped.
  systemctl disable --now postgresql.service >/dev/null 2>&1 || true

  install -d -o "$GS_MEMORY_USER" -g "$GS_MEMORY_USER" -m 0700 \
    "$GS_MEMORY_ROOT" "$APP" "$GS_MEMORY_ROOT/pg" "$PGRUN" "$MODELS" "$SECRETS" "$BACKUPS" "$LOGS"

  # The engine user cannot read the repo checkout (its parent home is 0750), so it gets its own copy.
  log "copy setup files to $APP/setup"
  rm -rf "$APP/setup"
  install -d -o "$GS_MEMORY_USER" -g "$GS_MEMORY_USER" -m 0700 "$APP/setup"
  cp -r "$SCRIPT_DIR/." "$APP/setup/"
  chown -R "$GS_MEMORY_USER:$GS_MEMORY_USER" "$APP/setup"

  # The nightly dump runs as the engine user, so it must be able to write here. With the WSL `metadata`
  # mount option the owner change works; without it /mnt/c ignores it and shows every folder as 0777.
  # Either way, prove it with a real write as that user.
  install -d -m 0700 -o "$GS_MEMORY_USER" -g "$GS_MEMORY_USER" "$GS_MEMORY_WINDOWS_BACKUPS" 2>/dev/null \
    || install -d -m 0755 "$GS_MEMORY_WINDOWS_BACKUPS"
  can_write_as "$GS_MEMORY_USER" "$GS_MEMORY_WINDOWS_BACKUPS" \
    || die "$GS_MEMORY_USER cannot write $GS_MEMORY_WINDOWS_BACKUPS, so nightly backups would fail. See doc/GS-MEMORY-ENGINE.md, \"Windows copy folder\"."
  log "Windows copy folder is writable by $GS_MEMORY_USER: $GS_MEMORY_WINDOWS_BACKUPS"

  log "install systemd units (not enabled; the engine is started by hand)"
  local unit
  for unit in gs-memory-postgres.service gs-memory-hindsight.service gs-memory-backup.service gs-memory-backup.timer; do
    sed -e "s#@USER@#$GS_MEMORY_USER#g" -e "s#@ROOT@#$GS_MEMORY_ROOT#g" \
      "$SCRIPT_DIR/units/$unit" > "$GS_MEMORY_SYSTEMD_DIR/$unit"
    chmod 0644 "$GS_MEMORY_SYSTEMD_DIR/$unit"
  done
  systemctl daemon-reload
  # Only the backup timer is enabled. It skips quietly when the database is not running.
  systemctl enable --now gs-memory-backup.timer
  log "system setup done. Next: sudo -u $GS_MEMORY_USER $APP/setup/gs-memory.sh install"
}

# Any Debian-managed PostgreSQL cluster, or an active postgresql.service, belongs to someone else.
# Without the opt-in: print it and stop before any change. With it: stop and disable postgresql.service only.
# No cluster is ever dropped, and pg_ctlcluster is never called.
guard_existing_postgres() {
  local allow="$1" clusters="" active=0 line
  if command -v pg_lsclusters >/dev/null; then
    clusters="$(pg_lsclusters -h 2>/dev/null | awk '{print $1"/"$2", port "$3", "$4", data "$6}')"
  fi
  if systemctl is-active --quiet postgresql.service 2>/dev/null; then active=1; fi
  if [[ -z "$clusters" && "$active" == 0 ]]; then
    log "no existing PostgreSQL cluster and postgresql.service is not active"
    return 0
  fi
  log "existing PostgreSQL found on this PC:"
  while read -r line; do [[ -z "$line" ]] || log "    cluster $line"; done <<<"$clusters"
  if [[ "$active" == 1 ]]; then log "    postgresql.service is active"; fi
  if [[ "$allow" != 1 ]]; then
    die "system-setup stopped and changed nothing. It never drops a cluster. If postgresql.service may be stopped and disabled (every cluster and its data stay on disk), run again with --allow-disable-default-postgres. If not sure, stop and comment on the install issue."
  fi
  log "--allow-disable-default-postgres: stop and disable postgresql.service. No cluster is dropped."
  systemctl disable --now postgresql.service
}

# Debian makes a default 16/main cluster on 5432 unless createcluster.conf says no. Say no for this
# install only, then put the file back as it was.
install_postgres_packages() {
  log "install postgresql-16 and postgresql-16-pgvector (no default cluster)"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-common
  local conf=/etc/postgresql-common/createcluster.conf saved rc=0
  saved="$(mktemp)"
  cp -p "$conf" "$saved"
  echo 'create_main_cluster = false' >> "$conf"
  DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-16 postgresql-16-pgvector python3-venv || rc=$?
  cp -p "$saved" "$conf"
  rm -f "$saved"
  [[ "$rc" == 0 ]] || die "apt-get install failed (exit $rc)"
}

# Writes and removes one test file in $2 as user $1.
can_write_as() {
  local probe=(sh -c 'p="$1/.gs-memory-write-test.$$" && echo ok > "$p" && rm -f "$p"' sh "$2")
  if [[ "$(id -un)" == "$1" ]]; then
    "${probe[@]}" 2>/dev/null
  else
    runuser -u "$1" -- "${probe[@]}" 2>/dev/null
  fi
}

# --------------------------------------------------------------------------------------------
# preflight (any user, no sudo). Read-only apart from one test file in the Windows copy folder.
cmd_preflight() {
  local fail=0
  pass() { printf '  PASS  %s\n' "$*"; }
  bad() { printf '  FAIL  %s\n' "$*"; fail=1; }
  note() { printf '  NOTE  %s\n' "$*"; }
  echo "gs-memory preflight as $(id -un) on $(hostname) at $(date -u +%FT%TZ)"

  if (guard_paths_and_ports) >/dev/null 2>&1; then
    pass "ports $GS_MEMORY_PG_PORT/$GS_MEMORY_API_PORT and root $GS_MEMORY_ROOT are not live GSAM's"
  else
    bad "$( (guard_paths_and_ports) 2>&1 | sed 's/^\[gs-memory\] ERROR: //')"
  fi

  local clusters=""
  if command -v pg_lsclusters >/dev/null; then
    clusters="$(pg_lsclusters -h 2>/dev/null | awk '{print $1"/"$2" (port "$3", "$4")"}' | paste -sd' ' -)"
  fi
  if [[ -z "$clusters" ]]; then
    pass "no existing PostgreSQL cluster (pg_lsclusters)"
  else
    bad "existing PostgreSQL cluster: $clusters. system-setup will stop; see --allow-disable-default-postgres"
  fi
  if systemctl is-active --quiet postgresql.service 2>/dev/null; then
    bad "postgresql.service is active. system-setup will stop; see --allow-disable-default-postgres"
  else
    pass "postgresql.service is not active"
  fi
  case "$(systemctl is-system-running 2>/dev/null || true)" in
    running|degraded|starting) pass "systemd runs (needed for the units)";;
    *) bad "systemd is not running (set systemd=true in /etc/wsl.conf)";;
  esac

  local port
  for port in "$GS_MEMORY_PG_PORT" "$GS_MEMORY_API_PORT"; do
    if [[ -z "$(ss -Hltn "( sport = :$port )" 2>/dev/null)" ]]; then
      pass "port $port is free"
    else
      bad "port $port is in use (expected only if gs-memory already runs)"
    fi
  done

  # The nearest folder that exists: the copy folder itself, or the drive above it before system-setup.
  local win="$GS_MEMORY_WINDOWS_BACKUPS"
  while [[ ! -d "$win" && "$win" != / ]]; do win="$(dirname "$win")"; done
  if can_write_as "$(id -un)" "$win"; then
    pass "$win is writable by $(id -un)"
  else
    bad "$win is not writable by $(id -un)"
  fi
  if [[ -d "$GS_MEMORY_WINDOWS_BACKUPS" ]] && id "$GS_MEMORY_USER" >/dev/null 2>&1 && [[ "$(id -u)" == 0 || "$(id -un)" == "$GS_MEMORY_USER" ]]; then
    if can_write_as "$GS_MEMORY_USER" "$GS_MEMORY_WINDOWS_BACKUPS"; then
      pass "$GS_MEMORY_WINDOWS_BACKUPS is writable by $GS_MEMORY_USER"
    else
      bad "$GS_MEMORY_WINDOWS_BACKUPS is not writable by $GS_MEMORY_USER (nightly backup will fail)"
    fi
  else
    note "write test as $GS_MEMORY_USER runs in system-setup (and here when run with sudo after it)"
  fi

  local need_gb="${GS_MEMORY_MIN_FREE_GB:-5}" at="$GS_MEMORY_ROOT" free_gb
  while [[ ! -d "$at" && "$at" != / ]]; do at="$(dirname "$at")"; done
  free_gb="$(df -Pk "$at" | awk 'NR==2 {print int($4/1048576)}')"
  if (( free_gb >= need_gb )); then
    pass "$free_gb GB free at $at (need $need_gb GB for venv, models and database)"
  else
    bad "$free_gb GB free at $at (need $need_gb GB)"
  fi
  free_gb="$(df -Pk "$win" | awk 'NR==2 {print int($4/1048576)}')"
  if (( free_gb >= 1 )); then pass "$free_gb GB free at $win"; else bad "$free_gb GB free at $win (need 1 GB)"; fi

  preflight_claude_cli
  [[ "$fail" == 0 ]] && echo "RESULT: PASS" || echo "RESULT: FAIL"
  return "$fail"
}

# The claude-code provider runs the Claude CLI bundled in the claude-agent-sdk wheel, as the engine user.
# Before install the venv does not exist, so only the pin is checked. After install, run preflight as
# the engine user (or root) and it runs the CLI as that user.
preflight_claude_cli() {
  if ! grep -q '^claude-agent-sdk==' "$SCRIPT_DIR/requirements.lock"; then
    bad "requirements.lock has no claude-agent-sdk pin (it brings the Claude CLI)"
    return
  fi
  if [[ ! -x "$VENV/bin/python" ]]; then
    if [[ "$(id -u)" == 0 || "$(id -un)" == "$GS_MEMORY_USER" ]]; then
      note "no venv yet; install brings the Claude CLI (claude-agent-sdk pin). Run preflight again after install"
    else
      note "Claude CLI is checked by install, or by: sudo -u $GS_MEMORY_USER $APP/setup/gs-memory.sh preflight"
    fi
    pass "requirements.lock pins claude-agent-sdk (bundles the Claude CLI)"
    return
  fi
  local version
  if version="$(claude_cli_version)"; then
    pass "$GS_MEMORY_USER can run the Claude CLI: $version"
  else
    bad "$GS_MEMORY_USER cannot run the Claude CLI; extraction will not work after link-claude"
  fi
}

# Prints the version of the Claude CLI the engine will use, run as the engine user. Fails if there is none.
claude_cli_version() {
  local run=()
  [[ "$(id -un)" == "$GS_MEMORY_USER" ]] || run=(runuser -u "$GS_MEMORY_USER" --)
  local cli
  cli="$("${run[@]}" "$VENV/bin/python" -c 'import claude_agent_sdk, pathlib; p = pathlib.Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude"; print(p if p.is_file() else "")' 2>/dev/null || true)"
  [[ -n "$cli" ]] || cli="$("${run[@]}" sh -c 'command -v claude' 2>/dev/null || true)"
  [[ -n "$cli" ]] || return 1
  local version
  version="$("${run[@]}" "$cli" --version 2>/dev/null | head -1)" && [[ -n "$version" ]] || return 1
  printf '%s (%s)\n' "$cli" "$version"
}

# --------------------------------------------------------------------------------------------
# install (gsmemory). Items 4, 5 and 7 of the G2 change list.
cmd_install() {
  guard_paths_and_ports
  umask 077
  mkdir -p "$APP" "$GS_MEMORY_ROOT/pg" "$PGRUN" "$MODELS" "$SECRETS" "$BACKUPS" "$LOGS" "$GS_MEMORY_ROOT/home"
  chmod 0700 "$GS_MEMORY_ROOT" "$PGRUN" "$SECRETS" "$BACKUPS"

  # Secrets: generated once, never printed, never leave this folder except through `link-gateway`.
  if [[ ! -s "$SECRETS/db.env" ]]; then
    printf 'GS_MEMORY_DB_PASSWORD=%s\n' "$(new_secret)" > "$SECRETS/db.env"
  fi
  if [[ ! -s "$SECRETS/engine.env" ]]; then
    printf 'HINDSIGHT_API_TENANT_API_KEY=%s\n' "$(new_secret)" > "$SECRETS/engine.env"
  fi
  # The assertion secret (GRE-672) is added to an older engine.env without changing its key.
  if ! grep -q '^HINDSIGHT_API_TENANT_ASSERTION_SECRET=' "$SECRETS/engine.env"; then
    local assertion
    assertion="$(new_secret)"
    printf 'HINDSIGHT_API_TENANT_ASSERTION_SECRET=%s\nHINDSIGHT_API_OPERATION_VALIDATOR_ASSERTION_SECRET=%s\n' \
      "$assertion" "$assertion" >> "$SECRETS/engine.env"
  fi
  write_gateway_env "$SECRETS/gateway.env"
  chmod 0600 "$SECRETS"/*.env
  # shellcheck disable=SC1091
  source "$SECRETS/db.env"

  install_cluster
  install_venv
  install_models
  install_extension
  write_hindsight_env
  report_claude_cli
  log "install done. Next: sudo $APP/setup/gs-memory.sh link-gateway, then sudo systemctl start gs-memory-hindsight"
}

# The GSAM server's copy of the engine secrets, in the format readMemoryGatewayConfig expects.
write_gateway_env() {
  local key assertion
  key="$(sed -n 's/^HINDSIGHT_API_TENANT_API_KEY=//p' "$SECRETS/engine.env")"
  assertion="$(sed -n 's/^HINDSIGHT_API_TENANT_ASSERTION_SECRET=//p' "$SECRETS/engine.env")"
  [[ -n "$key" && -n "$assertion" ]] || die "engine.env has no key or assertion secret"
  (umask 077; cat > "$1" <<EOF
# Written by scripts/gs-memory/gs-memory.sh. Engine secrets for the GSAM memory gateway (GRE-672). Mode 600.
GSAM_MEMORY_ENGINE_URL=http://127.0.0.1:$GS_MEMORY_API_PORT
GSAM_MEMORY_ENGINE_API_KEY=$key
GSAM_MEMORY_ASSERTION_SECRET=$assertion
EOF
  )
}

# The claude-code provider needs a Claude CLI the engine user can run: the one bundled in the
# claude-agent-sdk wheel, or one on its PATH. Without it extraction cannot work, so install fails here.
report_claude_cli() {
  local found
  found="$(claude_cli_version)" \
    || die "no Claude CLI that $(id -un) can run (claude-agent-sdk bundle or PATH). Extraction would not work after link-claude."
  log "Claude CLI for the engine: $found"
}

install_extension() {
  # Only the two runtime modules; the engine never imports from the repo checkout.
  install -d -m 0700 "$EXTENSION"
  install -m 0600 "$SCRIPT_DIR/extension/gsam_memory_extension.py" "$SCRIPT_DIR/extension/gsam_memory_assertion.py" "$EXTENSION/"
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
    # Old dumps still expire on a night with no new dump.
    prune "$BACKUPS"
    [[ -d "$GS_MEMORY_WINDOWS_BACKUPS" ]] && prune "$GS_MEMORY_WINDOWS_BACKUPS"
    return 0
  fi
  local stamp file
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$BACKUPS/hindsight-$stamp.dump"
  pg pg_dump -h "$PGRUN" -p "$GS_MEMORY_PG_PORT" -d "$DB_NAME" -Fc -f "$file.part"
  mv "$file.part" "$file"
  sha256sum "$file" | sed "s#$BACKUPS/##" > "$file.sha256"
  log "dump written: $file ($(du -h "$file" | cut -f1))"
  prune "$BACKUPS"
  # A missing or failed copy is an error, not a warning: the unit fails and `systemctl --failed` shows it.
  local name
  name="$(basename "$file")"
  [[ -d "$GS_MEMORY_WINDOWS_BACKUPS" ]] || die "Windows copy folder missing: $GS_MEMORY_WINDOWS_BACKUPS (local dump kept: $file)"
  cp "$file" "$file.sha256" "$GS_MEMORY_WINDOWS_BACKUPS/" \
    || die "cannot copy $name and its .sha256 to $GS_MEMORY_WINDOWS_BACKUPS (local dump kept)"
  (cd "$GS_MEMORY_WINDOWS_BACKUPS" && sha256sum -c --quiet "$name.sha256" >/dev/null 2>&1) \
    || die "checksum of the copy in $GS_MEMORY_WINDOWS_BACKUPS does not match (local dump kept)"
  log "copied to $GS_MEMORY_WINDOWS_BACKUPS (checksum verified)"
  prune "$GS_MEMORY_WINDOWS_BACKUPS"
}

prune() {
  local dir="$1" old cutoff f stamp
  # Newest first; keep the first GS_MEMORY_BACKUP_KEEP dumps.
  mapfile -t old < <(ls -1t "$dir"/hindsight-*.dump 2>/dev/null | tail -n +"$((GS_MEMORY_BACKUP_KEEP + 1))")
  for f in "${old[@]}"; do rm -f "$f" "$f.sha256"; done
  # Age cap by the UTC stamp in the name, not mtime: a copy to Windows gets a new mtime.
  cutoff="$(date -u -d "-$GS_MEMORY_BACKUP_MAX_AGE_DAYS days" +%Y%m%dT%H%M%SZ)"
  for f in "$dir"/hindsight-*.dump; do
    [[ -e "$f" ]] || continue
    stamp="$(basename "$f" .dump)"; stamp="${stamp#hindsight-}"
    if [[ "$stamp" < "$cutoff" ]]; then
      rm -f "$f" "$f.sha256"
      log "expired backup removed (older than $GS_MEMORY_BACKUP_MAX_AGE_DAYS days): $f"
    fi
  done
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
  # The trap clears itself: a RETURN trap stays set after this function and would run again with $tmp unset.
  trap 'pg pg_ctl -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"; trap - RETURN' RETURN
  pg initdb -D "$tmp/data" -U "$(id -un)" --auth-local=peer --auth-host=reject \
    --encoding=UTF8 --locale=C.UTF-8 >/dev/null
  pg pg_ctl -D "$tmp/data" -o "-c listen_addresses='' -c port=$port -c unix_socket_directories=$tmp" -l "$tmp/log" -w start >/dev/null
  pg createdb -h "$tmp" -p "$port" "$DB_NAME"
  pg pg_restore -h "$tmp" -p "$port" -d "$DB_NAME" --no-owner "$dump"
  local tables
  tables="$(pg psql -X -At -h "$tmp" -p "$port" -d "$DB_NAME" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  log "restore test passed: $(basename "$dump") -> $tables tables in a throwaway cluster"
}

# --------------------------------------------------------------------------------------------
# link-gateway (root). Copies secrets/gateway.env to the GSAM user's ~/gs-memory/secrets/gateway.env, mode 600.
# Residual risk (Everest, 5 Oct 2026): agents run as the same user as the GSAM server and can read this file.
# Accepted for synthetic data only; must be closed before G4 (GRE-646).
cmd_link_gateway() {
  guard_paths_and_ports
  [[ -s "$SECRETS/gateway.env" ]] || die "no $SECRETS/gateway.env; run install first"
  [[ "$(id -u)" == 0 || "$(id -un)" == "$GS_MEMORY_GSAM_USER" ]] || die "run as root (sudo) or as $GS_MEMORY_GSAM_USER"
  local dir
  dir="$(dirname "$GS_MEMORY_GATEWAY_ENV")"
  install -d -m 0700 "$(dirname "$dir")" "$dir"
  install -m 0600 "$SECRETS/gateway.env" "$GS_MEMORY_GATEWAY_ENV"
  if [[ "$(id -u)" == 0 ]]; then
    chown "$GS_MEMORY_GSAM_USER:" "$(dirname "$dir")" "$dir" "$GS_MEMORY_GATEWAY_ENV"
  fi
  log "gateway secrets written to $GS_MEMORY_GATEWAY_ENV (owner $GS_MEMORY_GSAM_USER, mode 600)"
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
  local recall="$base/v1/default/banks/gs-memory-check/memories/recall" body='{"query":"check"}'
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base/health" || true)"
  [[ "$code" == 200 ]] && ok "/health -> 200" || bad "/health -> $code"
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base/v1/default/banks" || true)"
  [[ "$code" == 401 || "$code" == 403 ]] && ok "engine API without key -> $code" || bad "engine API without key -> $code"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong-key' "$base/v1/default/banks" || true)"
  [[ "$code" == 401 || "$code" == 403 ]] && ok "engine API with a wrong key -> $code" || bad "engine API with a wrong key -> $code"
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base/mcp/" || true)"
  [[ "$code" == 404 || "$code" == 401 || "$code" == 403 || "$code" == 405 ]] && ok "MCP endpoint -> $code" || bad "MCP endpoint -> $code (expected off)"

  # With the gateway secrets (the GSAM user's gateway.env, or GS_MEMORY_CHECK_KEY / _ASSERTION_SECRET):
  # the key alone is refused; the key plus a signed assertion is accepted.
  local secret="${GS_MEMORY_CHECK_ASSERTION_SECRET:-}"
  if [[ -r "$GS_MEMORY_GATEWAY_ENV" ]]; then
    printf '  NOTE  %s can read %s (accepted risk until G4, GRE-646)\n' "$(id -un)" "$GS_MEMORY_GATEWAY_ENV"
    [[ -n "$key" ]] || key="$(sed -n 's/^GSAM_MEMORY_ENGINE_API_KEY=//p' "$GS_MEMORY_GATEWAY_ENV")"
    [[ -n "$secret" ]] || secret="$(sed -n 's/^GSAM_MEMORY_ASSERTION_SECRET=//p' "$GS_MEMORY_GATEWAY_ENV")"
  fi
  if [[ -n "$key" ]]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" "$base/v1/default/banks" || true)"
    [[ "$code" == 401 || "$code" == 403 ]] && ok "gateway key without assertion, list banks -> $code" || bad "gateway key without assertion, list banks -> $code"
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -d "$body" "$recall" || true)"
    [[ "$code" == 401 || "$code" == 403 ]] && ok "gateway key without assertion, recall -> $code" || bad "gateway key without assertion, recall -> $code"
  fi
  if [[ -n "$key" && -n "$secret" ]]; then
    local assertion
    assertion="$(GS_SECRET="$secret" "$GS_MEMORY_PYTHON" - <<'PY'
import base64, hashlib, hmac, json, os, secrets, time
now = int(time.time())
claims = {"v": 1, "op": "recall", "bank": "gs-memory-check", "read": ["gs-memory-check"], "write": [],
          "doc": None, "iat": now, "exp": now + 60, "nonce": secrets.token_urlsafe(12)}
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
payload = b64(json.dumps(claims, separators=(",", ":")).encode())
sig = b64(hmac.new(os.environ["GS_SECRET"].encode(), payload.encode(), hashlib.sha256).digest())
print(f"{payload}.{sig}")
PY
)"
    # The check writes nothing, so its bank does not exist: "Bank ... not found" means the call got past both locks.
    local reply
    reply="$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $key" -H "x-gsam-memory-assertion: $assertion" \
      -H 'Content-Type: application/json' -d "$body" "$recall" || true)"
    code="${reply##*$'\n'}"
    if [[ "$code" == 200 ]] || [[ "$code" == 404 && "$reply" == *"Bank 'gs-memory-check' not found"* ]]; then
      ok "gateway key + signed assertion, recall -> accepted ($code)"
    else
      bad "gateway key + signed assertion, recall -> $code"
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" -H "x-gsam-memory-assertion: $assertion" \
      -H 'Content-Type: application/json' -d "$body" "$base/v1/default/banks/other-bank/memories/recall" || true)"
    [[ "$code" == 401 || "$code" == 403 ]] && ok "signed assertion for another bank -> $code" || bad "signed assertion for another bank -> $code"
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

usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

main() {
  case "${1:-}" in
    preflight) cmd_preflight;;
    system-setup) shift; cmd_system_setup "$@";;
    install) cmd_install;;
    link-claude) cmd_link_claude;;
    unlink-claude) cmd_unlink_claude;;
    serve-postgres) cmd_serve_postgres;;
    serve-hindsight) cmd_serve_hindsight;;
    backup) cmd_backup;;
    restore-test) shift; cmd_restore_test "$@";;
    link-gateway) cmd_link_gateway;;
    check) cmd_check;;
    *) usage; exit 2;;
  esac
}

# Sourcing the script (the shell test does) defines the functions without running a command.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
