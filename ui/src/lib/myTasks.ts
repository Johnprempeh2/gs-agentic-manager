import type { AttentionItem, Issue, IssueRelationIssueSummary, IssueStatus } from "@greatstone/shared";

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

/**
 * My tasks as one list (GRE-42): the tasks the user blocks, the tasks behind
 * their open decisions, and the tasks assigned to them, each listed once with
 * every reason it is there. The first reason (in MY_TASKS_REASONS order) is
 * the group the row sits in.
 */

export const MY_TASKS_REASONS = ["blocking", "decision", "assigned"] as const;
export type MyTasksReason = (typeof MY_TASKS_REASONS)[number];

export const MY_TASKS_REASON_LABELS: Record<MyTasksReason, string> = {
  blocking: "Blocking",
  decision: "Decision",
  assigned: "Assigned",
};

export const MY_TASKS_REASON_GROUP_LABELS: Record<MyTasksReason, string> = {
  blocking: "You are blocking",
  decision: "Waiting on your decision",
  assigned: "Assigned to you",
};

type DecisionItem = Pick<AttentionItem, "id" | "subject" | "relatedIssue">;

export interface MyTasksMerge<TItem extends DecisionItem = DecisionItem> {
  issues: Issue[];
  reasonsById: Map<string, MyTasksReason[]>;
  /** Decisions with no task behind them, or whose task could not be loaded. */
  decisionsWithoutIssue: TItem[];
}

/** The task a decision is about: the subject itself, or the task it hangs off. */
export function decisionIssueId(item: DecisionItem): string | null {
  if (item.subject.kind === "issue") return item.subject.id;
  return item.relatedIssue?.kind === "issue" ? item.relatedIssue.id : null;
}

/**
 * `decisionIssues` holds the loaded task per decision issue id: an Issue when
 * loaded, `null` when loading failed. Ids missing from the map are still
 * loading; their decisions are left out until they resolve.
 */
export function mergeMyTasks<TItem extends DecisionItem>(input: {
  issues: readonly Issue[];
  decisions: readonly TItem[];
  decisionIssues: ReadonlyMap<string, Issue | null>;
  currentUserId: string | null | undefined;
}): MyTasksMerge<TItem> {
  const reasonsById = new Map<string, MyTasksReason[]>();
  const byId = new Map<string, Issue>();
  const decisionsWithoutIssue: TItem[] = [];
  const add = (issue: Issue, reason: MyTasksReason) => {
    if (!byId.has(issue.id)) byId.set(issue.id, issue);
    const reasons = reasonsById.get(issue.id) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    reasonsById.set(issue.id, reasons);
  };

  const selection = selectMyTasks(input.issues, input.currentUserId);
  for (const entry of selection.blocking) add(entry.issue, "blocking");
  for (const item of input.decisions) {
    const issueId = decisionIssueId(item);
    if (!issueId) {
      decisionsWithoutIssue.push(item);
      continue;
    }
    const issue = byId.get(issueId) ?? input.issues.find((candidate) => candidate.id === issueId)
      ?? input.decisionIssues.get(issueId);
    if (issue) add(issue, "decision");
    else if (issue === null) decisionsWithoutIssue.push(item);
  }
  for (const group of selection.assigned) {
    for (const issue of group.issues) add(issue, "assigned");
  }

  for (const reasons of reasonsById.values()) {
    reasons.sort((a, b) => MY_TASKS_REASONS.indexOf(a) - MY_TASKS_REASONS.indexOf(b));
  }
  return { issues: [...byId.values()], reasonsById, decisionsWithoutIssue };
}

/**
 * My tasks rows John can act on (GRE-619): tick to finish, hand to an agent,
 * or ask. Rows sit in three groups. The Ask state comes from comment times
 * the list already returns with a user context (touchedByUserId=me).
 */

export const MY_TASKS_GROUPS = ["needs_you", "waiting", "done_today"] as const;
export type MyTasksGroup = (typeof MY_TASKS_GROUPS)[number];

export const MY_TASKS_GROUP_LABELS: Record<MyTasksGroup, string> = {
  needs_you: "Needs you",
  waiting: "Waiting on an agent",
  done_today: "Done today",
};

