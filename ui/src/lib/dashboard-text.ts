import type { DashboardSummary } from "@greatstone/shared";
import { formatCents, formatShortDate } from "./utils";

/**
 * "Copy the numbers" on the Dashboard: the four headline cards as plain
 * lines, ready to paste into a message.
 *
 *   Dashboard, 16 Oct
 *   • Agents: 5 on (2 running, 1 paused, 0 with errors)
 *   • Tasks: 3 in progress, 10 open, 1 blocked
 *   • Spend this month: $120.00, 40% of $300.00 budget
 *   • Approvals waiting: 2
 */
export function dashboardNumbersText(data: DashboardSummary, now: Date = new Date()): string {
  const { agents, tasks, costs } = data;
  const enabled = agents.active + agents.running + agents.paused + agents.error;
  const budget =
    costs.monthBudgetCents > 0
      ? `, ${costs.monthUtilizationPercent}% of ${formatCents(costs.monthBudgetCents)} budget`
      : ", no budget limit";
  const approvals = data.pendingApprovals + data.budgets.pendingApprovals;
  return [
    `Dashboard, ${formatShortDate(now)}`,
    `• Agents: ${enabled} on (${agents.running} running, ${agents.paused} paused, ${agents.error} with errors)`,
    `• Tasks: ${tasks.inProgress} in progress, ${tasks.open} open, ${tasks.blocked} blocked${tasks.overdue ? `, ${tasks.overdue} overdue` : ""}`,
    `• Spend this month: ${formatCents(costs.monthSpendCents)}${budget}`,
    `• Approvals waiting: ${approvals}`,
  ].join("\n");
}
