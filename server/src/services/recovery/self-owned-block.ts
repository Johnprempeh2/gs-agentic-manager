import type { IssueUnblockDescriptor } from "@greatstone/shared";

/**
 * GRE-6360: a blocked task whose unblock descriptor names its own assignee
 * wakes no one but the agent that just parked it. GRE-6132 sat 40 hours that
 * way. Such a block is live only with a path that will move it later.
 */
export function isSelfOwnedUnblock(
  descriptor: IssueUnblockDescriptor | null | undefined,
  assigneeAgentId: string | null | undefined,
) {
  if (!descriptor || !assigneeAgentId) return false;
  const owner = descriptor.owner;
  return owner !== "board" && "agentId" in owner && owner.agentId === assigneeAgentId;
}

/**
 * A path in the descriptor or a monitor that will wake the task later: the card
 * it waits on, a waiting date whose wake has not fired yet, or a monitor still
 * due. Blockers, other cards and approvals are checked by the caller.
 */
export function hasDeferredUnblockWake(
  descriptor: IssueUnblockDescriptor | null | undefined,
  monitorNextCheckAt: Date | string | null | undefined,
  now: Date,
) {
  if (descriptor?.interactionId) return true;
  if (descriptor?.expectedBy && descriptor.expectedByWokenFor !== descriptor.expectedBy) return true;
  if (!monitorNextCheckAt) return false;
  const nextCheckAtMs = new Date(monitorNextCheckAt).getTime();
  return Number.isFinite(nextCheckAtMs) && nextCheckAtMs > now.getTime();
}
