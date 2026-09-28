#!/usr/bin/env bash
# Rehearses doc/AUTH-SWITCH-RUNBOOK.md on a throwaway sandbox (GRE-125):
# local_trusted -> authenticated + private -> close sign-up -> reset password
# -> back to local_trusted, with a real server started by `pnpm dev:once`.
#
#   scripts/auth-switch-sandbox-check.sh [data-dir]     (default: tmp/auth-switch-sandbox)
#
# Run from a worktree. The data dir must be under this checkout's tmp/ and is
# wiped first. The server runs with a clean environment on a free port, so it
# never reads ~/GSAM or talks to the live app. Prints PASS/FAIL per check and
# exits non-zero if any check fails.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$(cd "$ROOT" && mkdir -p "$(dirname "${1:-tmp/auth-switch-sandbox}")" && cd "$(dirname "${1:-tmp/auth-switch-sandbox}")" && pwd)/$(basename "${1:-tmp/auth-switch-sandbox}")"
case "$DATA_DIR" in
  "$ROOT"/tmp/*) ;;
  *) echo "refusing: data dir must be under $ROOT/tmp/ (got $DATA_DIR)" >&2; exit 2 ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/auth-switch-check.XXXXXX")"
JAR="$WORK/cookies"
FAILURES=0
RUNNER_PID=""
LOG_N=0

PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
BASE="http://localhost:$PORT"
OWNER_EMAIL="owner@example.com"
FIRST_PASSWORD="sandbox-first-password"
NEW_PASSWORD="sandbox-reset-password"

say() { printf '== %s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

# Only PATH and HOME reach the sandbox: an agent's GSAM_* variables (API URL,
# keys, instance) must not leak into it.
clean() { env -i HOME="$HOME" PATH="$PATH" "$@"; }
gsam() { (cd "$ROOT" && clean pnpm -s gsam "$@" --data-dir "$DATA_DIR"); }

descendants() {
  local pid child
  for pid in "$@"; do
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
      echo "$child"
      descendants "$child"
    done
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

# Embedded Postgres can outlive the server as an orphan. Stop it only when its
# command line names this sandbox's data dir.
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

start_server() {
  LOG_N=$((LOG_N + 1))
  LOG="$WORK/server-$LOG_N.log"
  (cd "$ROOT" && clean PORT="$PORT" pnpm dev:once --data-dir "$DATA_DIR" >"$LOG" 2>&1) &
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
expect_status() {
  local label="$1" want="$2" got
  shift 2
  got="$(status_of "$@")"
  case " $want " in
    *" $got "*) pass "$label ($got)" ;;
    *) fail "$label: wanted $want, got $got" ;;
  esac
}
mode_is() {
  local got
  got="$(curl -fsS "$BASE/api/health" | json_field deploymentMode)"
  [ "$got" = "$1" ] && pass "server runs $1" || fail "server runs $got, wanted $1"
}
sign_in() {
  rm -f "$JAR"
  status_of -c "$JAR" -X POST -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$1\"}" "$BASE/api/auth/sign-in/email"
}

# The dev runner refuses a linked worktree with no .gsam/.env; an empty one is
# enough because --data-dir supplies the instance.
if [ -f "$ROOT/.git" ] && [ ! -f "$ROOT/.gsam/.env" ]; then
  mkdir -p "$ROOT/.gsam"
  printf '# Sandbox-only worktree env. The data dir comes from --data-dir.\n' >"$ROOT/.gsam/.env"
fi
rm -rf "$DATA_DIR"

say "1. local_trusted, as the live install runs today (port $PORT, data $DATA_DIR)"
start_server
mode_is local_trusted
COMPANY_ID="$(curl -fsS -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"name":"Sandbox Co"}' "$BASE/api/companies" | json_field id)"
AGENT_ID="$(curl -fsS -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"name":"Worker","role":"engineer","adapterType":"process","adapterConfig":{"command":"true"}}' \
  "$BASE/api/companies/$COMPANY_ID/agents" | json_field id)"
AGENT_KEY="$(curl -fsS -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"name":"sandbox key"}' "$BASE/api/agents/$AGENT_ID/keys" | json_field token)"
RUN_TOKEN="$(cd "$ROOT/server" && clean GSAM_HOME="$DATA_DIR" GSAM_INSTANCE_ID=default \
  pnpm -s exec tsx ../scripts/auth-switch-sandbox-run-token.mts "$AGENT_ID" "$COMPANY_ID")"
expect_status "agent key works before the switch" 200 -H "authorization: Bearer $AGENT_KEY" "$BASE/api/agents/me"
expect_status "run token works before the switch" 200 -H "authorization: Bearer $RUN_TOKEN" "$BASE/api/agents/me"
stop_server

say "2. gsam auth mode authenticated, restart"
gsam auth mode authenticated >/dev/null
start_server
mode_is authenticated
for route in "/api/companies" "/api/companies/$COMPANY_ID/agents" "/api/companies/$COMPANY_ID/issues" "/api/instance/settings/general"; do
  expect_status "no session: GET $route refused" "401 403" "$BASE$route"
done
expect_status "no session: POST /api/companies refused" "401 403" -X POST -H 'content-type: application/json' \
  -H "origin: $BASE" -d '{"name":"x"}' "$BASE/api/companies"
expect_status "no session: dev-server restart refused" "401 403" -X POST "$BASE/api/health/dev-server/restart"
expect_status "agent key still works" 200 -H "authorization: Bearer $AGENT_KEY" "$BASE/api/agents/me"
expect_status "run token from before the switch still works" 200 -H "authorization: Bearer $RUN_TOKEN" "$BASE/api/agents/me"
expect_status "agent key reads company work" 200 -H "authorization: Bearer $AGENT_KEY" "$BASE/api/companies/$COMPANY_ID/issues"
expect_status "agent key is not a board session" "401 403" -H "authorization: Bearer $AGENT_KEY" "$BASE/api/instance/settings/general"

say "3. owner signs up once and claims the board"
expect_status "sign-up" 200 -c "$JAR" -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$FIRST_PASSWORD\",\"name\":\"Owner\"}" "$BASE/api/auth/sign-up/email"
CLAIM="$(sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -o 'board-claim/[^?]*?code=[A-Za-z0-9_-]*' | tail -n 1)"
[ -n "$CLAIM" ] && pass "server printed the board-claim link" || fail "no board-claim link in the server log"
CLAIM_TOKEN="${CLAIM#board-claim/}"; CLAIM_TOKEN="${CLAIM_TOKEN%%\?*}"; CLAIM_CODE="${CLAIM##*code=}"
expect_status "board claim" 200 -b "$JAR" -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"code\":\"$CLAIM_CODE\"}" "$BASE/api/board-claim/$CLAIM_TOKEN/claim"
expect_status "sign-in with the first password" 200 -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$FIRST_PASSWORD\"}" -c "$JAR" "$BASE/api/auth/sign-in/email"
expect_status "signed-in owner reads board routes" 200 -b "$JAR" "$BASE/api/instance/settings/general"
expect_status "signed-in owner sees the company" 200 -b "$JAR" "$BASE/api/companies/$COMPANY_ID/agents"
stop_server

say "4. gsam auth mode authenticated --sign-up closed, restart"
gsam auth mode authenticated --sign-up closed >/dev/null
start_server
expect_status "second sign-up refused" "400 403 422" -X POST -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"email":"second@example.com","password":"another-long-password","name":"Second"}' "$BASE/api/auth/sign-up/email"
[ "$(sign_in "$FIRST_PASSWORD")" = 200 ] && pass "owner still signs in" || fail "owner cannot sign in after closing sign-up"
OLD_JAR="$WORK/old-session"; cp "$JAR" "$OLD_JAR"

say "5. gsam auth reset-password (server running)"
if printf '%s\n' "$NEW_PASSWORD" | gsam auth reset-password --email "$OWNER_EMAIL" --password-stdin >/dev/null; then
  pass "reset-password command"
else
  fail "reset-password command"
fi
expect_status "old session signed out" "401 403" -b "$OLD_JAR" "$BASE/api/instance/settings/general"
[ "$(sign_in "$FIRST_PASSWORD")" = 401 ] && pass "old password refused" || fail "old password still accepted"
[ "$(sign_in "$NEW_PASSWORD")" = 200 ] && pass "new password accepted" || fail "new password refused"
expect_status "new session reads board routes" 200 -b "$JAR" "$BASE/api/instance/settings/general"
stop_server

say "6. way back: gsam auth mode local_trusted, restart"
gsam auth mode local_trusted >/dev/null
start_server
mode_is local_trusted
expect_status "board routes open again with no login" 200 "$BASE/api/instance/settings/general"
expect_status "company visible with no login" 200 "$BASE/api/companies/$COMPANY_ID/agents"
expect_status "agent key still works" 200 -H "authorization: Bearer $AGENT_KEY" "$BASE/api/agents/me"
expect_status "run token still works" 200 -H "authorization: Bearer $RUN_TOKEN" "$BASE/api/agents/me"
stop_server

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "auth switch sandbox check: all checks passed"
else
  echo "auth switch sandbox check: $FAILURES check(s) failed" >&2
  exit 1
fi
