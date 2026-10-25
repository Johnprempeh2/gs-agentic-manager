#!/usr/bin/env bash
# Sandbox test for the signed Website key (GRE-2396). Sandbox data only.
#
#   scripts/client-instance/entitlement.sandbox-test.sh <empty scratch dir>
#
# Makes a throwaway hub key pair in the scratch folder (the private key never
# leaves it) and a Managed sandbox instance with the hub public key. With no
# signed file the Website API answers 403 (state floor). A signed file that
# grants enableWebsiteView turns it on (200) without a restart; a website row
# is made. A higher version without the key takes it back (403) and the row
# stays. Granted again, the row is still there. Then `entitlement --off yes`
# and a restart: no hub key, 403 again, row kept. The edition values are the
# same at the end as at the start, and verify passes at each step.
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="${1:?usage: $0 <empty scratch dir>}"
mkdir -p "$S"
S="$(cd "$S" && pwd -P)"
[ -z "$(ls -A "$S")" ] || { echo "FAIL $S is not empty"; exit 1; }
mkdir -p "$S/tmp" "$S/hub"
chmod 700 "$S/hub"

CODE=c932
ROOT="$S/instances/$CODE"
CI="$CODE_DIR/scripts/client-instance.sh"

clean() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 TMPDIR="$S/tmp" \
    PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}
