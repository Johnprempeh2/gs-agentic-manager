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

# Checks the live checkout for a leftover .git/index.lock before anything is
# backed up or tagged: with it, the checkout that moves live fails after the
# backup and the new live-* tag exist (GRE-180). A lock that is empty, older
# than GSAM_INDEX_LOCK_STALE_SECONDS (default 600), not open in any process
# and with no git process in the live checkout is left over from a crash; it
# is removed and said so. Any other lock fails with the reason and the path.
# When lsof is missing no process check is possible, so the lock stays.
live_index_lock_check() {
  local git_dir lock age max="${GSAM_INDEX_LOCK_STALE_SECONDS:-600}"
  git_dir="$(git -C "$LIVE_DIR" rev-parse --absolute-git-dir 2>/dev/null)" || return 0
  lock="$git_dir/index.lock"
  [ -e "$lock" ] || return 0
  command -v lsof >/dev/null 2>&1 \
    || { say "$lock exists and lsof is missing, so it cannot be checked; remove it by hand once no git command runs in $LIVE_DIR. Nothing was changed."; return 1; }
  [ ! -s "$lock" ] || { say "$lock exists and is not empty: a git command may be running in $LIVE_DIR. Nothing was changed."; return 1; }
  age="$(perl -e 'printf "%d", time - (stat shift)[9]' "$lock")"
  [ "$age" -ge "$max" ] || { say "$lock is ${age}s old (under ${max}s): a git command may be running in $LIVE_DIR. Nothing was changed."; return 1; }
  [ -z "$(lsof -t -- "$lock" 2>/dev/null)" ] || { say "$lock is open in process $(lsof -t -- "$lock" 2>/dev/null | tr '\n' ' '); a git command runs in $LIVE_DIR. Nothing was changed."; return 1; }
  if lsof -a -c git -d cwd -Fn 2>/dev/null | grep -qxF "n$(cd "$LIVE_DIR" && pwd -P)"; then
    say "$lock exists and a git process runs in $LIVE_DIR. Nothing was changed."
    return 1
  fi
  rm -f -- "$lock" || { say "$lock is stale but could not be removed. Nothing was changed."; return 1; }
  say "Removed a stale $lock (empty, ${age}s old, no git process)."
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

# Makes the annotated <live-tag> on <commit> with the message of <rc-tag>: its
# title and changelog (GRE-120). The one place a live-* tag is made, for a
# release from the app and a release by hand alike.
tag_live_release() {
  local repo="$1" rc="$2" live="$3" commit="$4"
  git -C "$repo" for-each-ref --format='%(contents:subject)%0a%0a%(contents:body)' "refs/tags/$rc" \
    | git -C "$repo" tag -a "$live" "$commit" --cleanup=whitespace -F -
}

# drop_unpushed_live_tag <release-repo> <live-dir> <live-tag>
# After a failed release (GRE-239): deletes a live-* tag that origin does not
# have, in the release repo and in the live checkout. A pushed tag is kept.
# The release pushes only after live is healthy, so when origin cannot be
# asked the tag is taken as unpushed.
drop_unpushed_live_tag() {
  local repo="$1" live="$2" tag="$3" remote
  case "$tag" in live-*) ;; *) return 0 ;; esac
  remote="$(git -C "$repo" ls-remote --tags origin "refs/tags/$tag" 2>/dev/null)" || remote=""
  [ -z "$remote" ] || return 0
  git -C "$repo" tag -d "$tag" >/dev/null 2>&1 && say "Deleted the unpushed tag $tag: that version did not run healthy." >&2
  git -C "$live" tag -d "$tag" >/dev/null 2>&1 || true
}

