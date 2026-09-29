import type {
  GoalBlocker,
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

export function collectGoalBlockers(
  subtreeIds: readonly string[],
  blockedIssuesByGoal: ReadonlyMap<string, GoalBlockedIssue[]>,
  latestCheckIn: Pick<GoalCheckIn, "id" | "blockers"> | null,
): GoalBlocker[] {
  const blockers: GoalBlocker[] = [];
  for (const id of subtreeIds) {
    for (const issue of blockedIssuesByGoal.get(id) ?? []) {
      blockers.push({
        kind: "issue",
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        goalId: issue.goalId,
      });
    }
  }
  for (const text of latestCheckIn?.blockers ?? []) {
    blockers.push({ kind: "check_in", text, checkInId: latestCheckIn!.id });
  }
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
