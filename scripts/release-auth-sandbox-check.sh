#!/usr/bin/env bash
# Checks that the release scripts reach the live API in both modes (GRE-136):
# the restart request, the serverInfo read and the active-run count, through
# the helpers in scripts/greatstone-common.sh, against a throwaway sandbox.
#
#   scripts/release-auth-sandbox-check.sh [data-dir]     (default: tmp/release-auth-sandbox)
#
# Run from a worktree. The data dir must be under this checkout's tmp/ and is
# wiped first. The server runs with a clean environment on a free port, so it
# never reads ~/GSAM or talks to the live app. GSAM_ROOT and the board key file
# point into a scratch folder. Prints PASS/FAIL per check; exits non-zero if
# any check fails.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$(cd "$ROOT" && mkdir -p "$(dirname "${1:-tmp/release-auth-sandbox}")" && cd "$(dirname "${1:-tmp/release-auth-sandbox}")" && pwd)/$(basename "${1:-tmp/release-auth-sandbox}")"
case "$DATA_DIR" in
  "$ROOT"/tmp/*) ;;
  *) echo "refusing: data dir must be under $ROOT/tmp/ (got $DATA_DIR)" >&2; exit 2 ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/release-auth-check.XXXXXX")"
JAR="$WORK/cookies"
FAILURES=0
RUNNER_PID=""
LOG_N=0

PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
BASE="http://localhost:$PORT"
AUTH_SECRET="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"

# The helpers under test, pointed at the sandbox and a scratch GSAM root.
export GSAM_ROOT="$WORK/gsam-root"
export GSAM_LIVE_URL="$BASE"
export GSAM_LIVE_BOARD_KEY_FILE="$GSAM_ROOT/release-board-key"
mkdir -p "$GSAM_ROOT"
source "$ROOT/scripts/greatstone-common.sh"

say() { printf '== %s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

clean() { env -i HOME="$HOME" PATH="$PATH" "$@"; }

descendants() {
  local pid child
  for pid in "$@"; do
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
      echo "$child"
      descendants "$child"
    done
  done
}

stop_sandbox_postgres() {
  local pid_file="$DATA_DIR/instances/default/db/postmaster.pid" pid
  [ -f "$pid_file" ] || return 0
  pid="$(head -n 1 "$pid_file")"
  [ -n "$pid" ] && ps -o command= -p "$pid" 2>/dev/null | grep -qF -- "$DATA_DIR/" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
}

stop_server() {
  [ -n "$RUNNER_PID" ] || return 0
  local pids
  pids="$RUNNER_PID $(descendants "$RUNNER_PID" | tr '\n' ' ')"
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 $pids 2>/dev/null || break
    sleep 1
  done
  kill -KILL $pids 2>/dev/null || true
  wait "$RUNNER_PID" 2>/dev/null || true
  RUNNER_PID=""
  stop_sandbox_postgres
}

# start_server [dev-runner flags]: `--bind custom --bind-host 127.0.0.1` runs
# authenticated + private on loopback, as live will after GRE-125.
start_server() {
  LOG_N=$((LOG_N + 1))
  LOG="$WORK/server-$LOG_N.log"
  (cd "$ROOT" && clean PORT="$PORT" BETTER_AUTH_SECRET="$AUTH_SECRET" pnpm dev:once --data-dir "$DATA_DIR" "$@" >"$LOG" 2>&1) &
  RUNNER_PID=$!
  for _ in $(seq 1 120); do
    sleep 2
    if curl -fsS -m 2 "$BASE/api/health" >/dev/null 2>&1; then return 0; fi
    kill -0 "$RUNNER_PID" 2>/dev/null || break
  done
  echo "server did not start; log: $LOG" >&2
  tail -40 "$LOG" >&2
  exit 1
}

cleanup() {
  stop_server
  if [ "$FAILURES" -eq 0 ]; then rm -rf "$WORK"; else echo "logs kept in $WORK" >&2; fi
}
trap cleanup EXIT

json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(v??"")})' "$1"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# The restart request as greatstone-release.sh sends it. The sandbox has no
# pending change, so an accepted caller gets 409 restart_not_required (or 404
# when no supervisor runs); a refused caller gets 401/403.
restart_status() { live_curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$BASE/api/health/dev-server/restart"; }
expect_restart() {
  local label="$1" want="$2" got
  got="$(restart_status)"
  case " $want " in
    *" $got "*) pass "$label ($got)" ;;
    *) fail "$label: wanted $want, got $got" ;;
  esac
}
expect_started_at() {
  local got
  got="$(health_field "$BASE" serverInfo.processStartedAt)"
  if [ "$1" = shown ]; then
    [ -n "$got" ] && pass "$2 ($got)" || fail "$2: serverInfo.processStartedAt is empty"
  else
    [ -z "$got" ] && pass "$2" || fail "$2: got $got"
  fi
}
expect_active_runs() {
  local got
  if got="$(active_runs "$BASE" 2>"$WORK/active-runs.err")"; then
    [ "$1" = ok ] && [ "$got" = 0 ] && pass "$2 ($got)" || fail "$2: answered $got"
  else
    [ "$1" = refused ] && pass "$2 ($(head -c 80 "$WORK/active-runs.err"))" || fail "$2: $(cat "$WORK/active-runs.err")"
  fi
}

if [ -f "$ROOT/.git" ] && [ ! -f "$ROOT/.gsam/.env" ]; then
  mkdir -p "$ROOT/.gsam"
  printf '# Sandbox-only worktree env. The data dir comes from --data-dir.\n' >"$ROOT/.gsam/.env"
fi
rm -rf "$DATA_DIR"

say "1. local_trusted, no key file (today's live)"
start_server
curl -fsS -X POST -H 'content-type: application/json' -H "origin: $BASE" -d '{"name":"Sandbox Co"}' "$BASE/api/companies" >/dev/null
live_board_key_check >/dev/null && pass "no key file is fine" || fail "no key file refused"
expect_started_at shown "serverInfo shown with no key"
expect_restart "restart accepted with no key" "200 404 409"
expect_active_runs ok "active_runs with no key"
stop_server

say "2. authenticated + private: owner signs up, claims the board, makes a board key"
start_server --bind custom --bind-host 127.0.0.1
[ "$(curl -fsS "$BASE/api/health" | json_field deploymentMode)" = authenticated ] && pass "server runs authenticated" || fail "server not authenticated"
curl -fsS -c "$JAR" -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"email":"owner@example.com","password":"sandbox-owner-password","name":"Owner"}' "$BASE/api/auth/sign-up/email" >/dev/null
CLAIM="$(sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -o 'board-claim/[^?]*?code=[A-Za-z0-9_-]*' | tail -n 1)"
CLAIM_TOKEN="${CLAIM#board-claim/}"; CLAIM_TOKEN="${CLAIM_TOKEN%%\?*}"; CLAIM_CODE="${CLAIM##*code=}"
curl -fsS -b "$JAR" -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"code\":\"$CLAIM_CODE\"}" "$BASE/api/board-claim/$CLAIM_TOKEN/claim" >/dev/null
curl -fsS -c "$JAR" -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"email":"owner@example.com","password":"sandbox-owner-password"}' "$BASE/api/auth/sign-in/email" >/dev/null
BOARD_KEY="$(curl -fsS -b "$JAR" -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"name":"live-release"}' "$BASE/api/board-api-keys" | json_field token)"
[ -n "$BOARD_KEY" ] && pass "board key created" || fail "no board key"

say "3. authenticated, no key file: every call refused"
expect_started_at hidden "serverInfo hidden with no key"
expect_restart "restart refused with no key" "401 403"
expect_active_runs refused "active_runs refused with no key"

say "4. authenticated, key file with mode 0644: refused before any call"
printf '%s\n' "$BOARD_KEY" >"$GSAM_LIVE_BOARD_KEY_FILE"
chmod 644 "$GSAM_LIVE_BOARD_KEY_FILE"
live_board_key_check >/dev/null && fail "0644 key file accepted" || pass "0644 key file refused"

say "5. authenticated, key file with mode 0600: every call works"
chmod 600 "$GSAM_LIVE_BOARD_KEY_FILE"
live_board_key_check >/dev/null && pass "0600 key file accepted" || fail "0600 key file refused"
expect_started_at shown "serverInfo shown with the key"
expect_restart "restart accepted with the key" "200 404 409"
expect_active_runs ok "active_runs with the key"

say "6. authenticated, wrong key: every call refused"
printf 'pcp_board_%s\n' "$(printf '0%.0s' $(seq 1 48))" >"$GSAM_LIVE_BOARD_KEY_FILE"
expect_started_at hidden "serverInfo hidden with a wrong key"
expect_restart "restart refused with a wrong key" "401 403"
expect_active_runs refused "active_runs refused with a wrong key"
stop_server

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "release auth sandbox check: all checks passed"
else
  echo "release auth sandbox check: $FAILURES check(s) failed" >&2
  exit 1
fi
