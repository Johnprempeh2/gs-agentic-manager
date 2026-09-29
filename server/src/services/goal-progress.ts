import type {
  GoalBlocker,
  GoalBlockerActor,
  GoalBlockerReason,
  GoalBlockerWaitingOn,
  GoalIssueBlocker,
  GoalCheckIn,
  GoalMilestone,
  GoalProgress,
} from "@greatstone/shared";

/** The goal columns the roll-up reads. */
export interface GoalProgressGoal {
  id: string;
  parentId: string | null;
  status: string;
  targetValue: number | null;
  currentValue: number | null;
  createdAt: Date;
}

/** Linked-issue counts for one goal (its own issues only). */
export interface GoalIssueCounts {
  done: number;
  open: number;
  blocked: number;
}

export interface GoalBlockedIssue {
  id: string;
  identifier: string | null;
  title: string;
  goalId: string;
  createdAt: Date;
  reason: GoalBlockerReason;
  waitingOn: GoalBlockerWaitingOn | null;
  actor: GoalBlockerActor | null;
  note: string | null;
}

/** An open task that another task is waiting on. */
export interface GoalBlockingIssue extends GoalBlockerWaitingOn {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface BlockedIssueFacts {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByUserId: string | null;
  /** Blockers that are not done yet, oldest relation first. */
  openBlockers: readonly GoalBlockingIssue[];
  /** A pending question, confirmation or approval on the task. */
  waitingOnPerson: boolean;
  lastRunStatus: string | null;
}

export interface ActorNames {
  agents: ReadonlyMap<string, string>;
  users: ReadonlyMap<string, string>;
}

const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);

function actorFor(
  agentId: string | null,
  userId: string | null,
  names: ActorNames,
): GoalBlockerActor | null {
  if (agentId) return { type: "agent", id: agentId, name: names.agents.get(agentId) ?? null };
  if (userId) return { type: "user", id: userId, name: names.users.get(userId) ?? null };
  return null;
}

/**
 * Why one blocked task cannot move and who must act next. The most specific
 * reason wins: an unfinished task it depends on, then a person's answer, then
 * no owner, then a failed run.
 */
export function explainBlockedIssue(
  facts: BlockedIssueFacts,
  names: ActorNames,
): Pick<GoalBlockedIssue, "reason" | "waitingOn" | "actor"> {
  const blocker = facts.openBlockers[0];
  if (blocker) {
    return {
      reason: "waiting_on_issue",
      waitingOn: { issueId: blocker.issueId, identifier: blocker.identifier, title: blocker.title, status: blocker.status },
      actor: actorFor(blocker.assigneeAgentId, blocker.assigneeUserId, names),
    };
  }
  if (facts.waitingOnPerson || (facts.assigneeUserId && !facts.assigneeAgentId)) {
    return {
      reason: "waiting_on_person",
      waitingOn: null,
      actor: actorFor(null, facts.assigneeUserId ?? facts.createdByUserId, names),
    };
  }
  const actor = actorFor(facts.assigneeAgentId, facts.assigneeUserId, names);
  if (!actor) return { reason: "no_owner", waitingOn: null, actor: null };
  if (facts.lastRunStatus && FAILED_RUN_STATUSES.has(facts.lastRunStatus)) {
    return { reason: "failed_run", waitingOn: null, actor };
  }
  return { reason: "unknown", waitingOn: null, actor };
}

const EMPTY_COUNTS: GoalIssueCounts = { done: 0, open: 0, blocked: 0 };

/** Adds one issue to a per-goal count bucket. Cancelled issues are left out. */
export function addIssueToCounts(counts: GoalIssueCounts, status: string, n = 1): GoalIssueCounts {
  if (status === "cancelled") return counts;
  if (status === "done") return { ...counts, done: counts.done + n };
  if (status === "blocked") return { ...counts, blocked: counts.blocked + n };
  return { ...counts, open: counts.open + n };
}

/**
 * The goal plus every non-cancelled descendant. A cancelled sub-goal drops its
 * whole branch from the roll-up. The visited set guards against a parent cycle
 * in old data so a bad row cannot hang the request.
 */
export function goalSubtreeIds(rootId: string, goals: readonly GoalProgressGoal[]): string[] {
  const children = new Map<string, GoalProgressGoal[]>();
  for (const goal of goals) {
    if (!goal.parentId) continue;
    const list = children.get(goal.parentId) ?? [];
    list.push(goal);
    children.set(goal.parentId, list);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of children.get(id) ?? []) {
      if (child.status !== "cancelled") stack.push(child.id);
    }
  }
  return out;
}

