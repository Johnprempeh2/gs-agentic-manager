// Pure computation of time lost to platform faults (GRE-37). Measures the three
// faults from the GRE-32 assessment plus the human time they cost:
//
//   L1 — runs stopped as silent or hung, and their minutes (fault A)
//   L2 — issues moved to `blocked` by recovery while a pending interaction existed (fault D)
//   L3 — runs cancelled by `issue_reassigned`, and their minutes (fault E)
//   L4 — human comments that ask for or relay status, or recover a run (best effort)
//   L5 — recovery runs started while the issue waited on a pending card (GRE-53)
//
// The snapshot comes from lost-time-collect.mjs; tests build it by hand.

// Stop codes written by a watchdog that caught a silent run. `run_silent_timeout`
// is the code GRE-34 asks for; `process_lost` is the existing orphan reaper.
export const SILENT_STOP_CODES = ["run_silent_timeout", "process_lost"];
export const REASSIGN_STOP_CODE = "issue_reassigned";
export const DEFAULT_SILENCE_MINUTES = 20;

const MINUTE = 60_000;
const time = (value) => (value == null ? null : new Date(value).getTime());
const minutesBetween = (start, end) => (start == null || end == null ? 0 : Math.max(0, (time(end) - time(start)) / MINUTE));
const round1 = (value) => Math.round(value * 10) / 10;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const inWindow = (value, since, now) => value != null && time(value) >= since && time(value) <= now;

function runMinutes(run) {
  return minutesBetween(run.startedAt ?? run.createdAt, run.finishedAt);
}

function summariseRuns(runs) {
  const minutes = runs.map(runMinutes);
  return {
    count: runs.length,
    minutes: round1(sum(minutes)),
    maxMinutes: round1(minutes.length ? Math.max(...minutes) : 0),
    runs: runs.map((run) => ({
      id: run.id,
      issueIdentifier: run.issueIdentifier ?? null,
      agentId: run.agentId ?? null,
      status: run.status,
      errorCode: run.errorCode ?? null,
      minutes: round1(runMinutes(run)),
      finishedAt: run.finishedAt,
    })),
  };
}

// L1. Two kinds, reported apart so the fix shows up as a shift between them:
// - caught by a watchdog: a silent-stop code, or the run timed out;
// - caught by a human: a manual cancel (`errorCode = 'cancelled'`) of a run
//   that had been going for at least the silence threshold. Today nothing
//   stops a hung run, so a person cancelling a long run is the signal.
export function computeHungRuns(snapshot, { since, now, silenceMinutes = DEFAULT_SILENCE_MINUTES }) {
  const finished = snapshot.runs.filter((run) => inWindow(run.finishedAt, since, now));
  const watchdog = finished.filter((run) => SILENT_STOP_CODES.includes(run.errorCode) || run.status === "timed_out");
  const humanCancelled = finished.filter(
    (run) => run.status === "cancelled" && run.errorCode === "cancelled" && runMinutes(run) >= silenceMinutes,
  );
  const watchdogSummary = summariseRuns(watchdog);
  const humanSummary = summariseRuns(humanCancelled);
  return {
    silenceMinutes,
    count: watchdog.length + humanCancelled.length,
    minutes: round1(watchdogSummary.minutes + humanSummary.minutes),
    caughtByWatchdog: watchdogSummary,
    caughtByHuman: humanSummary,
  };
}

// L2. A recovery move is an activity row written by the system with a
// `recovery.*` source and status `blocked`. It is a false stall when an
// interaction on the same issue was pending at that moment: created before the
// move and not yet resolved.
export function computeFalseStalls(snapshot, { since, now }) {
  const moves = snapshot.activity.filter(
    (row) => row.actorType === "system" && row.status === "blocked" && String(row.source ?? "").startsWith("recovery.") && inWindow(row.createdAt, since, now),
  );
  const rows = moves.map((move) => {
    const pending = snapshot.interactions.filter(
      (interaction) =>
        interaction.issueId === move.entityId &&
        time(interaction.createdAt) <= time(move.createdAt) &&
        (interaction.resolvedAt == null || time(interaction.resolvedAt) > time(move.createdAt)),
    );
    return {
      issueIdentifier: move.issueIdentifier ?? move.entityId,
      movedAt: move.createdAt,
      source: move.source,
      previousStatus: move.previousStatus ?? null,
      pendingInteractions: pending.map((interaction) => ({ id: interaction.id, kind: interaction.kind })),
    };
  });
  const falseStalls = rows.filter((row) => row.pendingInteractions.length > 0);
  return { recoveryBlocks: rows.length, count: falseStalls.length, falseStalls, recoveryMoves: rows };
}

// L3. Minutes are the old assignee's run time thrown away. Runs cancelled
// while still queued (never started) count with zero minutes.
export function computeReassignCancels(snapshot, { since, now }) {
  const cancelled = snapshot.runs.filter(
    (run) => run.status === "cancelled" && run.errorCode === REASSIGN_STOP_CODE && inWindow(run.finishedAt, since, now),
  );
  const summary = summariseRuns(cancelled);
  return { ...summary, overFiveMinutes: cancelled.filter((run) => runMinutes(run) >= 5).length };
}

