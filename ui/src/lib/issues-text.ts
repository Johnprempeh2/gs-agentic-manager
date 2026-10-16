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
