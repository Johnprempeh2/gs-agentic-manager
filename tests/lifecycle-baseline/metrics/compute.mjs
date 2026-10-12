// Pure calculators for the tracked reliability and wake-latency numbers.
// Inputs are plain rows (see collect.mjs); nothing here reads a database, so the
// definitions are testable with fixed fixtures. Definitions are documented in
// README.md beside this file; change them there and here together.

export const OPEN_ISSUE_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);
export const LIVE_RUN_STATUSES = new Set(["queued", "running", "scheduled_retry"]);
export const LIVE_WAKE_STATUSES = new Set(["queued", "deferred_issue_execution", "claimed"]);
// Causes that make a recovery action an execution hold (shared EXECUTION_RECONCILIATION_CAUSES).
export const EXECUTION_HOLD_CAUSES = new Set([
  "uncertain_provider_action", "uncertain_external_action", "uncertain_control_plane_action",
  "completed_action_context_missing", "continuation_evidence_incomplete", "execution_finalization_deadline_exceeded",
  "execution_recovery_budget_exhausted", "provider_effect_inventory_unavailable", "provider_failure_meaning_unverified",
  "provider_ownership_unverified", "native_provider_terminal_failed", "native_event_replay_conflict",
  "native_session_cleanup_quarantined", "native_session_retry_exhausted", "native_restart_recovery_blocked",
  "native_continuation_requires_reconciliation", "legacy_execution_requires_reconciliation",
]);
export const FAILED_RUN_STATUSES = new Set(["failed", "timed_out", "interrupted"]);
// Agent-attributed activity that is harness bookkeeping, not progress on the task.
export const NON_USEFUL_AGENT_ACTIONS = new Set(["issue.checked_out", "issue.read_marked", "issue.released"]);
// Tool gateway audit rows the user can see. Every other `tool_gateway.*` row is
// session bookkeeping (tool discovery at session start) or a tool call the log
// can't tell apart from a read, so it does not count as a useful action.
export const USEFUL_TOOL_GATEWAY_ACTIONS = new Set(["tool_gateway.approval_requested", "tool_gateway.elicitation_requested"]);
// Human activity that does not intervene in the work (reading, inspecting).
export const PASSIVE_USER_ACTIONS = new Set(["issue.read_marked", "resource_membership.starred"]);

const ms = (value) => (value == null ? null : new Date(value).getTime());

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: the smallest value with at least p% of samples at or below it.
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isUsefulAgentAction(action) {
  if (action.startsWith("environment.") || NON_USEFUL_AGENT_ACTIONS.has(action)) return false;
  return !action.startsWith("tool_gateway.") || USEFUL_TOOL_GATEWAY_ACTIONS.has(action);
}

function isHumanIntervention(row) {
  return row.actorType === "user" && !PASSIVE_USER_ACTIONS.has(row.action) && !row.action.startsWith("provider_trace.");
}

/**
 * R1 — stranded task trees.
 *
 * A tree is a root issue plus all descendants. Coverage is decided per open
 * issue: an open issue is covered when it has a live path of its own, a human
 * owner, an active hold on it or an ancestor, an open child that is covered, or
 * an open blocker that is covered. A tree is stranded when at least one open
 * issue is uncovered and nothing in the tree has moved for `graceMinutes`.
 * `weekly` counts stranded trees whose last activity falls inside the window,
 * i.e. trees that stopped during the window.
 */
