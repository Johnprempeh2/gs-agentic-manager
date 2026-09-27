import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAuthFailures, computeRunFailures, computeStrandedTrees, computeWakeLatency, percentile } from "./compute.mjs";

const now = "2026-09-27T12:00:00.000Z";
const hoursAgo = (hours) => new Date(Date.parse(now) - hours * 3_600_000).toISOString();
const issue = (id, fields = {}) => ({ id, companyId: "c", identifier: id.toUpperCase(), parentId: null, status: "todo", assigneeAgentId: "a1", assigneeUserId: null, updatedAt: hoursAgo(5), ...fields });
const base = (fields = {}) => ({ now, issues: [], runs: [], activity: [], agents: [{ id: "a1", status: "idle", timerHeartbeat: false }], ...fields });

test("R1: an agent-assigned open tree with no path is stranded; each live path clears it", () => {
  const snapshot = base({ issues: [issue("root", { status: "in_progress" }), issue("child", { parentId: "root", status: "blocked" })] });
  const r1 = computeStrandedTrees(snapshot);
  assert.equal(r1.weekly, 1);
  assert.deepEqual(r1.stranded[0].openIssues.map((entry) => entry.identifier), ["ROOT", "CHILD"]);

  const cleared = {
    run: { runs: [{ id: "r", issueId: "child", status: "queued", createdAt: hoursAgo(5) }] },
    wake: { wakeRequests: [{ issueId: "root", status: "queued" }] },
    interaction: { interactions: [{ issueId: "child", status: "pending" }] },
    approval: { approvals: [{ issueId: "root", status: "pending" }] },
    recovery: { recoveryActions: [{ sourceIssueId: "root", resolvedAt: null }] },
    hold: { treeHolds: [{ rootIssueId: "root", status: "active" }] },
    timer: { agents: [{ id: "a1", status: "idle", timerHeartbeat: true }] },
    human: { issues: [issue("root", { status: "in_progress", assigneeUserId: "u1" }), issue("child", { parentId: "root", status: "blocked" })] },
  };
  for (const [name, extra] of Object.entries(cleared)) {
    assert.equal(computeStrandedTrees({ ...snapshot, ...extra }).total, 0, name);
  }
});

test("R1: a paused agent's timer heartbeat is not a live path", () => {
  const snapshot = base({ issues: [issue("root")], agents: [{ id: "a1", status: "paused", timerHeartbeat: true }] });
  assert.equal(computeStrandedTrees(snapshot).total, 1);
});

test("R1: blocker chains propagate liveness across trees; a dead blocker does not", () => {
  const issues = [issue("x", { status: "in_progress" }), issue("y", { status: "blocked" }), issue("z", { status: "blocked" })];
  const relations = [{ blockerIssueId: "y", blockedIssueId: "z" }, { blockerIssueId: "x", blockedIssueId: "y" }];
  const live = base({ issues, relations, runs: [{ id: "r", issueId: "x", status: "running", createdAt: hoursAgo(1) }] });
  assert.equal(computeStrandedTrees(live).total, 0);
  assert.equal(computeStrandedTrees(base({ issues, relations })).total, 3);
});

test("R1: closed, backlog, recently active and old trees are handled", () => {
  const snapshot = base({ issues: [
    issue("done", { status: "done" }),
    issue("parked", { status: "backlog" }),
    issue("fresh", { updatedAt: hoursAgo(0.1) }),
    issue("old", { updatedAt: hoursAgo(24 * 30) }),
  ] });
  const r1 = computeStrandedTrees(snapshot);
  assert.equal(r1.total, 1, "only the old tree is stranded; fresh is inside the grace period");
  assert.equal(r1.weekly, 0, "the old tree stopped before the window");
});

test("R2: failure rate excludes cancellations; recovery is split by human intervention", () => {
  const runs = [
    { id: "ok", issueId: "i1", status: "succeeded", finishedAt: hoursAgo(10) },
    { id: "f1", issueId: "i1", status: "failed", finishedAt: hoursAgo(9) },
    { id: "ok1", issueId: "i1", status: "succeeded", finishedAt: hoursAgo(8) },
    { id: "f2", issueId: "i2", status: "timed_out", finishedAt: hoursAgo(9) },
    { id: "ok2", issueId: "i2", status: "succeeded", finishedAt: hoursAgo(7) },
    { id: "f3", issueId: "i3", status: "interrupted", finishedAt: hoursAgo(9) },
    { id: "f4", issueId: null, status: "failed", finishedAt: hoursAgo(9) },
    { id: "c", issueId: "i3", status: "cancelled", finishedAt: hoursAgo(9) },
    { id: "old", issueId: "i3", status: "failed", finishedAt: hoursAgo(24 * 10) },
  ];
  const activity = [
    { actorType: "user", action: "issue.comment_added", entityType: "issue", entityId: "i2", createdAt: hoursAgo(8) },
    { actorType: "user", action: "issue.read_marked", entityType: "issue", entityId: "i1", createdAt: hoursAgo(8.5) },
  ];
  const r2 = computeRunFailures(base({ runs, activity }));
  assert.equal(r2.failed, 4);
  assert.equal(r2.succeeded, 3);
  assert.equal(r2.cancelled, 1);
  assert.equal(r2.failureRate, 4 / 7);
  assert.equal(r2.recoveredWithoutHuman, 1, "i1 recovered; a read marker is not an intervention");
  assert.equal(r2.recoveredWithHuman, 1, "i2 needed a human comment");
  assert.equal(r2.unresolved, 1);
  assert.equal(r2.failedWithoutIssue, 1);
  assert.equal(r2.unattendedRecoveryShare, 1 / 3);
});

