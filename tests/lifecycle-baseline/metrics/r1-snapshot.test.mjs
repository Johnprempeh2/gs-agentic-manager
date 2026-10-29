import { test } from "node:test";
import assert from "node:assert/strict";
import { captureR1Snapshot, calculateR1, validateR1Snapshot } from "./r1-snapshot.mjs";

const snapshotAt = "2026-10-29T12:00:00.000Z";
const issue = { id: "root", companyId: "c1", identifier: "GRE-TEST", parentId: null, status: "blocked", assigneeAgentId: "a1", assigneeUserId: null, updatedAt: "2026-10-29T10:00:00.000Z" };
const fixture = () => ({ snapshotAt, issues: [issue], backlogParkers: [], runs: [], wakeRequests: [], interactions: [], approvals: [], recoveryActions: [], treeHolds: [], relations: [], agents: [{ id: "a1", status: "idle", timerHeartbeat: false }] });

test("R1 capture rejects a missing input or timestamp instead of silently treating it as zero", () => {
  const missing = fixture();
  delete missing.wakeRequests;
  assert.throws(() => calculateR1(missing, "c1"), /missing input: wakeRequests/);
  assert.throws(() => validateR1Snapshot({ ...fixture(), snapshotAt: null }, "c1"), /snapshot timestamp/);
  assert.throws(() => calculateR1(fixture(), ""), /company ID/);
});

test("R1 capture rejects another company's issue and references outside its scoped issue set", () => {
  assert.throws(() => calculateR1({ ...fixture(), issues: [{ ...issue, companyId: "c2" }] }, "c1"), /another company/);
  assert.throws(() => calculateR1({ ...fixture(), wakeRequests: [{ issueId: "foreign", status: "queued" }] }, "c1"), /outside the company/);
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
  const snapshot = await captureR1Snapshot(tx, "c1");
  assert.equal(snapshot.snapshotAt, snapshotAt);
  assert.equal(index, keys.length + 1);
});
