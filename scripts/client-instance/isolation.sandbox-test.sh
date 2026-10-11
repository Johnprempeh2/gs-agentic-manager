#!/usr/bin/env bash
# Isolation sandbox test (GRE-1362: AT-3.1, AT-3.5, AT-3.6 on GRE-1357). Sandbox data only.
#
#   RESTIC=/path/to/restic scripts/client-instance/isolation.sandbox-test.sh <empty scratch dir>
#
# Makes a sandbox hub (internal edition, GSAM_FLEET_HUB=true) and two Managed
# client instances, A (c951) and B (c952), with the same create command. Both
# register with the hub through a local proxy that records every message.
#
# AT-3.1  verify passes on both; the two differ only in root, ports, database,
#         secrets and keys (files, health, feature switches, settings, company).
# AT-3.5  A's port serves no record of B; A's log-ins and session cookie fail
#         on B; each database refuses the other's password; B refuses A's
#         backup; B's master key cannot open A's secret; B's restic key cannot
#         read A's off-host repository; A's fleet key cannot check in or revoke
#         as B, and a replayed check-in is refused; every /api/fleet route is
#         404 on a client instance, for the client board user too.
# AT-3.6  every signed check-in (decoded) and the hub's stored check-ins hold
#         none of the seeded issue, comment, document, project or secret text,
#         ids, e-mails or company name.
#
# Stops all three instances at the end. Takes about 10 minutes.
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="${1:?usage: RESTIC=<restic binary> $0 <empty scratch dir>}"
RESTIC="${RESTIC:-$(command -v restic || true)}"
[ -x "$RESTIC" ] || { echo "FAIL restic not found; set RESTIC=<path to the restic binary>"; exit 1; }
mkdir -p "$S"
S="$(cd "$S" && pwd -P)"
[ -z "$(ls -A "$S")" ] || { echo "FAIL $S is not empty"; exit 1; }
mkdir -p "$S/tmp" "$S/etc" "$S/offsite" "$S/out"
chmod 700 "$S/etc"

HUB="$S/hub/c950"
A="$S/instances/c951"
B="$S/instances/c952"
CI="$CODE_DIR/scripts/client-instance.sh"
TSX="$CODE_DIR/cli/node_modules/tsx/dist/cli.mjs"
CAPTURE="$S/out/hub-requests.jsonl"

clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 TMPDIR="$S/tmp" \
    PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
