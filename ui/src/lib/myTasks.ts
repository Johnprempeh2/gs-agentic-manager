import type { Issue, IssueRelationIssueSummary, IssueStatus } from "@greatstone/shared";

/**
 * My tasks (GRE-29): split the signed-in user's assigned issues into
 * "You are blocking" (other open work waits on it, or a review/approval stage
 * is waiting on this user) and "Assigned to you" grouped by status. Closed
 * issues are dropped everywhere.
 */

export const MY_TASKS_OPEN_STATUSES = ["in_progress", "in_review", "todo", "blocked", "backlog"] as const;
export type MyTasksOpenStatus = (typeof MY_TASKS_OPEN_STATUSES)[number];

export const MY_TASKS_STATUS_LABELS: Record<MyTasksOpenStatus, string> = {
  in_progress: "In progress",
  in_review: "In review",
  todo: "Todo",
  blocked: "Blocked",
  backlog: "Backlog",
};

const CLOSED_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);

export interface MyTasksBlockingEntry {
  issue: Issue;
  /** Open issues that list this one in their blockedBy. */
  blockedIssues: IssueRelationIssueSummary[];
  /** The issue's current review/approval stage is waiting on this user. */
  waitingOnReview: boolean;
}

export interface MyTasksStatusGroup {
  status: MyTasksOpenStatus;
  issues: Issue[];
}

export interface MyTasksSelection {
  blocking: MyTasksBlockingEntry[];
  assigned: MyTasksStatusGroup[];
}

export function isOpenIssueStatus(status: IssueStatus | string | null | undefined): boolean {
  return Boolean(status) && !CLOSED_STATUSES.has(status as IssueStatus);
}

export function isWaitingOnUserReview(issue: Pick<Issue, "status" | "executionState">, userId: string): boolean {
  if (!isOpenIssueStatus(issue.status)) return false;
  const state = issue.executionState;
  if (!state || state.status !== "pending") return false;
  const participant = state.currentParticipant;
  return participant?.type === "user" && participant.userId === userId;
}

export function selectMyTasks(issues: readonly Issue[], currentUserId: string | null | undefined): MyTasksSelection {
  const blocking: MyTasksBlockingEntry[] = [];
  const byStatus = new Map<MyTasksOpenStatus, Issue[]>();
  if (!currentUserId) return { blocking, assigned: [] };

  const seen = new Set<string>();
  for (const issue of issues) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    if (!isOpenIssueStatus(issue.status)) continue;

    const waitingOnReview = isWaitingOnUserReview(issue, currentUserId);
    if (issue.assigneeUserId !== currentUserId && !waitingOnReview) continue;

    const blockedIssues = (issue.blocks ?? []).filter(
      (blocked) => blocked.id !== issue.id && isOpenIssueStatus(blocked.status),
    );
    if (blockedIssues.length > 0 || waitingOnReview) {
      blocking.push({ issue, blockedIssues, waitingOnReview });
      continue;
    }

    const status = MY_TASKS_OPEN_STATUSES.find((candidate) => candidate === issue.status);
    if (!status) continue;
    const bucket = byStatus.get(status) ?? [];
    bucket.push(issue);
    byStatus.set(status, bucket);
  }

  // Most-blocking first; ties keep the server's order (most recently updated).
  const order = new Map(blocking.map((entry, index) => [entry.issue.id, index]));
  blocking.sort(
    (a, b) =>
      b.blockedIssues.length - a.blockedIssues.length ||
      order.get(a.issue.id)! - order.get(b.issue.id)!,
  );

  const assigned = MY_TASKS_OPEN_STATUSES.flatMap((status) => {
    const bucket = byStatus.get(status);
    return bucket && bucket.length > 0 ? [{ status, issues: bucket }] : [];
  });
  return { blocking, assigned };
}
