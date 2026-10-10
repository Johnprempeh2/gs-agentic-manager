import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalRounds, classifyJohnComment, computeJohnTime, computeWindow, formatDigestLine } from "./john-time.mjs";

// Sample comments in the shape John writes them (GRE-394 assessment, 27 Sep to
// 2 Oct). Each is the class the rules must give.
const SAMPLES = {
  chase: [
    "how is it going here",
    "how are the different task going",
    "why is this blocked?",
    "Why is it taking summit taking so long?",
    "how long do you expect this to take?",
    "is everything okay here",
    "what do you need here",
    "whats wrong here",
    "What cased the run to fail",
    "what is mica doing now",
    "Yo you working?",
    "Hey are you receiving this?",
    "Why doesn’t mica have access to GitHub?",
    "any update on this?",
    // GRE-1181 audit misses (3 to 9 Oct), synthetic text.
    "why did you stop",
    "Why did you stop halfway through the review?",
    "I see runs have been stopping randomly today. Can you check that it is only a one-off?",
    "the agents keep failing on setup, could you look into it",
    "is there an update?",
  ],
  unstick: [
    "continue",
    "start now",
    "Run",
    "go ahead",
    "please retry",
    "its free now",
    "it should be unlocked just check",
    "you can activate the others now",
    "you can allow the next batch&#x20;",
    "you can add some more",
    "it looks like there is some free space available so you can add more tasks cautiously",
    "my laptop was closed please reactivate all the agents. obviously pace it to keep Ram from being overloaded",
    "can you please just reactivate mica? and also I guess boot up the other agents.",
    "Hey can you please just make sure you get all the agents working? We have a lot more RAM now",
  ],
  repair: [
    "Your last run hung for about 4.5 hours inside the terminal call that made the commit. Nothing is lost; please continue.",
    "The Claude connection is fixed (your last runs failed because its token had expired, not because of your work). Please continue: run the tests.",
    "Your last wake failed while creating the worktree: git's config lock collided. Nothing was lost.",
    "Setup failed at 21:46 on a stale git lock in the shared worktree; it is gone now.",
    // GRE-1181 audit misses, synthetic text.
    "Your earlier run failed because the board account was retired. It is active again now, so please pick this up again.",
    "Your previous run stopped on a lock. Pick it up again from the last commit.",
  ],
  other: [
    "the phone UI keeps flickering please fix it",
    "why does it need to write budgets, what are they for?",
    "you can go ahead with the hire anyway",
    "you can go ahead and review and merge",
    "lets make it a public repository for now and keep building",
    "oh it looks like you are working now",
    "I like the meeting insights one",
    "Let’s work on this once we setup on the desktop",
    "stop this run",
    // GRE-1181 false chase: a feature request, synthetic text.
    "We should be able to start and restart it from the dashboard and update the card when there is an update",
    "We should be able to restart the preview from the settings page. Any update on the layout can wait.",
    "please let me know once there's an update",
    "![Screenshot.png](/api/attachments/abc/content)",
    "",
  ],
};

for (const [expected, bodies] of Object.entries(SAMPLES)) {
  for (const body of bodies) {
    test(`classify ${expected}: ${JSON.stringify(body).slice(0, 60)}`, () => {
      assert.equal(classifyJohnComment(body), expected);
    });
  }
}

const now = "2026-10-02T07:00:00.000Z";
const hoursAgo = (hours) => new Date(Date.parse(now) - hours * 3_600_000).toISOString();
const base = (fields = {}) => ({ johnUserIds: ["local-board", "john-login"], comments: [], interactions: [], approvals: [], runs: [], ...fields });
const comment = (id, body, hours, authorUserId = "local-board") => ({ id, issueIdentifier: "GRE-1", authorUserId, body, createdAt: hoursAgo(hours) });

