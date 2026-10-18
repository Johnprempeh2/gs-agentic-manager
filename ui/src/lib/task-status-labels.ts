import type { IssueStatus } from "@greatstone/shared";

export const TASK_STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

/** Turns a raw value such as `in_progress` into sentence case: `In progress`. */
export function sentenceCaseLabel(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  if (!spaced) return value;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** The display label for a task status, with a sentence-case fallback for unknown values. */
export function taskStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return (TASK_STATUS_LABELS as Record<string, string>)[status] ?? sentenceCaseLabel(status);
}
