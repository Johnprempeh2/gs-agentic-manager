import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXECUTION_HOLD_CAUSES, computeRunFailures, computeStrandedTrees, computeWakeLatency, percentile } from "./compute.mjs";

const now = "2026-09-27T12:00:00.000Z";
const hoursAgo = (hours) => new Date(Date.parse(now) - hours * 3_600_000).toISOString();
const issue = (id, fields = {}) => ({ id, companyId: "c", identifier: id.toUpperCase(), parentId: null, status: "todo", assigneeAgentId: "a1", assigneeUserId: null, updatedAt: hoursAgo(5), ...fields });
const base = (fields = {}) => ({ now, issues: [], runs: [], activity: [], agents: [{ id: "a1", status: "idle", timerHeartbeat: false }], ...fields });

test("R1: an agent-assigned open tree with no path is stranded; each live path clears it", () => {
  const snapshot = base({ issues: [issue("root", { status: "in_progress" }), issue("child", { parentId: "root", status: "blocked" })] });
  const r1 = computeStrandedTrees(snapshot);
  assert.equal(r1.weekly, 1);
  assert.deepEqual(r1.stranded[0].openIssues.map((entry) => entry.identifier), ["ROOT", "CHILD"]);

  // Paths sit on the leaf: the parent waits on its child, so the child covers it.
  const cleared = {
    run: { runs: [{ id: "r", issueId: "child", status: "queued", createdAt: hoursAgo(5) }] },
    runByTaskId: { runs: [{ id: "r", taskId: "child", status: "queued", createdAt: hoursAgo(5) }] },
    runByNativeIssue: { runs: [{ id: "r", nativeIssueId: "child", status: "queued", createdAt: hoursAgo(5) }] },
    wake: { wakeRequests: [{ issueId: "child", status: "queued" }] },
    claimedWake: { wakeRequests: [{ taskId: "child", status: "claimed" }] },
    // A deferred wake is live only behind a live holder (see D1); the fixture carries one.
    deferredWakeContext: {
      runs: [{ id: "h", issueId: "child", status: "running", createdAt: hoursAgo(1), startedAt: hoursAgo(1), lastOutputAt: hoursAgo(0.9) }],
      wakeRequests: [{ contextIssueId: "child", status: "deferred_issue_execution" }],
    },
    interaction: { interactions: [{ issueId: "child", status: "pending" }] },
    approval: { approvals: [{ issueId: "child", status: "pending" }] },
    recovery: { recoveryActions: [{ sourceIssueId: "child", resolvedAt: null, status: "active", ownerType: "agent" }] },
    monitor: { issues: [issue("root", { status: "in_progress" }), issue("child", { parentId: "root", status: "blocked", monitorNextCheckAt: hoursAgo(-1) })] },
    hold: { treeHolds: [{ rootIssueId: "root", status: "active" }] },
    timer: { agents: [{ id: "a1", status: "idle", timerHeartbeat: true }] },
    human: { issues: [issue("root", { status: "in_progress" }), issue("child", { parentId: "root", status: "blocked", assigneeUserId: "u1" })] },
  };
  for (const [name, extra] of Object.entries(cleared)) {
    assert.equal(computeStrandedTrees({ ...snapshot, ...extra }).total, 0, name);
  }
  // A path on the parent does not cover the child beneath it.
  const parentOnly = computeStrandedTrees({ ...snapshot, wakeRequests: [{ issueId: "root", status: "queued" }] });
  assert.deepEqual(parentOnly.stranded[0].uncoveredIssues.map((entry) => entry.identifier), ["CHILD"]);
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

// GRE-21 audit: strands the server can produce that R1 used to read as live.

test("R1 blind spot B1: a recovery action escalated to the board is not a live path", () => {
  // Budget exhaustion sets status 'escalated', owner 'board', no owner ids, no
  // wake policy, and leaves resolved_at null (issue-recovery-actions.ts:326-362).
  const issues = [issue("root", { status: "blocked" })];
  const active = { sourceIssueId: "root", resolvedAt: null, status: "active", ownerType: "agent" };
  assert.equal(computeStrandedTrees(base({ issues, recoveryActions: [active] })).total, 0, "an active recovery action is live");
  const escalated = { sourceIssueId: "root", resolvedAt: null, status: "escalated", ownerType: "board" };
  assert.equal(computeStrandedTrees(base({ issues, recoveryActions: [escalated] })).total, 1);
});

test("R1 blind spot B2: a running run silent past the stale-run threshold is not a live path", () => {
  // The active-run watchdog only folds silent runs whose issue is already
  // done/cancelled; the orphan reaper only acts on lost processes. A hung
  // process on an open issue stays 'running' indefinitely.
  const issues = [issue("root", { status: "in_progress" })];
  const hung = { id: "r", issueId: "root", status: "running", createdAt: hoursAgo(6), startedAt: hoursAgo(6), lastOutputAt: hoursAgo(6) };
  assert.equal(computeStrandedTrees(base({ issues, runs: [hung] })).total, 1);
  const talking = { ...hung, lastOutputAt: hoursAgo(3.5) };
  assert.equal(computeStrandedTrees(base({ issues, runs: [talking] })).total, 0, "output inside the threshold keeps it live");
});

test("R1 blind spot B3: an overdue monitor that never fired is not a live path", () => {
  // Server liveness treats a monitor as a path only while next_check_at is in
  // the future (issue-graph-liveness.ts:197). A dispatch that throws keeps the
  // column set and is only logged (heartbeat.ts tickDueIssueMonitors).
  const issues = [issue("root", { status: "in_progress", monitorNextCheckAt: hoursAgo(3) })];
  assert.equal(computeStrandedTrees(base({ issues })).total, 1);
  const justDue = [issue("root", { status: "in_progress", monitorNextCheckAt: hoursAgo(0.25) })];
  assert.equal(computeStrandedTrees(base({ issues: justDue })).total, 0, "overdue by less than the grace period is still live");
  // tickDueIssueMonitors re-claims every 5 minutes and bumps updated_at each
  // time; that write is not activity, so the tree still counts as stopped.
  const reclaimed = [issue("root", { status: "in_progress", monitorNextCheckAt: hoursAgo(3), monitorWakeRequestedAt: hoursAgo(0.05), updatedAt: hoursAgo(0.05) })];
  const r1 = computeStrandedTrees(base({ issues: reclaimed }));
  assert.equal(r1.total, 1);
  assert.equal(r1.stranded[0].lastActivityAt, hoursAgo(3));
});

test("R1 blind spot B4: a live branch does not hide a dead sibling", () => {
  // The parent waits on its children, so a live child covers it. A sibling
  // with no path of its own is still stranded; nothing will wake it.
  const issues = [
    issue("root", { status: "in_progress" }),
    issue("live", { parentId: "root", status: "in_progress" }),
    issue("dead", { parentId: "root", status: "todo" }),
  ];
  const runs = [{ id: "r", issueId: "live", status: "running", createdAt: hoursAgo(1), startedAt: hoursAgo(1), lastOutputAt: hoursAgo(0.9) }];
  const r1 = computeStrandedTrees(base({ issues, runs }));
  assert.equal(r1.total, 1);
  assert.deepEqual(r1.stranded[0].uncoveredIssues.map((entry) => entry.identifier), ["DEAD"]);
});

// GRE-23: two more strands behind a deferred wake. Enqueue never defers behind
// a dead lock (heartbeat.ts enqueueWakeup clears it first), so a deferred wake
// only moves when its live holder releases and the drain promotes it
// (wake-queue use-cases.ts runReleaseDrain). GRE-24 changed the definition.

test("R1 strand D1: a deferred wake whose holder died without a drain is not a live path", () => {
  // sweepStaleIssueLocks clears a lock held by a terminal or missing run with a
  // bare update and never drains the queue (recovery/service.ts). The only
  // later promoter, resumeQueuedRuns, takes comment or interaction wakes on a
  // legacy run only (heartbeat.ts); an assignment, mention or dependency wake
  // stays deferred. hasActiveExecutionPath counts it as live, so
  // reconcileStrandedAssignedIssues skips the issue too.
  const issues = [issue("root", { status: "in_progress" })];
  const failed = { id: "r", issueId: "root", status: "failed", createdAt: hoursAgo(5), finishedAt: hoursAgo(5) };
  const wakeRequests = [{ issueId: "root", status: "deferred_issue_execution" }];
  assert.equal(computeStrandedTrees(base({ issues, runs: [failed], wakeRequests })).total, 1);
  const holder = { id: "h", issueId: "root", status: "running", createdAt: hoursAgo(1), startedAt: hoursAgo(1), lastOutputAt: hoursAgo(0.9) };
  assert.equal(computeStrandedTrees(base({ issues, runs: [holder], wakeRequests })).total, 0, "a live holder will drain it on release");
});

test("R1 strand D2: a deferred wake behind an execution hold is not a live path", () => {
  // settleUnrecoverableExecutions resolves the recovery action but keeps
  // evidence.automaticRecovery.replay = 'blocked' and sets the issue blocked
  // (execution-recovery-resolution.ts). executionBlockerPredicate still counts
  // that resolved row as a hold (execution-blocker.ts), so release returns
  // "released" without draining (wake-queue adapters/postgres.ts
  // withIssueExecutionLock) and dispatch cancels any queued run as stale
  // (run-dispatch adapters/postgres.ts decideCurrentRunStaleness). The wake
  // waits for a person who is not the assignee. An escalated hold is the same.
  const issues = [issue("root", { status: "blocked" })];
  const wakeRequests = [{ issueId: "root", status: "deferred_issue_execution" }];
  const replayBlocked = { sourceIssueId: "root", resolvedAt: hoursAgo(5), status: "resolved", cause: "uncertain_provider_action", replay: "blocked" };
  assert.equal(computeStrandedTrees(base({ issues, wakeRequests, recoveryActions: [replayBlocked] })).total, 1);
  const escalated = { sourceIssueId: "root", resolvedAt: null, status: "escalated", ownerType: "board", cause: "execution_recovery_budget_exhausted" };
  assert.equal(computeStrandedTrees(base({ issues, wakeRequests, recoveryActions: [escalated] })).total, 1);
  // Under the hold a live holder does not help: release skips the drain, and
  // dispatch cancels a queued or retry run as stale. A running run still counts.
  const running = { id: "h", issueId: "root", status: "running", createdAt: hoursAgo(1), startedAt: hoursAgo(1), lastOutputAt: hoursAgo(0.9) };
  const queued = { id: "q", issueId: "root", status: "queued", createdAt: hoursAgo(1) };
  assert.equal(computeStrandedTrees(base({ issues, wakeRequests, runs: [queued], recoveryActions: [replayBlocked] })).total, 1, "a queued run under a hold is cancelled at dispatch");
  assert.equal(computeStrandedTrees(base({ issues, wakeRequests, runs: [running], recoveryActions: [replayBlocked] })).total, 0, "a running run is still working");
  // Only a reconciliation cause makes a hold; replay-blocked evidence alone does not.
  const otherCause = { ...replayBlocked, cause: "stranded_assigned_issue" };
  assert.equal(computeStrandedTrees(base({ issues, wakeRequests, runs: [queued], recoveryActions: [otherCause] })).total, 0);
});

test("R1: the execution-hold causes match the shared EXECUTION_RECONCILIATION_CAUSES", () => {
  const source = readFileSync(new URL("../../../packages/shared/src/types/execution-projection.ts", import.meta.url), "utf8");
  const list = source.match(/EXECUTION_RECONCILIATION_CAUSES = \[([^\]]*)\]/)[1];
  assert.deepEqual([...EXECUTION_HOLD_CAUSES].sort(), [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort());
});

test("R1: a hold on a subtree covers the issues beneath it only", () => {
  const issues = [
    issue("root", { status: "in_progress" }),
    issue("held", { parentId: "root", status: "blocked" }),
    issue("under", { parentId: "held", status: "todo" }),
    issue("other", { parentId: "root", status: "todo" }),
  ];
  const r1 = computeStrandedTrees(base({ issues, treeHolds: [{ rootIssueId: "held", status: "active" }] }));
  assert.deepEqual(r1.stranded[0].uncoveredIssues.map((entry) => entry.identifier), ["OTHER"]);
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

test("percentile uses nearest rank", () => {
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(percentile(values, 95), 19);
  assert.equal(percentile(values, 50), 10);
  assert.equal(percentile([], 95), null);
});