// L4. Best effort: a human comment counts when its text matches one of three
// simple rules. Each counted comment is listed so the rule can be audited.
export const HUMAN_COMMENT_RULES = {
  // The person had to ask what is going on.
  asksStatus: /\bwhy is\b|\bwhy does (it|this) take\b|\btaking\b.*\blong\b|\bany (update|news)\b|\bstill working\b|\bis (this|it) (done|stuck|blocked)\b/i,
  // The person told an agent something the platform should have told it.
  relaysStatus: /\b(been|is|got|was) (merged|released|deployed|fixed)\b|\bi (think i |have |'ve )?(fixed|merged|released)\b|\bhave(n't| not) released\b/i,
  // The person diagnosed or restarted a stopped run.
  recoversRun: /\b(hung|hang|hanging|stuck)\b|\blast (run|runs|wake) (hung|failed)\b|\bruns? failed\b|\btoken (had )?expired\b|\bconnection is fixed\b|\breset the session\b|\bwas cancelled\b|\bplease (continue|retry)\b/i,
};

export function classifyHumanComment(body) {
  const text = String(body ?? "");
  return Object.entries(HUMAN_COMMENT_RULES)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

export function computeHumanComments(snapshot, { since, now }) {
  const human = snapshot.comments.filter((comment) => comment.authorUserId && inWindow(comment.createdAt, since, now));
  const counted = human
    .map((comment) => ({ comment, rules: classifyHumanComment(comment.body) }))
    .filter((entry) => entry.rules.length > 0);
  const byRule = Object.fromEntries(Object.keys(HUMAN_COMMENT_RULES).map((name) => [name, counted.filter((entry) => entry.rules.includes(name)).length]));
  return {
    humanComments: human.length,
    count: counted.length,
    byRule,
    // Ids only: reports never carry comment bodies.
    comments: counted.map(({ comment, rules }) => ({
      id: comment.id ?? null,
      issueIdentifier: comment.issueIdentifier ?? comment.issueId,
      createdAt: comment.createdAt,
      rules,
    })),
  };
}

// L5. Recovery wakes on an issue that only waits for a pending card (GRE-53).
// GRE-35 and GRE-51 stop these; after a release with both, this should be 0.
export const RECOVERY_WAKE_SOURCES = [
  "issue.interaction_continuation_recovery",
  "issue.execution_review_recovery",
  "issue.continuation_recovery",
  "issue.assignment_recovery",
  "issue.productive_terminal_continuation_recovery",
  "issue.successful_run_handoff_interrupted_retry",
  "issue.deliberate_wait_disposition_repair",
];
export const WAKING_CONTINUATION_POLICIES = ["wake_assignee", "wake_assignee_on_accept"];

// A run counts when its source is a recovery source and it started (or was
// created, if it never started) while an interaction on its issue with a
// waking continuation policy was pending: created before that moment and
// resolved after it, or not yet.
export function computeRecoveryWakesOnPendingCard(snapshot, { since, now }) {
  const recovery = (snapshot.recoveryRuns ?? []).filter(
    (run) => RECOVERY_WAKE_SOURCES.includes(run.source) && inWindow(run.startedAt ?? run.createdAt, since, now),
  );
  const rows = recovery.map((run) => {
    const startedAt = time(run.startedAt ?? run.createdAt);
    const pending = snapshot.interactions.filter(
      (interaction) =>
        interaction.issueId === run.issueId &&
        WAKING_CONTINUATION_POLICIES.includes(interaction.continuationPolicy) &&
        time(interaction.createdAt) <= startedAt &&
        (interaction.resolvedAt == null || time(interaction.resolvedAt) > startedAt),
    );
    return {
      id: run.id,
      issueIdentifier: run.issueIdentifier ?? run.issueId ?? null,
      source: run.source,
      status: run.status,
      startedAt: new Date(startedAt).toISOString(),
      pendingInteractions: pending.map((interaction) => ({ id: interaction.id, kind: interaction.kind, continuationPolicy: interaction.continuationPolicy })),
    };
  });
  const runs = rows.filter((row) => row.pendingInteractions.length > 0);
  const bySource = Object.fromEntries(RECOVERY_WAKE_SOURCES.map((source) => [source, runs.filter((row) => row.source === source).length]));
  return { recoveryRuns: rows.length, count: runs.length, bySource, runs };
}

// Denominators, so a window with more work is not read as a regression.
export function computeRunTotals(snapshot, { since, now }) {
  const finished = snapshot.runs.filter((run) => inWindow(run.finishedAt, since, now));
  return { finishedRuns: finished.length, agentMinutes: round1(sum(finished.map(runMinutes))) };
}

export function computeLostTime(snapshot, { now, windowDays, since: sinceOverride = null, silenceMinutes = DEFAULT_SILENCE_MINUTES }) {
  const end = time(now);
  const since = sinceOverride != null ? time(sinceOverride) : end - windowDays * 86_400_000;
  const window = { since, now: end, silenceMinutes };
  const hung = computeHungRuns(snapshot, window);
  const reassigned = computeReassignCancels(snapshot, window);
  const totals = computeRunTotals(snapshot, window);
  const share = (minutes) => (totals.agentMinutes > 0 ? round1((minutes / totals.agentMinutes) * 100) : null);
  return {
    windowStart: new Date(since).toISOString(),
    totals,
    l1HungRuns: { ...hung, shareOfAgentMinutesPct: share(hung.minutes) },
    l2FalseStalls: computeFalseStalls(snapshot, window),
    l3ReassignCancels: { ...reassigned, shareOfAgentMinutesPct: share(reassigned.minutes) },
    l4HumanComments: computeHumanComments(snapshot, window),
    l5RecoveryWakesOnPendingCard: computeRecoveryWakesOnPendingCard(snapshot, window),
  };
}
