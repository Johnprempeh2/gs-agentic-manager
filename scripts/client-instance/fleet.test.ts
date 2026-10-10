import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import { buildCheckIn, countRunsSince, fleetHubUrl, generateFleetKey, hubAnswer, nextSeq, RUN_PAGE_LIMIT, signFleetMessage, usageTotals, type CheckInInput } from "./fleet.ts";

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
    { key: "ai-connections:12345678", ok: true, detail: "1 connected" },
    { key: "ai-failed-auth:12345678", ok: true, detail: "" },
    { key: "Weird Key", ok: true, detail: "" },
  ],
};

test("the check-in keeps keys and pass/fail, never the signal detail", () => {
  const checkIn = buildCheckIn(input, now);
  assert.deepEqual(checkIn.alerts, [
    { key: "health", ok: true },
    { key: "ai-connections", ok: false },
    { key: "ai-failed-auth", ok: true },
    { key: "other", ok: true },
  ]);
  assert.equal(checkIn.health.backupAgeMinutes, 30);
  assert.deepEqual(checkIn.health.restoreCheck, { ok: true, ageMinutes: 1440 });
  assert.equal(JSON.stringify(checkIn).includes("Acme"), false);
});

test("no company id leaves the host: per-company signals fold into one key per check", () => {
  const serialized = JSON.stringify(buildCheckIn(input, now));
  for (const id of ["abcdef12", "12345678"]) assert.equal(serialized.includes(id), false);
});

test("a value outside the schema stops the check-in before it is signed", () => {
  assert.throws(() => buildCheckIn({ ...input, releaseTag: "Acme merger plan" }, now));
});

test("usage is totals over every company", () => {
  const usage = usageTotals(
    [
      { agents: [{ status: "idle" }, { status: "terminated" }, { status: "running" }], runsLast24h: 1, spendCents: 120.4, budgetCents: 5000 },
      { agents: [{ status: "paused" }], runsLast24h: 1500, spendCents: 10, budgetCents: 0 },
    ],
    2048,
  );
  assert.deepEqual(usage, { companies: 2, activeAgents: 2, runsLast24h: 1501, spendCentsMonth: 130, budgetCentsMonth: 5000, storageBytes: 2048 });
});

/** A fake run list with the API's rules: since inclusive, before exclusive, newest first, 1000 per page. */
function runList(runs: Array<{ id: string; createdAt: string }>) {
  const calls: Array<Date | null> = [];
  const fetchPage = async (since: Date, before: Date | null) => {
    calls.push(before);
    return runs
      .filter((r) => Date.parse(r.createdAt) >= since.getTime() && (!before || Date.parse(r.createdAt) < before.getTime()))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, RUN_PAGE_LIMIT);
  };
  return { fetchPage, calls };
}

test("the 24 h run count pages past the 1000-row cap and counts each run once", async () => {
  const since = new Date(now - 24 * 60 * 60 * 1000);
  // 2501 runs in the window, 5 per millisecond so pages end mid-timestamp, and 10 older runs.
  const runs = Array.from({ length: 2501 }, (_, i) => ({ id: `r${i}`, createdAt: new Date(now - 1000 - Math.floor(i / 5)).toISOString() }));
  runs.push(...Array.from({ length: 10 }, (_, i) => ({ id: `old${i}`, createdAt: new Date(since.getTime() - 1 - i).toISOString() })));
  const list = runList(runs);
  assert.equal(await countRunsSince(list.fetchPage, since), 2501);
  assert.ok(list.calls.length >= 3);
  assert.equal(await countRunsSince(runList(runs.slice(0, 1000)).fetchPage, since), 1000);
  assert.equal(await countRunsSince(runList([]).fetchPage, since), 0);
});

test("the run count moves on when a full page is all one millisecond", async () => {
  const since = new Date(now - 24 * 60 * 60 * 1000);
  const sameMs = new Date(now - 5000).toISOString();
  const runs = Array.from({ length: 1200 }, (_, i) => ({ id: `s${i}`, createdAt: sameMs }));
  runs.push(...Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, createdAt: new Date(now - 9000 - i).toISOString() })));
  // 200 runs in the one millisecond cannot be reached; the 7 older runs still count.
  assert.equal(await countRunsSince(runList(runs).fetchPage, since), 1007);
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
