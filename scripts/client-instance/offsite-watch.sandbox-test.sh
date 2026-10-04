#!/usr/bin/env bash
# Sandbox test for off-host backups and the host watch (GRE-666). Sandbox data only.
#
#   RESTIC=/path/to/restic scripts/client-instance/offsite-watch.sandbox-test.sh <empty scratch dir>
#
# Makes a Managed sandbox instance. Off-host: offsite-backup to a local restic
# repository (the Storage Box is an sftp: repository; the commands are the
# same), the repository is encrypted, a second code cannot use the first
# code's repository, offsite-check restores the newest copy into a sandbox,
# restore-check passes on it and the copy is deleted. Watch: all pass and the
# dead-man check gets an ok ping; a refused AI run and a wrong operator
# password each fail, ping /fail and send one mail; the same failure again
# sends no second mail; recovery sends one. The public URL probe passes on a
# working URL and fails (ping, mail) on a TLS failure while loopback health
# still passes. Stops the instance at the end.
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

ROOT="$S/instances/c917"
CI="$CODE_DIR/scripts/client-instance.sh"
TSX="$CODE_DIR/cli/node_modules/tsx/dist/cli.mjs"

clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 TMPDIR="$S/tmp" \
    PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
PING_PID=""
cleanup() {
  clean "$CI" stop --root "$ROOT" >/dev/null 2>&1 || true
  [ -n "$PING_PID" ] && kill "$PING_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "== create a Managed sandbox instance"
CREATE_OUT="$(clean "$CI" create --root "$ROOT" --edition managed)" || { echo "$CREATE_OUT" | grep -v -e 'Operator:' -e 'Client:'; fail "create"; }
OPERATOR_PASSWORD="$(echo "$CREATE_OUT" | awk '/Operator:/ {print $4}')"
[ -n "$OPERATOR_PASSWORD" ] || fail "no operator log-in in the create output"
clean "$CI" restore-check --root "$ROOT" >/dev/null || fail "restore-check on the host"

echo "== off-host config: one repository and one key file per code, mode 600"
head -c 32 /dev/urandom | base64 >"$S/etc/c917.key"
chmod 600 "$S/etc/c917.key"
printf 'RESTIC_REPOSITORY=%s\nRESTIC_PASSWORD_FILE=%s\nRESTIC_CACHE_DIR=%s\n' "$S/offsite/c917" "$S/etc/c917.key" "$S/tmp/restic-cache" >"$S/etc/c917-offsite.env"
chmod 644 "$S/etc/c917-offsite.env"
if OUT="$(clean "$CI" offsite-init --root "$ROOT" --offsite-config "$S/etc/c917-offsite.env" --restic "$RESTIC" 2>&1)"; then fail "a world-readable config was accepted"; fi
echo "$OUT" | grep -q 'chmod 600' && pass "world-readable config refused" || fail "wrong refusal: $OUT"
chmod 600 "$S/etc/c917-offsite.env"

if OUT="$(clean "$CI" offsite-backup --root "$ROOT" --offsite-config "$S/etc/c917-offsite.env" --restic "$RESTIC" 2>&1)"; then fail "offsite-backup ran without a repository"; fi
echo "$OUT" | grep -q 'offsite-backup FAILED: the repository cannot be read' && pass "no repository: FAILED line" || fail "wrong output: $OUT"
clean "$CI" status --root "$ROOT" | grep -q 'WARNING: the last off-host backup failed' && pass "status warns after a failed off-host backup" || fail "no WARNING"

clean "$CI" offsite-init --root "$ROOT" --offsite-config "$S/etc/c917-offsite.env" --restic "$RESTIC" || fail "offsite-init"
clean "$CI" offsite-init --root "$ROOT" --offsite-config "$S/etc/c917-offsite.env" --restic "$RESTIC" | grep -q 'already exists' && pass "offsite-init twice changes nothing" || fail "offsite-init is not idempotent"

echo "== offsite-backup"
OUT="$(clean "$CI" offsite-backup --root "$ROOT" --offsite-config "$S/etc/c917-offsite.env" --restic "$RESTIC")" || { echo "$OUT"; fail "offsite-backup"; }
echo "$OUT"
echo "$OUT" | grep -Eq '^client-instance: offsite-backup OK: snapshot [0-9a-f]{8}, [0-9]+ files$' && pass "OK line" || fail "no OK line"
STATUS="$(clean "$CI" status --root "$ROOT")"
echo "$STATUS" | grep -q 'last off-host backup: offsite-backup OK' && pass "status shows it" || fail "status"
! echo "$STATUS" | grep -q 'WARNING.*off-host' && pass "no off-host WARNING" || fail "unexpected WARNING"
! grep -rqa -e '"edition"' -e 'c917' -e 'client-instance' "$S/offsite/c917" && pass "repository holds no plain text" || fail "plain text in the repository"

echo "== a second code cannot use the first code's repository"
mkdir -p "$S/instances/c918" && cp "$ROOT/client-instance.json" "$S/instances/c918/"
if OUT="$(clean "$CI" offsite-backup --root "$S/instances/c918" --offsite-config "$S/etc/c917-offsite.env" --restic "$RESTIC" 2>&1)"; then fail "c918 used the c917 repository"; fi
echo "$OUT" | grep -q 'must end in /c918' && pass "refused: one repository per code" || fail "wrong refusal: $OUT"
rm -rf "$S/instances/c918"

echo "== offsite-check: pull the newest copy into a sandbox and restore-check it"
OUT="$(clean "$CI" offsite-check --code c917 --offsite-config "$S/etc/c917-offsite.env" --sandbox "$S/pull" --restic "$RESTIC")" || { echo "$OUT"; fail "offsite-check"; }
echo "$OUT"
echo "$OUT" | grep -Eq '^client-instance: offsite-check OK: c917, snapshot [0-9a-f]{8} of .*: restore-check OK: .*, 1 company, ' && pass "OK line" || fail "no OK line"
[ -z "$(ls -A "$S/pull")" ] && pass "the pulled copy is deleted" || fail "the pulled copy is left in $S/pull"
if OUT="$(clean "$CI" offsite-check --code c917 --offsite-config "$S/etc/c917-offsite.env" --sandbox "$ROOT" --restic "$RESTIC" 2>&1)"; then fail "offsite-check used a non-empty folder"; fi
pass "a non-empty sandbox is refused"

echo "== a wrong key cannot read the copies"
head -c 32 /dev/urandom | base64 >"$S/etc/wrong.key" && chmod 600 "$S/etc/wrong.key"
printf 'RESTIC_REPOSITORY=%s\nRESTIC_PASSWORD_FILE=%s\n' "$S/offsite/c917" "$S/etc/wrong.key" >"$S/etc/wrong.env" && chmod 600 "$S/etc/wrong.env"
if clean "$CI" offsite-check --code c917 --offsite-config "$S/etc/wrong.env" --sandbox "$S/pull2" --restic "$RESTIC" >/dev/null 2>&1; then fail "a wrong key read the copies"; fi
pass "wrong key refused"

echo "== watch: dead-man endpoint and mail command (sandbox stand-ins)"
PING_PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
node -e '
  const fs = require("fs");
  require("http").createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { fs.appendFileSync(process.argv[1], `${req.method} ${req.url} ${body.split("\n").filter((l) => l.startsWith("FAIL")).length}\n`); res.end("OK"); });
  }).listen(Number(process.argv[2]), "127.0.0.1");
