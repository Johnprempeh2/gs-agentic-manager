#!/usr/bin/env bash
# Sandbox test for pause, resume, archive and delete (GRE-1367). Sandbox data only.
#
#   RESTIC=/path/to/restic scripts/client-instance/lifecycle.sandbox-test.sh <empty scratch dir>
#
# Makes a Managed sandbox instance with a local off-host repository. Pause
# needs an operator and a reason, pauses the company in the app, stops the
# app; start is refused (exit 3), offsite-backup and restore-check skip.
# Resume proves no new use while paused (AT-4.6) and makes the company active
# again. Pause again, then archive: refused without a retention setting;
# then final backup, off-host copy checked in a sandbox, ports free, retention
# end recorded (AT-4.7). Past the retention end, status lists it as due for
# deletion and nothing is removed (AT-4.9). Delete is refused with a wrong
# code or no approval; then removes the instance folder and off-host copies
# and leaves one deletion record with no client data; a second run finds
# nothing (AT-4.8).
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="${1:?usage: RESTIC=<restic binary> $0 <empty scratch dir>}"
RESTIC="${RESTIC:-$(command -v restic || true)}"
[ -x "$RESTIC" ] || { echo "FAIL restic not found; set RESTIC=<path to the restic binary>"; exit 1; }
mkdir -p "$S"
S="$(cd "$S" && pwd -P)"
[ -z "$(ls -A "$S")" ] || { echo "FAIL $S is not empty"; exit 1; }
mkdir -p "$S/tmp" "$S/etc" "$S/offsite"
chmod 700 "$S/etc"

CODE=c931
ROOT="$S/instances/$CODE"
CI="$CODE_DIR/scripts/client-instance.sh"
COMPANY="Sandbox Lifecycle Co"
EMAIL="lifecycle-client@instance.invalid"

clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 TMPDIR="$S/tmp" \
    PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}