# helper takes its log-ins as VAR=value words before the command: helper_run [VAR=value...] -- <command> <args>
helper_run() {
  local vars=()
  while [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  (cd "$CODE_DIR" && clean "${vars[@]}" node "$TSX" "$CODE_DIR/scripts/client-instance/isolation-helper.ts" "$@")
}
# The app allows 3 sign-ins per 10 s; each step below signs in again.
pause_sign_in() { sleep 11; }
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

PROXY_PID_FILE="$S/tmp/proxy.pid"
cleanup() {
  for root in "$A" "$B" "$HUB"; do
    [ -f "$root/client-instance.json" ] && clean "$CI" stop --root "$root" >/dev/null 2>&1 || true
  done
  # tsx runs the proxy in a child process, which writes its own pid.
  if [ -f "$PROXY_PID_FILE" ]; then
    PROXY_PID="$(cat "$PROXY_PID_FILE")"
    kill "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# create prints two log-ins once; keep them in this shell only.
create() {
  local root="$1"; shift
  local out
  out="$(clean "$@" "$CI" create --root "$root" --edition "${EDITION:-managed}" ${FLEET_HUB:+--fleet-hub "$FLEET_HUB"})" \
    || { echo "$out" | grep -v -e 'Operator:' -e 'Client:'; fail "create $root"; }
  echo "$out" | grep -v -e 'Operator:' -e 'Client:' | grep -e 'instance folder' -e 'checks passed' -e 'fleet-register' || true
  CREATED_OPERATOR="$(echo "$out" | awk '/Operator:/ {print $4}')"
  CREATED_CLIENT="$(echo "$out" | awk '/Client:/ {print $4}')"
  [ -n "$CREATED_OPERATOR" ] && [ -n "$CREATED_CLIENT" ] || fail "no log-ins in the create output for $root"
}
CLIENT_EMAIL="client@instance.invalid"

echo "== sandbox hub c950 (internal edition, then started with GSAM_FLEET_HUB=true)"
EDITION=internal create "$HUB"
HUB_OPERATOR="$CREATED_OPERATOR"
clean "$CI" stop --root "$HUB" >/dev/null
HUB_PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$HUB/client-instance.json")"
HUB_URL="http://127.0.0.1:$HUB_PORT"
# The same clean environment the script gives a server, plus the hub switch.
# Written to server.pid so `stop --root` ends it like any instance.
UI_DEV=true; [ -f "$CODE_DIR/ui/dist/index.html" ] && UI_DEV=false
(cd "$CODE_DIR" && clean GSAM_HOME="$HUB" GSAM_INSTANCE_ID=default GSAM_CONFIG="$HUB/instances/default/config.json" PORT="$HUB_PORT" \
  GSAM_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 GSAM_MIGRATION_AUTO_APPLY=true GSAM_MIGRATION_PROMPT=never GSAM_UI_DEV_MIDDLEWARE="$UI_DEV" \
  GSAM_FLEET_HUB=true SHELL=/bin/bash COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  node -e '
    const fs = require("fs");
    const log = fs.openSync(process.argv[1], "a");
    const child = require("child_process").spawn("pnpm", ["--filter", "@greatstone/server", "exec", "tsx", "src/index.ts"], { detached: true, stdio: ["ignore", log, log] });
    fs.writeFileSync(process.argv[2], `${child.pid}\n`);
    child.unref();
  ' "$HUB/server.log" "$HUB/server.pid")
for _ in $(seq 1 150); do
  curl -sf "$HUB_URL/api/health" | grep -q '"status":"ok"' && break
  sleep 2
done
curl -sf "$HUB_URL/api/health" | grep -q '"status":"ok"' || fail "hub did not start; see $HUB/server.log"
HUB_JAR="$S/tmp/hub-cookies"
hub_api() { curl -sS -b "$HUB_JAR" -c "$HUB_JAR" -H "Origin: $HUB_URL" -H "Content-Type: application/json" "$@"; }
hub_api -o /dev/null -X POST "$HUB_URL/api/auth/sign-in/email" -d "{\"email\":\"operator@instance.invalid\",\"password\":\"$HUB_OPERATOR\"}"
[ "$(hub_api -o /dev/null -w '%{http_code}' "$HUB_URL/api/fleet/instances")" = 200 ] && pass "hub answers /api/fleet as its instance admin" || fail "hub /api/fleet"

echo "== recording proxy in front of the hub"
PROXY_PORT="$(free_port)"
helper_run -- proxy "$PROXY_PORT" "$HUB_URL" "$CAPTURE" "$PROXY_PID_FILE" &
sleep 3
FLEET_HUB="http://127.0.0.1:$PROXY_PORT"

registration_code() { hub_api -X POST "$HUB_URL/api/fleet/instances" -d "{\"code\":\"$1\"}" | json 'v.registrationCode'; }

echo "== AT-3.1: create A and B with the same command"
CODE_A="$(registration_code c951)"; CODE_B="$(registration_code c952)"
[ -n "$CODE_A" ] && [ -n "$CODE_B" ] || fail "no registration codes from the hub"
create "$A" CLIENT_INSTANCE_FLEET_CODE="$CODE_A"
A_OPERATOR="$CREATED_OPERATOR"; A_CLIENT="$CREATED_CLIENT"
create "$B" CLIENT_INSTANCE_FLEET_CODE="$CODE_B"
B_OPERATOR="$CREATED_OPERATOR"; B_CLIENT="$CREATED_CLIENT"
unset CODE_A CODE_B
pass "create passed its own checks on A and B"
[ "$A_OPERATOR" != "$B_OPERATOR" ] && [ "$A_CLIENT" != "$B_CLIENT" ] && pass "each instance has its own log-in passwords" || fail "same password on A and B"

pause_sign_in
for root in "$A" "$B"; do
  pw="$A_OPERATOR"; [ "$root" = "$B" ] && pw="$B_OPERATOR"
  OUT="$(clean CLIENT_INSTANCE_OPERATOR_PASSWORD="$pw" "$CI" verify --root "$root")" || { echo "$OUT"; fail "verify $(basename "$root")"; }
  pass "verify $(basename "$root"): $(echo "$OUT" | grep 'checks passed' | sed 's/client-instance: //')"
  STATUS="$(clean "$CI" status --root "$root")"
  echo "$STATUS" | grep -q 'edition managed' && echo "$STATUS" | grep -q 'limits: agent budget' && echo "$STATUS" | grep -q 'AI access route: ' \
    && echo "$STATUS" | grep -q "fleet: $(basename "$root") at $FLEET_HUB" \
    && pass "status $(basename "$root"): Managed, install limits, AI route, registered with the hub" || { echo "$STATUS"; fail "status $(basename "$root")"; }
done
HUB_LIST="$(hub_api "$HUB_URL/api/fleet/instances")"
echo "$HUB_LIST" | json 'v.filter(i=>["c951","c952"].includes(i.code)&&i.status==="active").length' | grep -qx 2 \
  && pass "hub: c951 and c952 are active" || { echo "$HUB_LIST"; fail "hub records"; }

pause_sign_in
helper_run ISO_A_OPERATOR="$A_OPERATOR" ISO_B_OPERATOR="$B_OPERATOR" -- compare "$A" "$B" || fail "A and B differ in more than root, ports, database, secrets and keys"

echo "== seed business content with a marker on each instance"
MARK_A="ISOMARKA$(node -e 'console.log(require("crypto").randomBytes(6).toString("hex"))')"
MARK_B="ISOMARKB$(node -e 'console.log(require("crypto").randomBytes(6).toString("hex"))')"
pause_sign_in
helper_run ISO_CLIENT_EMAIL="$CLIENT_EMAIL" ISO_CLIENT_PASSWORD="$A_CLIENT" -- seed "$A" "$MARK_A" "$S/out/seed-a.json" || fail "seed A"
helper_run ISO_CLIENT_EMAIL="$CLIENT_EMAIL" ISO_CLIENT_PASSWORD="$B_CLIENT" -- seed "$B" "$MARK_B" "$S/out/seed-b.json" || fail "seed B"
SECRET_A="$(json 'v.secretId' <"$S/out/seed-a.json")"

echo "== AT-3.5: A's port, log-ins and session do not reach B"
pause_sign_in
helper_run ISO_A_OPERATOR="$A_OPERATOR" ISO_B_OPERATOR="$B_OPERATOR" ISO_A_CLIENT="$A_CLIENT" ISO_B_CLIENT="$B_CLIENT" ISO_CLIENT_EMAIL="$CLIENT_EMAIL" \
  -- cross "$A" "$B" "$S/out/seed-a.json" "$S/out/seed-b.json" || fail "cross access"

echo "== AT-3.5: each database takes only its own password"
PW_A="$A/instances/default/secrets/embedded-postgres.password"
PW_B="$B/instances/default/secrets/embedded-postgres.password"
[ "$(helper_run -- db-login "$A" "$PW_A")" = ok ] && pass "A's database takes A's password (control)" || fail "A's own password"
OUT="$(helper_run -- db-login "$A" "$PW_B")"; case "$OUT" in refused:*) pass "A's database refuses B's password: ${OUT#refused: }";; *) fail "A's database took B's password";; esac
OUT="$(helper_run -- db-login "$B" "$PW_A")"; case "$OUT" in refused:*) pass "B's database refuses A's password";; *) fail "B's database took A's password";; esac

