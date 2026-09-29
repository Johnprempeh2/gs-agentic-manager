#!/usr/bin/env bash
# Sandbox test for `upgrade` and `restore` (GRE-130). Sandbox data only.
#
#   scripts/client-instance/upgrade-restore.sandbox-test.sh <empty scratch dir> [from ref] [to ref]
#
# Makes a sandbox git repo with two stable-* tags (from ref, to ref; default
# origin/main and HEAD), a release folder for the first tag, and a Managed
# instance on it. Then: refuses a non-stable tag and an unknown tag; upgrades
# to the second tag; changes data; restores the pre-upgrade backup; checks
# that the instance runs the first tag again, with the old data, and passes
# health and verify. Stops the instance at the end. Takes about 10 minutes
# (two clones with pnpm install). Never point it at a real instance.
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="${1:?usage: $0 <empty scratch dir> [from ref] [to ref]}"
FROM_REF="${2:-origin/main}"
TO_REF="${3:-HEAD}"
mkdir -p "$S"
S="$(cd "$S" && pwd)"
[ -z "$(ls -A "$S")" ] || { echo "FAIL $S is not empty"; exit 1; }
mkdir -p "$S/tmp"

ROOT="$S/instances/c901"
RELEASES="$S/instances/releases"
REPO="$S/repo.git"
DAY="$(date +%Y-%m-%d)"
TAG1="stable-$DAY.1"
TAG2="stable-$DAY.2"

# The runbook's clean environment: nothing from this shell reaches the instance.
clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 TMPDIR="$S/tmp" \
    PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
cleanup() { clean "$CODE_DIR/scripts/client-instance.sh" stop --root "$ROOT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== sandbox repo with $TAG1 ($FROM_REF) and $TAG2 ($TO_REF)"
git clone --quiet --bare "$CODE_DIR" "$REPO"
git -C "$REPO" tag -a "$TAG1" "$(git -C "$CODE_DIR" rev-parse "$FROM_REF")" -m "Sandbox test release 1"
git -C "$REPO" tag -a "$TAG2" "$(git -C "$CODE_DIR" rev-parse "$TO_REF")" -m "Sandbox test release 2"

echo "== release folder for $TAG1 (as in the runbook)"
REL1="$RELEASES/$TAG1"
git clone --quiet --branch "$TAG1" "$REPO" "$REL1"
git -C "$REL1" remote set-url --push origin DISABLED
(cd "$REL1" && clean pnpm install --frozen-lockfile >/dev/null && clean pnpm --filter @greatstone/plugin-sdk build >/dev/null)

echo "== create a Managed sandbox instance on $TAG1"
# Log-ins stay in this shell only; they are not printed.
CREATE_OUT="$(clean "$REL1/scripts/client-instance.sh" create --root "$ROOT" --edition managed)" || { echo "$CREATE_OUT" | grep -v -e 'Operator:' -e 'Client:'; fail "create"; }
echo "$CREATE_OUT" | grep -v -e 'Operator:' -e 'Client:'
OPERATOR_PASSWORD="$(echo "$CREATE_OUT" | awk '/Operator:/ {print $4}')"
PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$ROOT/client-instance.json")"
BASE="http://127.0.0.1:$PORT"
[ -n "$OPERATOR_PASSWORD" ] || fail "no operator log-in in the create output"

runs_from() {
  lsof -a -d cwd -p "$(cat "$ROOT/server.pid")" -Fn | sed -n 's/^n//p'
}
[ "$(runs_from)" = "$REL1" ] && pass "instance runs from $TAG1" || fail "instance runs from $(runs_from)"

JAR="$S/tmp/cookies"
api() { curl -sS -b "$JAR" -c "$JAR" -H "Origin: $BASE" -H "Content-Type: application/json" "$@"; }
sign_in() {
  rm -f "$JAR"
  api -o /dev/null -X POST "$BASE/api/auth/sign-in/email" \
    -d "{\"email\":\"operator@instance.invalid\",\"password\":\"$OPERATOR_PASSWORD\"}"
}
company_name() { api "$BASE/api/companies" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].name))'; }
company_id() { api "$BASE/api/companies" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].id))'; }
sign_in
BEFORE="$(company_name)"
pass "company name before upgrade: $BEFORE"

