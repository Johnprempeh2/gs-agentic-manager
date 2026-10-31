import { test } from "node:test";
import assert from "node:assert/strict";
import { captureR1Snapshot, calculateR1, summariseR1, validateR1Snapshot } from "./r1-snapshot.mjs";

const snapshotAt = "2026-10-29T12:00:00.000Z";
const issue = { id: "root", companyId: "c1", identifier: "GRE-TEST", parentId: null, status: "blocked", assigneeAgentId: "a1", assigneeUserId: null, conversationUserId: null, conversationState: null, monitorNextCheckAt: null, monitorWakeRequestedAt: null, hiddenAt: null, updatedAt: "2026-10-29T10:00:00.000Z", tabledByUserId: null };
const fixture = () => ({ snapshotAt, issues: [{ ...issue }], backlogParkers: [], runs: [], wakeRequests: [], interactions: [], approvals: [], recoveryActions: [], treeHolds: [], relations: [], agents: [{ companyId: "c1", id: "a1", status: "idle", timerHeartbeat: false }] });

test("R1 capture rejects a missing input or timestamp instead of silently treating it as zero", () => {
  const missing = fixture();
  delete missing.wakeRequests;
  assert.throws(() => calculateR1(missing, "c1"), /missing input: wakeRequests/);
  assert.throws(() => validateR1Snapshot({ ...fixture(), snapshotAt: null }, "c1"), /snapshot timestamp/);
  assert.throws(() => calculateR1(fixture(), ""), /company ID/);
});

test("R1 capture rejects another company's issue and references outside its scoped issue set", () => {
  assert.throws(() => calculateR1({ ...fixture(), issues: [{ ...issue, companyId: "c2" }] }, "c1"), /another company/);
  assert.throws(() => calculateR1({ ...fixture(), wakeRequests: [{ companyId: "c1", issueId: "foreign", taskId: null, contextIssueId: null, contextTaskId: null, status: "queued" }] }, "c1"), /outside the company/);
  assert.throws(() => calculateR1({ ...fixture(), agents: [{ companyId: "c2", id: "a1", status: "idle", timerHeartbeat: false }] }, "c1"), /another company/);
});

test("R1 capture rejects missing projected columns in each nonempty input", () => {
  for (const [key, row] of Object.entries({
    issues: { ...issue }, backlogParkers: { companyId: "c1", issueId: "root", actorType: "user" },
    runs: { companyId: "c1", id: "run", status: "failed", issueId: "root", taskId: null, nativeIssueId: null, createdAt: snapshotAt, startedAt: null, lastOutputAt: null, finishedAt: null },
    wakeRequests: { companyId: "c1", status: "queued", issueId: "root", taskId: null, contextIssueId: null, contextTaskId: null },
    interactions: { companyId: "c1", issueId: "root", status: "pending" },
    approvals: { companyId: "c1", issueId: "root", status: "pending" },
    recoveryActions: { companyId: "c1", sourceIssueId: "root", resolvedAt: null, status: "active", cause: "test", replay: null },
    treeHolds: { companyId: "c1", rootIssueId: "root", status: "active" },
    relations: { companyId: "c1", blockerIssueId: "root", blockedIssueId: "root" },
    agents: { companyId: "c1", id: "a1", status: "idle", timerHeartbeat: false },
  })) {
    for (const column of Object.keys(row)) {
      const incomplete = { ...row };
      delete incomplete[column];
      assert.throws(() => calculateR1({ ...fixture(), [key]: [incomplete] }, "c1"), new RegExp(`missing column: ${key}\\.${column}`));
    }
    assert.throws(() => calculateR1({ ...fixture(), [key]: [{ ...row, companyId: "c2" }] }, "c1"), /another company/);
  }
});

test("R1 result can emit only totals, window, source and counted root identifiers", () => {
  const snapshot = fixture();
  snapshot.issues[0].description = "private raw row";
  const result = summariseR1(snapshot, "c1", "approved-restore-ref");
  assert.deepEqual(Object.keys(result).sort(), ["schema", "sourceRef", "companyId", "sourceCapturedAt", "readAt", "windowStart", "windowDays", "weekly", "total", "treesWithOpenWork", "countedRoots"].sort());
  assert.deepEqual(result.countedRoots, [{ rootIssueId: "root", rootIdentifier: "GRE-TEST" }]);
  assert.equal(JSON.stringify(result).includes("private raw row"), false);
  assert.equal(JSON.stringify(result).includes("uncoveredIssues"), false);
});

test("R1 deliberately stranded tree is counted in the database-timestamp window", () => {
  const result = calculateR1(fixture(), "c1");
  assert.equal(result.weekly, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(result.stranded[0].uncoveredIssues.map((entry) => entry.id), ["root"]);
});

test("R1 SQL reader scopes each table and takes timestamp before rows", async () => {
  const keys = Object.keys(fixture()).filter((key) => key !== "snapshotAt");
  let index = 0;
  const tx = { unsafe: async (query, params) => {
    if (index++ === 0) {
      assert.match(query, /transaction_timestamp\(\)/);
      return [{ snapshotAt }];
    }
    assert.match(query, /company_id = \$1/);
    assert.deepEqual(params, ["c1"]);
    return fixture()[keys[index - 2]];
  } };
  const snapshot = await captureR1Snapshot(tx, "c1", { sourceCapturedAt: "2026-10-28T00:00:00.000Z" });
  assert.equal(snapshot.readAt, snapshotAt);
  assert.equal(snapshot.snapshotAt, "2026-10-28T00:00:00.000Z");
  assert.equal(index, keys.length + 1);
});

test("R1 reader fails on absent source tables and future source timestamp", async () => {
  const tx = { unsafe: async (query) => {
    if (query.includes("transaction_timestamp")) return [{ snapshotAt }];
    throw new Error('relation "issues" does not exist');
  } };
  await assert.rejects(captureR1Snapshot(tx, "c1"), /does not exist/);
  await assert.rejects(captureR1Snapshot(tx, "c1", { sourceCapturedAt: "2026-10-30T00:00:00Z" }), /original source capture timestamp/);
});
