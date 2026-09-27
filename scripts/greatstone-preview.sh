#!/usr/bin/env bash
# Try a version before it goes live (see doc/GREATSTONE-WAY-OF-WORKING.md).
#
#   scripts/greatstone-preview.sh start <tag>   run <tag> at http://localhost:3200 on a copy of the live data
#   scripts/greatstone-preview.sh status        say what the preview runs and whether any agent run started
#   scripts/greatstone-preview.sh stop          stop the preview (only the preview)
#
# The preview lives in ~/GSAM/preview: code/ is its own clone at <tag>, data/
# is a fresh copy of the live data. It only reads ~/GSAM/data and never talks
# to the server on port 3100. Agents are off: the scheduler, timer heartbeats
# and every agent wake are switched off, and the live secrets key is not
# copied, so stored credentials cannot be used.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"

die() { printf 'preview: %s\n' "$*" >&2; exit 1; }

# The preview server gets only these variables; nothing from the caller's
# shell (GSAM_HOME, GSAM_CONFIG, DATABASE_URL, agent tokens) can leak in.
PREVIEW_ENV=(
  HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL=/bin/bash LANG="${LANG:-en_US.UTF-8}"
  TMPDIR="${TMPDIR:-/tmp}" PATH="$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  PORT="$PREVIEW_PORT"
  HEARTBEAT_SCHEDULER_ENABLED=false
  GSAM_RESTORE_IN_PROGRESS=true
  GSAM_DB_BACKUP_ENABLED=false
  GSAM_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
  GSAM_FEEDBACK_EXPORT_BACKEND_URL=http://127.0.0.1:9
  GSAM_MANAGED_RUNTIME_HTTPS=off
  GSAM_SECRETS_MASTER_KEY_FILE="$PREVIEW_DATA_DIR/instances/$INSTANCE_ID/secrets/master.key"
)

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

cmd_start() {
  local tag="${1:-}"
  [ -n "$tag" ] || die "usage: greatstone-preview.sh start <tag>"
  if preview_running; then
    die "a preview of $(preview_state tag) is already running; run 'greatstone-preview.sh stop' first."
  fi
  port_in_use "$PREVIEW_PORT" && die "port $PREVIEW_PORT is in use by another process."
  case "$PREVIEW_ROOT/" in "$LIVE_DIR/"* | "$LIVE_DATA_DIR/"*) die "the preview folder must be outside the live folders." ;; esac
  [ -d "$LIVE_DATA_DIR/instances/$INSTANCE_ID" ] || die "no live data at $LIVE_DATA_DIR"
  local source_url
  source_url="$(live_database_url)" \
    || die "the live database is not running. Start live first; the preview copies from the running database and never starts it."

  local commit
  commit="$(git -C "$RELEASE_REPO" rev-parse --verify --quiet "refs/tags/$tag^{commit}")" || die "unknown tag $tag"
  say "Preview $tag ($commit)"

  # Code: our own clone, fetched from the local repository so unpushed rc-* tags work.
  mkdir -p "$PREVIEW_ROOT"
  local source_git
  source_git="$(cd "$RELEASE_REPO" && cd "$(git rev-parse --git-common-dir)" && pwd)"
  if [ ! -d "$PREVIEW_CODE_DIR/.git" ]; then
    git clone --quiet --no-checkout "$source_git" "$PREVIEW_CODE_DIR"
  fi
  git -C "$PREVIEW_CODE_DIR" fetch --quiet --force "$source_git" "refs/tags/$tag:refs/tags/$tag"
  git -C "$PREVIEW_CODE_DIR" checkout --quiet --force --detach "$commit"
  say "Code: $PREVIEW_CODE_DIR at $(git -C "$PREVIEW_CODE_DIR" rev-parse --short HEAD)"
  say "Installing dependencies..."
  # Non-interactive: agent runs get a new pnpm store each time, and pnpm then
  # asks (hidden by --reporter=silent) to purge node_modules and waits forever.
  (cd "$PREVIEW_CODE_DIR" && pnpm install --frozen-lockfile --prefer-offline \
    --config.confirm-modules-purge=false --reporter=silent </dev/null)

  # Data: a fresh copy every start. Files are copied read-only from live; the
  # database comes from a read-only backup of the running live database.
  # rsync -a keeps the modes of read-only folders (the skills runtime cache),
  # so the old copy must be made writable before it can be removed.
  [ -d "$PREVIEW_DATA_DIR" ] && chmod -R u+w "$PREVIEW_DATA_DIR"
  rm -rf "$PREVIEW_DATA_DIR" "$PREVIEW_ROOT/seed"
  mkdir -p "$PREVIEW_DATA_DIR" "$PREVIEW_ROOT/seed"
  rsync -a \
    --exclude "/instances/*/db/" \
    --exclude "/instances/*/secrets/" \
    --exclude "/instances/*/locks/" \
    --exclude "/instances/*/runtime-services/" \
    --exclude "/instances/*/data/backups/" \
    --exclude "/instances/*/hot-restart-*.json" \
    --exclude "/instances/*/config.json" \
    --exclude "/instances/*/.env" \
    "$LIVE_DATA_DIR/" "$PREVIEW_DATA_DIR/"
  say "Files: copied to $PREVIEW_DATA_DIR (without the database, secrets, locks and backups)"
  gs_db seed-preview \
    --source-url "$source_url" \
    --target-db-dir "$PREVIEW_DATA_DIR/instances/$INSTANCE_ID/db" \
    --work-dir "$PREVIEW_ROOT/seed" \
    --rewrite-from "$LIVE_DATA_DIR" \
    --rewrite-to "$PREVIEW_DATA_DIR"

  # Server: the same start command as live, in its own process group so that
  # stop can end the server and its database together.
  say "Starting the preview on $PREVIEW_URL (log: $PREVIEW_LOG)"
  set -m
  (cd "$PREVIEW_CODE_DIR" && exec env -i "${PREVIEW_ENV[@]}" pnpm dev:once --data-dir "$PREVIEW_DATA_DIR") >"$PREVIEW_LOG" 2>&1 &
  local pid=$!
  set +m
  cat >"$PREVIEW_STATE_FILE" <<EOF