test("window: only John's comments count, by class; repair counts under unstick", () => {
  const snapshot = base({
    comments: [
      comment("c1", "how is it going here", 1),
      comment("c2", "continue", 2, "john-login"),
      comment("c3", "Your last run hung for 3 hours. Please continue.", 3),
      comment("c4", "the phone UI keeps flickering please fix it", 4),
      comment("c5", "how is it going here", 5, "board-concierge"),
      comment("c6", "how is it going here", 30),
    ],
  });
  const day = computeWindow(snapshot, { since: Date.parse(now) - 86_400_000, now: Date.parse(now) });
  assert.equal(day.johnComments, 4);
  assert.equal(day.chase, 1);
  assert.equal(day.unstick, 2);
  assert.equal(day.repair, 1);
  assert.deepEqual(day.counted.map((entry) => entry.id), ["c1", "c2", "c3"]);
  assert.equal("body" in day.counted[0], false);
});

test("window: decisions are John's answered cards and decided approvals, not expired or agent-resolved", () => {
  const snapshot = base({
    interactions: [
      { status: "accepted", resolvedByUserId: "local-board", resolvedAt: hoursAgo(1) },
      { status: "answered", resolvedByUserId: "john-login", resolvedAt: hoursAgo(2) },
      { status: "rejected", resolvedByUserId: "local-board", resolvedAt: hoursAgo(3) },
      { status: "expired", resolvedByUserId: "local-board", resolvedAt: hoursAgo(4) },
      { status: "accepted", resolvedByUserId: null, resolvedAt: hoursAgo(5) },
      { status: "accepted", resolvedByUserId: "local-board", resolvedAt: hoursAgo(40) },
    ],
    approvals: [
      { status: "approved", decidedByUserId: "local-board", decidedAt: hoursAgo(1) },
      { status: "pending", decidedByUserId: null, decidedAt: null },
    ],
  });
  const day = computeWindow(snapshot, { since: Date.parse(now) - 86_400_000, now: Date.parse(now) });
  assert.equal(day.decisions, 4);
});

test("window: failed runs by cause; routine cancels are not failures", () => {
  const run = (status, errorCode, hours = 1) => ({ status, errorCode, finishedAt: hoursAgo(hours) });
  const snapshot = base({
    runs: [
      run("failed", "setup_failed"),
      run("failed", "setup_failed"),
      run("failed", "claude_auth_required"),
      run("timed_out", null),
      run("interrupted", "server_shutdown_interrupted"),
      run("cancelled", "run_silent_timeout"),
      run("cancelled", "cancelled"),
      run("cancelled", "issue_reassigned"),
      run("succeeded", null),
      run("failed", "setup_failed", 30),
    ],
  });
  const day = computeWindow(snapshot, { since: Date.parse(now) - 86_400_000, now: Date.parse(now) });
  assert.equal(day.failedRuns, 6);
  assert.deepEqual(day.failedByCause, { setup_failed: 2, claude_auth_required: 1, run_silent_timeout: 1, server_shutdown_interrupted: 1, timed_out: 1 });
});

