// Pure calculators for the tracked reliability and wake-latency numbers.
// Inputs are plain rows (see collect.mjs); nothing here reads a database, so the
// definitions are testable with fixed fixtures. Definitions are documented in
// README.md beside this file; change them there and here together.

export const OPEN_ISSUE_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);
export const LIVE_RUN_STATUSES = new Set(["queued", "running", "scheduled_retry"]);
export const LIVE_WAKE_STATUSES = new Set(["queued", "deferred_issue_execution"]);
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
 * A tree is a root issue plus all descendants. It is stranded when it has at
 * least one open issue, no open issue has a live path, no open issue has a
 * human owner, no active tree hold covers it, and nothing in the tree has moved
 * for `graceMinutes`. `weekly` counts stranded trees whose last activity falls
 * inside the window, i.e. trees that stopped during the window.
 */
export function computeStrandedTrees(snapshot, { now, windowDays = 7, graceMinutes = 30 } = {}) {
  const nowMs = ms(now ?? snapshot.now);
  const windowStart = nowMs - windowDays * 86_400_000;
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

  const liveReasons = new Map();
  const addLive = (issueId, reason) => {
    if (!issueId || !byId.has(issueId)) return;
    if (!liveReasons.has(issueId)) liveReasons.set(issueId, new Set());
    liveReasons.get(issueId).add(reason);
  };
  for (const run of snapshot.runs) if (LIVE_RUN_STATUSES.has(run.status)) addLive(run.issueId, `run:${run.status}`);
  for (const wake of snapshot.wakeRequests ?? []) if (LIVE_WAKE_STATUSES.has(wake.status)) addLive(wake.issueId, `wake:${wake.status}`);
  for (const interaction of snapshot.interactions ?? []) if (interaction.status === "pending") addLive(interaction.issueId, "interaction:pending");
  for (const approval of snapshot.approvals ?? []) if (["pending", "revision_requested"].includes(approval.status)) addLive(approval.issueId, `approval:${approval.status}`);
  for (const recovery of snapshot.recoveryActions ?? []) if (!recovery.resolvedAt) addLive(recovery.sourceIssueId, "recovery:open");
  for (const issue of issues) if (issue.monitorNextCheckAt) addLive(issue.id, "monitor:scheduled");

  const agents = new Map((snapshot.agents ?? []).map((agent) => [agent.id, agent]));
  for (const issue of issues) {
    const agent = issue.assigneeAgentId ? agents.get(issue.assigneeAgentId) : null;
    // A timer heartbeat is a live path only when the agent can actually be invoked.
    if (agent?.timerHeartbeat && !["paused", "terminated", "pending_approval", "error"].includes(agent.status)) {
      addLive(issue.id, "agent:timer_heartbeat");
    }
  }
  const hasPath = (issue) => liveReasons.has(issue.id) || Boolean(issue.assigneeUserId);
  // A blocked issue waiting on a blocker that itself has a path is not stranded;
  // propagate through blocker chains until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    for (const relation of snapshot.relations ?? []) {
      const blocker = byId.get(relation.blockerIssueId);
      if (!blocker || !OPEN_ISSUE_STATUSES.has(blocker.status) || !hasPath(blocker)) continue;
      if (liveReasons.get(relation.blockedIssueId)?.has("blocker:live")) continue;
      addLive(relation.blockedIssueId, "blocker:live");
      changed = byId.has(relation.blockedIssueId) || changed;
    }
  }

  const heldRoots = new Set((snapshot.treeHolds ?? []).filter((hold) => hold.status === "active").map((hold) => hold.rootIssueId));
  const lastActivity = new Map();
  const touch = (issueId, at) => {
    const issue = byId.get(issueId);
    const value = ms(at);
    if (!issue || value == null) return;
    const root = rootOf(issue).id;
    lastActivity.set(root, Math.max(lastActivity.get(root) ?? 0, value));
  };
  for (const issue of issues) touch(issue.id, issue.updatedAt);
  for (const run of snapshot.runs) touch(run.issueId, run.finishedAt ?? run.startedAt ?? run.createdAt);

  const trees = new Map();
  for (const issue of issues) {
    const root = rootOf(issue);
    if (!trees.has(root.id)) trees.set(root.id, { root, open: [] });
    if (OPEN_ISSUE_STATUSES.has(issue.status)) trees.get(root.id).open.push(issue);
  }

  const stranded = [];
  for (const { root, open } of trees.values()) {
    if (open.length === 0 || heldRoots.has(root.id)) continue;
    if (open.some((issue) => liveReasons.has(issue.id))) continue;
    if (open.some((issue) => issue.assigneeUserId)) continue;
    const last = lastActivity.get(root.id) ?? 0;
    if (nowMs - last < graceMinutes * 60_000) continue;
    stranded.push({
      rootIssueId: root.id,
      rootIdentifier: root.identifier,
      companyId: root.companyId,
      openIssues: open.map((issue) => ({ id: issue.id, identifier: issue.identifier, status: issue.status, assigneeAgentId: issue.assigneeAgentId ?? null })),
      lastActivityAt: last ? new Date(last).toISOString() : null,
      stoppedInWindow: last >= windowStart,
    });
  }
  return {
    windowDays,
    graceMinutes,
    treesWithOpenWork: [...trees.values()].filter((tree) => tree.open.length > 0).length,
    weekly: stranded.filter((tree) => tree.stoppedInWindow).length,
    total: stranded.length,
    stranded,
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
      failures.push({ runId: run.id, status: run.status, errorCode: run.errorCode ?? null, outcome: "no_issue" });
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
    failures.push({ runId: run.id, issueId: run.issueId, status: run.status, errorCode: run.errorCode ?? null, outcome });
  }
  const attributable = failed.length - outcomes.noIssue;
  const denominator = succeeded.length + failed.length;
  return {
    windowDays,
    finishedRuns: finished.length,
    succeeded: succeeded.length,
    failed: failed.length,
    cancelled: cancelled.length,
    failureRate: denominator ? failed.length / denominator : null,
    recoveredWithoutHuman: outcomes.auto,
    recoveredWithHuman: outcomes.human,
    unresolved: outcomes.unresolved,
    failedWithoutIssue: outcomes.noIssue,
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
 */
export function computeWakeLatency(snapshot, { now, windowDays = 7 } = {}) {
  const nowMs = ms(now ?? snapshot.now);
  const windowStart = nowMs - windowDays * 86_400_000;
  const firstUseful = new Map();
  for (const row of snapshot.activity ?? []) {
    if (!row.runId || row.actorType !== "agent" || !isUsefulAgentAction(row.action)) continue;
    const at = ms(row.createdAt);
    if (!firstUseful.has(row.runId) || at < firstUseful.get(row.runId)) firstUseful.set(row.runId, at);
  }
  const samples = [];
  const queueDelays = [];
  const setups = [];
  const agentTimes = [];
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
    r2: computeRunFailures(snapshot, options),
    auth: computeAuthFailures(snapshot, options),
    s1: computeWakeLatency(snapshot, options),
  };
}
