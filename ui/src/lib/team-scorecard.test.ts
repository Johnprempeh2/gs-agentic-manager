import { describe, expect, it } from "vitest";
import type { TeamScorecardAgent } from "@greatstone/shared";
import { scorecardSentence, scorecardUpdateText, workValueLabel } from "./team-scorecard";

function agent(overrides: Partial<TeamScorecardAgent>): TeamScorecardAgent {
  return {
    agentId: "a1",
    name: "Everest",
    title: null,
    status: "idle",
    finished: 0,
    underWay: 0,
    inReview: 0,
    stuck: 0,
    overdue: 0,
    recentlyFinished: [],
    stuckTasks: [],
    ...overrides,
  };
}

describe("team scorecard wording", () => {
  it("says what an agent did in plain words", () => {
    expect(scorecardSentence(agent({ finished: 5, underWay: 2, inReview: 1, stuck: 1 }), 7)).toBe(
      "Finished 5 tasks this week. 2 under way, 1 waiting for review. 1 task is stuck.",
    );
    expect(scorecardSentence(agent({ finished: 1, overdue: 2 }), 30)).toBe(
      "Finished 1 task in the last 30 days. 2 tasks are past the due date.",
    );
    expect(scorecardSentence(agent({}), 7)).toBe("Finished nothing this week. Nothing assigned right now.");
  });

  it("shows work value in whole dollars", () => {
    expect(workValueLabel(4321)).toBe("$43");
  });
});

describe("scorecardUpdateText", () => {
  it("writes a plain update to paste into an email", () => {
    const text = scorecardUpdateText(
      {
        since: "2026-10-09T00:00:00.000Z",
        days: 7,
        totals: { finished: 3, underWay: 1, inReview: 0, stuck: 1, overdue: 0 },
        agents: [
          agent({
            name: "Ridge",
            title: "Engineer",
            finished: 2,
            stuck: 1,
            recentlyFinished: [
              { id: "t1", identifier: "GRE-5", title: "Booking page" },
              { id: "t2", identifier: null, title: "Copy refresh" },
            ],
            stuckTasks: [{ id: "t3", identifier: "GRE-8", title: "Pipedrive import" }],
          }),
          agent({ name: "Everest", finished: 1, underWay: 1 }),
        ],
      },
      "Greatstone",
    );
    expect(text).toBe(
      [
        "Greatstone team update for the last 7 days",
        "",
        "Finished 3 tasks. 1 under way, 1 stuck.",
        "",
        "Ridge (Engineer): Finished 2 tasks this week. 1 task is stuck.",
        "  - Finished: GRE-5 Booking page",
        "  - Finished: Copy refresh",
        "  - Stuck: GRE-8 Pipedrive import",
        "",
        "Everest: Finished 1 task this week. 1 under way.",
      ].join("\n"),
    );
  });
});
