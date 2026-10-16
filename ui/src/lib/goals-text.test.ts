import { describe, expect, it } from "vitest";
import type { GoalWithProgress } from "@greatstone/shared";
import { goalsUpdateText } from "./goals-text";

function goal(overrides: Partial<GoalWithProgress> = {}): GoalWithProgress {
  return {
    id: "g1",
    title: "Win three new clients",
    ownerAgentId: null,
    ownerUserId: null,
    targetDate: null,
    progress: { percent: null, source: "tasks", done: 0, open: 0, blocked: 0, total: 0 },
    ...overrides,
  } as GoalWithProgress;
}

const lookups = {
  agentName: (id: string) => (id === "a1" ? "Ridge" : null),
  userName: (id: string) => (id === "u1" ? "Ben" : null),
};

describe("goalsUpdateText", () => {
  it("writes each goal with its health, progress, due date and owner, sub-goals indented", () => {
    const text = goalsUpdateText(
      [
        {
          goal: goal({
            ownerAgentId: "a1",
            targetDate: "2026-12-31",
            progress: { percent: 40, source: "tasks", done: 4, open: 6, blocked: 1, total: 10 } as GoalWithProgress["progress"],
          }),
          health: "at_risk",
          subGoals: [
            {
              goal: goal({ id: "g2", title: "Send the proposals", ownerUserId: "u1" }),
              health: "not_started",
            },
          ],
        },
      ],
      lookups,
      "2026-10-16",
    );
    expect(text).toBe(
      [
        "Goals update, 16 Oct",
        "",
        "• Win three new clients: At risk, 40%, 4 of 10 tasks done, 1 blocked, due 31 Dec, Ridge",
        "  ◦ Send the proposals: Not started, Ben",
      ].join("\n"),
    );
  });

  it("says so when no goals are open", () => {
    expect(goalsUpdateText([], lookups, "2026-10-16")).toBe("Goals update, 16 Oct\n\nNo goals are open.");
  });
});
