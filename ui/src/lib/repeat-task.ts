import type { Issue } from "@greatstone/shared";
import type { NewIssueDefaults } from "../context/DialogContext";

/**
 * Defaults for "Do this again": a new task with the same brief, owner, project
 * and goal as an earlier one. Status, dates, parent and work history start fresh.
 */
export function repeatTaskDefaults(
  issue: Pick<
    Issue,
    "title" | "description" | "priority" | "projectId" | "goalId" | "assigneeAgentId" | "assigneeUserId"
  >,
): NewIssueDefaults {
  const defaults: NewIssueDefaults = { title: issue.title };
  if (issue.description) defaults.description = issue.description;
  if (issue.priority) defaults.priority = issue.priority;
  if (issue.projectId) defaults.projectId = issue.projectId;
  if (issue.goalId) defaults.goalId = issue.goalId;
  if (issue.assigneeAgentId) defaults.assigneeAgentId = issue.assigneeAgentId;
  else if (issue.assigneeUserId) defaults.assigneeUserId = issue.assigneeUserId;
  return defaults;
}