echo "== upgrade refuses tags that are not stable-* tags"
for bad in "live-$DAY.1" "stable-$DAY" "stable-2026-13-01.1"; do
  if out="$(clean "$CODE_DIR/scripts/client-instance.sh" upgrade "$ROOT" "$bad" --repo "$REPO" --releases "$RELEASES" 2>&1)"; then
    fail "upgrade accepted $bad"
  fi
  echo "$out" | grep -q "is not a stable-\* tag" && pass "refused $bad: $out" || fail "wrong error for $bad: $out"
done
if out="$(clean "$CODE_DIR/scripts/client-instance.sh" upgrade "$ROOT" "stable-2099-01-01.1" --repo "$REPO" --releases "$RELEASES" 2>&1)"; then
  fail "upgrade accepted a tag that does not exist"
fi
echo "$out" | grep -q "is not in" && pass "refused an unknown tag: $out" || fail "wrong error for unknown tag: $out"
[ "$(runs_from)" = "$REL1" ] && pass "a refused upgrade leaves the instance on $TAG1" || fail "instance moved"

echo "== upgrade to $TAG2"
clean "$CODE_DIR/scripts/client-instance.sh" upgrade "$ROOT" "$TAG2" --repo "$REPO" --releases "$RELEASES" || fail "upgrade"
REL2="$RELEASES/$TAG2"
[ "$(runs_from)" = "$REL2" ] && pass "instance runs from $TAG2" || fail "instance runs from $(runs_from)"
clean CLIENT_INSTANCE_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" "$CODE_DIR/scripts/client-instance.sh" verify --root "$ROOT" >/dev/null \
  && pass "verify after upgrade" || fail "verify after upgrade"
BACKUP="$(node -e 'console.log(require(process.argv[1]).lastUpgrade.backupFile)' "$ROOT/client-instance.json")"
case "$BACKUP" in "$ROOT"/instances/default/data/backups/pre-upgrade*) pass "pre-upgrade backup in the instance folder: $(basename "$BACKUP")";; *) fail "backup at $BACKUP";; esac

echo "== change data after the upgrade"
sign_in
api -o /dev/null -X PATCH "$BASE/api/companies/$(company_id)" -d '{"name":"Changed after upgrade"}'
[ "$(company_name)" = "Changed after upgrade" ] && pass "company renamed after upgrade" || fail "rename did not stick"

echo "== restore refuses a backup that is not the pre-upgrade one"
if out="$(clean "$CODE_DIR/scripts/client-instance.sh" restore "$ROOT" /etc/hosts 2>&1)"; then fail "restore accepted /etc/hosts"; fi
pass "refused: $out"

echo "== restore to $TAG1 with the pre-upgrade backup"
clean "$CODE_DIR/scripts/client-instance.sh" restore "$ROOT" "$BACKUP" || fail "restore"
[ "$(runs_from)" = "$REL1" ] && pass "instance runs from $TAG1 again" || fail "instance runs from $(runs_from)"
curl -sS "$BASE/api/health" | grep -q '"status":"ok"' && pass "health ok after restore" || fail "health after restore"
sign_in
AFTER="$(company_name)"
[ "$AFTER" = "$BEFORE" ] && pass "data is the pre-upgrade data (company name: $AFTER)" || fail "company name after restore: $AFTER"
clean CLIENT_INSTANCE_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" "$CODE_DIR/scripts/client-instance.sh" verify --root "$ROOT" >/dev/null \
  && pass "verify after restore" || fail "verify after restore"
ls "$ROOT"/instances/default/data/backups/pre-restore* >/dev/null && pass "safety backup of the post-upgrade data kept" || fail "no safety backup"

echo "ALL PASSED"