' "$S/pings.log" "$PING_PORT" &
PING_PID=$!
printf '#!/bin/sh\n{ cat; echo "--- end of mail"; } >>"%s"\n' "$S/mail.log" >"$S/etc/fake-sendmail" && chmod 700 "$S/etc/fake-sendmail"
watch_config() {
  printf 'WATCH_OPERATOR_PASSWORD=%s\nWATCH_PING_URL=http://127.0.0.1:%s/ping/sandbox\nWATCH_ALERT_EMAIL=oncall@example.invalid\nWATCH_MAIL_COMMAND=%s\n' \
    "$1" "$PING_PORT" "$S/etc/fake-sendmail" >"$S/etc/c917-watch.env"
  chmod 600 "$S/etc/c917-watch.env"
}
watch_config "$OPERATOR_PASSWORD"
sleep 1
mails() { cat "$S/mail.log" 2>/dev/null | grep -c '^--- end of mail' || true; }

OUT="$(clean "$CI" watch --root "$ROOT" --watch-config "$S/etc/c917-watch.env")" || { echo "$OUT"; fail "watch on a healthy instance"; }
echo "$OUT" | grep -v -e "$OPERATOR_PASSWORD"
for key in health backup restore-check offsite-backup disk memory 'ai-connections:' 'ai-failed-auth:'; do
  echo "$OUT" | grep -q "^client-instance: PASS $key" || fail "no PASS $key"
