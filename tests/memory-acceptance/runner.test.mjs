import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDoubleTarget, FAULTS } from "./lib/double.mjs";
import { d7Items, grantedScopes, loadFixtures } from "./lib/fixtures.mjs";
import { createLiveTarget, loadLiveConfig } from "./lib/live.mjs";
import { loadGsamConfig } from "./lib/gsam.mjs";
import { PHASE1_TESTS, PHASE2_TESTS, PHASE3_TESTS, runAll } from "./lib/tests.mjs";

const { world, scenarios, graph } = loadFixtures();
const PHASE1 = ["MT-01", "MT-02", "MT-03", "MT-04", "MT-05", "MT-06", "MT-07", "MT-08", "MT-09", "MT-12", "MT-31"];
// GRE-888. GRE-651 numbering; MT-33 (same question, two clients) is new.
const PHASE2 = ["MT-10", "MT-10b", "MT-11", "MT-32", "MT-33", "MT-14", "MT-15", "MT-16", "MT-17", "MT-18", "MT-26", "MT-30", "MT-19", "MT-13"];
// GRE-866: plan GRE-646 section 8, on fixture D9 (fixtures/graph.json).
const PHASE3 = ["MT-40", "MT-41", "MT-42", "MT-43", "MT-44", "MT-45", "MT-46", "MT-47", "MT-48", "MT-49", "MT-50", "MT-51", "MT-52"];
const ALL = [...PHASE1, ...PHASE2, ...PHASE3];

async function statuses(faults = []) {
  const report = await runAll(createDoubleTarget({ world, faults }), { scenarios, graph });
  return Object.fromEntries(report.results.map((r) => [r.id, r.status]));
}

test("the runner covers exactly the 11 phase 1 tests from GRE-651", () => {
  assert.deepEqual(PHASE1_TESTS.map((t) => t.id), PHASE1);
});

test("the runner covers the phase 2 exit tests (GRE-888)", () => {
  assert.deepEqual(PHASE2_TESTS.map((t) => t.id), PHASE2);
});

test("the runner covers the phase 3 acceptance tests (GRE-866)", () => {
  assert.deepEqual(PHASE3_TESTS.map((t) => t.id), PHASE3);
});

test("phase 3 fixture D9 is synthetic and its hidden strings are really hidden", () => {
  assert.equal(graph.synthetic, true);
  const scopeIds = new Set(world.scopes.map((s) => s.id));
  const ids = new Set(world.identities.map((i) => i.id));
  for (const r of graph.records) {
    assert.ok(scopeIds.has(r.scope), `${r.id} on unknown scope`);
    assert.ok(ids.has(r.contributor), `${r.id} contributor unknown`);
    assert.ok(r.topics?.length, `${r.id} needs topics (client-scope proposals are refused without them)`);
  }
  for (const rv of [...graph.reviews, ...graph.supersessions]) assert.equal(rv.actor, "hu-john-syn", "client and restricted scopes are owner-reviewed");
  for (const e of graph.relationships) {
    const all = [...graph.records, ...Object.values(scenarios).flatMap((s) => s.records ?? [])];
    const from = all.find((r) => r.id === e.from);
    const to = all.find((r) => r.id === e.to);
    assert.equal(from.scope, to.scope, `${e.id} must stay in one scope`);
  }
  // Every string a restricted caller must not see appears in no record it may read.
  const readable = (who) => grantedScopes(world, who, "read");
  const records = [...graph.records, ...Object.values(scenarios).flatMap((s) => [...(s.records ?? []), ...(s.entries ?? []).map((e) => ({ ...e, id: e.recordId }))])];
  for (const [who, r] of Object.entries(graph.restricted)) {
    const visible = records.filter((x) => readable(who).includes(x.scope));
    for (const str of r.hiddenStrings) assert.deepEqual(visible.filter((x) => JSON.stringify(x).includes(str)).map((x) => x.id), [], `${who}: '${str}' is in a readable record`);
    for (const id of r.hiddenRecords) assert.ok(!visible.some((x) => x.id === id), `${who}: ${id} is readable`);
  }
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
  assert.ok(scenarios.D5.missedDayEntries.every((e) => e.scope !== "cl-brook"), "missed-day entries never touch cl-brook");
  assert.ok(scenarios.D5.outOfScopeEntries.every((e) => e.scope === "cl-brook"), "out-of-scope entries are cl-brook");
  const scribe = world.identities.find((i) => i.id === "ag-scribe-syn");
  assert.ok(scribe.grants.every((g) => !g.rights.includes("approve") && !g.rights.includes("read")), "the seeding agent can only contribute");
});

test("all phase 1, 2 and 3 tests pass against the correct test double", async () => {
  const s = await statuses();
  assert.deepEqual(s, Object.fromEntries(ALL.map((id) => [id, "pass"])));
});