test("trend: seven 24-hour windows, oldest first, today last; digest line format", () => {
  const snapshot = base({
    comments: [comment("a", "how is it going here", 1), comment("b", "continue", 25), comment("c", "why is this blocked?", 6 * 24 + 1)],
    runs: ["setup_failed", "setup_failed", "configuration_incomplete", "claude_auth_required", "process_lost"].map((errorCode) => ({ status: "failed", errorCode, finishedAt: hoursAgo(2) })),
  });
  const report = computeJohnTime(snapshot, { now });
  assert.equal(report.trend.length, 7);
  assert.deepEqual(report.trend.map((day) => day.chase), [1, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(report.trend.map((day) => day.unstick), [0, 0, 0, 0, 0, 1, 0]);
  assert.equal(
    formatDigestLine(report),
    "**John's time (24h):** Chase 1 · Unstick 0 · Decisions 0 · Cards rejected 0 · Failed runs 5 (setup_failed 2, claude_auth_required 1, configuration_incomplete 1, other 1). " +
      "Rounds per approved card (7d): - over 0. " +
      "7 days, oldest first: Chase 1,0,0,0,0,0,1 · Unstick 0,0,0,0,0,1,0 · Decisions 0,0,0,0,0,0,0 · Rejected 0,0,0,0,0,0,0 · Rounds -,-,-,-,-,-,- · Failed 0,0,0,0,0,0,5.",
  );
});

// Approval cards (GRE-453). `card` is one interaction John (or someone else)
// resolved; the issue id groups the rounds.
const card = (issueId, status, hours, { kind = "request_confirmation", resolvedByUserId = "local-board" } = {}) => ({ kind, status, issueId, resolvedByUserId, resolvedAt: hoursAgo(hours) });

test("cards rejected: John's rejected approval cards in the window, not other kinds or other resolvers", () => {
  const snapshot = base({
    interactions: [
      card("A", "rejected", 1),
      card("A", "rejected", 2, { kind: "request_checkbox_confirmation" }),
      card("B", "rejected", 3, { resolvedByUserId: "john-login" }),
      card("C", "rejected", 4, { resolvedByUserId: null }),
      card("D", "rejected", 5, { kind: "suggest_tasks" }),
      card("E", "expired", 6),
      card("F", "accepted", 7),
      card("G", "rejected", 30),
    ],
  });
  const day = computeWindow(snapshot, { since: Date.parse(now) - 86_400_000, now: Date.parse(now) });
  assert.equal(day.cardsRejected, 3);
});

test("cards rejected: GRE-449 baseline shape, 15 of 33 approval cards rejected", () => {
  const interactions = Array.from({ length: 33 }, (_, index) => card(`T${index}`, index < 15 ? "rejected" : "accepted", 1 + index * 0.5));
  const day = computeWindow(base({ interactions }), { since: Date.parse(now) - 86_400_000, now: Date.parse(now) });
  assert.equal(day.cardsRejected, 15);
  assert.equal(day.cardsApproved, 18);
});

test("rounds: 1 + rejections on the same task since its last accepted card, including before the window", () => {
  const snapshot = base({
    interactions: [
      card("A", "rejected", 40),
      card("A", "rejected", 30),
      card("A", "accepted", 10),
      card("B", "accepted", 9),
      card("C", "rejected", 50),
      card("C", "accepted", 45),
      card("C", "rejected", 8),
      card("C", "accepted", 5),
      card("D", "rejected", 3),
      card("E", "rejected", 4, { resolvedByUserId: null }),
      card("E", "accepted", 2),
    ],
  });
  const window = { since: Date.parse(now) - 86_400_000, now: Date.parse(now) };
  assert.deepEqual(approvalRounds(snapshot, window), [3, 1, 2, 1]);
  const day = computeWindow(snapshot, window);
  assert.equal(day.roundsPerApproval, 1.8);
  assert.equal(day.cardsApproved, 4);
});

test("digest line: cards rejected today and rounds per approved card over 7 days, with 7-day history", () => {
  const snapshot = base({
    interactions: [
      card("A", "rejected", 6 * 24 + 2),
      card("A", "accepted", 6 * 24 + 1),
      card("B", "rejected", 3),
      card("B", "rejected", 2),
      card("C", "accepted", 1),
    ],
  });
  const report = computeJohnTime(snapshot, { now });
  assert.deepEqual(report.trend.map((day) => day.cardsRejected), [1, 0, 0, 0, 0, 0, 2]);
  assert.deepEqual(report.week, { cardsApproved: 2, roundsPerApproval: 1.5 });
  const line = formatDigestLine(report);
  assert.match(line, /Decisions 3 · Cards rejected 2 · Failed runs 0\. Rounds per approved card \(7d\): 1\.5 over 2\./);
  assert.match(line, / · Rejected 1,0,0,0,0,0,2 · Rounds 2.0,-,-,-,-,-,1.0 · /);
});
