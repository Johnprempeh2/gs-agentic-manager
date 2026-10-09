import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import { buildCheckIn, fleetHubUrl, generateFleetKey, hubAnswer, nextSeq, signFleetMessage, usageTotals, type CheckInInput } from "./fleet.ts";

const now = Date.parse("2026-10-09T12:00:00Z");

const input: CheckInInput = {
  edition: "managed",
  appUp: true,
  newestBackupAt: "2026-10-09T11:30:00Z",
  lastRestoreCheck: { ok: true, at: "2026-10-08T12:00:00Z" },
  lastOffsiteBackup: null,
  releaseTag: "stable-2026-10-01.1",
  appVersion: "0.3.1",
  lastUpgrade: { to: { tag: "stable-2026-10-01.1" }, at: "2026-10-02T12:00:00Z" },
  usage: usageTotals([], 0),
  signals: [
    { key: "health", ok: true, detail: "pid 1, health ok" },
    { key: "ai-connections:abcdef12", ok: false, detail: "claude connection 1234 for Acme Ltd is expired" },
    { key: "Weird Key", ok: true, detail: "" },
  ],
};

test("the check-in keeps keys and pass/fail, never the signal detail", () => {
  const checkIn = buildCheckIn(input, now);
  assert.deepEqual(checkIn.alerts, [
    { key: "health", ok: true },
    { key: "ai-connections:abcdef12", ok: false },
    { key: "other", ok: true },
  ]);
  assert.equal(checkIn.health.backupAgeMinutes, 30);
  assert.deepEqual(checkIn.health.restoreCheck, { ok: true, ageMinutes: 1440 });
  assert.equal(JSON.stringify(checkIn).includes("Acme"), false);
});

test("a value outside the schema stops the check-in before it is signed", () => {
  assert.throws(() => buildCheckIn({ ...input, releaseTag: "Acme merger plan" }, now));
});

test("usage is totals over every company", () => {
  const usage = usageTotals(
    [
      { agents: [{ status: "idle" }, { status: "terminated" }, { status: "running" }], runs: [{ createdAt: "2026-10-09T10:00:00Z" }, { createdAt: "2026-10-07T10:00:00Z" }], spendCents: 120.4, budgetCents: 5000 },
      { agents: [{ status: "paused" }], runs: [], spendCents: 10, budgetCents: 0 },
    ],
    2048,
    now,
  );
  assert.deepEqual(usage, { companies: 2, activeAgents: 2, runsLast24h: 1, spendCentsMonth: 130, budgetCentsMonth: 5000, storageBytes: 2048 });
});

test("a signed message verifies with the public key only", () => {
  const key = generateFleetKey();
  const message = signFleetMessage(key.privateJwk, { act: "revoke", sub: "id-1", seq: 5 }, now);
  const [header, payload, signature] = message.split(".");
  const publicKey = createPublicKey({ key: key.publicKey, format: "jwk" });
  assert.equal(verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url")), true);
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "EdDSA", typ: "gsam-fleet+jwt", kid: "id-1" });
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
  assert.equal(claims.exp - claims.iat, 300);
  assert.equal("d" in key.publicKey, false);
});

test("seq always grows, even when the clock goes back", () => {
  assert.equal(nextSeq(0, now), now);
  assert.equal(nextSeq(now + 5000, now), now + 5001);
});

test("hub URL: https, or http on loopback only", () => {
  assert.equal(fleetHubUrl("https://hub.example/"), "https://hub.example");
  assert.equal(fleetHubUrl("http://127.0.0.1:3300"), "http://127.0.0.1:3300");
  assert.ok(typeof fleetHubUrl("http://hub.example") !== "string");
  assert.ok(typeof fleetHubUrl("https://user:pw@hub.example") !== "string");
});

test("a revoked key tells the operator what to do", () => {
  assert.match(hubAnswer(401, { error: "fleet_key_revoked" }).detail, /new code/);
  assert.deepEqual(hubAnswer(409, { error: "fleet_replay" }), { ok: false, detail: "hub refused: fleet_replay" });
});
