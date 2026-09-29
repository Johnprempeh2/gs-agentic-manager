import { describe, expect, it } from "vitest";
import type { GoalIssueBlocker, GoalMilestone } from "@greatstone/shared";
import {
  blockerSentence,
  buildJourney,
  buildScoreboard,
  goalHealth,
  leadAgentId,
  mainBlockerSummary,
  plainText,
  remainingLabel,
  shortTitle,
} from "./goal-journey";
import { makeGoal } from "./goal-journey.fixtures";

const NOW = new Date(2026, 8, 29, 12);

function milestone(id: string, status: GoalMilestone["status"]): GoalMilestone {
  return {
    id,
    identifier: `GRE-${id}`,
    title: `Task ${id}`,
    status,
    goalId: "g1",
    assigneeAgentId: null,
    createdAt: new Date(2026, 8, 1),
    completedAt: status === "done" ? new Date(2026, 8, 2) : null,
  };
}

describe("goalHealth", () => {
  it("is done when achieved or at 100%", () => {
    expect(goalHealth(makeGoal({ status: "achieved" }), NOW)).toBe("done");
    expect(goalHealth(makeGoal({ progress: { percent: 100, source: "issues", done: 4, open: 0, blocked: 0, total: 4 } }), NOW)).toBe("done");
  });

  it("is blocked when everything left is blocked", () => {
    const goal = makeGoal({ progress: { percent: 50, source: "issues", done: 2, open: 0, blocked: 2, total: 4 } });
    expect(goalHealth(goal, NOW)).toBe("blocked");
  });

  it("is at risk when past the target date, when it has a blocker, or when far behind schedule", () => {
    expect(goalHealth(makeGoal({ targetDate: "2026-09-20" }), NOW)).toBe("at_risk");
    expect(
      goalHealth(makeGoal({ blockers: [{ kind: "check_in", text: "Waiting on keys", checkInId: "x" }] }), NOW),
    ).toBe("at_risk");
    // 28 of 30 days gone, only 10% done.
    const behind = makeGoal({
      targetDate: "2026-10-01",
      progress: { percent: 10, source: "issues", done: 1, open: 9, blocked: 0, total: 10 },
    });
    expect(goalHealth(behind, NOW)).toBe("at_risk");
  });

  it("is on track otherwise, and not started for a planned goal with no progress", () => {
    expect(goalHealth(makeGoal({ targetDate: "2026-12-31" }), NOW)).toBe("on_track");
    expect(
      goalHealth(makeGoal({ status: "planned", progress: { percent: 0, source: "issues", done: 0, open: 3, blocked: 0, total: 3 } }), NOW),
    ).toBe("not_started");
  });
});

describe("remainingLabel", () => {
  it("counts tasks or number units left", () => {
    expect(remainingLabel(makeGoal())).toBe("2 of 4 tasks left");
    expect(
      remainingLabel(makeGoal({ targetValue: 10, currentValue: 4, unit: "clients", progress: { percent: 40, source: "number", done: 0, open: 0, blocked: 0, total: 0 } })),
    ).toBe("6 clients left");
    expect(remainingLabel(makeGoal({ progress: { percent: null, source: "none", done: 0, open: 0, blocked: 0, total: 0 } }))).toBeNull();
  });
});

describe("buildScoreboard", () => {
  it("puts top-level goals first, worst health first, with sub-goals nested and cancelled goals hidden", () => {
    const entries = buildScoreboard(
      [
        makeGoal({ id: "a", title: "Fine", targetDate: "2026-12-31" }),
        makeGoal({ id: "b", title: "Late", targetDate: "2026-09-01" }),
        makeGoal({ id: "a1", parentId: "a", title: "Child" }),
        makeGoal({ id: "a1x", parentId: "a1", title: "Grandchild" }),
        makeGoal({ id: "c", status: "cancelled" }),
        makeGoal({ id: "d", status: "achieved" }),
      ],
      { now: NOW },
    );
    expect(entries.map((entry) => entry.goal.id)).toEqual(["b", "a"]);
    expect(entries[1].subGoals.map((sub) => sub.goal.id)).toEqual(["a1", "a1x"]);
  });

  it("shows achieved goals on request and promotes orphans to top level", () => {
    const entries = buildScoreboard(
      [makeGoal({ id: "d", status: "achieved" }), makeGoal({ id: "o", parentId: "gone" })],
      { includeAchieved: true, now: NOW },
    );
    expect(entries.map((entry) => entry.goal.id).sort()).toEqual(["d", "o"]);
  });
});

describe("buildJourney", () => {
  it("marks the first task in flight as 'we are here'", () => {
    const journey = buildJourney([
      milestone("1", "done"),
      milestone("2", "in_progress"),
      milestone("3", "blocked"),
      milestone("4", "todo"),
    ]);
    expect(journey.stops.map((stop) => stop.kind)).toEqual(["done", "here", "blocked", "ahead"]);
    expect(journey.reachedIndex).toBe(1);
  });

  it("reaches the last done stop when nothing is in flight, and -1 when nothing is done", () => {
    expect(buildJourney([milestone("1", "done"), milestone("2", "todo")]).reachedIndex).toBe(0);
    expect(buildJourney([milestone("1", "todo")]).reachedIndex).toBe(-1);
    expect(buildJourney([]).stops).toEqual([]);
  });

  it("folds long journeys so the map stays readable", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => milestone(`d${i}`, "done")),
      milestone("here", "in_progress"),
      ...Array.from({ length: 8 }, (_, i) => milestone(`t${i}`, "todo")),
      milestone("x", "cancelled"),
    ];
    const { stops } = buildJourney(rows, 9);
    expect(stops).toHaveLength(9);
    expect(stops[0]).toMatchObject({ key: "done-group", kind: "done", count: 4, label: "4 done" });
    expect(stops[3].kind).toBe("here");
    expect(stops.at(-1)).toMatchObject({ key: "ahead-group", kind: "ahead", label: "+4 more" });
  });
});