tag=$tag
commit=$commit
pid=$pid
port=$PREVIEW_PORT
source_repo=$(dirname "$source_git")
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

  for _ in $(seq 1 150); do
    sleep 2
    kill -0 "$pid" 2>/dev/null || die "the preview server exited; see $PREVIEW_LOG"
    if [ "$(health_commit "$PREVIEW_URL")" = "$commit" ]; then
      say "Preview is up: $PREVIEW_URL runs $tag ($commit). Agents are off."
      return 0
    fi
  done
  die "the preview did not report $tag within 5 minutes; see $PREVIEW_LOG. Stop it with: scripts/greatstone-preview.sh stop"
}

cmd_status() {
  if ! preview_running; then
    say "No preview is running."
    return 0
  fi
  local commit started
  commit="$(health_commit "$PREVIEW_URL")"
  started="$(preview_state started_at)"
  say "Preview: $PREVIEW_URL"
  say "  tag:        $(preview_state tag)"
  say "  commit:     ${commit:-<no answer from /api/health>} (expected $(preview_state commit))"
  say "  process:    $(preview_state pid) (started $started)"
  say "  data:       $PREVIEW_DATA_DIR"
  say "  agents off: HEARTBEAT_SCHEDULER_ENABLED=false GSAM_RESTORE_IN_PROGRESS=true"
  node --input-type=module -e '
    const [base, since] = process.argv.slice(1);
    const get = async (p) => (await fetch(base + p)).json();
    let started = 0, active = 0;
    for (const company of await get("/api/companies")) {
      const runs = await get(`/api/companies/${company.id}/heartbeat-runs?limit=200`);
      const list = Array.isArray(runs) ? runs : (runs.runs ?? runs.items ?? []);
      started += list.filter((r) => new Date(r.createdAt) >= new Date(since)).length;
      active += list.filter((r) => r.status === "running" || r.status === "queued").length;
    }
    console.log(`  agent runs: ${started} started since the preview started, ${active} queued or running`);
  ' "$PREVIEW_URL" "$started" || say "  agent runs: could not ask the preview"
}

cmd_stop() {
  if ! preview_running; then
    say "No preview is running."
    rm -f "$PREVIEW_STATE_FILE"
    return 0
  fi
  local pid
  pid="$(preview_state pid)"
  say "Stopping the preview (process group $pid)..."
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  # The preview database, if it outlived the server.
  local pgpid
  pgpid="$(sed -n 1p "$PREVIEW_DATA_DIR/instances/$INSTANCE_ID/db/postmaster.pid" 2>/dev/null || true)"
  if [ -n "$pgpid" ] && kill -0 "$pgpid" 2>/dev/null; then
    kill -INT "$pgpid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pgpid" 2>/dev/null || break; sleep 1; done
  fi
  rm -f "$PREVIEW_STATE_FILE"
  if port_in_use "$PREVIEW_PORT"; then
    die "port $PREVIEW_PORT is still in use; check with: lsof -nP -iTCP:$PREVIEW_PORT -sTCP:LISTEN"
  fi
  say "Preview stopped."
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  *) die "usage: greatstone-preview.sh start <tag> | status | stop" ;;
esac
