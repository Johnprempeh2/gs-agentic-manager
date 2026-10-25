// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/entitlement.test.ts
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { entitlementChecks, entitlementEnv, parseEntitlementFlags, websiteExpected } from "./entitlement.js";

const keys = generateKeyPairSync("ed25519");
const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const raw = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
const root = "/srv/instances/c001";
const dir = path.join(root, "instances", "default");

test("no flags and no setup: entitlements stay off", () => {
  assert.equal(parseEntitlementFlags({}, root, dir, null), null);
  assert.deepEqual(entitlementEnv(null), {});
});

test("a public key gives the default file inside the instance and the three env values", () => {
  const setup = parseEntitlementFlags({ "entitlement-public-key": raw, "entitlement-client": "c001" }, root, dir, null)!;
  assert.equal(setup.file, path.join(dir, "entitlements", "entitlement.json"));
  assert.deepEqual(entitlementEnv(setup), {
    GSAM_ENTITLEMENT_PUBLIC_KEY: raw,
    GSAM_ENTITLEMENT_FILE: setup.file,
    GSAM_ENTITLEMENT_CLIENT: "c001",
  });
});

test("the key can be a PEM file; a private key is refused", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ent-flags-"));
  try {
    const pub = path.join(scratch, "hub.pub.pem");
    writeFileSync(pub, pem);
    assert.equal(parseEntitlementFlags({ "entitlement-public-key": pub }, root, dir, null)!.publicKey, pem.trim());
    const priv = path.join(scratch, "hub.key.pem");
    writeFileSync(priv, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    assert.throws(() => parseEntitlementFlags({ "entitlement-public-key": priv }, root, dir, null), /private key/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("bad key, file outside the instance, or a client name are refused", () => {
  assert.throws(() => parseEntitlementFlags({ "entitlement-public-key": "not-a-key" }, root, dir, null), /not a valid Ed25519/);
  assert.throws(
    () => parseEntitlementFlags({ "entitlement-public-key": raw, "entitlement-file": "/srv/instances/c002/e.json" }, root, dir, null),
    /inside the instance folder/,
  );
  assert.throws(() => parseEntitlementFlags({ "entitlement-public-key": raw, "entitlement-client": "Acme Ltd" }, root, dir, null), /client code/);
  assert.throws(() => parseEntitlementFlags({ "entitlement-client": "c001" }, root, dir, null), /need --entitlement-public-key/);
});

test("a later change keeps what it does not name", () => {
  const first = parseEntitlementFlags({ "entitlement-public-key": raw, "entitlement-client": "c001" }, root, dir, null)!;
  const moved = parseEntitlementFlags({ "entitlement-file": path.join(root, "keys", "e.json") }, root, dir, first)!;
  assert.equal(moved.publicKey, raw);
  assert.equal(moved.client, "c001");
  assert.equal(moved.file, path.join(root, "keys", "e.json"));
});

const feature = (entitled: boolean) => ({ enableWebsiteView: { entitled, effective: entitled, pendingRestart: false } }) as never;
const doc = { client: "c001", version: 2, issuedAt: "2026-10-01T00:00:00Z", issuedBy: "x", validUntil: "2026-11-01T00:00:00Z", graceEndsAt: "2026-11-15T00:00:00Z" };

test("Website is expected on only for an active or grace document that grants the key", () => {
  assert.equal(websiteExpected({ state: "active", features: feature(true) }), true);
  assert.equal(websiteExpected({ state: "grace", features: feature(true) }), true);
  assert.equal(websiteExpected({ state: "active", features: feature(false) }), false);
  assert.equal(websiteExpected({ state: "floor", features: feature(true) }), false);
  assert.equal(websiteExpected({ state: "disabled", features: feature(true) }), false);
});

test("verify passes when state, switch and API all match the key", () => {
  const setup = { publicKey: raw, file: "/x" };
  const on = entitlementChecks(setup, { state: "active", features: feature(true), document: doc, lastError: null }, true, 200);
  assert.ok(on.every((c) => c.ok), JSON.stringify(on));
  const off = entitlementChecks(null, { state: "disabled", features: feature(true), document: null, lastError: null }, false, 403);
  assert.ok(off.every((c) => c.ok), JSON.stringify(off));
  const floor = entitlementChecks(setup, { state: "floor", features: feature(false), document: null, lastError: null }, false, 403);
  assert.ok(floor.every((c) => c.ok), JSON.stringify(floor));
});

test("verify fails on a mismatch", () => {
  const setup = { publicKey: raw, file: "/x" };
  // Hub key set, but the server runs without it (not restarted).
  assert.equal(entitlementChecks(setup, { state: "disabled", features: feature(false), document: null, lastError: null }, false, 403)[0]!.ok, false);
  // The key is granted but the Website API still refuses.
  const refused = entitlementChecks(setup, { state: "active", features: feature(true), document: doc, lastError: null }, true, 403);
  assert.equal(refused.at(-1)!.ok, false);
  // No key, but the switch reads on.
  assert.equal(entitlementChecks(null, { state: "disabled", features: feature(true), document: null, lastError: null }, true, 200)[1]!.ok, false);
});

test("grace says when to renew", () => {
  const lines = entitlementChecks({ publicKey: raw, file: "/x" }, { state: "grace", features: feature(true), document: doc, lastError: null }, true, 200);
  assert.ok(lines.some((c) => c.line.includes("renew before 2026-11-15")));
});