echo "== AT-3.5: A's backups are no use to B"
BACKUP_A="$(clean "$CI" backup --root "$A" | sed -n 's/^client-instance: backup written: //p')"
BACKUP_B="$(clean "$CI" backup --root "$B" | sed -n 's/^client-instance: backup written: //p')"
[ -f "$BACKUP_A" ] && [ -f "$BACKUP_B" ] || fail "backups"
case "$BACKUP_A" in "$A"/instances/default/data/backups/*) pass "A's backup is in A's folder";; *) fail "A's backup at $BACKUP_A";; esac
if OUT="$(clean "$CI" restore-check --root "$B" "$BACKUP_A" 2>&1)"; then fail "B's restore-check took A's backup"; fi
echo "$OUT" | grep -q 'is not a backup of this instance' && pass "B's restore-check refuses A's backup" || fail "wrong refusal: $OUT"
# Plain copies to grep (sandbox data only; removed right after).
gzip -dc -f "$BACKUP_A" >"$S/tmp/a.sql"; gzip -dc -f "$BACKUP_B" >"$S/tmp/b.sql"
grep -q "$MARK_A" "$S/tmp/a.sql" && pass "A's backup holds A's seeded rows (it is a real dump)" || fail "A's backup has no seeded rows"
! grep -q "$MARK_B" "$S/tmp/a.sql" && ! grep -q "$MARK_A" "$S/tmp/b.sql" && pass "neither backup holds the other instance's rows" || fail "a backup holds the other instance's rows"
! grep -q "$MARK_A-secret-value" "$S/tmp/a.sql" && pass "A's backup holds A's secret only encrypted" || fail "A's secret in plain text in the backup"
rm -f "$S/tmp/a.sql" "$S/tmp/b.sql"
[ "$(helper_run -- decrypt "$A" "$A/instances/default/secrets/master.key" "$SECRET_A")" = decrypted ] && pass "A's master key opens A's secret (control)" || fail "A's key"
if OUT="$(helper_run -- decrypt "$A" "$B/instances/default/secrets/master.key" "$SECRET_A")"; then fail "B's master key opened A's secret"; fi
pass "B's master key cannot open A's secret: ${OUT#refused: }"

echo "== AT-3.5: A's off-host repository is unreadable with B's key"
for code in c951 c952; do
  head -c 32 /dev/urandom | base64 >"$S/etc/$code.key" && chmod 600 "$S/etc/$code.key"
  printf 'RESTIC_REPOSITORY=%s\nRESTIC_PASSWORD_FILE=%s\nRESTIC_CACHE_DIR=%s\n' "$S/offsite/$code" "$S/etc/$code.key" "$S/tmp/restic-cache-$code" >"$S/etc/$code-offsite.env"
  chmod 600 "$S/etc/$code-offsite.env"
done
for pair in "$A:c951" "$B:c952"; do
  root="${pair%%:*}"; code="${pair##*:}"
  clean "$CI" offsite-init --root "$root" --offsite-config "$S/etc/$code-offsite.env" --restic "$RESTIC" >/dev/null || fail "offsite-init $code"
  clean "$CI" offsite-backup --root "$root" --offsite-config "$S/etc/$code-offsite.env" --restic "$RESTIC" | grep -q 'offsite-backup OK' || fail "offsite-backup $code"
done
pass "each instance has its own off-host repository and key"
! grep -rqa -e "$MARK_A" -e 'c951' "$S/offsite/c951" && pass "A's repository holds no plain text" || fail "plain text in A's repository"
printf 'RESTIC_REPOSITORY=%s\nRESTIC_PASSWORD_FILE=%s\nRESTIC_CACHE_DIR=%s\n' "$S/offsite/c951" "$S/etc/c952.key" "$S/tmp/restic-cache-x" >"$S/etc/b-key-on-a.env" && chmod 600 "$S/etc/b-key-on-a.env"
if clean env RESTIC_REPOSITORY="$S/offsite/c951" RESTIC_PASSWORD_FILE="$S/etc/c952.key" "$RESTIC" cat config >/dev/null 2>&1; then fail "restic opened A's repository with B's key"; fi
pass "restic cannot open A's repository with B's key"
if clean "$CI" offsite-check --code c951 --offsite-config "$S/etc/b-key-on-a.env" --sandbox "$S/pull-b" --restic "$RESTIC" >/dev/null 2>&1; then fail "offsite-check read A's copies with B's key"; fi
pass "offsite-check cannot read A's copies with B's key"
if OUT="$(clean "$CI" offsite-backup --root "$B" --offsite-config "$S/etc/c951-offsite.env" --restic "$RESTIC" 2>&1)"; then fail "B wrote into A's repository"; fi
echo "$OUT" | grep -q 'must end in /c952' && pass "B cannot use A's off-host config" || fail "wrong refusal: $OUT"
clean "$CI" offsite-check --code c951 --offsite-config "$S/etc/c951-offsite.env" --sandbox "$S/pull-a" --restic "$RESTIC" | grep -q 'offsite-check OK' \
  && pass "A's key reads A's copies (control)" || fail "offsite-check A"

echo "== check-ins: one watch pass on each instance"
for pair in "$A:$A_OPERATOR" "$B:$B_OPERATOR"; do
  root="${pair%%:*}"; pw="${pair#*:}"; code="$(basename "$root")"
  printf 'WATCH_OPERATOR_PASSWORD=%s\nWATCH_PING_URL=%s/ping/%s\n' "$pw" "$FLEET_HUB" "$code" >"$S/etc/$code-watch.env"
  chmod 600 "$S/etc/$code-watch.env"
  pause_sign_in
  OUT="$(clean "$CI" watch --root "$root" --watch-config "$S/etc/$code-watch.env" || true)"
  echo "$OUT" | grep -q 'fleet check-in sent' && pass "watch $code sent a signed check-in" || { echo "$OUT"; fail "no check-in from $code"; }
done

echo "== AT-3.5: A's fleet key cannot act as B"
helper_run -- forge "$A" "$B" "$HUB_URL" "$CAPTURE" || fail "forged messages"
pause_sign_in
OUT="$(clean "$CI" fleet-check-in --root "$B" --watch-config "$S/etc/c952-watch.env")" || { echo "$OUT"; fail "B's own check-in after the forged ones"; }
pass "B's own check-in still works after the forged ones: ${OUT#client-instance: }"

echo "== AT-3.5: no /api/fleet route on a client instance"
pause_sign_in
helper_run ISO_CLIENT_EMAIL="$CLIENT_EMAIL" ISO_CLIENT_PASSWORD="$A_CLIENT" ISO_OPERATOR="$A_OPERATOR" -- fleet-404 "$A" || fail "fleet routes on A"

echo "== AT-3.6: no business content leaves an instance"
for code in c951 c952; do
  id="$(echo "$HUB_LIST" | json "v.find(i=>i.code===\"$code\").id")"
  hub_api "$HUB_URL/api/fleet/instances/$id/check-ins?limit=288" >"$S/out/hub-check-ins-$code.json"
  [ "$(json 'v.length' <"$S/out/hub-check-ins-$code.json")" -ge 1 ] && pass "hub stored check-ins of $code" || fail "hub has no check-in of $code"
done
helper_run -- scan "$CAPTURE" "$S/out/seed-a.json" "$S/out/seed-b.json" \
  --also "$S/out/hub-check-ins-c951.json" --also "$S/out/hub-check-ins-c952.json" || fail "business content in a check-in"

echo "ALL PASSED"