done
pass "all signals pass"
tail -n 1 "$S/pings.log" | grep -q '^POST /ping/sandbox 0$' && pass "ok ping sent" || fail "no ok ping: $(cat "$S/pings.log")"
[ "$(mails)" = 0 ] && pass "no mail while all pass" || fail "mail sent while all pass"
node -e 'const s=require(process.argv[1]);if(!s.lastRun.signals.length||s.failing.length)process.exit(1)' "$ROOT/watch-state.json" && pass "signals kept in watch-state.json" || fail "watch-state.json"

echo "== watch: a run refused by the AI provider"
cat >"$S/tmp/refused-run.mts" <<EOF
import { createDb, agents, heartbeatRuns, companies } from "$CODE_DIR/packages/db/src/index.js";
const db = createDb(process.argv[2]!);
const [company] = await db.select({ id: companies.id }).from(companies).limit(1);
const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Sandbox watch agent", status: "paused" }).returning({ id: agents.id });
await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, status: "failed", errorCode: "claude_auth_required", error: "sandbox: invalid token", startedAt: new Date(), finishedAt: new Date() });
process.exit(0);
EOF
DB_PORT="$(node -e 'console.log(require(process.argv[1]).dbPort)' "$ROOT/client-instance.json")"
(cd "$CODE_DIR" && clean node "$TSX" "$S/tmp/refused-run.mts" "postgres://paperclip:paperclip@127.0.0.1:$DB_PORT/paperclip") || fail "could not add the refused run"
if OUT="$(clean "$CI" watch --root "$ROOT" --watch-config "$S/etc/c917-watch.env")"; then fail "watch passed with a refused run"; fi
echo "$OUT" | grep -q '^client-instance: FAIL ai-failed-auth:.* claude_auth_required' && pass "FAIL ai-failed-auth" || { echo "$OUT"; fail "no ai-failed-auth FAIL"; }
tail -n 1 "$S/pings.log" | grep -q '^POST /ping/sandbox/fail 1$' && pass "fail ping sent with the report" || fail "no fail ping: $(tail -n 1 "$S/pings.log")"
[ "$(mails)" = 1 ] && grep -q '^Subject: \[GSAM c917\] 1 check(s) failing: ai-failed-auth:' "$S/mail.log" && grep -q '^To: oncall@example.invalid' "$S/mail.log" \
  && pass "one alert mail" || { cat "$S/mail.log" 2>/dev/null; fail "alert mail"; }
clean "$CI" watch --root "$ROOT" --watch-config "$S/etc/c917-watch.env" >/dev/null && fail "second pass passed"
[ "$(mails)" = 1 ] && pass "the same failure sends no second mail" || fail "duplicate mail"

echo "== watch: a wrong operator password fails the AI check"
watch_config "not-the-password"
if OUT="$(clean "$CI" watch --root "$ROOT" --watch-config "$S/etc/c917-watch.env")"; then fail "watch passed with a wrong password"; fi
echo "$OUT" | grep -q '^client-instance: FAIL ai: operator log-in refused' && pass "FAIL ai on a refused log-in" || { echo "$OUT"; fail "no FAIL ai"; }
[ "$(mails)" = 2 ] && pass "a changed failure sends a new mail" || fail "no mail for the changed failure"
! grep -q "$OPERATOR_PASSWORD" "$S/mail.log" "$S/pings.log" "$ROOT/watch-state.json" && pass "no password in mails, pings or state" || fail "password leaked"

