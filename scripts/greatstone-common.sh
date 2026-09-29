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
#   GSAM_LIVE_BOARD_KEY_FILE  board API key for the live server (default $GSAM_ROOT/release-board-key)
#
# When live runs in login mode (authenticated), the restart request, the
# serverInfo read and the active-run count need a board login. The scripts send
# the board API key in GSAM_LIVE_BOARD_KEY_FILE (mode 0600, never in the repo).
# With no file they send no login, as in local_trusted (GRE-136).
#
# ~ is the home folder of the user account, not $HOME: agent runs set HOME to
# a temp folder, and the scripts must still find the real ~/GSAM.

GS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GS_TOOLS_ROOT="$(cd "$GS_SCRIPT_DIR/.." && pwd)"
GS_USER_HOME="$(perl -e 'print((getpwuid($<))[7])' 2>/dev/null || true)"
GS_ROOT="${GSAM_ROOT:-${GS_USER_HOME:-$HOME}/GSAM}"
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
LIVE_BOARD_KEY_FILE="${GSAM_LIVE_BOARD_KEY_FILE:-$GS_ROOT/release-board-key}"
INSTANCE_ID="default"

export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

say() { printf '%s\n' "$*"; }

# Fails with the reason when the board key file exists but others can read it
# or it is empty. No file is fine (local_trusted).
live_board_key_check() {
  [ -e "$LIVE_BOARD_KEY_FILE" ] || return 0
  local mode
  mode="$(perl -e 'printf "%o", (stat shift)[2] & 0777' "$LIVE_BOARD_KEY_FILE")"
  [ "$mode" = 600 ] || [ "$mode" = 400 ] || { say "$LIVE_BOARD_KEY_FILE has mode $mode; run: chmod 600 $LIVE_BOARD_KEY_FILE"; return 1; }
  [ -n "$(tr -d '[:space:]' <"$LIVE_BOARD_KEY_FILE")" ] || { say "$LIVE_BOARD_KEY_FILE is empty"; return 1; }
}

# curl with the live board key, when there is one. The key goes in through a
# file descriptor, never on a command line that ps can show.
live_curl() {
  if [ -s "$LIVE_BOARD_KEY_FILE" ]; then
    curl -H @<(printf 'Authorization: Bearer %s\n' "$(tr -d '[:space:]' <"$LIVE_BOARD_KEY_FILE")") "$@"
  else
    curl "$@"
  fi
}

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

# Prints one field of <url>/api/health (a dotted path such as
# serverInfo.processStartedAt), or nothing. Never fails, so that it can be
# polled while the server restarts. In login mode, serverInfo needs the board key.
health_field() {
  { live_curl -fsS -m 5 "$1/api/health" 2>/dev/null || true; } \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(v??"")}catch{console.log("")}})' "$2"
}

# The "commit" of a running server. It is read from git in the server's
# folder, so it changes on checkout, before the server restarts.
health_commit() { health_field "$1" commit; }

# Counts queued or running agent runs across every company on <url>. While a
# task drain holds new runs (the one-click release sets one), queued runs cannot
# start, so only running ones count. A server that does not answer runs nothing.
# Fails with the reason when the server refuses the request (login mode and no
# or a bad board key).
active_runs() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [base, keyFile] = process.argv.slice(1);
    let key = "";
    try { key = readFileSync(keyFile, "utf8").trim(); } catch {}
    const headers = key ? { authorization: `Bearer ${key}` } : {};
    const get = async (p) => {
      const res = await fetch(base + p, { headers });
      if (!res.ok) {
        console.error(`GET ${p} answered ${res.status} ${(await res.text()).slice(0, 200)}`);
        process.exit(1);
      }
      return res.json();
    };
    try { await fetch(base + "/api/health"); } catch { console.log(0); process.exit(0); }
    let draining = false;
    try { draining = (await (await fetch(base + "/api/instance/task-drain", { headers })).json()).draining === true; } catch {}
    let active = 0;
    for (const company of await get("/api/companies")) {
      const runs = await get(`/api/companies/${company.id}/heartbeat-runs?limit=50`);
      const list = Array.isArray(runs) ? runs : (runs.runs ?? runs.items ?? []);
      active += list.filter((r) => r.status === "running" || (!draining && r.status === "queued")).length;
    }
    console.log(active);
  ' "$1" "$LIVE_BOARD_KEY_FILE"
}

# Prints the title (line 1 of the message) of rc tag <tag> in <repo>. Fails
# with the reason when the tag has no title: a lightweight tag, an empty first
# line, or a placeholder such as "Release candidate rc-...". Must match
# titleProblem in scripts/greatstone-candidate.mjs.
rc_tag_title() {
  local repo="$1" tag="$2" type title
  type="$(git -C "$repo" cat-file -t "refs/tags/$tag" 2>/dev/null)" || { say "unknown tag $tag"; return 1; }
  [ "$type" = tag ] || { say "$tag has no title: it is a lightweight tag. Cut it with scripts/greatstone-candidate.mjs"; return 1; }
  title="$(git -C "$repo" for-each-ref --format='%(contents:subject)' "refs/tags/$tag")"
  title="$(printf '%s' "$title" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [ -z "$title" ] || [ "$title" = "$tag" ] || printf '%s' "$title" | grep -qiE '^(release candidate([^[:alnum:]]|$)|rc-[0-9])'; then
    say "$tag has no title (line 1 is \"$title\"). Cut it with scripts/greatstone-candidate.mjs --title \"...\""
    return 1
  fi
  say "$title"
}

# Records <dir> as the release repo in $GS_ROOT/release.conf, where the live
# server finds it to release from the app (GRE-121). Nothing removes this file,
# so it survives `greatstone-preview.sh stop` (GRE-71).
RELEASE_CONF_FILE="$GS_ROOT/release.conf"
record_release_repo() {
  mkdir -p "$GS_ROOT"
  printf 'release_repo=%s\n' "$1" >"$RELEASE_CONF_FILE.tmp" && mv "$RELEASE_CONF_FILE.tmp" "$RELEASE_CONF_FILE"
}

# Writes the release phase (switching, restarting) for the one-click release,
# when the launcher asked for it. The server shows it as progress.
release_phase() {
  [ -n "${GSAM_RELEASE_PHASE_FILE:-}" ] || return 0
  printf '%s\n' "$1" >"$GSAM_RELEASE_PHASE_FILE"
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
