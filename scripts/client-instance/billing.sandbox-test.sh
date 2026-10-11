#!/usr/bin/env bash
# Sandbox test for `billing-export` and `billing-archive` (B11, GRE-1372). Sandbox data only.
#
#   scripts/client-instance/billing.sandbox-test.sh <empty scratch dir>
#
# Makes a Managed sandbox instance, writes one billing account and two
# invoices into its database, then: billing-export writes one file outside
# the instance folder with the same rows; a second run changes nothing; with
# the instance stopped (as `delete` finds it) the export reads the database on
# its own and gives the same file; an archive inside the instance folder, or a
# config with no retention years, is refused and writes nothing;
# billing-archive lists the export with its retention end and removes nothing.
# Then AT-4.10: the instance is paused and `delete` is refused, removing
# nothing, with no billing config, with no retention years and when the export
# fails; then `delete` exports the rows, removes the instance and names the
# export in the deletion record. An export past its retention end is listed
# as due for review and stays.
# Never point it at a real instance.
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="${1:?usage: $0 <empty scratch dir>}"
mkdir -p "$S"
S="$(cd "$S" && pwd -P)"
[ -z "$(ls -A "$S")" ] || { echo "FAIL $S is not empty"; exit 1; }
mkdir -p "$S/tmp"

ROOT="$S/instances/c917"
CI="$CODE_DIR/scripts/client-instance.sh"
ARCHIVE="$S/billing-archive"
CONFIG="$S/billing.env"
TSX="$CODE_DIR/cli/node_modules/tsx/dist/cli.mjs"

clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 TMPDIR="$S/tmp" \
    PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