echo "== watch: the app is down"
clean "$CI" stop --root "$ROOT" >/dev/null
if OUT="$(clean "$CI" watch --root "$ROOT" --watch-config "$S/etc/c917-watch.env")"; then fail "watch passed with the app down"; fi
echo "$OUT" | grep -q '^client-instance: FAIL health: not running' && pass "FAIL health" || { echo "$OUT"; fail "no FAIL health"; }
[ "$(mails)" = 3 ] && pass "mail for the app down" || fail "no mail for the app down"

echo "== watch: recovery sends one mail"
clean "$CI" start --root "$ROOT" >/dev/null || fail "start"
watch_config "$OPERATOR_PASSWORD"
# Age the refused run (the only run in this sandbox) out of the one-hour window.
cat >"$S/tmp/age-run.mts" <<EOF
import { createDb, heartbeatRuns } from "$CODE_DIR/packages/db/src/index.js";
const db = createDb(process.argv[2]!);
const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
await db.update(heartbeatRuns).set({ finishedAt: old, startedAt: old, createdAt: old });
process.exit(0);
EOF
(cd "$CODE_DIR" && clean node "$TSX" "$S/tmp/age-run.mts" "postgres://paperclip:paperclip@127.0.0.1:$DB_PORT/paperclip") || fail "could not age the run"
OUT="$(clean "$CI" watch --root "$ROOT" --watch-config "$S/etc/c917-watch.env")" || { echo "$OUT"; fail "watch after recovery"; }
[ "$(mails)" = 4 ] && grep -q '^Subject: \[GSAM c917\] all checks pass again' "$S/mail.log" && pass "one recovery mail" || fail "no recovery mail"
clean "$CI" watch --root "$ROOT" --watch-config "$S/etc/c917-watch.env" >/dev/null || fail "watch"
[ "$(mails)" = 4 ] && pass "no more mail while all pass" || fail "extra mail"

echo "== watch: the public URL probe (plain http is allowed on loopback only)"
# Each pass signs in once; the app allows 3 sign-ins per 10 s, and real passes are 5 min apart.
pause_sign_in() { sleep 11; }
pause_sign_in
APP_PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$ROOT/client-instance.json")"
OUT="$(clean "$CI" watch --root "$ROOT" --watch-config "$S/etc/c917-watch.env" --public-url "http://127.0.0.1:$APP_PORT")" || { echo "$OUT"; fail "watch with a working public URL"; }
echo "$OUT" | grep -q "^client-instance: PASS public-url: http://127.0.0.1:$APP_PORT/api/health: health ok" && pass "PASS public-url" || { echo "$OUT"; fail "no PASS public-url"; }
if clean "$CI" watch --root "$ROOT" --watch-config "$S/etc/c917-watch.env" --public-url "http://c917.example.invalid" >/dev/null 2>&1; then fail "plain http accepted for a public host"; fi
pass "plain http refused for a public host"
pause_sign_in
# TLS against a plain-http port: the handshake fails, as a broken certificate or proxy would.
if OUT="$(clean "$CI" watch --root "$ROOT" --watch-config "$S/etc/c917-watch.env" --public-url "https://127.0.0.1:$APP_PORT")"; then fail "watch passed with TLS failing"; fi
echo "$OUT" | grep -q '^client-instance: FAIL public-url: https://127.0.0.1:.*/api/health: no answer' && pass "FAIL public-url" || { echo "$OUT"; fail "no FAIL public-url"; }
echo "$OUT" | grep -q '^client-instance: PASS health' && pass "loopback health still passes (the gap this probe closes)" || fail "loopback health"
tail -n 1 "$S/pings.log" | grep -q '^POST /ping/sandbox/fail 1$' && pass "fail ping sent" || fail "no fail ping"
[ "$(mails)" = 5 ] && grep -q '^Subject: \[GSAM c917\] 1 check(s) failing: public-url$' "$S/mail.log" && pass "one alert mail for the public URL" || { cat "$S/mail.log"; fail "public-url mail"; }
pause_sign_in
clean "$CI" watch --root "$ROOT" --watch-config "$S/etc/c917-watch.env" --public-url "http://127.0.0.1:$APP_PORT" >/dev/null || fail "watch after the public URL is back"
[ "$(mails)" = 6 ] && pass "one recovery mail" || fail "no recovery mail"

echo "ALL PASSED"
