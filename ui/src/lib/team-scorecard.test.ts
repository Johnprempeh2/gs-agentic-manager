import { describe, expect, it } from "vitest";
import type { TeamScorecardAgent } from "@greatstone/shared";
import { scorecardSentence, workValueLabel } from "./team-scorecard";

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
