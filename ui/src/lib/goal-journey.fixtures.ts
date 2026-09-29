import type { GoalWithProgress } from "@greatstone/shared";

/** Test fixture: an active goal, half done by linked tasks. */
export function makeGoal(overrides: Partial<GoalWithProgress> = {}): GoalWithProgress {
  return {
    id: "g1",
    companyId: "c1",
    title: "Goal",
    description: null,
    level: "company",
    status: "active",
    parentId: null,
    ownerAgentId: null,
    targetDate: null,
    doneWhen: null,
    targetValue: null,
    currentValue: null,
    unit: null,
    createdAt: new Date(2026, 8, 1),
    updatedAt: new Date(2026, 8, 1),
    progress: { percent: 50, source: "issues", done: 2, open: 2, blocked: 0, total: 4 },
    blockers: [],
    latestCheckIn: null,
    ...overrides,
  };
}
