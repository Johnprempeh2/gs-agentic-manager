import type { Issue } from "@greatstone/shared";
import type { IssuesCsvLookups } from "./issues-csv";
import { formatCalendarDay } from "./utils";

/**
 * "Copy as a list" on task lists: the tasks the list shows as plain lines,
 * ready to paste into an email or a chat.
 *
 *   • GRE-12 Send the proposal (In progress, Ridge, due 20 Oct)
 */
export function issuesToPlainList(
  issues: readonly Issue[],
  lookups: Pick<IssuesCsvLookups, "statusLabel" | "agentName" | "userLabel">,
): string {
  return issues
    .map((issue) => {
      const responsible = issue.assigneeAgentId
        ? lookups.agentName(issue.assigneeAgentId)
        : issue.assigneeUserId
          ? lookups.userLabel(issue.assigneeUserId)
          : null;
      const details = [lookups.statusLabel(issue.status), responsible, issue.dueDate ? `due ${formatCalendarDay(issue.dueDate)}` : null]
        .filter(Boolean)
        .join(", ");
      const name = issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
      return `• ${name}${details ? ` (${details})` : ""}`;
    })
    .join("\n");
}

const UPDATE_STATUS_LABELS: Record<string, string> = {
  backlog: "Not started",
  todo: "To do",
  in_progress: "In progress",
  in_review: "Waiting for review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

/**
 * "Copy as an update" on a task: a short status note to paste into an email
 * or a chat, so nobody has to open the app to know where a task stands.
 *
 *   GRE-12 Send the proposal
 *   Status: In progress
 *   Responsible: Ridge
 *   Due: 20 Oct
 *   Link: https://...
 */
export function issueToUpdate(
  issue: Pick<Issue, "identifier" | "title" | "status" | "dueDate">,
  extras: { responsible?: string | null; link?: string | null },
): string {
  const name = issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
  return [
    name,
    `Status: ${UPDATE_STATUS_LABELS[issue.status] ?? issue.status}`,
    extras.responsible ? `Responsible: ${extras.responsible}` : null,
    issue.dueDate ? `Due: ${formatCalendarDay(issue.dueDate)}` : null,
    extras.link ? `Link: ${extras.link}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
