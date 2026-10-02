// Pure computation of how John spends his time on the board (GRE-397). One
// line for the 08:00 digest, for the last 24 hours plus a 7-day trend:
//
//   Chase     — John's comments that ask for status or a reason
//   Unstick   — John's comments that only tell an agent to start, continue or
//               retry, plus repair notes posted under his name
//   Decisions — cards (interactions) and approvals John answered
//   Failed    — runs that failed, by cause (error code)
//
// Classification is best effort: simple keyword rules on the comment text,
// limited to comments whose author is one of John's user ids. A small error
// rate is accepted; every counted comment is listed by id so it can be audited.
// The snapshot comes from john-time-collect.mjs; tests build it by hand.

const DAY = 86_400_000;
const time = (value) => (value == null ? null : new Date(value).getTime());
const inWindow = (value, since, now) => value != null && time(value) > since && time(value) <= now;
const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

// Normalise what the editor and phone keyboards add: HTML entities (`&#x20;`),
// curly apostrophes, markdown links and images.
export function normaliseComment(body) {
  return String(body ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/&#x?[0-9a-f]+;|&\w+;/gi, " ")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// A repair note: a diagnosis of a stopped run written for the agent and posted
// under John's name (by John, or by a helper acting for him), usually ending in
// "please continue". Counted under Unstick.
export const REPAIR_RULE =
  /\byour (last )?(run|runs|wake)\b.{0,80}\b(failed|hung|ended|stopped)\b|\bsetup (kept )?fail(ed|ing)?\b|\b(connection|token) (is|was) (fixed|expired)\b|\bplease (continue|retry|re-?run)\b/i;

// Unstick, short form: the whole comment is a nudge to start, continue or
// retry. Only comments of at most UNSTICK_MAX_WORDS words count, so an
// instruction that also carries content ("start now, but use X") is not one.
export const UNSTICK_MAX_WORDS = 8;
export const UNSTICK_SHORT_RULE =
  /^(ok(ay)?[, ]+)?(please )?(you can )?(start|continue|resume|retry|re-?run|run|go( ahead)?|carry on|proceed|try again|keep going)( (it|this|now|again|the run|please|it again|with it))*( now)?[.!]*$|\b(it'?s|it is) (free|unlocked) now\b|\bshould be unlocked\b/i;

// Unstick, any length: John restarting or pacing agents by hand (wake them
// after the laptop slept, let the next batch run).
export const UNSTICK_ANY_RULE =
  /\b(re-?activate|reactivate|boot up|wake up)\b.{0,40}\b(agents?|everybody|everyone|the others|mica|them)\b|\bactivate the others\b|\bget (all )?the agents (working|going|active)\b|\b(allow|start|run) the next batch\b|\byou can (add|let|allow|start) (some )?more\b|\badd more tasks\b/i;

// Chase: John had to ask what is going on, or why.
export const CHASE_RULE = new RegExp(
  [
    String.raw`\bhow(?:'s| is| are)\b.{0,40}\bgoing\b`,
    String.raw`\b(any|an) (update|news|progress)\b`,
    String.raw`\b(is|are) (everything|it|this|things|all) (ok|okay|fine|alright|good)\b`,
    String.raw`\bwhat do you need\b`,
    String.raw`\bwhat'?s (wrong|happening|going on|the status)\b`,
    String.raw`\bwhat (is|are) \w+ doing\b`,
    String.raw`\b(are )?you (still )?working\s*\?`,
    String.raw`\bare you (there|receiving|awake|alive|on it)\b`,
    String.raw`\bhow long\b.{0,40}\b(take|left|until)\b`,
    String.raw`\bwhy (is|are|was|has|hasn't|isn't|did|didn't|does|doesn't|do|don't)\b.{0,60}\b(blocked|stuck|fail\w*|slow|taking|long|stopped|waiting|access|done|working|running)\b`,
    String.raw`\bwhat (caused|cased|made)\b.{0,40}\b(fail|stop|block|hang|hung)`,
    String.raw`\bis (this|it) (done|stuck|blocked|finished)\b`,
    String.raw`\bstill (working|running|waiting|blocked|stuck)\b`,
  ].join("|"),
  "i",
);

// One class per comment, first match wins: short nudge, repair, restart
// agents, chase, other. A short nudge comes first so "please retry" on its own
// is a plain unstick, not a repair note.
export function classifyJohnComment(body) {
  const text = normaliseComment(body);
  if (!text) return "other";
  if (wordCount(text) <= UNSTICK_MAX_WORDS && UNSTICK_SHORT_RULE.test(text)) return "unstick";
  if (REPAIR_RULE.test(text)) return "repair";
  if (UNSTICK_ANY_RULE.test(text)) return "unstick";
  if (CHASE_RULE.test(text)) return "chase";
  return "other";
}

// Decisions: interactions John resolved with an answer (expired and cancelled
// cards are not decisions) and approvals he decided.
const DECIDED_INTERACTION = new Set(["accepted", "rejected", "answered"]);
const DECIDED_APPROVAL = new Set(["approved", "rejected", "revision_requested"]);

// Failed runs: the run ended in error, or a watchdog stopped it. Routine
// cancels (reassigned, dependency blocked, a person pressing stop) are not
// failures; L1 in lost-time.mjs measures hung runs a person cancelled.
const FAILED_STATUSES = new Set(["failed", "timed_out", "interrupted"]);
const WATCHDOG_CANCEL_CODES = new Set(["run_silent_timeout", "process_lost", "adapter_failed"]);
export const isFailedRun = (run) => FAILED_STATUSES.has(run.status) || (run.status === "cancelled" && WATCHDOG_CANCEL_CODES.has(run.errorCode));

export function computeWindow(snapshot, { since, now }) {
  const john = new Set(snapshot.johnUserIds);
  const comments = snapshot.comments
    .filter((comment) => john.has(comment.authorUserId) && inWindow(comment.createdAt, since, now))
    .map((comment) => ({ id: comment.id ?? null, issueIdentifier: comment.issueIdentifier ?? null, createdAt: comment.createdAt, class: classifyJohnComment(comment.body) }));
  const count = (name) => comments.filter((comment) => comment.class === name).length;
  const decisions =
    snapshot.interactions.filter((row) => john.has(row.resolvedByUserId) && DECIDED_INTERACTION.has(row.status) && inWindow(row.resolvedAt, since, now)).length +
    snapshot.approvals.filter((row) => john.has(row.decidedByUserId) && DECIDED_APPROVAL.has(row.status) && inWindow(row.decidedAt, since, now)).length;
  const failed = snapshot.runs.filter((run) => isFailedRun(run) && inWindow(run.finishedAt, since, now));
  const causes = {};
  for (const run of failed) {
    const cause = run.errorCode ?? run.status;
    causes[cause] = (causes[cause] ?? 0) + 1;
  }
  return {
    johnComments: comments.length,
    chase: count("chase"),
    unstick: count("unstick") + count("repair"),
    repair: count("repair"),
    decisions,
    failedRuns: failed.length,
    failedByCause: Object.fromEntries(Object.entries(causes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    // Ids only: reports never carry comment bodies.
    counted: comments.filter((comment) => comment.class !== "other"),
  };
}

// Today is the 24 hours up to `now`; the trend is the seven 24-hour windows
// before and including today, oldest first.
export function computeJohnTime(snapshot, { now, days = 7 }) {
  const end = time(now);
  const trend = Array.from({ length: days }, (_, index) => {
    const windowEnd = end - (days - 1 - index) * DAY;
    return { windowEnd: new Date(windowEnd).toISOString(), ...computeWindow(snapshot, { since: windowEnd - DAY, now: windowEnd }) };
  });
  return { windowEnd: new Date(end).toISOString(), today: trend[trend.length - 1], trend };
}

export function formatDigestLine({ today, trend }, { topCauses = 3 } = {}) {
  const causes = Object.entries(today.failedByCause);
  const shown = causes.slice(0, topCauses).map(([cause, n]) => `${cause} ${n}`);
  const rest = causes.slice(topCauses).reduce((total, [, n]) => total + n, 0);
  if (rest) shown.push(`other ${rest}`);
  const series = (key) => trend.map((day) => day[key]).join(",");
  return (
    `**John's time (24h):** Chase ${today.chase} · Unstick ${today.unstick}` +
    (today.repair ? ` (${today.repair} repair)` : "") +
    ` · Decisions ${today.decisions} · Failed runs ${today.failedRuns}` +
    (shown.length ? ` (${shown.join(", ")})` : "") +
    `. 7 days, oldest first: Chase ${series("chase")} · Unstick ${series("unstick")} · Decisions ${series("decisions")} · Failed ${series("failedRuns")}.`
  );
}
