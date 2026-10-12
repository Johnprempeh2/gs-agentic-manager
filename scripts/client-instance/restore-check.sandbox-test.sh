#!/usr/bin/env bash
# Sandbox test for `restore-check` (GRE-616). Sandbox data only.
#
#   scripts/client-instance/restore-check.sandbox-test.sh <empty scratch dir>
#
# Makes a Managed sandbox instance and leaves it running. Then: restore-check
# on the newest backup prints the OK line and leaves no throwaway database or
# process; a corrupt backup gives a FAILED line and a non-zero exit; `status`
# shows the last check, and a WARNING when it failed or is older than 7 days.
# The instance's server pid, database pid and ports are the same before and
# after. Stops the instance at the end. Never point it at a real instance.
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="${1:?usage: $0 <empty scratch dir>}"
mkdir -p "$S"
S="$(cd "$S" && pwd -P)"
[ -z "$(ls -A "$S")" ] || { echo "FAIL $S is not empty"; exit 1; }
mkdir -p "$S/tmp"

ROOT="$S/instances/c916"
CI="$CODE_DIR/scripts/client-instance.sh"
BACKUPS="$ROOT/instances/default/data/backups"
DB_DIR="$ROOT/instances/default/db"

# The runbook's clean environment: nothing from this shell reaches the instance.
clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 TMPDIR="$S/tmp" \
    PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
cleanup() { clean "$CI" stop --root "$ROOT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== create a Managed sandbox instance"
# Log-ins are not printed.
CREATE_OUT="$(clean "$CI" create --root "$ROOT" --edition managed)" || { echo "$CREATE_OUT" | grep -v -e 'Operator:' -e 'Client:'; fail "create"; }
echo "$CREATE_OUT" | grep -v -e 'Operator:' -e 'Client:'

# What must not change: server pid, database pid (and its port), the ports in client-instance.json.
fingerprint() {
  echo "server $(cat "$ROOT/server.pid")"
  echo "db $(head -n 4 "$DB_DIR/postmaster.pid" | tr '\n' ' ')"
  node -e 'const s=require(process.argv[1]);console.log(`ports ${s.port} ${s.dbPort}`)' "$ROOT/client-instance.json"
}
BEFORE="$(fingerprint)"
echo "$BEFORE"

no_leftovers() {
  [ -z "$(ls -A "$S/tmp" | grep '^client-instance-restore-check-' || true)" ] || fail "a throwaway folder is left in $S/tmp"
  ! pgrep -f "$S/tmp/client-instance-restore-check-" >/dev/null || fail "a throwaway database process is left"
  pass "no throwaway folder or process left"
}

echo "== restore-check on the newest backup"
OUT="$(clean "$CI" restore-check --root "$ROOT")" || { echo "$OUT"; fail "restore-check"; }
echo "$OUT"
echo "$OUT" | grep -Eq '^client-instance: restore-check OK: client-instance-.*, 1 company, [0-9]+ users?, [0-9]+ issues?$' \
  && pass "OK line" || fail "no OK line"
no_leftovers

echo "== status shows the last check"
STATUS="$(clean "$CI" status --root "$ROOT")"
echo "$STATUS"
echo "$STATUS" | grep -q 'last restore-check: restore-check OK' && pass "status shows the check" || fail "status"
! echo "$STATUS" | grep -q 'WARNING.*restore-check' && pass "no restore-check WARNING" || fail "unexpected WARNING"

echo "== a corrupt backup fails"
CORRUPT="$BACKUPS/sandbox-corrupt.sql.gz"
head -c 4096 /dev/urandom >"$CORRUPT"
if OUT="$(clean "$CI" restore-check --root "$ROOT" sandbox-corrupt.sql.gz 2>&1)"; then rm -f "$CORRUPT"; fail "restore-check accepted a corrupt backup"; fi
rm -f "$CORRUPT"
echo "$OUT"
echo "$OUT" | grep -q '^client-instance: restore-check FAILED: sandbox-corrupt.sql.gz: ' && pass "FAILED line and non-zero exit" || fail "wrong failure output"
no_leftovers
clean "$CI" status --root "$ROOT" | grep -q 'WARNING: the last restore-check failed' && pass "status warns after a failed check" || fail "no WARNING after failure"

echo "== a backup of another folder is refused"
if OUT="$(clean "$CI" restore-check --root "$ROOT" /etc/hosts 2>&1)"; then fail "restore-check accepted /etc/hosts"; fi
pass "refused: $OUT"

echo "== a check older than 7 days gives a WARNING"
clean "$CI" restore-check --root "$ROOT" >/dev/null || fail "restore-check"
node -e 'const f=process.argv[1],fs=require("fs"),s=JSON.parse(fs.readFileSync(f));s.lastRestoreCheck.at=new Date(Date.now()-8*864e5).toISOString();fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$ROOT/client-instance.json"
clean "$CI" status --root "$ROOT" | grep -q 'WARNING: no restore-check in the last 7 days' && pass "7-day WARNING" || fail "no 7-day WARNING"
clean "$CI" status --root "$ROOT" >/dev/null && pass "status exit code is still 0" || fail "status exit code"

echo "== the instance is not touched"
AFTER="$(fingerprint)"
[ "$BEFORE" = "$AFTER" ] && pass "server pid, database pid and ports unchanged" || { echo "$AFTER"; fail "the instance changed"; }
PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$ROOT/client-instance.json")"
curl -sS "http://127.0.0.1:$PORT/api/health" | grep -q '"status":"ok"' && pass "health ok" || fail "health"

echo "ALL PASSED"
