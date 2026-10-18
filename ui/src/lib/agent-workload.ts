import type { Issue } from "@greatstone/shared";
import { isPastDue } from "../components/issue-properties/IssueDueDateRow";

const WORKLOAD_ORDER = [
  ["in_progress", "in progress"],
  ["in_review", "in review"],
  ["todo", "to do"],
  ["blocked", "blocked"],
  ["backlog", "in backlog"],
] as const;

/**
 * One line for the agent page: the agent's own open tasks by status, plus how
 * many are overdue, e.g. "2 in progress, 3 to do, 1 blocked (1 overdue)".
 * Null when the agent holds no open tasks.
 */
export function agentWorkloadLine(
  issues: Pick<Issue, "assigneeAgentId" | "status" | "dueDate">[],
  agentId: string,
  today: Date = new Date(),
): string | null {
  const own = issues.filter((issue) => issue.assigneeAgentId === agentId);
  const parts = WORKLOAD_ORDER.flatMap(([status, label]) => {
    const count = own.filter((issue) => issue.status === status).length;
    return count > 0 ? [`${count} ${label}`] : [];
  });
  if (parts.length === 0) return null;
  const overdue = own.filter(
    (issue) => issue.status !== "done" && issue.status !== "cancelled" && issue.dueDate && isPastDue(issue.dueDate, today),
  ).length;
  return `${parts.join(", ")}${overdue > 0 ? ` (${overdue} overdue)` : ""}`;
}