describe("leadAgentId", () => {
  it("picks the oldest live agent that reports to no one", () => {
    const agent = (id: string, created: number, extra: object = {}) =>
      ({ id, status: "idle", reportsTo: null, createdAt: new Date(created), ...extra }) as never;
    expect(
      leadAgentId([
        agent("young", 3),
        agent("old-gone", 1, { status: "terminated" }),
        agent("report", 0, { reportsTo: "young" }),
        agent("lead", 2),
      ]),
    ).toBe("lead");
    expect(leadAgentId([])).toBeNull();
  });
});

function issueBlocker(overrides: Partial<GoalIssueBlocker> = {}): GoalIssueBlocker {
  return {
    kind: "issue",
    issueId: "i1",
    identifier: "GRE-131",
    title: "Client install",
    goalId: "g1",
    reason: "unknown",
    waitingOn: null,
    actor: null,
    note: null,
    holdsUpCount: 0,
    ...overrides,
  };
}

const ridge = { type: "agent", id: "a1", name: "Ridge" } as const;

describe("main blocker sentence", () => {
  const NO_CODE = /`|<|>|\.sh\b|\.ts\b|GRE-\d+/;

  it("strips code, file names, tags and ticket numbers into plain words", () => {
    expect(plainText("client-instance.sh: upgrade <stable tag> and a tested restore (GRE-130)")).toBe(
      "Upgrade stable tag and a tested restore",
    );
    expect(plainText("Fix `server/src/services/goals.ts` so **cards** load <br/> see [docs](https://x.y/z)")).toBe(
      "Fix so cards load see docs",
    );
    expect(plainText("Keep and/or wording")).toBe("Keep and/or wording");
    expect(plainText('Ship <a tested build> <span class="x">now</span>')).toBe("Ship a tested build now");
  });

  it("names the stuck work, the task it waits on and who must finish it", () => {
    const sentence = blockerSentence(
      issueBlocker({
        title: "client-instance.sh: upgrade <stable tag> and a tested restore",
        reason: "waiting_on_issue",
        waitingOn: { issueId: "r", identifier: "GRE-130", title: "`restore.sh` restore test", status: "in_progress" },
        actor: ridge,
      }),
    );
    expect(sentence).toBe(
      'Upgrade stable tag and a tested restore waits for Ridge to finish "Restore test".',
    );
    expect(sentence).not.toMatch(NO_CODE);
  });

  it("covers each reason in one plain sentence", () => {
    expect(blockerSentence(issueBlocker({ reason: "waiting_on_person", actor: { type: "user", id: "u", name: "John" } })))
      .toBe("Client install waits for John to answer or approve.");
    expect(blockerSentence(issueBlocker({ reason: "waiting_on_person" }))).toBe(
      "Client install waits for the board to answer or approve.",
    );
    expect(blockerSentence(issueBlocker({ reason: "no_owner" }))).toBe(
      "Client install is blocked and nobody owns it; it needs an owner.",
    );
    expect(blockerSentence(issueBlocker({ reason: "failed_run", actor: ridge }))).toBe(
      "Client install stopped after a failed run; Ridge must retry or fix it.",
    );
    expect(blockerSentence(issueBlocker({ reason: "waiting_on_issue", waitingOn: null }))).toBe(
      "Client install waits for another task, which nobody owns yet.",
    );
  });

  it("falls back to the first sentence of the blocking comment", () => {
    const sentence = blockerSentence(
      issueBlocker({ actor: ridge, note: "Blocked: need the `deploy.sh` key from John (GRE-9). Details below." }),
    );
    expect(sentence).toBe("Client install is blocked: Need the key from John. Ridge must act next.");
    expect(sentence).not.toMatch(NO_CODE);
    expect(blockerSentence(issueBlocker())).toBe("Client install is blocked; its owner must say why and clear it.");
  });

  it("shows a check-in blocker as written, in plain words", () => {
    expect(blockerSentence({ kind: "check_in", text: "Waiting for the client to sign", checkInId: "k" })).toBe(
      "Waiting for the client to sign.",
    );
  });

  it("keeps long titles short", () => {
    const title = shortTitle("A very long task title that goes on and on about many things well past the card width");
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("mainBlockerSummary", () => {
  it("uses the first ranked blocker and counts the rest", () => {
    const checkIn = { kind: "check_in", text: "Need budget", checkInId: "k" } as const;
    const summary = mainBlockerSummary(makeGoal({ blockers: [checkIn, issueBlocker(), issueBlocker()] }), "at_risk");
    expect(summary).toEqual({ kind: "blocker", blocker: checkIn, sentence: "Need budget.", moreCount: 2 });
  });

  it("says there is no blocker when the goal is at risk only because tasks are open", () => {
    const goal = makeGoal({ progress: { percent: 13, source: "issues", done: 1, open: 7, blocked: 0, total: 8 } });
    expect(mainBlockerSummary(goal, "at_risk")).toEqual({ kind: "open", sentence: "No blocker. 7 of 8 tasks still open." });
    expect(mainBlockerSummary(goal, "on_track")).toBeNull();
  });
});
