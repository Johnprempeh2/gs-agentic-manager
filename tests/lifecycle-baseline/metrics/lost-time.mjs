// Pure computation of time lost to platform faults (GRE-37). Measures the three
// faults from the GRE-32 assessment plus the human time they cost:
//
//   L1 — runs stopped as silent or hung, and their minutes (fault A)
//   L2 — issues moved to `blocked` by recovery while a pending interaction existed (fault D)
//   L3 — runs cancelled by `issue_reassigned`, and their minutes (fault E)
//   L4 — human comments that ask for or relay status, or recover a run (best effort)
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

// Stopping a run makes the dying process flush a last burst of output (tool
// call, status, error) a few seconds before `finishedAt`, which also moves the
// row's `lastOutputAt`. Output this close to the finish is the stop's own, not
// a sign the run was working.
export const STOP_FLUSH_SECONDS = 60;

// Minutes with no output when the run was stopped, measured up to the start
// of the stop flush. The clock starts where the silent-run watchdog's does
// (GRE-34): last output, then process start, then run start, then creation.
// `outputTimes` (run-log chunk times) gives the exact answer; without it the
// row's `lastOutputAt` is used, which the stop flush can hide. A start time
// inside the flush is skipped: a stop can stamp `processStartedAt` again (GRE-3's
// run d267e002 shows 18:49:15 after a hang from 14:23).
function silentMinutesAtStop(run) {
  const cutoff = time(run.finishedAt) - STOP_FLUSH_SECONDS * 1000;
  const start = [run.processStartedAt, run.startedAt, run.createdAt].find((value) => value != null && time(value) <= cutoff) ?? run.finishedAt;
  if (!run.outputTimes) return minutesBetween(run.lastOutputAt ?? start, run.finishedAt);
  const before = run.outputTimes.map(time).filter((value) => value < cutoff);
  const last = Math.max(time(start) ?? 0, ...before);
  return Math.max(0, (cutoff - last) / MINUTE);
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
      silentMinutes: round1(silentMinutesAtStop(run)),
      silenceSource: run.outputTimes ? "run_log" : "run_row",
      finishedAt: run.finishedAt,
    })),
  };
}

// L1. Two kinds, reported apart so the fix shows up as a shift between them:
// - caught by a watchdog: a silent-stop code, or the run timed out;
// - caught by a human: a manual cancel (`errorCode = 'cancelled'`) of a run
//   that had written no output for at least the silence threshold when it was
//   cancelled, ignoring the stop flush (GRE-182). A long run that was still
//   writing is not a hang, so a bulk cancel of working runs does not count.
//   The rule stays next to the watchdog because an agent can turn the
//   watchdog off and older windows predate it.
export function computeHungRuns(snapshot, { since, now, silenceMinutes = DEFAULT_SILENCE_MINUTES }) {
  const finished = snapshot.runs.filter((run) => inWindow(run.finishedAt, since, now));
  const watchdog = finished.filter((run) => SILENT_STOP_CODES.includes(run.errorCode) || run.status === "timed_out");
  const manualCancels = finished.filter((run) => run.status === "cancelled" && run.errorCode === "cancelled");
  const humanCancelled = manualCancels.filter((run) => silentMinutesAtStop(run) >= silenceMinutes);
  const watchdogSummary = summariseRuns(watchdog);
  const humanSummary = summariseRuns(humanCancelled);
  return {
    silenceMinutes,
    stopFlushSeconds: STOP_FLUSH_SECONDS,
    // Long manual cancels left out because the run was still writing, so the
    // exclusion can be audited.
    manualCancelsNotCounted: manualCancels.filter((run) => !humanCancelled.includes(run) && runMinutes(run) >= silenceMinutes).length,
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
  };
}
