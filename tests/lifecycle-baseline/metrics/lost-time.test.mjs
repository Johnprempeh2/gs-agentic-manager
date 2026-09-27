import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHumanComment, computeFalseStalls, computeHungRuns, computeLostTime, computeReassignCancels, computeRecoveryWakesOnPendingCard } from "./lost-time.mjs";

const now = "2026-09-27T23:00:00.000Z";
const at = (hhmm) => `2026-09-27T${hhmm}:00.000Z`;
const window = { since: Date.parse(at("00:00")), now: Date.parse(now), silenceMinutes: 20 };
const run = (id, fields) => ({ id, agentId: "a1", status: "succeeded", errorCode: null, createdAt: at("10:00"), startedAt: at("10:00"), finishedAt: at("10:05"), ...fields });
const base = (fields = {}) => ({ now, runs: [], activity: [], interactions: [], comments: [], ...fields });

test("L1: watchdog stops and long manual cancels count; short cancels and long successful runs do not", () => {
  const snapshot = base({
    runs: [
      // GRE-3 on 27 Sep: hung 282 min, then a person cancelled it.
      run("hung", { status: "cancelled", errorCode: "cancelled", startedAt: at("14:07"), finishedAt: at("18:49") }),
      run("silent", { status: "failed", errorCode: "run_silent_timeout", startedAt: at("15:00"), finishedAt: at("15:20") }),
      run("lost", { status: "failed", errorCode: "process_lost", startedAt: at("16:00"), finishedAt: at("16:03") }),
      run("timeout", { status: "timed_out", errorCode: "timeout", startedAt: at("17:00"), finishedAt: at("17:30") }),
      run("short-cancel", { status: "cancelled", errorCode: "cancelled", startedAt: at("12:00"), finishedAt: at("12:05") }),
      run("long-success", { startedAt: at("09:00"), finishedAt: at("10:00") }),
      run("reassigned", { status: "cancelled", errorCode: "issue_reassigned", startedAt: at("11:00"), finishedAt: at("12:00") }),
      run("before-window", { status: "failed", errorCode: "process_lost", startedAt: "2026-09-19T10:00:00.000Z", finishedAt: "2026-09-19T11:00:00.000Z" }),
    ],
  });
  const l1 = computeHungRuns(snapshot, window);
  assert.deepEqual(l1.caughtByHuman.runs.map((entry) => entry.id), ["hung"]);
  assert.deepEqual(l1.caughtByWatchdog.runs.map((entry) => entry.id).sort(), ["lost", "silent", "timeout"]);
  assert.equal(l1.count, 4);
  assert.equal(l1.minutes, 282 + 20 + 3 + 30);
});

test("L2: a recovery block counts only while an interaction on that issue is pending", () => {
  const move = (entityId, createdAt, fields = {}) => ({ actorType: "system", entityId, issueIdentifier: entityId, status: "blocked", source: "recovery.reconcile_execution_review_participant", previousStatus: "in_review", createdAt, ...fields });
  const snapshot = base({
    activity: [
      move("GRE-26", at("21:39")), // card f619fd60 pending until 21:47
      move("GRE-34", at("21:49"), { source: "recovery.reconcile_stranded_assigned_issue" }), // no card
      move("GRE-4", at("14:07")), // card created later
      move("GRE-3", at("20:30")), // card already resolved
      move("GRE-9", at("13:00"), { actorType: "agent", source: "comment" }), // an agent blocked it: not recovery
      move("GRE-11", at("13:00"), { status: "in_review" }), // recovery that did not block
    ],
    interactions: [
      { id: "f619fd60", issueId: "GRE-26", kind: "request_confirmation", createdAt: at("21:38"), resolvedAt: at("21:47") },
      { id: "late", issueId: "GRE-4", kind: "ask_user_questions", createdAt: at("14:13"), resolvedAt: null },
      { id: "done", issueId: "GRE-3", kind: "request_confirmation", createdAt: at("19:48"), resolvedAt: at("20:19") },
      { id: "other-issue", issueId: "GRE-99", kind: "request_confirmation", createdAt: at("09:00"), resolvedAt: null },
    ],
  });
  const l2 = computeFalseStalls(snapshot, window);
  assert.equal(l2.recoveryBlocks, 4);
  assert.equal(l2.count, 1);
  assert.equal(l2.falseStalls[0].issueIdentifier, "GRE-26");
  assert.deepEqual(l2.falseStalls[0].pendingInteractions, [{ id: "f619fd60", kind: "request_confirmation" }]);
});

test("L3: issue_reassigned cancels count with their run minutes; queued cancels add zero", () => {
  const snapshot = base({
    runs: [
      run("r60", { status: "cancelled", errorCode: "issue_reassigned", startedAt: at("11:00"), finishedAt: at("12:00") }),
      run("r1", { status: "cancelled", errorCode: "issue_reassigned", startedAt: at("13:00"), finishedAt: at("13:01") }),
      run("queued", { status: "cancelled", errorCode: "issue_reassigned", createdAt: at("13:00"), startedAt: null, finishedAt: at("13:00") }),
      run("assignee-changed", { status: "cancelled", errorCode: "issue_assignee_changed", startedAt: null, finishedAt: at("12:51") }),
    ],
  });
  const l3 = computeReassignCancels(snapshot, window);
  assert.equal(l3.count, 3);
  assert.equal(l3.minutes, 61);
  assert.equal(l3.maxMinutes, 60);
  assert.equal(l3.overFiveMinutes, 1);
});