test("R2: an issue completed after the failure counts as recovered", () => {
  const r2 = computeRunFailures(base({
    issues: [issue("i1", { status: "done", completedAt: hoursAgo(1) })],
    runs: [{ id: "f", issueId: "i1", status: "failed", finishedAt: hoursAgo(2) }],
  }));
  assert.equal(r2.recoveredWithoutHuman, 1);
});

test("R2: rejected logins are counted under either code, with the retries and exhaustion they caused", () => {
  const failed = (id, fields) => ({ id, issueId: "i1", status: "failed", createdAt: hoursAgo(3), finishedAt: hoursAgo(3), ...fields });
  // Before GRE-15: the ACP access failure was a generic turn failure, retried until exhausted.
  const before = base({
    runs: [
      failed("r1", { errorCode: "acpx_turn_failed", errorMentionsAccessFailure: true }),
      failed("r2", { errorCode: "acpx_turn_failed", errorMentionsAccessFailure: true, retryOfRunId: "r1" }),
      failed("r3", { errorCode: "acpx_turn_failed", errorMentionsAccessFailure: false }),
    ],
    retryExhaustions: [{ runId: "r2", createdAt: hoursAgo(3) }, { runId: "r3", createdAt: hoursAgo(3) }],
  });
  const b = computeAuthFailures(before);
  assert.equal(b.authFailedRuns, 2);
  assert.equal(b.retriesAfterAuthFailure, 1);
  assert.equal(b.retryExhaustions, 2);
  assert.equal(b.retryExhaustionsFromAuthFailures, 1);
  assert.deepEqual(b.exhaustedAuthRuns.map((entry) => entry.runId), ["r2"]);

  // After: coded as a rejected login and handed to the board with no retry.
  const after = computeAuthFailures(base({ runs: [failed("r4", { errorCode: "claude_auth_required" }), { ...failed("r5", { errorCode: "claude_auth_required" }), status: "succeeded" }] }));
  assert.deepEqual([after.authFailedRuns, after.retriesAfterAuthFailure, after.retryExhaustionsFromAuthFailures], [1, 0, 0]);
  assert.deepEqual(after.byErrorCode, { claude_auth_required: 1 });
});


test("S1: wake to first useful action ignores harness bookkeeping and untimed runs", () => {
  const runs = [
    { id: "r1", status: "succeeded", wakeRequestedAt: hoursAgo(3), createdAt: hoursAgo(3), startedAt: hoursAgo(3) },
    { id: "r2", status: "failed", wakeRequestedAt: null, createdAt: hoursAgo(2), startedAt: hoursAgo(2) },
    { id: "r3", status: "succeeded", wakeRequestedAt: hoursAgo(1), createdAt: hoursAgo(1) },
    { id: "r4", status: "running", wakeRequestedAt: hoursAgo(1), createdAt: hoursAgo(1) },
  ];
  const at = (hours, seconds) => new Date(Date.parse(hoursAgo(hours)) + seconds * 1000).toISOString();
  const activity = [
    { runId: "r1", actorType: "agent", action: "environment.lease_acquired", createdAt: at(3, 1) },
    { runId: "r1", actorType: "agent", action: "issue.checked_out", createdAt: at(3, 2) },
    { runId: "r1", actorType: "agent", action: "issue.comment_added", createdAt: at(3, 10) },
    { runId: "r2", actorType: "agent", action: "issue.updated", createdAt: at(2, 30) },
    { runId: "r3", actorType: "user", action: "issue.comment_added", createdAt: at(1, 5) },
  ];
  const s1 = computeWakeLatency(base({ runs, activity }));
  assert.deepEqual(s1.samplesMs, [10_000, 30_000]);
  assert.equal(s1.medianMs, 20_000);
  assert.equal(s1.p95Ms, 30_000);
  assert.equal(s1.runsWithoutUsefulAction, 1, "r3 had only human activity; r4 is still running and excluded");
});

test("S1: tool discovery at session start is bookkeeping; the split needs a prompt-sent time", () => {
  const at = (hours, seconds) => new Date(Date.parse(hoursAgo(hours)) + seconds * 1000).toISOString();
  const runs = [
    { id: "r1", status: "succeeded", wakeRequestedAt: hoursAgo(3), createdAt: hoursAgo(3), promptSentAt: at(3, 2) },
    { id: "r2", status: "succeeded", wakeRequestedAt: hoursAgo(2), createdAt: hoursAgo(2) },
  ];
  const activity = [
    { runId: "r1", actorType: "agent", action: "tool_gateway.session_created", createdAt: at(3, 1) },
    { runId: "r1", actorType: "agent", action: "tool_gateway.discovery", createdAt: at(3, 3) },
    { runId: "r1", actorType: "agent", action: "tool_gateway.call_completed", createdAt: at(3, 5) },
    { runId: "r1", actorType: "agent", action: "issue.comment_added", createdAt: at(3, 20) },
    { runId: "r2", actorType: "agent", action: "tool_gateway.discovery", createdAt: at(2, 1) },
    { runId: "r2", actorType: "agent", action: "tool_gateway.approval_requested", createdAt: at(2, 8) },
  ];
  const s1 = computeWakeLatency(base({ runs, activity }));
  assert.deepEqual(s1.samplesMs, [8_000, 20_000], "discovery and gateway calls skipped; an approval request counts");
  assert.equal(s1.split.sampleSize, 1, "r2 has no prompt-sent time");
  assert.equal(s1.split.setupMedianMs, 2_000);
  assert.equal(s1.split.agentMedianMs, 18_000);
});

test("percentile uses nearest rank", () => {
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(percentile(values, 95), 19);
  assert.equal(percentile(values, 50), 10);
  assert.equal(percentile([], 95), null);
});