op() { clean CLIENT_INSTANCE_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" "$@"; }
cleanup() { [ -f "$ROOT/client-instance.json" ] && clean "$CI" stop --root "$ROOT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

printf 'BILLING_ARCHIVE_DIR=%s\nBILLING_RETENTION_YEARS=6\n' "$ARCHIVE" >"$CONFIG"

echo "== create a Managed sandbox instance"
CREATE_OUT="$(clean "$CI" create --root "$ROOT" --edition managed)" || { echo "$CREATE_OUT" | grep -v -e 'Operator:' -e 'Client:'; fail "create"; }
echo "$CREATE_OUT" | grep -v -e 'Operator:' -e 'Client:'
OPERATOR_PASSWORD="$(echo "$CREATE_OUT" | awk '/Operator:/ {print $4}')"
[ -n "$OPERATOR_PASSWORD" ] || fail "no operator log-in in the create output"

echo "== write one billing account and two invoices (test values)"
cat >"$S/seed.mts" <<EOF
import * as db from "$CODE_DIR/packages/db/src/index.ts";
const state = JSON.parse(await (await import("node:fs/promises")).readFile("$ROOT/client-instance.json", "utf8"));
const url = db.resolveEmbeddedPostgresConnectionString({ dataDir: "$ROOT/instances/default/db", port: state.dbPort });
const conn = db.createDb(url);
await conn.insert(db.billingAccounts).values({ planKind: "test", catalogueVersion: "test", currency: "GBP", serviceFeeCents: 1, allowanceMonthlyCents: 1, termKind: "monthly", termStartsOn: "2026-10-01" });
await conn.insert(db.billingInvoices).values([
  { reference: "TEST-1", periodStart: "2026-09-01", periodEnd: "2026-09-30", amountCents: 1, currency: "GBP", status: "paid", issuedOn: "2026-10-01" },
  { reference: "TEST-2", periodStart: "2026-10-01", periodEnd: "2026-10-31", amountCents: 1, currency: "GBP", status: "open", issuedOn: "2026-10-11" },
]);
await db.closeRegisteredClients(url);
EOF
clean node "$TSX" "$S/seed.mts" || fail "seed billing rows"

echo "== billing-export while running"
OUT="$(clean "$CI" billing-export --root "$ROOT" --billing-config "$CONFIG")" || { echo "$OUT"; fail "billing-export"; }
echo "$OUT"
echo "$OUT" | grep -q 'billing-export: 1 billing account and 2 invoices' && pass "counts 1 and 2" || fail "counts"
FILES=("$ARCHIVE"/*.json)
[ "${#FILES[@]}" -eq 1 ] && pass "one export file" || fail "expected one export file"
FILE="${FILES[0]}"
case "$FILE" in "$ROOT"/*) fail "export inside the instance folder" ;; esac
[ "$(stat -c %a "$FILE" 2>/dev/null || stat -f %Lp "$FILE")" = "600" ] && pass "export is private (600)" || fail "export mode"
node -e '
  const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ok = e.code === "c917" && e.counts.accounts === 1 && e.counts.invoices === 2
    && e.invoices.map((i) => i.reference).join() === "TEST-1,TEST-2" && e.retentionYears === 6
    && Number(e.retentionEndsOn.slice(0, 4)) === Number(e.exportedOn.slice(0, 4)) + 6;
  process.exit(ok ? 0 : 1);' "$FILE" && pass "rows and retention end (export day + 6 years from the config)" || fail "export content"
SUM1="$(sha256sum "$FILE" | cut -d' ' -f1)"

echo "== billing-export again"
OUT="$(clean "$CI" billing-export --root "$ROOT" --billing-config "$CONFIG")" || { echo "$OUT"; fail "second billing-export"; }
echo "$OUT" | grep -q 'already exported; nothing changed' && pass "second run changes nothing" || fail "second run"
[ "$(sha256sum "$FILE" | cut -d' ' -f1)" = "$SUM1" ] && pass "same bytes" || fail "file changed"

echo "== billing-export with the instance stopped (as delete finds it)"
clean "$CI" stop --root "$ROOT" >/dev/null
OUT="$(clean "$CI" billing-export --root "$ROOT" --billing-config "$CONFIG")" || { echo "$OUT"; fail "billing-export stopped"; }
echo "$OUT"
echo "$OUT" | grep -q 'billing-export: 1 billing account and 2 invoices' && pass "stopped instance read on its own" || fail "stopped counts"
[ "$(sha256sum "$FILE" | cut -d' ' -f1)" = "$SUM1" ] && pass "same file when stopped" || fail "file changed when stopped"
[ ! -f "$ROOT/server.pid" ] || ! kill -0 "$(cat "$ROOT/server.pid")" 2>/dev/null && pass "instance still stopped" || fail "instance started"
[ ! -f "$ROOT/instances/default/db/postmaster.pid" ] && pass "its database stopped again" || fail "database left running"

echo "== refused: archive inside the instance folder"
printf 'BILLING_ARCHIVE_DIR=%s\nBILLING_RETENTION_YEARS=6\n' "$ROOT/billing" >"$S/inside.env"
if OUT="$(clean "$CI" billing-export --root "$ROOT" --billing-config "$S/inside.env" 2>&1)"; then fail "inside archive accepted"; fi
echo "$OUT" | grep -q 'delete would remove it' && pass "inside archive refused" || { echo "$OUT"; fail "inside message"; }
[ ! -e "$ROOT/billing" ] && pass "nothing written inside" || fail "written inside"

echo "== refused: retention years not set"
printf 'BILLING_ARCHIVE_DIR=%s\n' "$ARCHIVE" >"$S/noyears.env"
if OUT="$(clean "$CI" billing-export --root "$ROOT" --billing-config "$S/noyears.env" 2>&1)"; then fail "no retention accepted"; fi
echo "$OUT" | grep -q 'billing retention not set' && pass "no retention refused" || { echo "$OUT"; fail "retention message"; }

echo "== billing-archive"
OUT="$(clean "$CI" billing-archive --billing-config "$CONFIG")" || { echo "$OUT"; fail "billing-archive"; }
echo "$OUT"
echo "$OUT" | grep -q "c917, 1 accounts, 2 invoices, exported .* kept until " && pass "export listed" || fail "not listed"
echo "$OUT" | grep -q 'no export is past its retention end' && pass "nothing due" || fail "due line"
[ "$(ls "$ARCHIVE" | wc -l | tr -d ' ')" = "1" ] && pass "archive unchanged" || fail "archive changed"

echo "== delete exports billing records first (AT-4.10)"
clean "$CI" start --root "$ROOT" >/dev/null || fail "start"
op "$CI" pause --root "$ROOT" --operator sandbox-ops --reason "billing delete test" >/dev/null || fail "pause"
DEL=(--confirm-code c917 --approval GRE-1372 --operator sandbox-ops)
if OUT="$(clean "$CI" delete --root "$ROOT" "${DEL[@]}" 2>&1)"; then fail "delete without a billing config ran"; fi
echo "$OUT" | grep -q -- 'holds 1 billing account and 2 invoices: --billing-config <file> is required' && pass "delete needs --billing-config" || { echo "$OUT"; fail "no-config message"; }
if OUT="$(clean "$CI" delete --root "$ROOT" "${DEL[@]}" --billing-config "$S/noyears.env" 2>&1)"; then fail "delete with no retention ran"; fi
echo "$OUT" | grep -q 'billing retention not set' && pass "delete needs the retention setting" || { echo "$OUT"; fail "no-retention message"; }
if OUT="$(clean "$CI" delete --root "$ROOT" "${DEL[@]}" --billing-config "$S/inside.env" 2>&1)"; then fail "delete with a failing export ran"; fi
echo "$OUT" | grep -q 'billing-export failed: .*delete would remove it; nothing removed' && pass "failed export stops delete" || { echo "$OUT"; fail "failed-export message"; }
[ -d "$ROOT/instances/default/db" ] && pass "refusals removed nothing" || fail "a refusal removed data"
OUT="$(clean "$CI" delete --root "$ROOT" "${DEL[@]}" --billing-config "$CONFIG")" || { echo "$OUT"; fail "delete"; }
echo "$OUT"
echo "$OUT" | grep -q "billing records: 1 billing account and 2 invoices exported to $FILE" && pass "delete exported the rows first" || fail "no export line"
[ ! -e "$ROOT" ] && pass "instance folder removed" || fail "$ROOT still there"
[ "$(sha256sum "$FILE" | cut -d' ' -f1)" = "$SUM1" ] && pass "billing export kept, same rows" || fail "export changed or gone"
TODAY="$(date -u +%F)"
node -e '
  const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const [y, md] = [Number(process.argv[2].slice(0, 4)), process.argv[2].slice(4)];
  process.exit(e.exportedOn === process.argv[2] && e.retentionEndsOn === `${y + 6}${md}` ? 0 : 1);' "$FILE" "$TODAY" \
  && pass "retention end = deletion day + 6 years (from the config)" || fail "retention end"
RECORD="$S/instances/deletions/c917.json"
node -e 'const r=require(process.argv[1]);process.exit(r.billingExport.endsWith(process.argv[2])?0:1)' "$RECORD" "$FILE" && pass "deletion record names the export" || fail "record billingExport"

echo "== past the retention end: listed, not removed"
node -e 'const f=process.argv[1];const e=JSON.parse(require("fs").readFileSync(f,"utf8"));e.retentionEndsOn="2000-01-01";require("fs").writeFileSync(f,JSON.stringify(e,null,2)+"\n")' "$FILE"
OUT="$(clean "$CI" billing-archive --billing-config "$CONFIG")" || { echo "$OUT"; fail "billing-archive"; }
echo "$OUT" | grep -q 'kept until 2000-01-01 - DUE FOR REVIEW' && pass "listed as due for review" || { echo "$OUT"; fail "not due"; }
[ -f "$FILE" ] && pass "export not removed" || fail "export removed"

echo "ALL PASS"