test("phase 2 tests pass when run one at a time (each seeds what it needs)", async () => {
  for (const id of PHASE2) {
    const report = await runAll(createDoubleTarget({ world }), { scenarios, only: [id], phases: [2] });
    assert.equal(report.results[0].status, "pass", id);
  }
});

test("a target without the phase 2 calls reports phase 2 inconclusive, never pass", async () => {
  const t = createDoubleTarget({ world });
  for (const m of ["review", "supersede", "stewardQueue", "remove", "getRecord", "createDirective", "stewardRun", "stewardLedger", "reviewQueue", "recordHistory", "grantsOf", "adminRecordRow", "adminFindText"]) delete t[m];
  const report = await runAll(t, { scenarios, phases: [2] });
  for (const r of report.results) assert.equal(r.status, "inconclusive", r.id);
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
  // Zero results from a recall that never searched must not count as isolation.
  "recall-unavailable": ["MT-01", "MT-03", "MT-04", "MT-05"],
  // A recall with no scope named must not reach any client scope.
  "bare-recall-crosses-clients": ["MT-01"],
  // Phase 2. The extra ids are knock-on effects: MT-19 runs last over
  // everything earlier tests wrote, so a broken rule upstream shows there too.
  "grant-check-allow+": ["MT-30", "MT-19"],
  "extra-egress+": ["MT-16"],
  "audit-off+": ["MT-10", "MT-10b", "MT-18", "MT-26", "MT-30", "MT-13"],
  "recall-unavailable+": ["MT-10", "MT-10b", "MT-32", "MT-33", "MT-14", "MT-15", "MT-16", "MT-13"],
  "self-approval-allowed": ["MT-18"],
  "approve-rights-off": ["MT-26", "MT-30", "MT-19"],
  "proposal-overwrites-approved": ["MT-10b", "MT-11", "MT-32", "MT-15", "MT-19"],
  // No conflict check, no inferred edge (R-911 ~ R-907) in the phase 3 graph.
  "conflict-check-off": ["MT-10", "MT-11", "MT-33", "MT-19", "MT-41"],
  "client-topics-optional": ["MT-10b"],
  "conflict-across-scopes": ["MT-33", "MT-19"],
  "supersede-as-conflict": ["MT-32"],
  "newest-first": ["MT-10", "MT-32", "MT-15"],
  "as-of-ignored": ["MT-32"],
  "trust-content-approval": ["MT-15", "MT-17", "MT-26"],
  "instruction-flag-off": ["MT-14", "MT-16"],
  "directives-open": ["MT-17"],
  "steward-not-idempotent": ["MT-19"],
  "steward-skip-missed-day": ["MT-19"],
  "delete-leaves-engine": ["MT-13"],
  "delete-no-tombstone": ["MT-13"],
  // Phase 3 (GRE-866). A stubbed grant check also leaks through every phase 3 view.
  "grant-check-allow++": ["MT-45", "MT-50", "MT-51", "MT-52"],
  "graph-fabricated-edge": ["MT-40"],
  "inferred-as-explicit": ["MT-40", "MT-41"],
  "causal-label": ["MT-41"],
  "graph-ignores-grants": ["MT-50", "MT-52"],
  // Edges never cross scopes, so a kept half-hidden edge shows only in filtered views.
  "dangling-edges": ["MT-42"],
  "edges-ignore-grants": ["MT-42", "MT-50", "MT-52"],
  "counts-include-hidden": ["MT-45", "MT-51"],
  "activity-ignores-grants": ["MT-45", "MT-51", "MT-52"],
  "count-drilldown-mismatch": ["MT-45", "MT-51"],
  "roles-merged": ["MT-46"],
  "extraction-unlinked": ["MT-47"],
  "list-graph-mismatch": ["MT-42"],
  // Every caller reads org, so only filtered views are empty.
  "restricted-errors": ["MT-52"],
  "hidden-id-distinguishable": ["MT-50"],
  "status-drift": ["MT-42", "MT-43", "MT-44", "MT-49"],
  "nav-no-source": ["MT-43", "MT-47", "MT-48"],
  "score-field": ["MT-45"],
  "activity-no-history": ["MT-44"],
};

// "fault+" entries add phase 2 ids, "fault++" phase 3 ids, to an earlier fault's list.
for (const key of Object.keys(EXPECTED_RED).filter((k) => k.endsWith("+"))) {
  EXPECTED_RED[key.replace(/\+*$/, "")].push(...EXPECTED_RED[key]);
  delete EXPECTED_RED[key];
}

test("every fault is covered by an expectation", () => {
  assert.deepEqual(Object.keys(EXPECTED_RED).sort(), Object.keys(FAULTS).sort());
});

for (const [fault, red] of Object.entries(EXPECTED_RED)) {
  test(`fault ${fault} turns ${red.join(", ")} red and nothing else`, async () => {
    const s = await statuses([fault]);
    for (const id of ALL) assert.equal(s[id], red.includes(id) ? "fail" : "pass", `${id} under ${fault}`);
  });
}

test("every phase 1, 2 and 3 test is turned red by at least one fault", () => {
  const covered = new Set(Object.values(EXPECTED_RED).flat());
  assert.deepEqual(ALL.filter((id) => !covered.has(id)), []);
});

test("phase 3 tests pass when run one at a time (each seeds D9 itself)", async () => {
  for (const id of PHASE3) {
    const report = await runAll(createDoubleTarget({ world }), { scenarios, graph, only: [id], phases: [3] });
    assert.equal(report.results[0].status, "pass", id);
  }
});

test("a target without the phase 3 views reports phase 3 inconclusive, never pass", async () => {
  const t = createDoubleTarget({ world });
  for (const m of ["graph", "memoryList", "node", "edge", "activity", "counts", "relationshipRows", "inferredRows", "extractedFacts", "backdate"]) delete t[m];
  const report = await runAll(t, { scenarios, graph, phases: [3] });
  for (const r of report.results) assert.equal(r.status, "inconclusive", r.id);
});

test("live target refuses the live app port", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-acc-"));
  const path = join(dir, "live.json");
  writeFileSync(path, JSON.stringify({ gatewayUrl: "http://127.0.0.1:3100", companyId: "x" }));
  assert.throws(() => loadLiveConfig(path), /3100/);
});