export type MyTasksAskState = "waiting" | "answered";

export const MY_TASKS_ASK_STATE_LABELS: Record<MyTasksAskState, string> = {
  waiting: "Waiting for answer",
  answered: "Answer ready",
};

/** Older comments from you are history, not a question still open. */
export const MY_TASKS_ASK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

type AskStateIssue = Pick<Issue, "myLastCommentAt" | "lastExternalCommentAt" | "myLastReadAt">;

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * "waiting": your last comment is newer than anyone else's.
 * "answered": someone answered after your last comment and you have not
 * opened the task since. (isUnreadForMe cannot say this for tasks assigned
 * to you: any update, the reply included, counts as you touching it.)
 */
export function myTasksAskState(issue: AskStateIssue, now: number = Date.now()): MyTasksAskState | null {
  const mine = toTime(issue.myLastCommentAt);
  if (mine === null || now - mine > MY_TASKS_ASK_WINDOW_MS) return null;
  const theirs = toTime(issue.lastExternalCommentAt);
  if (theirs === null || mine >= theirs) return "waiting";
  const read = toTime(issue.myLastReadAt);
  return read !== null && read >= theirs ? null : "answered";
}

export function isDoneToday(issue: Pick<Issue, "status" | "completedAt">, now: Date = new Date()): boolean {
  if (issue.status !== "done") return false;
  const completed = toTime(issue.completedAt);
  if (completed === null) return false;
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return completed >= startOfDay;
}

/**
 * Blocking work, an open decision or an answer to read keep a task in Needs
 * you. A question still open, or a task handed to an agent, waits.
 */
export function myTasksGroupOf(
  issue: AskStateIssue & Pick<Issue, "status" | "assigneeAgentId">,
  reasons: readonly MyTasksReason[],
  now: number = Date.now(),
): MyTasksGroup {
  if (issue.status === "done") return "done_today";
  if (reasons.includes("blocking") || reasons.includes("decision")) return "needs_you";
  const ask = myTasksAskState(issue, now);
  if (ask === "answered") return "needs_you";
  if (ask === "waiting" || (issue.assigneeAgentId && reasons.length === 0)) return "waiting";
  return "needs_you";
}

/**
 * Open tasks you handed to an agent or asked about, from the list of tasks
 * you touched. Tasks still assigned to you are already in My tasks.
 */
export function selectHandedOffTasks(
  touched: readonly Issue[],
  currentUserId: string | null | undefined,
  now: number = Date.now(),
): Issue[] {
  if (!currentUserId) return [];
  return touched.filter(
    (issue) =>
      isOpenIssueStatus(issue.status) &&
      issue.assigneeUserId !== currentUserId &&
      Boolean(issue.assigneeAgentId) &&
      myTasksAskState(issue, now) !== null,
  );
}

/** Done tasks closed today, newest first. */
export function selectDoneToday(issues: readonly Issue[], now: Date = new Date()): Issue[] {
  return issues
    .filter((issue) => isDoneToday(issue, now))
    .sort((a, b) => (toTime(b.completedAt) ?? 0) - (toTime(a.completedAt) ?? 0));
}

type AgentChoice = { id: string; name: string; role?: string | null; status?: string | null; reportsTo?: string | null };

const NOT_ASSIGNABLE_AGENT_STATUSES = new Set(["terminated", "pending_approval", "paused"]);

/** Active agents by name, with the lead (Everest) first. */
export function handOffAgentChoices<T extends AgentChoice>(agents: readonly T[], leadAgentId: string | null): T[] {
  return agents
    .filter((agent) => !NOT_ASSIGNABLE_AGENT_STATUSES.has(agent.status ?? ""))
    .sort((a, b) => {
      if (a.id === leadAgentId) return -1;
      if (b.id === leadAgentId) return 1;
      return a.name.localeCompare(b.name);
    });
}

/** Who an Ask goes to: the assignee agent, else the agent that made the task, else the lead. */
export function askTargetAgentId(
  issue: Pick<Issue, "assigneeAgentId" | "createdByAgentId">,
  leadAgentId: string | null,
): string | null {
  return issue.assigneeAgentId ?? issue.createdByAgentId ?? leadAgentId;
}