export function computeGoalProgress(
  goal: Pick<GoalProgressGoal, "targetValue" | "currentValue">,
  subtreeIds: readonly string[],
  countsByGoal: ReadonlyMap<string, GoalIssueCounts>,
): GoalProgress {
  let counts = EMPTY_COUNTS;
  for (const id of subtreeIds) {
    const c = countsByGoal.get(id);
    if (!c) continue;
    counts = { done: counts.done + c.done, open: counts.open + c.open, blocked: counts.blocked + c.blocked };
  }
  const total = counts.done + counts.open + counts.blocked;

  if (goal.targetValue != null && goal.targetValue > 0) {
    const ratio = (goal.currentValue ?? 0) / goal.targetValue;
    return { ...counts, total, source: "number", percent: clampPercent(ratio * 100) };
  }
  if (total > 0) {
    return { ...counts, total, source: "issues", percent: clampPercent((counts.done / total) * 100) };
  }
  return { ...counts, total, source: "none", percent: null };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** An open goal-linked task that waits on another task. */
export interface GoalDependent {
  id: string;
  goalId: string;
}

/**
 * How many open tasks in the goal tree wait on this task, directly or through
 * a chain. `dependents` maps a task to the open tasks it blocks.
 */
export function countHeldUpTasks(
  issueId: string,
  dependents: ReadonlyMap<string, readonly GoalDependent[]>,
  goalIds: ReadonlySet<string>,
): number {
  const seen = new Set<string>([issueId]);
  const stack = [issueId];
  let count = 0;
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const next of dependents.get(id) ?? []) {
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      if (goalIds.has(next.goalId)) count += 1;
      stack.push(next.id);
    }
  }
  return count;
}

/**
 * Ranked goal blockers; the first one is the main blocker. Check-in blockers
 * come first because a person wrote them on purpose. Blocked tasks follow:
 * the one holding up the most other goal tasks, then the oldest.
 */
export function collectGoalBlockers(
  subtreeIds: readonly string[],
  blockedIssuesByGoal: ReadonlyMap<string, GoalBlockedIssue[]>,
  latestCheckIn: Pick<GoalCheckIn, "id" | "blockers"> | null,
  dependents: ReadonlyMap<string, readonly GoalDependent[]> = new Map(),
): GoalBlocker[] {
  const goalIds = new Set(subtreeIds);
  const issues: Array<{ blocker: GoalIssueBlocker; createdAt: Date }> = [];
  for (const id of subtreeIds) {
    for (const issue of blockedIssuesByGoal.get(id) ?? []) {
      issues.push({
        createdAt: issue.createdAt,
        blocker: {
          kind: "issue",
          issueId: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          goalId: issue.goalId,
          reason: issue.reason,
          waitingOn: issue.waitingOn,
          actor: issue.actor,
          note: issue.note,
          holdsUpCount: countHeldUpTasks(issue.id, dependents, goalIds),
        },
      });
    }
  }
  issues.sort(
    (a, b) =>
      b.blocker.holdsUpCount - a.blocker.holdsUpCount
      || a.createdAt.getTime() - b.createdAt.getTime()
      || a.blocker.issueId.localeCompare(b.blocker.issueId),
  );

  const blockers: GoalBlocker[] = [];
  for (const text of latestCheckIn?.blockers ?? []) {
    if (text.trim()) blockers.push({ kind: "check_in", text, checkInId: latestCheckIn!.id });
  }
  blockers.push(...issues.map((row) => row.blocker));
  return blockers;
}

/** Journey order: finished work first, then work in flight, then work not started. */
const MILESTONE_STATUS_RANK: Record<string, number> = {
  done: 0,
  in_review: 1,
  in_progress: 2,
  blocked: 3,
  todo: 4,
  backlog: 5,
};

export function sortMilestones<T extends Pick<GoalMilestone, "status" | "createdAt" | "id">>(
  rows: readonly T[],
): T[] {
  return rows
    .filter((row) => row.status !== "cancelled")
    .slice()
    .sort(
      (a, b) =>
        (MILESTONE_STATUS_RANK[a.status] ?? 99) - (MILESTONE_STATUS_RANK[b.status] ?? 99)
        || a.createdAt.getTime() - b.createdAt.getTime()
        || a.id.localeCompare(b.id),
    );
}

const GOAL_STATUS_RANK: Record<string, number> = {
  achieved: 0,
  active: 1,
  planned: 2,
  cancelled: 3,
};

export function sortSubGoals<T extends Pick<GoalProgressGoal, "status" | "createdAt" | "id">>(
  rows: readonly T[],
): T[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        (GOAL_STATUS_RANK[a.status] ?? 99) - (GOAL_STATUS_RANK[b.status] ?? 99)
        || a.createdAt.getTime() - b.createdAt.getTime()
        || a.id.localeCompare(b.id),
    );
}
