import type { IssueUnblockDescriptor } from "@greatstone/shared";

/**
 * GRE-500: a task that waits on John or the board gets a 24h limit. After
 * that it shows in the one "needs me" list with its age, and its assignee is
 * woken once to re-check that the block is still true.
 *
 * One wait is one blocked cycle: `blockedTransitionAt` marks its start and is
 * reset on every new transition into `blocked`. `blockedOwnerNotifiedAt` is
 * the one owner-side notification for that cycle: the agent owner at the
 * transition (routable-blocked), or this re-check wake when a human owns the
 * wait. Both reset together, so a new wait gets a new re-check.
 */
export const HUMAN_WAIT_RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
export const HUMAN_WAIT_RECHECK_WAKE_REASON = "human_wait_recheck";

export type HumanWaitIssue = {
  id: string;
  status: string;
  assigneeAgentId?: string | null;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

export function isHumanUnblockOwner(descriptor: IssueUnblockDescriptor | null | undefined) {
  const owner = descriptor?.owner;
  return owner === "board" || Boolean(owner && typeof owner === "object" && "userId" in owner);
}

/** True when the wait belongs to this user: the board, or this user by id. */
export function isHumanWaitOwnedBy(descriptor: IssueUnblockDescriptor | null | undefined, userId: string) {
  const owner = descriptor?.owner;
  if (owner === "board") return true;
  return Boolean(owner && typeof owner === "object" && "userId" in owner && owner.userId === userId);
}

export function humanWaitAgeMs(issue: HumanWaitIssue, now: Date): number | null {
  if (issue.status !== "blocked" || !isHumanUnblockOwner(issue.unblockDescriptor)) return null;
  if (!issue.blockedTransitionAt) return null;
  return Math.max(0, now.getTime() - issue.blockedTransitionAt.getTime());
}

export function isOverdueHumanWait(issue: HumanWaitIssue, now: Date) {
  const age = humanWaitAgeMs(issue, now);
  return age !== null && age >= HUMAN_WAIT_RECHECK_AFTER_MS;
}

export function needsHumanWaitRecheckWake(issue: HumanWaitIssue, now: Date) {
  return Boolean(issue.assigneeAgentId) && !issue.blockedOwnerNotifiedAt && isOverdueHumanWait(issue, now);
}

export function humanWaitRecheckCutoff(now: Date) {
  return new Date(now.getTime() - HUMAN_WAIT_RECHECK_AFTER_MS);
}

export function buildHumanWaitRecheckIdempotencyKey(issueId: string, blockedTransitionAt: Date) {
  return `${HUMAN_WAIT_RECHECK_WAKE_REASON}:${issueId}:${blockedTransitionAt.toISOString()}`;
}