test("L4: the simple rule catches the 27 Sep status and recovery comments and skips ordinary ones", () => {
  const counted = {
    "why is this blocked?": ["asksStatus"],
    "Why is it taking summit taking so long?": ["asksStatus"],
    "its been merged": ["relaysStatus"],
    "I think I fixed this using the Claude code terminal please check and confirm.": ["relaysStatus"],
    "Your last run hung for about 4.5 hours inside the terminal call": ["recoversRun"],
    "Your last wake failed while creating the worktree": ["recoversRun"],
    "The Claude connection is fixed (your last runs failed because its token had expired). Please continue": ["relaysStatus", "recoversRun"],
  };
  for (const [body, rules] of Object.entries(counted)) assert.deepEqual(classifyHumanComment(body), rules, body);
  for (const body of ["thats pretty cool", "you can go ahead and review and merge", "pass this work onto keystone they deal with this"]) {
    assert.deepEqual(classifyHumanComment(body), [], body);
  }
});

test("computeLostTime: agent comments are ignored and shares use finished agent-minutes", () => {
  const snapshot = base({
    runs: [
      run("ok", { startedAt: at("10:00"), finishedAt: at("11:30") }),
      run("r", { status: "cancelled", errorCode: "issue_reassigned", startedAt: at("12:00"), finishedAt: at("12:10") }),
    ],
    comments: [
      { issueId: "i", authorUserId: "u", body: "its been merged", createdAt: at("20:13") },
      { issueId: "i", authorUserId: null, body: "why is this blocked?", createdAt: at("20:14") },
    ],
  });
  const result = computeLostTime(snapshot, { now, windowDays: 1 });
  assert.equal(result.totals.agentMinutes, 100);
  assert.equal(result.l3ReassignCancels.shareOfAgentMinutesPct, 10);
  assert.equal(result.l4HumanComments.humanComments, 1);
  assert.equal(result.l4HumanComments.count, 1);
  assert.equal(result.l1HungRuns.shareOfAgentMinutesPct, 0);
});

test("L5: a recovery run counts only when it starts while a waking card on its issue is pending", () => {
  const recovery = (id, issueId, startedAt, source = "issue.continuation_recovery", fields = {}) => ({ id, issueId, issueIdentifier: issueId, source, status: "succeeded", createdAt: startedAt, startedAt, ...fields });
  const card = (id, issueId, createdAt, resolvedAt, continuationPolicy = "wake_assignee") => ({ id, issueId, kind: "request_confirmation", continuationPolicy, createdAt, resolvedAt });
  const snapshot = base({
    recoveryRuns: [
      recovery("d3fcd0dd", "GRE-48", at("12:00")), // card pending, resolved later
      recovery("a4e8465f", "GRE-34", at("13:00"), "issue.execution_review_recovery"), // card still pending
      recovery("queued", "GRE-39", null, "issue.assignment_recovery", { createdAt: at("14:00"), startedAt: null }), // never started: uses createdAt
      recovery("no-card", "GRE-4", at("15:00")),
      recovery("card-later", "GRE-5", at("09:00")), // card created after the run started
      recovery("card-resolved", "GRE-6", at("16:00")), // card resolved before the run
      recovery("policy-none", "GRE-7", at("16:00")), // card does not wake the assignee
      recovery("other-source", "GRE-48", at("12:30"), "issue.comment"), // not a recovery source
      recovery("before-window", "GRE-48", "2026-09-26T12:00:00.000Z"),
    ],
    interactions: [
      card("c1", "GRE-48", at("11:00"), at("20:00")),
      card("c2", "GRE-34", at("12:00"), null, "wake_assignee_on_accept"),
      card("c3", "GRE-39", at("13:00"), null),
      card("c5", "GRE-5", at("10:00"), null),
      card("c6", "GRE-6", at("10:00"), at("11:00")),
      card("c7", "GRE-7", at("10:00"), null, "none"),
    ],
  });
  const l5 = computeRecoveryWakesOnPendingCard(snapshot, window);
  assert.equal(l5.recoveryRuns, 7);
  assert.deepEqual(l5.runs.map((row) => row.id), ["d3fcd0dd", "a4e8465f", "queued"]);
  assert.equal(l5.count, 3);
  assert.equal(l5.bySource["issue.continuation_recovery"], 1);
  assert.equal(l5.bySource["issue.execution_review_recovery"], 1);
  assert.deepEqual(l5.runs[1].pendingInteractions, [{ id: "c2", kind: "request_confirmation", continuationPolicy: "wake_assignee_on_accept" }]);
  assert.equal(computeLostTime(base(), { now, windowDays: 1 }).l5RecoveryWakesOnPendingCard.count, 0);
});