export function computeStrandedTrees(snapshot, { now, windowDays = 7, graceMinutes = 30, staleRunHours = 4 } = {}) {
  const nowMs = ms(now ?? snapshot.now);
  const windowStart = nowMs - windowDays * 86_400_000;
  const graceMs = graceMinutes * 60_000;
  const issues = snapshot.issues.filter((issue) => !issue.hiddenAt);
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const rootOf = (issue) => {
    const seen = new Set();
    let current = issue;
    while (current.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
    return current;
  };
  const isOpen = (issue) => Boolean(issue) && OPEN_ISSUE_STATUSES.has(issue.status);

  const liveReasons = new Map();
  const addLive = (issueIds, reason) => {
    for (const issueId of new Set(issueIds)) {
      if (!issueId || !byId.has(issueId)) continue;
      if (!liveReasons.has(issueId)) liveReasons.set(issueId, new Set());
      liveReasons.get(issueId).add(reason);
    }
  };
  // Runs and wakes name their issue in several places; the server matches on any.
  const runIssueIds = (run) => [run.issueId, run.taskId, run.nativeIssueId];
  const wakeIssueIds = (wake) => [wake.issueId, wake.taskId, wake.contextIssueId, wake.contextTaskId];
  // A running run that has been silent past the stale threshold is hung, not live.
  const runQuietSince = (run) => ms(run.lastOutputAt ?? run.startedAt ?? run.createdAt);
  // An execution hold: a reconciliation-cause recovery action that is active,
  // escalated, or resolved with replay blocked. Under it, release skips the
  // drain and dispatch cancels queued and retry runs as stale.
  const executionHeld = new Set((snapshot.recoveryActions ?? [])
    .filter((action) => EXECUTION_HOLD_CAUSES.has(action.cause) && (["active", "escalated"].includes(action.status) || action.replay === "blocked"))
    .map((action) => action.sourceIssueId));
  const liveRunIssues = new Set();
  for (const run of snapshot.runs) {
    if (!LIVE_RUN_STATUSES.has(run.status)) continue;
    if (run.status === "running" && nowMs - (runQuietSince(run) ?? nowMs) >= staleRunHours * 3_600_000) continue;
    const ids = runIssueIds(run).filter((id) => id && (run.status === "running" || !executionHeld.has(id)));
    addLive(ids, `run:${run.status}`);
    for (const issueId of ids) liveRunIssues.add(issueId);
  }
  for (const wake of snapshot.wakeRequests ?? []) {
    if (!LIVE_WAKE_STATUSES.has(wake.status)) continue;
    // A deferred wake moves only when a live run on the issue releases the lock
    // and the drain promotes it. With no live run, or under an execution hold,
    // nothing will drain it.
    if (wake.status === "deferred_issue_execution") {
      const ids = wakeIssueIds(wake).filter((id) => liveRunIssues.has(id) && !executionHeld.has(id));
      addLive(ids, "wake:deferred_issue_execution");
      continue;
    }
    addLive(wakeIssueIds(wake), `wake:${wake.status}`);
  }
  for (const interaction of snapshot.interactions ?? []) if (interaction.status === "pending") addLive([interaction.issueId], "interaction:pending");
  for (const approval of snapshot.approvals ?? []) if (["pending", "revision_requested"].includes(approval.status)) addLive([approval.issueId], `approval:${approval.status}`);
  // Only an active recovery action has an owner and a wake; an escalated one waits on the board.
  for (const recovery of snapshot.recoveryActions ?? []) {
    if (!recovery.resolvedAt && recovery.status === "active") addLive([recovery.sourceIssueId], "recovery:active");
  }
  // A monitor is a path while its next check is ahead, or overdue by less than the grace period.
  for (const issue of issues) {
    const next = ms(issue.monitorNextCheckAt);
    if (next != null && next > nowMs - graceMs) addLive([issue.id], "monitor:scheduled");
  }

  const agents = new Map((snapshot.agents ?? []).map((agent) => [agent.id, agent]));
  for (const issue of issues) {
    const agent = issue.assigneeAgentId ? agents.get(issue.assigneeAgentId) : null;
    // A timer heartbeat is a live path only when the agent can actually be invoked.
    if (agent?.timerHeartbeat && !["paused", "terminated", "pending_approval", "error"].includes(agent.status)) {
      addLive([issue.id], "agent:timer_heartbeat");
    }
  }

  const heldIds = new Set((snapshot.treeHolds ?? []).filter((hold) => hold.status === "active").map((hold) => hold.rootIssueId));
  const isHeld = (issue) => {
    const seen = new Set();
    for (let current = issue; current && !seen.has(current.id); current = byId.get(current.parentId)) {
      if (heldIds.has(current.id)) return true;
      seen.add(current.id);
    }
    return false;
  };
  const open = issues.filter(isOpen);
  const openChildren = new Map();
  for (const issue of open) {
    if (!issue.parentId || !byId.has(issue.parentId)) continue;
    if (!openChildren.has(issue.parentId)) openChildren.set(issue.parentId, []);
    openChildren.get(issue.parentId).push(issue.id);
  }
  const openBlockers = new Map();
  for (const relation of snapshot.relations ?? []) {
    if (!isOpen(byId.get(relation.blockerIssueId))) continue;
    if (!openBlockers.has(relation.blockedIssueId)) openBlockers.set(relation.blockedIssueId, []);
    openBlockers.get(relation.blockedIssueId).push(relation.blockerIssueId);
  }
  // An agent chat in `waiting` is on its user's turn, so the user owns it.
  const waitsOnUser = (issue) => Boolean(issue.conversationUserId) && issue.conversationState === "waiting";
  const covered = new Set(open.filter((issue) => liveReasons.has(issue.id) || issue.assigneeUserId || waitsOnUser(issue) || isHeld(issue)).map((issue) => issue.id));
  // A parent waits on its open children and a blocked issue on its blockers:
  // either is covered once what it waits on is covered. Iterate to a fixed point.
  for (let changed = true; changed;) {
    changed = false;
    for (const issue of open) {
      if (covered.has(issue.id)) continue;
      const waitsOn = [...(openChildren.get(issue.id) ?? []), ...(openBlockers.get(issue.id) ?? [])];
      if (waitsOn.some((id) => covered.has(id))) {
        covered.add(issue.id);
        changed = true;
      }
    }
  }

  const lastActivity = new Map();
  const touch = (issueId, at) => {
    const issue = byId.get(issueId);
    const value = ms(at);
    if (!issue || value == null) return;
    const root = rootOf(issue).id;
    lastActivity.set(root, Math.max(lastActivity.get(root) ?? 0, value));
  };
  for (const issue of issues) {
    // Re-claiming an overdue monitor bumps updated_at every few minutes without
    // doing anything; when that claim is the last write, the issue stopped when
    // the monitor fell due.
    const reclaimOnly = issue.monitorNextCheckAt && issue.monitorWakeRequestedAt
      && ms(issue.monitorNextCheckAt) <= nowMs && ms(issue.updatedAt) === ms(issue.monitorWakeRequestedAt);
    touch(issue.id, reclaimOnly ? issue.monitorNextCheckAt : issue.updatedAt);
  }
  for (const run of snapshot.runs) {
    const at = run.finishedAt ?? new Date(Math.max(...[run.lastOutputAt, run.startedAt, run.createdAt].map(ms).filter((v) => v != null), 0));
    for (const issueId of new Set(runIssueIds(run))) touch(issueId, at);
  }

  const trees = new Map();
  for (const issue of issues) {
    const root = rootOf(issue);
    if (!trees.has(root.id)) trees.set(root.id, { root, open: [] });
    if (isOpen(issue)) trees.get(root.id).open.push(issue);
  }

  const summary = (issue) => ({ id: issue.id, identifier: issue.identifier, status: issue.status, assigneeAgentId: issue.assigneeAgentId ?? null });
  const stranded = [];
  for (const { root, open: treeOpen } of trees.values()) {
    const uncovered = treeOpen.filter((issue) => !covered.has(issue.id));
    if (uncovered.length === 0) continue;
    const last = lastActivity.get(root.id) ?? 0;
    if (nowMs - last < graceMs) continue;
    stranded.push({
      rootIssueId: root.id,
      rootIdentifier: root.identifier,
      companyId: root.companyId,
      openIssues: treeOpen.map(summary),
      uncoveredIssues: uncovered.map(summary),
      lastActivityAt: last ? new Date(last).toISOString() : null,
      stoppedInWindow: last >= windowStart,
    });
  }
  return {
    windowDays,
    graceMinutes,
    staleRunHours,
    treesWithOpenWork: [...trees.values()].filter((tree) => tree.open.length > 0).length,
    weekly: stranded.filter((tree) => tree.stoppedInWindow).length,
    total: stranded.length,
    stranded,
  };
}

/**
 * R1 detail — parked wakes on issues with no live run (register row 51, GRE-685).
 *
 * A parked wake (`deferred_issue_execution`) whose issue has no
 * `executionRunId` waits for a drain that will not come. The server's
 * stranded-queue sweep promotes it only when it carries comment ids or an
 * interaction answer, so review hand-offs, "blockers resolved" and assignment
 * wakes stay parked. Counts such wakes requested at least `minAgeMinutes` ago,
 * split by wake reason. Read-only measurement before the sweep change (row 50).
 */
export function computeParkedWakes(snapshot, { now, parkedWakeMinAgeMinutes = 10 } = {}) {
  const nowMs = ms(now ?? snapshot.now);
  const cutoff = nowMs - parkedWakeMinAgeMinutes * 60_000;
  const byId = new Map((snapshot.issues ?? []).map((issue) => [issue.id, issue]));
  const counts = new Map();
  let total = 0;
  for (const wake of snapshot.wakeRequests ?? []) {
    if (wake.status !== "deferred_issue_execution") continue;
    const requested = ms(wake.requestedAt);
    if (requested == null || requested > cutoff) continue;
    // The sweep matches the issue on payload.issueId; older wakes name it elsewhere.
    const issue = [wake.issueId, wake.taskId, wake.contextIssueId, wake.contextTaskId].map((id) => id && byId.get(id)).find(Boolean);
    if (!issue || issue.executionRunId) continue;
    const reason = wake.reason ?? "unknown";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    total += 1;
  }
  return {
    minAgeMinutes: parkedWakeMinAgeMinutes,
    total,
    byReason: [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

/**
 * R1 detail — disposition repair escalated to the board (register row 76, GRE-725).
 *
 * When bounded disposition repair runs out of attempts on an unchanged source
 * state, recovery escalates with `unchanged_source_state_exhausted` and names
 * the board as owner. Counts those escalations (`issue.disposition_repair_escalated`
 * activity) in the window, split by whether the task is agent-only (agent
 * assignee, no user assignee, no chat user, every execution stage participant
 * an agent) and whether any repair run for that escalation posted a comment.
 * A repair run belongs to the escalation when it is on the same issue, carries
 * the same source-state fingerprint and started no later than the escalation.
 * The recovery action id is not used: each attempt resolves its action and the
 * escalation opens a new one (GRE-712). Report only: it sizes row 75.
 */
export const REPAIR_EXHAUSTED_REASON = "unchanged_source_state_exhausted";

function isAgentOnlyTask(issue, assigneeBefore) {
  const agentId = assigneeBefore ? assigneeBefore.agentId : issue?.assigneeAgentId;
  const userId = assigneeBefore ? assigneeBefore.userId : issue?.assigneeUserId;
  if (!agentId || userId || issue?.conversationUserId) return false;
  const stages = Array.isArray(issue?.executionPolicy?.stages) ? issue.executionPolicy.stages : [];
  return stages.every((stage) => (stage.participants ?? []).every((participant) => participant.type === "agent"));
}

export function computeRepairEscalations(snapshot, { now, windowDays = 7 } = {}) {
  const nowMs = ms(now ?? snapshot.now);
  const windowStart = nowMs - windowDays * 86_400_000;
  const byId = new Map((snapshot.issues ?? []).map((issue) => [issue.id, issue]));
  const cells = {
    agentOnlyCommented: [], agentOnlyNoComment: [], otherCommented: [], otherNoComment: [],
  };
  for (const escalation of snapshot.repairEscalations ?? []) {
    const at = ms(escalation.createdAt);
    if (escalation.terminalReason !== REPAIR_EXHAUSTED_REASON || at == null || at < windowStart || at > nowMs) continue;
    const issue = byId.get(escalation.issueId);
    const repairRuns = (snapshot.repairRuns ?? []).filter((run) => run.issueId === escalation.issueId
      && (!escalation.fingerprint || run.fingerprint === escalation.fingerprint)
      && (ms(run.createdAt) ?? 0) <= at);
    const commented = repairRuns.some((run) => (run.commentCount ?? 0) > 0);
    const agentOnly = isAgentOnlyTask(issue, escalation.sourceAssigneeBefore);
    const key = `${agentOnly ? "agentOnly" : "other"}${commented ? "Commented" : "NoComment"}`;
    cells[key].push({
      issueId: escalation.issueId,
      identifier: issue?.identifier ?? escalation.identifier ?? escalation.issueId,
      at: new Date(at).toISOString(),
      repairRuns: repairRuns.length,
      repairComments: repairRuns.reduce((sum, run) => sum + (run.commentCount ?? 0), 0),
    });
  }
  const list = (entries) => entries.sort((a, b) => a.at.localeCompare(b.at));
  return {
    windowDays,
    terminalReason: REPAIR_EXHAUSTED_REASON,
    total: Object.values(cells).reduce((sum, entries) => sum + entries.length, 0),
    agentOnlyCommented: list(cells.agentOnlyCommented),
    agentOnlyNoComment: list(cells.agentOnlyNoComment),
    otherCommented: list(cells.otherCommented),
    otherNoComment: list(cells.otherNoComment),
  };
}

/**
 * R1 detail — throttled rewakes (register row 126, GRE-893).
 *
 * The rewake throttle skips a state-asserting wake on an issue whose agent has
 * had a streak of no-progress runs, and writes a `skipped` wake request with
 * reason `issue_rewake_throttled` (payload `heartbeatSkip.noProgressStreak`).
 * It never stops the loop and the run API does not show skipped wakes, so this
 * counts those records requested in the window: total, per agent, and per
 * (issue, agent) with the highest streak seen. Report only: it sizes row 125.
 */
export const REWAKE_THROTTLED_REASON = "issue_rewake_throttled";

export function computeThrottledRewakes(snapshot, { now, windowDays = 7, topIssues = 10 } = {}) {
  const nowMs = ms(now ?? snapshot.now);
  const windowStart = nowMs - windowDays * 86_400_000;
  const byId = new Map((snapshot.issues ?? []).map((issue) => [issue.id, issue]));
  const agentNames = new Map((snapshot.agents ?? []).map((agent) => [agent.id, agent.name ?? null]));
  const perAgent = new Map();
  const perIssue = new Map();
  let total = 0;
  for (const wake of snapshot.throttledWakes ?? []) {
    const at = ms(wake.requestedAt);
    if (wake.reason !== REWAKE_THROTTLED_REASON || at == null || at < windowStart || at > nowMs) continue;
    total += 1;
    const agentId = wake.agentId ?? "unknown";
    const agent = perAgent.get(agentId) ?? { agentId, name: agentNames.get(agentId) ?? null, count: 0, issueIds: new Set() };
    agent.count += 1;
    const issueId = wake.issueId ?? "unknown";
    agent.issueIds.add(issueId);
    perAgent.set(agentId, agent);
    const key = `${issueId}\u0000${agentId}`;
    const entry = perIssue.get(key) ?? {
      issueId, identifier: byId.get(issueId)?.identifier ?? issueId, agentId, count: 0, maxStreak: 0, lastAt: 0, requestedReasons: new Set(),
    };
    entry.count += 1;
    entry.maxStreak = Math.max(entry.maxStreak, Number(wake.noProgressStreak) || 0);
    entry.lastAt = Math.max(entry.lastAt, at);
    if (wake.requestedReason) entry.requestedReasons.add(wake.requestedReason);
    perIssue.set(key, entry);
  }
  const issues = [...perIssue.values()]
    .sort((a, b) => b.count - a.count || b.maxStreak - a.maxStreak || a.identifier.localeCompare(b.identifier))
    .map(({ requestedReasons, lastAt, ...entry }) => ({ ...entry, lastAt: new Date(lastAt).toISOString(), requestedReasons: [...requestedReasons].sort() }));
  return {
    windowDays,
    reason: REWAKE_THROTTLED_REASON,
    total,
    issues: issues.length,
    maxStreak: issues.reduce((max, entry) => Math.max(max, entry.maxStreak), 0),
    byAgent: [...perAgent.values()]
      .map(({ issueIds, ...agent }) => ({ ...agent, issues: issueIds.size }))
      .sort((a, b) => b.count - a.count || a.agentId.localeCompare(b.agentId)),
    topIssues: issues.slice(0, topIssues),
  };
}

/**
 * R2 — run failure rate and unattended recovery share.
 *
 * Denominator: runs that finished inside the window as succeeded or failed
 * (failed, timed_out, interrupted). Cancelled runs are counted separately and
 * excluded, since cancellation is usually a human or supersession decision.
 * A failed run on an issue is recovered without a human when a later run on the
 * same issue succeeds, or the issue reaches done, with no human intervention on
 * that issue in between.
 *
 * Platform failure rate leaves out rejected logins (`isAuthFailure`) from both
 * sides: a refused login is an account problem for the board, not a platform
 * fault (GRE-590). They are counted on their own as `loginRefusals`. Account
 * and setup refusals (`accountRefusalReason`) are left out the same way and
 * counted as `accountRefusals` (GRE-745).
 */
export function computeRunFailures(snapshot, { now, windowDays = 7 } = {}) {
  const nowMs = ms(now ?? snapshot.now);
  const windowStart = nowMs - windowDays * 86_400_000;
  const finished = snapshot.runs.filter((run) => {
    const at = ms(run.finishedAt);
    return at != null && at >= windowStart && at <= nowMs;
  });
  const succeeded = finished.filter((run) => run.status === "succeeded");
  const failed = finished.filter((run) => FAILED_RUN_STATUSES.has(run.status));
  const cancelled = finished.filter((run) => run.status === "cancelled");
  const loginRefusals = failed.filter(isAuthFailure).length;
  const accountRefused = failed.map(accountRefusalReason).filter(Boolean);
  const accountRefusalsByReason = Object.fromEntries(
    ACCOUNT_REFUSAL_REASONS.map(({ reason }) => [reason, accountRefused.filter((entry) => entry === reason).length]),
  );
  const platformFailed = failed.length - loginRefusals - accountRefused.length;

  const humanByIssue = new Map();
  for (const row of snapshot.activity ?? []) {
    if (row.entityType !== "issue" || !isHumanIntervention(row)) continue;
    if (!humanByIssue.has(row.entityId)) humanByIssue.set(row.entityId, []);
    humanByIssue.get(row.entityId).push(ms(row.createdAt));
  }
  const issues = new Map((snapshot.issues ?? []).map((issue) => [issue.id, issue]));
  const outcomes = { auto: 0, human: 0, unresolved: 0, noIssue: 0 };
  const failures = [];
  for (const run of failed) {
    if (!run.issueId) {
      outcomes.noIssue += 1;
      failures.push({ runId: run.id, status: run.status, errorCode: run.errorCode ?? null, loginRefusal: isAuthFailure(run), accountRefusal: accountRefusalReason(run), outcome: "no_issue" });
      continue;
    }
    const failedAt = ms(run.finishedAt);
    const later = snapshot.runs
      .filter((other) => other.issueId === run.issueId && other.status === "succeeded" && ms(other.finishedAt) > failedAt)
      .map((other) => ms(other.finishedAt));
    const issue = issues.get(run.issueId);
    if (issue?.status === "done" && issue.completedAt && ms(issue.completedAt) > failedAt) later.push(ms(issue.completedAt));
    const recoveredAt = later.length ? Math.min(...later) : null;
    let outcome = "unresolved";
    if (recoveredAt != null) {
      const touched = (humanByIssue.get(run.issueId) ?? []).some((at) => at > failedAt && at <= recoveredAt);
      outcome = touched ? "human" : "auto";
    }
    outcomes[outcome] += 1;
    failures.push({ runId: run.id, issueId: run.issueId, status: run.status, errorCode: run.errorCode ?? null, loginRefusal: isAuthFailure(run), accountRefusal: accountRefusalReason(run), outcome });
  }
  const attributable = failed.length - outcomes.noIssue;
  const denominator = succeeded.length + failed.length;
  const platformDenominator = succeeded.length + platformFailed;
  return {
    windowDays,
    finishedRuns: finished.length,
    succeeded: succeeded.length,
    failed: failed.length,
    cancelled: cancelled.length,
    failureRate: denominator ? failed.length / denominator : null,
    platformFailed,
    platformFinished: platformDenominator,
    platformFailureRate: platformDenominator ? platformFailed / platformDenominator : null,
    loginRefusals,
    accountRefusals: accountRefused.length,
    accountRefusalsByReason,
    recoveredWithoutHuman: outcomes.auto,
    recoveredWithHuman: outcomes.human,
    unresolved: outcomes.unresolved,
    failedWithoutIssue: outcomes.noIssue,
    failuresWithIssue: attributable,
    unattendedRecoveryShare: attributable ? outcomes.auto / attributable : null,
    failures,
  };
}

/**
 * S1 — wake to first useful agent action.
 *
 * Wake: the wakeup request's requestedAt, or the run's createdAt when the run
 * has no wakeup request. First useful action: the first agent-attributed
 * activity row for the run that is not harness bookkeeping (environment leases,
 * checkout, read markers, tool discovery). Runs with no useful action are
 * counted, not timed.
 *
 * Timed runs are also split at the moment the prompt was sent (the run's
 * `promptSentAt`, when recorded): setup is wake → prompt sent (queue, workspace,
 * adapter start, prompt build); agent is prompt sent → first useful action.
 *
 * S1-work is the same clock stopped at the first useful action that is not a
 * comment (`issue.comment_added`). An early "on it" comment moves S1 but not
 * S1-work, so a speed claim needs both (GRE-74).
 */
export function computeWakeLatency(snapshot, { now, windowDays = 7 } = {}) {
  const nowMs = ms(now ?? snapshot.now);
  const windowStart = nowMs - windowDays * 86_400_000;
  const firstUseful = new Map();
  const firstWork = new Map();
  const keepEarliest = (map, runId, at) => {
    if (!map.has(runId) || at < map.get(runId)) map.set(runId, at);
  };
  for (const row of snapshot.activity ?? []) {
    if (!row.runId || row.actorType !== "agent" || !isUsefulAgentAction(row.action)) continue;
    const at = ms(row.createdAt);
    keepEarliest(firstUseful, row.runId, at);
    if (row.action !== "issue.comment_added") keepEarliest(firstWork, row.runId, at);
  }
  const samples = [];
  const queueDelays = [];
  const setups = [];
  const agentTimes = [];
  const workSamples = [];
  let withoutUsefulAction = 0;
  let considered = 0;
  for (const run of snapshot.runs) {
    const wake = ms(run.wakeRequestedAt ?? run.createdAt);
    if (wake == null || wake < windowStart || wake > nowMs) continue;
    if (!["succeeded", ...FAILED_RUN_STATUSES].includes(run.status)) continue;
    considered += 1;
    if (run.startedAt) queueDelays.push(ms(run.startedAt) - wake);
    const first = firstUseful.get(run.id);
    if (first == null) { withoutUsefulAction += 1; continue; }
    samples.push(first - wake);
    const work = firstWork.get(run.id);
    if (work != null) workSamples.push(work - wake);
    const promptSent = ms(run.promptSentAt);
    if (promptSent != null && promptSent >= wake && promptSent <= first) {
      setups.push(promptSent - wake);
      agentTimes.push(first - promptSent);
    }
  }
  return {
    windowDays,
    finishedRunsConsidered: considered,
    sampleSize: samples.length,
    runsWithoutUsefulAction: withoutUsefulAction,
    medianMs: median(samples),
    p95Ms: percentile(samples, 95),
    maxMs: samples.length ? Math.max(...samples) : null,
    queueDelayMedianMs: median(queueDelays),
    split: {
      sampleSize: setups.length,
      setupMedianMs: median(setups),
      setupP95Ms: percentile(setups, 95),
      agentMedianMs: median(agentTimes),
      agentP95Ms: percentile(agentTimes, 95),
    },
    work: {
      sampleSize: workSamples.length,
      runsWithCommentsOnly: samples.length - workSamples.length,
      medianMs: median(workSamples),
      p95Ms: percentile(workSamples, 95),
    },
    samplesMs: [...samples].sort((a, b) => a - b),
  };
}

/**
 * A run failed because the provider refused the login. Newer servers code it
 * `<provider>_auth_required`; older ones coded the ACP "terminal access
 * failure" as a generic turn failure, so the collector also passes a flag for
 * that error text. Stated here, not imported from the recovery code.
 */
export function isAuthFailure(run) {
  if (!FAILED_RUN_STATUSES.has(run.status)) return false;
  return /^[a-z]+_auth_required$/.test(run.errorCode ?? "") || run.errorMentionsAccessFailure === true;
}

/**
 * Account and setup refusals left out of the R2 platform rate (GRE-745). Each
 * is matched on its error code and the fixed server message for that one
 * reason, never on a whole code: `configuration_incomplete` also carried the
 * GRE-236 platform bug ("Reconnect or validate the selected AI account"),
 * which must stay counted. `acpx_turn_failed` stays counted too.
 */
export const ACCOUNT_REFUSAL_REASONS = [
  { reason: "expired_credential", errorCode: "configuration_incomplete", text: / token expired at / },
  { reason: "no_personal_default", errorCode: "configuration_incomplete", text: /^Connect an account and choose your personal default/ },
  { reason: "connection_not_permitted", errorCode: "configuration_incomplete", text: /^This connection is not permitted for this agent/ },
  { reason: "low_trust_no_sandbox", errorCode: "low_trust_requires_sandbox_environment", text: null },
  { reason: "no_project_workspace", errorCode: "workspace_validation_failed", text: /This task needs a project \/ project workspace or a reusable execution workspace/ },
];

/** The account or setup refusal reason of a failed run, or null. Login refusals are not included. */
export function accountRefusalReason(run) {
  if (!FAILED_RUN_STATUSES.has(run.status) || isAuthFailure(run)) return null;
  const match = ACCOUNT_REFUSAL_REASONS.find(
    (entry) => entry.errorCode === run.errorCode && (entry.text == null || entry.text.test(run.errorText ?? "")),
  );
  return match?.reason ?? null;
}

/**
 * R2 detail — rejected logins. A dead credential should hand the task to the
 * board at once: no automatic retries and no `Bounded retry exhausted` event.
 * Counts auth-failed runs that finished in the window, retry runs scheduled
 * from them, and retry exhaustion events in the window that follow one.
 */
export function computeAuthFailures(snapshot, { now, windowDays = 7 } = {}) {
  const nowMs = ms(now ?? snapshot.now);
  const windowStart = nowMs - windowDays * 86_400_000;
  const inWindow = (value) => {
    const at = ms(value);
    return at != null && at >= windowStart && at <= nowMs;
  };
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  const failed = snapshot.runs.filter((run) => inWindow(run.finishedAt) && isAuthFailure(run));
  const failedIds = new Set(failed.map((run) => run.id));
  const retries = snapshot.runs.filter((run) => run.retryOfRunId && failedIds.has(run.retryOfRunId));
  const exhaustions = (snapshot.retryExhaustions ?? []).filter((event) => inWindow(event.createdAt));
  const fromAuth = exhaustions.filter((event) => {
    const run = runs.get(event.runId);
    return run != null && isAuthFailure(run);
  });
  return {
    windowDays,
    authFailedRuns: failed.length,
    byErrorCode: Object.fromEntries(
      [...new Set(failed.map((run) => run.errorCode ?? "none"))].map((code) => [code, failed.filter((run) => (run.errorCode ?? "none") === code).length]),
    ),
    retriesAfterAuthFailure: retries.length,
    retryExhaustions: exhaustions.length,
    retryExhaustionsFromAuthFailures: fromAuth.length,
    exhaustedAuthRuns: fromAuth.map((event) => ({
      runId: event.runId,
      issueId: runs.get(event.runId)?.issueId ?? null,
      errorCode: runs.get(event.runId)?.errorCode ?? null,
      at: new Date(event.createdAt).toISOString(),
    })),
  };
}

export function computeAll(snapshot, options = {}) {
  return {
    r1: computeStrandedTrees(snapshot, options),
    parkedWakes: computeParkedWakes(snapshot, options),
    repairEscalations: computeRepairEscalations(snapshot, options),
    throttledRewakes: computeThrottledRewakes(snapshot, options),
    r2: computeRunFailures(snapshot, options),
    auth: computeAuthFailures(snapshot, options),
    s1: computeWakeLatency(snapshot, options),
  };
}
