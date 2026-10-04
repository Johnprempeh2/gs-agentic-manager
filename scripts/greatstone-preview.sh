#!/usr/bin/env bash
# Try a version before it goes live (see doc/GREATSTONE-WAY-OF-WORKING.md).
#
#   scripts/greatstone-preview.sh start <tag>   run <tag> at http://localhost:3200 on a copy of the live data
#   scripts/greatstone-preview.sh status        say what the preview runs and whether any agent run started
#   scripts/greatstone-preview.sh switch-tests  run the tests of every Experimental switch that is on
#                                               (the preview has live's values); fails when one fails
#   scripts/greatstone-preview.sh shot <path> <name>
#                                               screenshot http://localhost:3200<path> at laptop and
#                                               phone size into ~/GSAM/preview/shots/<tag>-<name>-*.png
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
# HOME is the account home, not the agent's temp HOME, and GSAM_ROOT is the
# root this script uses, so the Releases page finds release.conf (GRE-171).
PREVIEW_ENV=(
  HOME="${GS_USER_HOME:-$HOME}" GSAM_ROOT="$GS_ROOT" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL=/bin/bash LANG="${LANG:-en_US.UTF-8}"
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

# Writes the state file for a started preview: <tag> <commit> <pid> <source repo>,
# and the agent run and issue that started it (empty outside an agent run).
write_preview_state() {
  cat >"$PREVIEW_STATE_FILE" <<EOF
tag=$1
commit=$2
pid=$3
port=$PREVIEW_PORT
source_repo=$4
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
run_id=$(printf '%s' "${GSAM_RUN_ID:-}" | tr -d '\r\n')
issue_id=$(printf '%s' "${GSAM_TASK_ID:-}" | tr -d '\r\n')
EOF
}

# Says when and by whom the running preview was started, e.g. "started 3h ago
# by run <id> for issue <id>", so a preview left by a run that ended early can
# be traced (GRE-525). State files written before that have no run or issue.
preview_origin() {
  local age
  age="$(perl -MTime::Local -e '
    my ($y, $mo, $d, $h, $mi, $s) = ($ARGV[0] // "") =~ /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)Z$/ or exit;
    my $t = time - timegm($s, $mi, $h, $d, $mo - 1, $y);
    $t = 0 if $t < 0;
    print $t < 60 ? "${t}s ago" : $t < 3600 ? int($t / 60) . "m ago" : $t < 86400 ? int($t / 3600) . "h ago" : int($t / 86400) . "d ago";
  ' "$(preview_state started_at)" 2>/dev/null || true)"
  printf 'started %s by run %s for issue %s' "${age:-at an unknown time}" \
    "$(preview_state run_id | grep . || echo unknown)" "$(preview_state issue_id | grep . || echo unknown)"
}

cmd_start() {
  local tag="${1:-}"
  [ -n "$tag" ] || die "usage: greatstone-preview.sh start <tag>"
  if preview_running; then
    die "a preview of $(preview_state tag) is already running ($(preview_origin)); run 'greatstone-preview.sh stop' first."
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
  write_preview_state "$tag" "$commit" "$pid" "$(dirname "$source_git")"
  record_release_repo "$(dirname "$source_git")"

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
  say "  origin:     $(preview_origin)"
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

# The preview is a copy of the live data, so its Experimental switches are the
# ones on in live. Runs the candidate's test files for each switch that is on
# (tests/release-switch-tests/switch-tests.json) and fails, naming the switch
# and the test, when one fails (GRE-101). The report is saved next to the log.
cmd_switch_tests() {
  preview_running || die "no preview is running; start the candidate first."
  local report="$PREVIEW_ROOT/switch-tests-$(preview_state tag).json" code=0
  node "$GS_TOOLS_ROOT/tests/release-switch-tests/run.mjs" \
    --repo "$PREVIEW_CODE_DIR" --settings-url "$PREVIEW_URL" --json "$report" || code=$?
  if [ ! -f "$report" ]; then
    say "No report was written to $report; the switch tests did not run."
    [ "$code" -ne 0 ] || code=1
    return "$code"
  fi
  say "Report: $report"
  return "$code"
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
  # Wait for the whole group, not just its leader: the dev runner in it starts
  # the server in a process group of its own and needs time to stop it (up to
  # ~20s, then it kills it). Killing the runner early would leave that server
  # unsupervised.
  for _ in $(seq 1 30); do
    kill -0 -- "-$pid" 2>/dev/null || break
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

# Screenshots one page of the running preview at laptop and phone size, named
# after the preview's tag, for the preview check (GRE-606). Only ever opens
# http://localhost:3200: any other port, from the caller or the state file, is
# refused, so it can never shoot the live app on 3100.
cmd_shot() {
  local page="${1:-}" name="${2:-}"
  [ -n "$page" ] && [ -n "$name" ] || die "usage: greatstone-preview.sh shot <page path> <name>"
  case "$page" in /*) ;; *) die "the page path must start with /, e.g. /GRE/issues" ;; esac
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "the name may use only letters, digits, '.', '_' and '-'."
  [ "$PREVIEW_PORT" = 3200 ] || die "shot only opens the preview on port 3200, not port $PREVIEW_PORT."
  preview_running || die "no preview is running; start one with 'greatstone-preview.sh start <tag>'."
  local port tag
  port="$(preview_state port)"
  [ "$port" = 3200 ] || die "the running preview is on port ${port:-<unknown>}; shot only opens port 3200."
  tag="$(preview_state tag)"
  [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || die "the preview state has no usable tag ('$tag')."
  local dir="$PREVIEW_ROOT/shots"
  local laptop="$dir/$tag-$name-laptop.png" phone="$dir/$tag-$name-phone.png"
  mkdir -p "$dir"
  (cd "$GS_TOOLS_ROOT" && node scripts/preview-shot.mjs "http://localhost:3200$page" "$laptop" "$phone") \
    || die "the screenshot of http://localhost:3200$page failed."
  say "$laptop"
  say "$phone"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  status) cmd_status ;;
  switch-tests) cmd_switch_tests ;;
  shot) shift; cmd_shot "$@" ;;
  stop) cmd_stop ;;
  *) die "usage: greatstone-preview.sh start <tag> | status | switch-tests | shot <page path> <name> | stop" ;;
esac
