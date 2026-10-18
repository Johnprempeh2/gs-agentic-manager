/** Choices the Tasks list offers when several tasks are selected. */
export const BULK_STATUS_CHOICES = [
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "in_review", label: "In review" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const BULK_PRIORITY_CHOICES = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const;

export interface BulkIssueChange {
  data: Record<string, unknown>;
  /** Reads after "Set N tasks to", such as "Done" or "Ridge". */
  label: string;
  field: "status" | "priority" | "assignee";
}

/**
 * Turns a picked option ("status:done", "priority:high", "assignee:<agent id>")
 * into the task update it stands for. Returns null for anything else.
 */
export function parseBulkIssueChange(
  value: string,
  agents: ReadonlyArray<{ id: string; name: string }>,
): BulkIssueChange | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const kind = value.slice(0, separator);
  const choice = value.slice(separator + 1);
  if (kind === "status") {
    const match = BULK_STATUS_CHOICES.find((option) => option.value === choice);
    return match ? { data: { status: match.value }, label: match.label, field: "status" } : null;
  }
  if (kind === "priority") {
    const match = BULK_PRIORITY_CHOICES.find((option) => option.value === choice);
    return match ? { data: { priority: match.value }, label: `${match.label} priority`, field: "priority" } : null;
  }
  if (kind === "assignee") {
    const agent = agents.find((candidate) => candidate.id === choice);
    return agent ? { data: { assigneeAgentId: agent.id }, label: agent.name, field: "assignee" } : null;
  }
  return null;
}

export function taskCount(count: number): string {
  return `${count} ${count === 1 ? "task" : "tasks"}`;
}