# Each op and website call signs in; the sign-in rate limit allows about 3 in 10 seconds.
op() { sleep 11; clean CLIENT_INSTANCE_OPERATOR_PASSWORD="$OPERATOR_PASSWORD" "$@"; }
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
cleanup() { [ -f "$ROOT/client-instance.json" ] && clean "$CI" stop --root "$ROOT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== throwaway hub key pair (scratch only)"
node -e '
  const { generateKeyPairSync } = require("node:crypto");
  const fs = require("node:fs");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fs.writeFileSync(process.argv[1] + "/hub.key.pem", privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(process.argv[1] + "/hub.pub.pem", publicKey.export({ type: "spki", format: "pem" }));
' "$S/hub"

# sign <version> <true|false>: a signed file for this client code, valid 30 days.
sign() {
  node -e '
    const { createPrivateKey, sign } = require("node:crypto");
    const fs = require("node:fs");
    const [dir, client, version, website] = process.argv.slice(1);
    const now = Date.now();
    const doc = {
      v: 1, client, version: Number(version),
      issuedAt: new Date(now - 60000).toISOString(),
      validUntil: new Date(now + 30 * 86400000).toISOString(),
      issuedBy: "sandbox-hub", reason: "GRE-2396 sandbox test",
      features: website === "true" ? { enableWebsiteView: true } : {},
      limits: {},
    };
    const bytes = Buffer.from(JSON.stringify(doc));
    const key = createPrivateKey(fs.readFileSync(dir + "/hub.key.pem"));
    const out = dir + "/v" + version + ".json";
    fs.writeFileSync(out, JSON.stringify({ v: 1, document: bytes.toString("base64url"), signature: sign(null, bytes, key).toString("base64url") }));
    console.log(out);
  ' "$S/hub" "$CODE" "$1" "$2"
}

# website: the HTTP status of GET /api/companies/:id/website for the operator; with "make", POST one property first.
website() {
  sleep 11
  node -e '
    const [base, password, make] = process.argv.slice(1);
    (async () => {
      const r = await fetch(base + "/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ email: "operator@instance.invalid", password }) });
      const headers = { Cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), Origin: base, "Content-Type": "application/json" };
      const [company] = await (await fetch(base + "/api/companies", { headers })).json();
      if (make === "make") {
        const made = await fetch(base + "/api/companies/" + company.id + "/website/properties", { method: "POST", headers, body: JSON.stringify({ name: "Sandbox site", siteUrl: "https://sandbox.invalid" }) });
        if (made.status !== 201) { console.log("make-" + made.status); return; }
      }
      const res = await fetch(base + "/api/companies/" + company.id + "/website", { headers });
      const body = res.status === 200 ? await res.json() : null;
      console.log(res.status + (body ? " " + body.properties.length : ""));
    })();' "http://127.0.0.1:$PORT" "$OPERATOR_PASSWORD" "${1:-}"
}

# check: run verify; show the entitlement lines; stop on any FAIL.
check() {
  local out
  out="$(op "$CI" verify --root "$ROOT" 2>&1)" || { echo "$out" | grep FAIL; fail "verify"; }
  echo "$out" | grep -e 'entitlements' -e 'enableWebsiteView' -e 'Website API' -e 'checks passed'
  VERIFY="$out"
}

# rows: website rows in the instance database, read straight from Postgres (the API is closed while off).
rows() {
  (cd "$CODE_DIR/server" && clean node "$CODE_DIR/cli/node_modules/tsx/dist/cli.mjs" -e '
    import(process.argv[3]).then(async (db) => {
      const url = db.resolveEmbeddedPostgresConnectionString({ dataDir: process.argv[1], port: Number(process.argv[2]) });
      const [{ n }] = await db.createDb(url).$client.unsafe("select count(*)::int as n from website_properties");
      console.log(n);
      await db.closeRegisteredClients(url);
    });' "$ROOT/instances/default/db" "$DB_PORT" "$CODE_DIR/packages/db/src/index.ts")
}

EDITION_BEFORE="$(clean "$CI" edition-env --edition managed)"

echo "== create a Managed sandbox instance with the hub public key"
CREATE_OUT="$(clean "$CI" create --root "$ROOT" --edition managed --entitlement-public-key "$S/hub/hub.pub.pem" --entitlement-client "$CODE" 2>&1)" \
  || { echo "$CREATE_OUT" | grep FAIL; fail "create"; }
echo "$CREATE_OUT" | grep -e 'entitlement' -e 'enableWebsiteView' -e 'Website API' -e 'checks passed'
OPERATOR_PASSWORD="$(echo "$CREATE_OUT" | awk '/Operator:/ {print $4}')"
[ -n "$OPERATOR_PASSWORD" ] || fail "no operator log-in in the create output"
PORT="$(node -e 'console.log(require(process.argv[1]).port)' "$ROOT/client-instance.json")"
DB_PORT="$(node -e 'console.log(require(process.argv[1]).dbPort)' "$ROOT/client-instance.json")"
grep -q 'PRIVATE' "$ROOT/client-instance.json" && fail "a private key is in client-instance.json" || pass "no private key in the instance"
echo "$CREATE_OUT" | grep -q 'PASS entitlements: state floor' && pass "no signed file: state floor" || fail "state not floor"
[ "$(website)" = "403" ] && pass "no signed file: Website 403" || fail "Website not 403 with no file"

echo "== a private key is refused"
if OUT="$(clean "$CI" entitlement --root "$ROOT" --entitlement-public-key "$S/hub/hub.key.pem" 2>&1)"; then fail "private key accepted"; fi
echo "$OUT" | grep -q 'private key' && pass "private key refused" || fail "wrong refusal: $OUT"

echo "== give the key (v1)"
op "$CI" entitlement --root "$ROOT" --install "$(sign 1 true)"
[ "$(website make)" = "200 1" ] && pass "signed key: Website 200, one website row made" || fail "Website not 200 with the key"
check

echo "== an older or equal version is refused"
if OUT="$(op "$CI" entitlement --root "$ROOT" --install "$(sign 1 false)" 2>&1)"; then fail "same version accepted"; fi
echo "$OUT" | grep -q 'higher version' && pass "same version refused" || fail "wrong refusal: $OUT"
rm -f "$S/hub/v1.json"

echo "== take the key back (v2, no enableWebsiteView)"
op "$CI" entitlement --root "$ROOT" --install "$(sign 2 false)"
[ "$(website)" = "403" ] && pass "key taken back: Website 403" || fail "Website not 403 after take-back"
[ "$(rows)" = "1" ] && pass "the website row is kept" || fail "website row lost"
check

echo "== renew (v3, key again): the data is still there"
op "$CI" entitlement --root "$ROOT" --install "$(sign 3 true)"
[ "$(website)" = "200 1" ] && pass "renewed: Website 200 with the kept row" || fail "row not back after renew"

echo "== remove the hub key and restart"
clean "$CI" entitlement --root "$ROOT" --off yes
clean "$CI" stop --root "$ROOT" >/dev/null
clean "$CI" start --root "$ROOT" >/dev/null
[ "$(website)" = "403" ] && pass "no hub key: Website 403" || fail "Website not 403 with no hub key"
[ "$(rows)" = "1" ] && pass "the website row is kept" || fail "website row lost"
check
echo "$VERIFY" | grep -q 'PASS entitlements: state disabled' && pass "verify: state disabled" || fail "state not disabled"

[ "$(clean "$CI" edition-env --edition managed)" = "$EDITION_BEFORE" ] && pass "edition values unchanged" || fail "edition values changed"
echo "ALL PASS"
