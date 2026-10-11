// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/lifecycle.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkActor,
  checkDeleteRequest,
  deletionRecordPath,
  describeUsage,
  lifecycleStatusLines,
  parseRetentionDays,
  retentionEnd,
  usageDelta,
  usageIsZero,
  type ArchiveRecord,
  type UsageCounts,
} from "./lifecycle.ts";

const counts: UsageCounts = { heartbeatRuns: 4, costEvents: 3, financeEvents: 0, billingInvoices: 1 };

test("operator and reason are required and one line", () => {
  assert.match(checkActor({}, true) ?? "", /--operator is required/);
  assert.match(checkActor({ operator: "ops" }, true) ?? "", /--reason is required/);
  assert.equal(checkActor({ operator: "ops" }, false), null);
  assert.match(checkActor({ operator: "a\nb", reason: "x" }, true) ?? "", /one line/);
  assert.equal(checkActor({ operator: "ops", reason: "client asked" }, true), null);
});

test("retention days: required, no default, whole number", () => {
  assert.match((parseRetentionDays(undefined) as { error: string }).error, /no default/);
  for (const bad of ["0", "-1", "1.5", "x", ""]) assert.ok(typeof parseRetentionDays(bad) === "object", bad);
  assert.equal(parseRetentionDays("90"), 90);
  assert.equal(retentionEnd("2026-10-01T00:00:00.000Z", 30), "2026-10-31T00:00:00.000Z");
});

test("delete: code typed again, approval, operator, not active, not running", () => {
  const ok = { code: "c901", typedCode: "c901", approval: "GRE-1234", operator: "ops", lifecycle: "archived" as const, running: false };
  assert.equal(checkDeleteRequest(ok), null);
  assert.equal(checkDeleteRequest({ ...ok, lifecycle: "paused" }), null);
  assert.match(checkDeleteRequest({ ...ok, typedCode: undefined }) ?? "", /--confirm-code/);
  assert.match(checkDeleteRequest({ ...ok, typedCode: "c902" }) ?? "", /does not match/);
  assert.match(checkDeleteRequest({ ...ok, approval: undefined }) ?? "", /--approval/);
  assert.match(checkDeleteRequest({ ...ok, approval: "a b" }) ?? "", /--approval/);
  assert.match(checkDeleteRequest({ ...ok, operator: "" }) ?? "", /--operator/);
  assert.match(checkDeleteRequest({ ...ok, lifecycle: "active" }) ?? "", /pause \(or archive\) it first/);
  assert.match(checkDeleteRequest({ ...ok, running: true }) ?? "", /running/);
});

test("AT-4.6: usage added while paused", () => {
  assert.ok(usageIsZero(usageDelta(counts, counts)));
  const grown = usageDelta(counts, { ...counts, heartbeatRuns: 5 });
  assert.equal(grown.heartbeatRuns, 1);
  assert.ok(!usageIsZero(grown));
  assert.equal(describeUsage(grown), "1 runs, 0 cost events, 0 finance events, 0 invoices");
});

test("status lines: active, paused, archived, due for deletion (AT-4.9)", () => {
  assert.deepEqual(lifecycleStatusLines({}), ["lifecycle: active"]);
  const pause = { at: "2026-10-01T00:00:00.000Z", operator: "ops", reason: "client asked", backupFile: "/b", companyIds: [], counts };
  assert.match(lifecycleStatusLines({ lifecycle: "paused", lastPause: pause })[0]!, /paused since 2026-10-01.*use resume/);

  const archive: ArchiveRecord = {
    at: "2026-10-01T00:00:00.000Z",
    operator: "ops",
    backupFile: "/b",
    offsiteSnapshot: "abcd1234",
    offsiteCheck: "offsite-check OK",
    retentionDays: 30,
    retentionEnd: "2026-10-31T00:00:00.000Z",
  };
  const before = lifecycleStatusLines({ lifecycle: "archived", lastArchive: archive }, Date.parse("2026-10-30T00:00:00Z"));
  assert.ok(!before.some((l) => l.includes("DUE FOR DELETION")));
  const after = lifecycleStatusLines({ lifecycle: "archived", lastArchive: archive }, Date.parse("2026-11-01T00:00:00Z"));
  assert.ok(after.some((l) => l.startsWith("DUE FOR DELETION") && l.includes("Nothing is deleted automatically")));

  const resumed = { at: "2026-10-05T00:00:00.000Z", operator: "ops", reason: "r", pausedAt: pause.at, ok: true, addedWhilePaused: usageDelta(counts, counts) };
  assert.match(lifecycleStatusLines({ lastResume: resumed })[1]!, /no new use/);
  assert.match(lifecycleStatusLines({ lastResume: { ...resumed, ok: false } })[1]!, /^WARNING/);
});

test("the deletion record sits beside the instance folders", () => {
  assert.equal(deletionRecordPath("/srv/gsam/instances/c901"), "/srv/gsam/instances/deletions/c901.json");
});
