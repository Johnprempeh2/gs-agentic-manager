# Shared settings for scripts/greatstone-preview.sh and scripts/greatstone-release.sh.
# Source it; do not run it.
#
# Every path can be moved for a sandbox test (see doc/GREATSTONE-WAY-OF-WORKING.md):
#   GSAM_ROOT           the GSAM home (default ~/GSAM): live/, data/, backups/, preview/
#   GSAM_LIVE_DIR       live code checkout        (default $GSAM_ROOT/live)
#   GSAM_LIVE_DATA_DIR  live data                 (default $GSAM_ROOT/data)
#   GSAM_LIVE_URL       live server               (default http://localhost:3100)
#   GSAM_PREVIEW_PORT   preview server port       (default 3200)
#   GSAM_RELEASE_REPO   git repo that holds the rc-*/live-* tags (default: this checkout)

GS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GS_TOOLS_ROOT="$(cd "$GS_SCRIPT_DIR/.." && pwd)"
GS_ROOT="${GSAM_ROOT:-$HOME/GSAM}"
LIVE_DIR="${GSAM_LIVE_DIR:-$GS_ROOT/live}"
LIVE_DATA_DIR="${GSAM_LIVE_DATA_DIR:-$GS_ROOT/data}"
LIVE_URL="${GSAM_LIVE_URL:-http://localhost:3100}"
BACKUP_ROOT="$GS_ROOT/backups"
PREVIEW_ROOT="$GS_ROOT/preview"
PREVIEW_CODE_DIR="$PREVIEW_ROOT/code"
PREVIEW_DATA_DIR="$PREVIEW_ROOT/data"
PREVIEW_STATE_FILE="$PREVIEW_ROOT/preview.state"
PREVIEW_LOG="$PREVIEW_ROOT/preview.log"
PREVIEW_PORT="${GSAM_PREVIEW_PORT:-3200}"
PREVIEW_URL="http://localhost:$PREVIEW_PORT"
RELEASE_REPO="${GSAM_RELEASE_REPO:-$GS_TOOLS_ROOT}"
INSTANCE_ID="default"

export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

say() { printf '%s\n' "$*"; }

# Runs scripts/greatstone-db.ts with this checkout's dependencies.
gs_db() {
  (cd "$GS_TOOLS_ROOT" && node cli/node_modules/tsx/dist/cli.mjs scripts/greatstone-db.ts "$@")
}

# Prints the connection string of the running live database. The port comes
# from the postmaster.pid file that PostgreSQL writes; nothing is written.
live_database_url() {
  local pidfile="$LIVE_DATA_DIR/instances/$INSTANCE_ID/db/postmaster.pid"
  [ -f "$pidfile" ] || return 1
  local pid port
  pid="$(sed -n 1p "$pidfile")"
  port="$(sed -n 4p "$pidfile")"
  kill -0 "$pid" 2>/dev/null || return 1
  printf 'postgres://paperclip:paperclip@127.0.0.1:%s/paperclip\n' "$port"
}

# Prints the "commit" field of <url>/api/health, or nothing.
health_commit() {
  curl -fsS -m 5 "$1/api/health" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).commit||"")}catch{console.log("")}})'
}

# Counts queued or running agent runs across every company on <url>.
active_runs() {
  node --input-type=module -e '
    const base = process.argv[1];
    const get = async (p) => (await fetch(base + p)).json();
    let active = 0;
    for (const company of await get("/api/companies")) {
      const runs = await get(`/api/companies/${company.id}/heartbeat-runs?limit=50`);
      const list = Array.isArray(runs) ? runs : (runs.runs ?? runs.items ?? []);
      active += list.filter((r) => r.status === "running" || r.status === "queued").length;
    }
    console.log(active);
  ' "$1"
}

# Reads one key from the preview state file.
preview_state() {
  [ -f "$PREVIEW_STATE_FILE" ] || return 0
  sed -n "s/^$1=//p" "$PREVIEW_STATE_FILE"
}

# True when the process group recorded in the state file is the preview.
preview_running() {
  local pid
  pid="$(preview_state pid)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -o command= -p "$pid" | grep -qF -- "$PREVIEW_DATA_DIR"
}
