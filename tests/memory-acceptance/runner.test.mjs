import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDoubleTarget, FAULTS } from "./lib/double.mjs";
import { d7Items, loadFixtures } from "./lib/fixtures.mjs";
import { createLiveTarget, loadLiveConfig } from "./lib/live.mjs";
import { runAll, TESTS } from "./lib/tests.mjs";

const { world, scenarios } = loadFixtures();
const PHASE1 = ["MT-01", "MT-02", "MT-03", "MT-04", "MT-05", "MT-06", "MT-07", "MT-08", "MT-09", "MT-12", "MT-31"];

async function statuses(faults = []) {
  const report = await runAll(createDoubleTarget({ world, faults }), { scenarios });
  return Object.fromEntries(report.results.map((r) => [r.id, r.status]));
}

test("the runner covers exactly the 11 phase 1 tests from GRE-651", () => {
  assert.deepEqual(TESTS.map((t) => t.id), PHASE1);
});

test("fixtures are synthetic and internally consistent", () => {
  assert.equal(world.synthetic, true);
  const scopeIds = new Set(world.scopes.map((s) => s.id));
  for (const i of world.identities) for (const g of i.grants) assert.ok(scopeIds.has(g.scope), `${i.id} grant on unknown scope ${g.scope}`);
  for (const s of Object.values(scenarios)) for (const r of s.records ?? []) assert.ok(scopeIds.has(r.scope), `${r.id} on unknown scope`);
  assert.equal(scenarios.D5.entries.length, 40);
  assert.ok(scenarios.D5.entries.every((e) => e.scope === "org" || e.scope === "cl-alder"), "D5 never touches cl-brook");
  const token = d7Items(scenarios).find((i) => i.id === "D7-token").value;
  assert.match(token, /^ghp_[A-Za-z0-9]{36}$/);
  assert.match(token, /SYNTHETIC/);
});

test("all 11 tests pass against the correct test double", async () => {
  const s = await statuses();
  assert.deepEqual(s, Object.fromEntries(PHASE1.map((id) => [id, "pass"])));
});

// Output bar: show each test can fail. Every fault must turn its tests red.
const EXPECTED_RED = {
  "grant-check-allow": ["MT-01", "MT-02", "MT-03", "MT-04"],
  "trust-body-identity": ["MT-05"],
  "skip-run-check": ["MT-06"],
  "engine-open": ["MT-07", "MT-08", "MT-09"],
  "redaction-off": ["MT-12"],
  "extra-egress": ["MT-31"],
  "audit-off": ["MT-01", "MT-02", "MT-03", "MT-04", "MT-05", "MT-06", "MT-12"],
};

test("every fault is covered by an expectation", () => {
  assert.deepEqual(Object.keys(EXPECTED_RED).sort(), Object.keys(FAULTS).sort());
});

for (const [fault, red] of Object.entries(EXPECTED_RED)) {
  test(`fault ${fault} turns ${red.join(", ")} red and nothing else`, async () => {
    const s = await statuses([fault]);
    for (const id of PHASE1) assert.equal(s[id], red.includes(id) ? "fail" : "pass", `${id} under ${fault}`);
  });
}

test("every phase 1 test is turned red by at least one fault", () => {
  const covered = new Set(Object.values(EXPECTED_RED).flat());
  assert.deepEqual(PHASE1.filter((id) => !covered.has(id)), []);
});

test("live target refuses the live app port", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-acc-"));
  const path = join(dir, "live.json");
  writeFileSync(path, JSON.stringify({ gatewayUrl: "http://127.0.0.1:3100", companyId: "x" }));
  assert.throws(() => loadLiveConfig(path), /3100/);
});

test("live target with no engine reports engine tests inconclusive, never pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-acc-"));
  const path = join(dir, "live.json");
  // Port 9 (discard) on loopback: nothing listens, so the gateway is unreachable.
  writeFileSync(path, JSON.stringify({ gatewayUrl: "http://127.0.0.1:9", companyId: "x", engine: { host: "127.0.0.1", restPort: 9, controlPlanePort: 9, postgresPort: 9 }, timeoutMs: 500 }));
  const target = createLiveTarget(loadLiveConfig(path));
  target.seed = async () => {};
  const report = await runAll(target, { scenarios });
  const byId = Object.fromEntries(report.results.map((r) => [r.id, r.status]));
  assert.equal(report.preflight.engineUp, false);
  for (const id of ["MT-07", "MT-08", "MT-09"]) assert.equal(byId[id], "inconclusive");
  assert.equal(byId["MT-31"], "inconclusive");
  assert.equal(byId["MT-12"], "fail", "an unreachable gateway is not 'redacted'");
  assert.equal(byId["MT-05"], "fail", "an unreachable gateway is not 'rejected'");
  assert.ok(report.results.every((r) => r.status !== "pass"), "nothing passes against an unreachable gateway");
});
