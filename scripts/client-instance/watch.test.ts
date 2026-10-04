// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/watch.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALERT_REPEAT_MS,
  aiSignals,
  alertMessage,
  decideAlert,
  diskSignal,
  linesSignal,
  memAvailableFromMeminfo,
  memorySignal,
  parseWatchConfig,
  publicHealthUrl,
  publicUrlSignal,
} from "./watch.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const COMPANY = "11111111-2222-3333-4444-555555555555";
const iso = (ms: number) => new Date(ms).toISOString();

test("a status WARNING line fails the signal", () => {
  assert.deepEqual(linesSignal("backup", ["backup: newest x.sql.gz, 40 min old"]), { key: "backup", ok: true, detail: "backup: newest x.sql.gz, 40 min old" });
  const failed = linesSignal("backup", ["backup: none in /x", "WARNING: no backup found; check the server's hourly backup"]);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /^WARNING: no backup found/);
});

test("disk and memory fail below the run floors (GRE-207)", () => {
  assert.equal(diskSignal(21 * 1024 ** 3).ok, true);
  assert.equal(diskSignal(19 * 1024 ** 3).ok, false);
  assert.equal(memorySignal(3000 * 1024 ** 2).ok, true);
  assert.equal(memorySignal(1000 * 1024 ** 2).ok, false);
  assert.equal(memAvailableFromMeminfo("MemTotal:  16000000 kB\nMemAvailable:    2048000 kB\n"), 2048000 * 1024);
  assert.equal(memAvailableFromMeminfo("MemTotal: 1 kB\n"), null);
});

test("AI access passes when every connection is connected with no expiry under 7 days", () => {
  const [connections, runs] = aiSignals(COMPANY, [{ id: "aaaaaaaa-1", provider: "claude", status: "connected", credential: { expiresAt: iso(NOW + 300 * DAY) } }], [], NOW);
  assert.deepEqual(connections, { key: "ai-connections:11111111", ok: true, detail: "1 connected" });
  assert.equal(runs!.ok, true);
});

test("AI access fails on needs attention, expired or revoked", () => {
  for (const status of ["needs_attention", "expired", "revoked"]) {
    const [signal] = aiSignals(COMPANY, [{ id: "aaaaaaaa-1", provider: "claude", status }], [], NOW);
    assert.equal(signal!.ok, false, status);
    assert.match(signal!.detail, new RegExp(`claude connection aaaaaaaa is ${status.replace("_", " ")}`));
  }
});

test("AI access fails when a token expires in under 7 days, or has expired", () => {
  const soon = aiSignals(COMPANY, [{ id: "aaaaaaaa-1", status: "connected", credential: { expiresAt: iso(NOW + 6 * DAY) } }], [], NOW)[0]!;
  assert.equal(soon.ok, false);
  assert.match(soon.detail, /under 7 days/);
  const gone = aiSignals(COMPANY, [{ id: "aaaaaaaa-1", status: "connected", credential: { expiresAt: iso(NOW - MIN) } }], [], NOW)[0]!;
  assert.match(gone.detail, /token expired/);
  const unknown = aiSignals(COMPANY, [{ id: "aaaaaaaa-1", status: "connected", credential: { expiresAt: null } }], [], NOW)[0]!;
  assert.equal(unknown.ok, true);
});

test("a run refused for auth in the last hour fails; older ones and other failures do not", () => {
  const runs = [
    { id: "r1aaaaaa-x", status: "failed", errorCode: "claude_auth_required", finishedAt: iso(NOW - 10 * MIN) },
    { id: "r2aaaaaa-x", status: "failed", errorCode: "claude_auth_required", finishedAt: iso(NOW - 2 * 60 * MIN) },
    { id: "r3aaaaaa-x", status: "failed", errorCode: "adapter_failed", finishedAt: iso(NOW - MIN) },
    { id: "r4aaaaaa-x", status: "succeeded", errorCode: null, finishedAt: iso(NOW - MIN) },
  ];
  const signal = aiSignals(COMPANY, [], runs, NOW)[1]!;
  assert.equal(signal.key, "ai-failed-auth:11111111");
  assert.equal(signal.ok, false);
  assert.match(signal.detail, /^1 run\(s\) refused .*r1aaaaaa claude_auth_required\)$/);
  assert.equal(aiSignals(COMPANY, [], runs.slice(1), NOW)[1]!.ok, true);
});

test("alerts go out on a change, every 24 h while failing, and once on recovery", () => {
  const quiet = { failing: [], alertedAt: null };
  assert.deepEqual(decideAlert(quiet, [], NOW), { send: false });
  assert.deepEqual(decideAlert(quiet, ["disk"], NOW), { send: true, kind: "failing" });
  const sent = { failing: ["disk"], alertedAt: iso(NOW - 5 * MIN) };
  assert.deepEqual(decideAlert(sent, ["disk"], NOW), { send: false });
  assert.deepEqual(decideAlert(sent, ["disk", "ai"], NOW), { send: true, kind: "failing" });
  assert.deepEqual(decideAlert({ failing: ["disk"], alertedAt: iso(NOW - ALERT_REPEAT_MS) }, ["disk"], NOW), { send: true, kind: "failing" });
  assert.deepEqual(decideAlert(sent, [], NOW), { send: true, kind: "recovered" });
  // Order of keys does not matter.
  assert.deepEqual(decideAlert({ failing: ["ai", "disk"], alertedAt: iso(NOW) }, ["disk", "ai"], NOW), { send: false });
});