# Fails with the reason when the release scripts in <repo> are not those on
# origin/main (fetch first). A dev checkout that was not pulled runs an old
# release script; before GRE-120 that one wrote a generic live tag message
# with no title or changelog (GRE-178).
RELEASE_SCRIPT_FILES=(scripts/greatstone-release.sh scripts/greatstone-common.sh scripts/greatstone-live-release.sh)
release_scripts_current() {
  local repo="$1" files
  files="$(git -C "$repo" diff --name-only origin/main -- "${RELEASE_SCRIPT_FILES[@]}" 2>&1)" \
    || { say "cannot compare the release scripts in $repo with origin/main ($files)"; return 1; }
  [ -z "$files" ] && return 0
  say "the release scripts in $repo are not the ones on origin/main ($(printf '%s' "$files" | tr '\n' ' ' | sed 's/ $//')); run: git -C $repo pull --ff-only origin main, then release again. Nothing was changed."
  return 1
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

# Prints the PIDs whose command line matches <pattern> (extended regex) and
# whose working folder is <dir> or inside it. The folder tells live (~/GSAM/live)
# from the preview (~/GSAM/preview/code) and from sandboxes in worktrees.
pids_in_dir() {
  local dir="$1" pattern="$2" pid cwd
  for pid in $(pgrep -f -- "$pattern" 2>/dev/null || true); do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    case "$cwd" in "$dir" | "$dir"/*) printf '%s\n' "$pid" ;; esac
  done
}

# Waits up to <seconds> for every PID in the list to exit. Fails if one is left.
wait_gone() {
  local secs="$1"
  shift
  [ "$#" -gt 0 ] || return 0
  for _ in $(seq 1 "$secs"); do
    kill -0 "$@" 2>/dev/null || return 0
    sleep 1
  done
  ! kill -0 "$@" 2>/dev/null
}

# Stops the whole live server (GRE-442): its dev runner, every server tree in
# the live checkout the runner leaves behind, and the live database. Before
# #274 a stopped runner on Linux orphaned tsx, the server and PostgreSQL (the
# 2 Oct bug), so each step looks for what the step before it left. Fails, and
# names what is still running on stderr; then nothing new may start.
stop_live_server() {
  local dir pids pgfile pgpid left
  dir="$(cd -P "$LIVE_DIR" && pwd)"
  pids="$(pids_in_dir "$dir" 'dev-runner\.ts')"
  if [ -n "$pids" ]; then
    say "Stopping the live dev runner (pid $(echo $pids))..."
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    # The runner from #274 on stops its server group in up to ~15s.
    # shellcheck disable=SC2086
    wait_gone 30 $pids || { printf '%s\n' "the live dev runner (pid $(echo $pids)) did not stop within 30s" >&2; return 1; }
  fi
  # tsx passes SIGTERM on to the server, which writes its hot-restart snapshot
  # and stops PostgreSQL. Only tsx gets it: a second SIGTERM to the server
  # itself could cut that short.
  pids="$(pids_in_dir "$dir" 'tsx/dist/cli\.mjs .*src/index\.ts')"
  if [ -n "$pids" ]; then
    say "Stopping the live server left by the runner (tsx pid $(echo $pids))..."
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    # shellcheck disable=SC2086
    wait_gone 30 $pids || true
  fi
  # A server with no tsx above it.
  pids="$(pids_in_dir "$dir" 'src/index\.ts')"
  if [ -n "$pids" ]; then
    say "Stopping the live server process (pid $(echo $pids))..."
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    # shellcheck disable=SC2086
    wait_gone 30 $pids || true
  fi
  # The live database, if it outlived the server. SIGINT is a fast shutdown.
  pgfile="$LIVE_DATA_DIR/instances/$INSTANCE_ID/db/postmaster.pid"
  pgpid="$(sed -n 1p "$pgfile" 2>/dev/null || true)"
  if [ -n "$pgpid" ] && kill -0 "$pgpid" 2>/dev/null; then
    say "Stopping the live database (pid $pgpid)..."
    kill -INT "$pgpid" 2>/dev/null || true
    wait_gone 30 "$pgpid" || true
  fi
  left="$(pids_in_dir "$dir" 'dev-runner\.ts|src/index\.ts')"
  if [ -n "$pgpid" ] && kill -0 "$pgpid" 2>/dev/null; then left="$left $pgpid"; fi
  if [ -n "$(echo $left)" ]; then
    printf '%s\n' "these live processes did not stop: $(echo $left) (see: ps -o pid,pgid,args -p $(echo $left | tr ' ' ','))" >&2
    return 1
  fi
  if curl -fsS -m 2 -o /dev/null "$LIVE_URL/api/health" 2>/dev/null; then
    printf '%s\n' "a server still answers on $LIVE_URL after live was stopped" >&2
    return 1
  fi
}

# Starts live with $GS_ROOT/start-live.sh in a session of its own, so that the
# end of the session this script runs in (a closed terminal, an SSH logout, the
# end of a wsl.exe call) cannot hang up the live server. On 3 Oct 2026 the end
# of the wsl.exe call that ran a --full-restart release stopped live moments
# after it reported healthy. --wait keeps the exit status of start-live.sh.
# macOS has no setsid; there start-live.sh runs directly, as before.
start_live_server() {
  if command -v setsid >/dev/null 2>&1; then
    setsid --wait "$GS_ROOT/start-live.sh" </dev/null
  else
    "$GS_ROOT/start-live.sh" </dev/null
  fi
}