op() { clean CLIENT_INSTANCE_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" "$@"; }
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
cleanup() { [ -f "$ROOT/client-instance.json" ] && clean "$CI" stop --root "$ROOT" >/dev/null 2>&1 || true; }
trap cleanup EXIT
OFFSITE=(--offsite-config "$S/etc/$CODE-offsite.env" --restic "$RESTIC")

echo "== create a Managed sandbox instance and its off-host repository"
CREATE_OUT="$(clean "$CI" create --root "$ROOT" --edition managed --company-name "$COMPANY" --client-email "$EMAIL")" \
  || { echo "$CREATE_OUT" | grep -v -e 'Operator:' -e 'Client:'; fail "create"; }
OPERATOR_PASSWORD="$(echo "$CREATE_OUT" | awk '/Operator:/ {print $4}')"
[ -n "$OPERATOR_PASSWORD" ] || fail "no operator log-in in the create output"
PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$ROOT/client-instance.json")"
DB_PORT="$(node -e 'console.log(require(process.argv[1]).dbPort)' "$ROOT/client-instance.json")"
head -c 32 /dev/urandom | base64 >"$S/etc/$CODE.key"
printf 'RESTIC_REPOSITORY=%s\nRESTIC_PASSWORD_FILE=%s\nRESTIC_CACHE_DIR=%s\n' "$S/offsite/$CODE" "$S/etc/$CODE.key" "$S/tmp/restic-cache" >"$S/etc/$CODE-offsite.env"
chmod 600 "$S/etc/$CODE.key" "$S/etc/$CODE-offsite.env"
clean "$CI" offsite-init --root "$ROOT" "${OFFSITE[@]}" >/dev/null || fail "offsite-init"
clean "$CI" offsite-backup --root "$ROOT" "${OFFSITE[@]}" >/dev/null || fail "offsite-backup"

company_status() {
  node -e '
    const [base, password] = process.argv.slice(1);
    (async () => {
      const r = await fetch(base + "/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ email: "operator@instance.invalid", password }) });
      const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const list = await (await fetch(base + "/api/companies", { headers: { Cookie: cookie, Origin: base } })).json();
      console.log(list.map((c) => c.status).join(","));
    })();' "http://127.0.0.1:$PORT" "$OPERATOR_PASSWORD"
}
[ "$(company_status)" = "active" ] && pass "the company is active" || fail "company not active"

echo "== pause (AT-4.3)"
if OUT="$(op "$CI" pause --root "$ROOT" --operator sandbox-ops 2>&1)"; then fail "pause without a reason ran"; fi
echo "$OUT" | grep -q -- '--reason is required' && pass "pause needs a reason" || fail "wrong refusal: $OUT"
BACKUPS_BEFORE="$(ls "$ROOT/instances/default/data/backups" | wc -l)"
OUT="$(op "$CI" pause --root "$ROOT" --operator sandbox-ops --reason "sandbox pause test")" || { echo "$OUT"; fail "pause"; }
echo "$OUT"
echo "$OUT" | grep -q 'paused 1 company' && pass "the company is paused in the app" || fail "company not paused"
[ "$(ls "$ROOT/instances/default/data/backups" | wc -l)" -gt "$BACKUPS_BEFORE" ] && ls "$ROOT/instances/default/data/backups" | grep -q '^pre-pause' && pass "pause made a backup" || fail "no pause backup"
curl -s -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null && fail "the app still answers" || pass "the app is stopped"
[ -d "$S/offsite/$CODE" ] && [ -d "$ROOT/instances/default/db" ] && pass "data, backups and off-host repository stay" || fail "data removed by pause"
clean "$CI" status --root "$ROOT" | grep -q 'lifecycle: paused since .* by sandbox-ops: sandbox pause test' && pass "status shows paused" || fail "status"
set +e; clean "$CI" start --root "$ROOT" >/dev/null 2>&1; CODE_START=$?; set -e
[ "$CODE_START" = 3 ] && pass "start refused with exit 3" || fail "start exit code $CODE_START"
clean "$CI" offsite-backup --root "$ROOT" "${OFFSITE[@]}" | grep -q 'offsite-backup skipped: the instance is paused' && pass "offsite-backup skips" || fail "offsite-backup ran"
clean "$CI" restore-check --root "$ROOT" | grep -q 'restore-check skipped' && pass "restore-check skips" || fail "restore-check ran"

echo "== resume (AT-4.4, AT-4.6)"
if op "$CI" resume --root "$ROOT" --reason x >/dev/null 2>&1; then fail "resume without an operator ran"; fi
pass "resume needs an operator"
OUT="$(op "$CI" resume --root "$ROOT" --operator sandbox-ops --reason "sandbox resume test")" || { echo "$OUT"; fail "resume"; }
echo "$OUT"
echo "$OUT" | grep -q 'PASS no new use while paused (0 runs, 0 cost events, 0 finance events, 0 invoices added)' && pass "AT-4.6: no new use while paused" || fail "AT-4.6"
[ "$(company_status)" = "active" ] && pass "the company is active again" || fail "company not resumed"
clean "$CI" status --root "$ROOT" | grep -q 'lifecycle: active; resumed' && pass "status shows active" || fail "status after resume"

echo "== pause again, then archive (AT-4.7)"
op "$CI" pause --root "$ROOT" --operator sandbox-ops --reason "before archive" >/dev/null || fail "second pause"
if OUT="$(clean "$CI" archive --root "$ROOT" --operator sandbox-ops "${OFFSITE[@]}" --sandbox "$S/check" 2>&1)"; then fail "archive without a retention setting ran"; fi
echo "$OUT" | grep -q 'no default' && pass "archive needs John's retention setting" || fail "wrong refusal: $OUT"
OUT="$(clean "$CI" archive --root "$ROOT" --operator sandbox-ops --retention-days 30 "${OFFSITE[@]}" --sandbox "$S/check")" || { echo "$OUT"; fail "archive"; }
echo "$OUT"
echo "$OUT" | grep -q 'offsite-check OK' && pass "the off-host copy restores in a sandbox" || fail "no offsite-check OK"
[ -z "$(ls -A "$S/check")" ] && pass "the sandbox copy is deleted" || fail "copy left in $S/check"
for p in "$PORT" "$DB_PORT"; do
  node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(+process.argv[1],"127.0.0.1",()=>s.close())' "$p" && pass "port $p is free" || fail "port $p in use"
done
STATUS="$(clean "$CI" status --root "$ROOT")"
echo "$STATUS" | grep -q 'lifecycle: archived on .*retention 30 days, ends ' && pass "archive date and retention end recorded" || fail "status: $STATUS"
! echo "$STATUS" | grep -q 'DUE FOR DELETION' && pass "not due before the retention end" || fail "due too early"

echo "== retention end passed (AT-4.9)"
node -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.lastArchive.retentionEnd="2000-01-01T00:00:00.000Z";require("fs").writeFileSync(f,JSON.stringify(s,null,2))' "$ROOT/client-instance.json"
clean "$CI" status --root "$ROOT" | grep -q 'DUE FOR DELETION' && pass "status lists it as due for deletion" || fail "not listed as due"
[ -d "$ROOT/instances/default/db" ] && pass "nothing deleted automatically" || fail "data gone"

echo "== delete (AT-4.8)"
DEL=(--operator sandbox-ops "${OFFSITE[@]}")
if OUT="$(clean "$CI" delete --root "$ROOT" --confirm-code c999 --approval GRE-1367 "${DEL[@]}" 2>&1)"; then fail "delete with a wrong code ran"; fi
echo "$OUT" | grep -q 'does not match' && pass "wrong code refused" || fail "wrong refusal: $OUT"
if OUT="$(clean "$CI" delete --root "$ROOT" --confirm-code "$CODE" "${DEL[@]}" 2>&1)"; then fail "delete without approval ran"; fi
echo "$OUT" | grep -q -- '--approval <reference> is required' && pass "approval reference required" || fail "wrong refusal: $OUT"
[ -d "$ROOT/instances/default/db" ] && [ -d "$S/offsite/$CODE" ] && pass "refusals removed nothing" || fail "a refusal removed data"
OUT="$(clean "$CI" delete --root "$ROOT" --confirm-code "$CODE" --approval GRE-1367 "${DEL[@]}")" || { echo "$OUT"; fail "delete"; }
echo "$OUT"
echo "$OUT" | grep -q 'billing records: none' && pass "billing step ran first (no billing record)" || fail "no billing step"
[ ! -e "$ROOT" ] && pass "instance folder removed (data, local backups)" || fail "$ROOT still there"
[ ! -e "$S/offsite/$CODE" ] && [ ! -e "$S/etc/$CODE.key" ] && pass "off-host repository and key removed" || fail "off-host copy left"
RECORD="$S/instances/deletions/$CODE.json"
[ -f "$RECORD" ] && pass "one deletion record" || fail "no deletion record"
node -e 'const r=require(process.argv[1]);process.exit(r.code==="c931"&&r.approval==="GRE-1367"&&r.operator==="sandbox-ops"&&r.removed.length>0?0:1)' "$RECORD" && pass "record names code, approval, operator and what was removed" || fail "record fields"
! grep -q -e "$COMPANY" -e "$EMAIL" -e "$OPERATOR_PASSWORD" "$RECORD" && pass "record holds no client data" || fail "client data in the record"
OUT="$(clean "$CI" delete --root "$ROOT" --confirm-code "$CODE" --approval GRE-1367 "${DEL[@]}")" || fail "second delete failed"
echo "$OUT" | grep -q 'nothing to delete' && pass "second run finds nothing" || fail "second run: $OUT"

echo "ALL PASS"