test("the alert mail names the code and the failing checks only", () => {
  const signals = [
    { key: "health", ok: true, detail: "pid 1, health ok" },
    { key: "ai-connections:11111111", ok: false, detail: "claude connection aaaaaaaa is needs attention" },
  ];
  const mail = alertMessage("c001", "failing", signals, iso(NOW));
  assert.equal(mail.subject, "[GSAM c001] 1 check(s) failing: ai-connections:11111111");
  assert.match(mail.body, /^FAIL ai-connections:11111111: claude connection aaaaaaaa is needs attention$/m);
  assert.equal(alertMessage("c001", "recovered", signals, iso(NOW)).subject, "[GSAM c001] all checks pass again");
});

test("a watch config must tell someone", () => {
  const ok = parseWatchConfig("WATCH_OPERATOR_PASSWORD=pw\nWATCH_PING_URL=https://hc-ping.com/uuid\nWATCH_ALERT_EMAIL=oncall@example.com\nWATCH_MAIL_COMMAND=/usr/sbin/sendmail -t\n");
  assert.deepEqual(ok, { operatorPassword: "pw", pingUrl: "https://hc-ping.com/uuid", alertEmail: "oncall@example.com", mailCommand: ["/usr/sbin/sendmail", "-t"], publicUrl: null });
  assert.match((parseWatchConfig("WATCH_OPERATOR_PASSWORD=pw\n") as { error: string }).error, /set WATCH_PING_URL/);
  assert.match((parseWatchConfig("WATCH_PING_URL=https://x\n") as { error: string }).error, /WATCH_OPERATOR_PASSWORD is missing/);
  assert.match((parseWatchConfig("WATCH_OPERATOR_PASSWORD=pw\nWATCH_ALERT_EMAIL=a@b\n") as { error: string }).error, /both/);
  assert.match((parseWatchConfig("WATCH_OPERATOR_PASSWORD=pw\nWATCH_PING_URL=ftp://x\n") as { error: string }).error, /http/);
  assert.match((parseWatchConfig("OTHER=1\n") as { error: string }).error, /not a watch setting/);
});

test("the public URL probe takes https only (http only on loopback) and probes /api/health", () => {
  assert.equal(publicHealthUrl("https://c001.example.com"), "https://c001.example.com/api/health");
  assert.equal(publicHealthUrl("https://c001.example.com/"), "https://c001.example.com/api/health");
  assert.equal(publicHealthUrl("http://127.0.0.1:3901"), "http://127.0.0.1:3901/api/health");
  assert.match((publicHealthUrl("http://c001.example.com") as { error: string }).error, /https/);
  assert.match((publicHealthUrl("c001.example.com") as { error: string }).error, /not a URL/);
  assert.match((publicHealthUrl("https://u:p@c001.example.com") as { error: string }).error, /log-in/);
  const config = parseWatchConfig("WATCH_OPERATOR_PASSWORD=pw\nWATCH_PING_URL=https://hc-ping.com/uuid\nWATCH_PUBLIC_URL=https://c001.example.com\n");
  assert.equal((config as { publicUrl: string }).publicUrl, "https://c001.example.com");
  assert.match((parseWatchConfig("WATCH_OPERATOR_PASSWORD=pw\nWATCH_PING_URL=https://x\nWATCH_PUBLIC_URL=http://c001.example.com\n") as { error: string }).error, /^WATCH_PUBLIC_URL: .*https/);
});

test("the public URL probe passes only on HTTP 200 with health ok", () => {
  const url = "https://c001.example.com/api/health";
  assert.deepEqual(publicUrlSignal(url, { status: 200, body: { status: "ok" } }), { key: "public-url", ok: true, detail: `${url}: health ok` });
  assert.match(publicUrlSignal(url, { error: "fetch failed: CERT_HAS_EXPIRED" }).detail, /no answer \(fetch failed: CERT_HAS_EXPIRED\)/);
  assert.match(publicUrlSignal(url, { status: 502, body: null }).detail, /HTTP 502$/);
  assert.match(publicUrlSignal(url, { status: 403, body: { error: "forbidden" } }).detail, /HTTP 403$/);
  assert.match(publicUrlSignal(url, { status: 308, body: null }).detail, /HTTP 308$/);
  assert.match(publicUrlSignal(url, { status: 200, body: null }).detail, /health not JSON$/);
  assert.match(publicUrlSignal(url, { status: 200, body: { status: "degraded" } }).detail, /health degraded$/);
  for (const r of [{ error: "x" }, { status: 502, body: null }, { status: 200, body: { status: "degraded" } }]) assert.equal(publicUrlSignal(url, r).ok, false);
});
