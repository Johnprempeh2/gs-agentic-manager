import { describe, expect, it } from "vitest";
import type { DashboardSummary } from "@greatstone/shared";
import { formatCents } from "./utils";
import { dashboardNumbersText } from "./dashboard-text";

const summary: DashboardSummary = {
  companyId: "c",
  agents: { active: 2, running: 2, paused: 1, error: 0 },
  tasks: { open: 10, inProgress: 3, blocked: 1, done: 4 },
  costs: { monthSpendCents: 12000, monthBudgetCents: 30000, monthUtilizationPercent: 40 },
  pendingApprovals: 1,
  budgets: { activeIncidents: 0, pendingApprovals: 1, pausedAgents: 0, pausedProjects: 0 },
  runActivity: [],
};

describe("dashboardNumbersText", () => {
  it("lists the four headline numbers", () => {
    expect(dashboardNumbersText(summary, new Date(2026, 9, 16))).toBe(
      [
        "Dashboard, 16 Oct",
        "• Agents: 5 on (2 running, 1 paused, 0 with errors)",
        "• Tasks: 3 in progress, 10 open, 1 blocked",
        `• Spend this month: ${formatCents(12000)}, 40% of ${formatCents(30000)} budget`,
        "• Approvals waiting: 2",
      ].join("\n"),
    );
  });

  it("adds overdue tasks only when there are some", () => {
    expect(dashboardNumbersText({ ...summary, tasks: { ...summary.tasks, overdue: 2 } })).toContain("1 blocked, 2 overdue");
    expect(dashboardNumbersText({ ...summary, tasks: { ...summary.tasks, overdue: 0 } })).not.toContain("overdue");
  });

  it("says when there is no budget limit", () => {
    const text = dashboardNumbersText({ ...summary, costs: { ...summary.costs, monthBudgetCents: 0 } });
    expect(text).toContain("no budget limit");
  });
});
