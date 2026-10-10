// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { StrategyBoardGoal } from "@greatstone/shared";
import { dueDateRowState, isPastDue } from "./IssueDueDateRow";

function goal(values: Partial<StrategyBoardGoal> & Pick<StrategyBoardGoal, "id">): StrategyBoardGoal {
  return {
    parentId: null,
    kind: null,
    status: "active",
    title: values.id,
    unit: null,
    targetValue: null,
    targetDate: null,
    ownerUserId: null,
    ownerAgentId: null,
    ...values,
  };
}

const GOALS = [
  goal({ id: "company" }),
  goal({ id: "csf", kind: "csf" }),
  goal({ id: "objective", kind: "objective", parentId: "csf" }),
  goal({ id: "initiative", kind: "initiative", parentId: "objective" }),
];

describe("due date row (GRE-1188)", () => {
  it("is editable on a task under a plan objective", () => {
    expect(dueDateRowState("objective", null, GOALS)).toBe("editable");
    expect(dueDateRowState("initiative", "2026-10-31", GOALS)).toBe("editable");
  });

  it("is hidden on a task not on the plan, and read-only if it still has a date", () => {
    expect(dueDateRowState("company", null, GOALS)).toBe("hidden");
    expect(dueDateRowState("csf", null, GOALS)).toBe("hidden");
    expect(dueDateRowState(null, null, GOALS)).toBe("hidden");
    expect(dueDateRowState("objective", null, undefined)).toBe("hidden");
    expect(dueDateRowState("company", "2026-10-31", GOALS)).toBe("read_only");
  });

  it("knows a past due date by the local calendar day", () => {
    const today = new Date(2026, 9, 10, 9, 0);
    expect(isPastDue("2026-10-09", today)).toBe(true);
    expect(isPastDue("2026-10-10", today)).toBe(false);
    expect(isPastDue("2026-11-01", today)).toBe(false);
  });
});