test("gsam target refuses the live app port and the live database", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-acc-"));
  const path = join(dir, "gsam.json");
  const sandboxDb = "postgres://u:p@127.0.0.1:54391/db";
  writeFileSync(path, JSON.stringify({ gatewayUrl: "http://127.0.0.1:3100", databaseUrl: sandboxDb }));
  assert.throws(() => loadGsamConfig(path), /3100/);
  writeFileSync(path, JSON.stringify({ gatewayUrl: "http://127.0.0.1:3291", databaseUrl: "postgres://u:p@127.0.0.1:54329/db" }));
  assert.throws(() => loadGsamConfig(path), /54329/);
});

test("live target with no engine reports engine tests inconclusive, never pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-acc-"));
  const path = join(dir, "live.json");
  // Port 9 (discard) on loopback: nothing listens, so the gateway is unreachable.
  writeFileSync(path, JSON.stringify({ gatewayUrl: "http://127.0.0.1:9", companyId: "x", engine: { host: "127.0.0.1", restPort: 9, controlPlanePort: 9, postgresPort: 9 }, timeoutMs: 500 }));
  const target = createLiveTarget(loadLiveConfig(path));
  target.seed = async () => {};
  const report = await runAll(target, { scenarios, phases: [1] });
  const byId = Object.fromEntries(report.results.map((r) => [r.id, r.status]));
  assert.equal(report.preflight.engineUp, false);
  for (const id of ["MT-07", "MT-08", "MT-09"]) assert.equal(byId[id], "inconclusive");
  assert.equal(byId["MT-31"], "inconclusive");
  assert.equal(byId["MT-12"], "fail", "an unreachable gateway is not 'redacted'");
  assert.equal(byId["MT-05"], "fail", "an unreachable gateway is not 'rejected'");
  assert.ok(report.results.every((r) => r.status !== "pass"), "nothing passes against an unreachable gateway");
});

// Fake PostgreSQL that answers every startup message with one auth reply.
async function fakePg(authCode) {
  const net = await import("node:net");
  const server = net.createServer((sock) => {
    sock.once("data", () => {
      const r = Buffer.alloc(9);
      r.write("R", 0);
      r.writeInt32BE(8, 1);
      r.writeInt32BE(authCode, 5);
      sock.end(r);
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return server;
}

for (const [code, want] of [[10, false], [3, false], [0, true]]) {
  test(`PostgreSQL probe: auth code ${code} means login accepted = ${want}`, async () => {
    const server = await fakePg(code);
    const cfg = { gatewayUrl: "http://127.0.0.1:9", companyId: "x", engine: { host: "127.0.0.1", postgresPort: server.address().port }, timeoutMs: 1000 };
    const dir = mkdtempSync(join(tmpdir(), "mem-acc-"));
    const path = join(dir, "live.json");
    writeFileSync(path, JSON.stringify(cfg));
    const pg = await createLiveTarget(loadLiveConfig(path)).probeEngine("postgres");
    server.close();
    assert.equal(pg.reached, true);
    assert.equal(pg.loginAccepted, want, pg.detail);
  });
}
