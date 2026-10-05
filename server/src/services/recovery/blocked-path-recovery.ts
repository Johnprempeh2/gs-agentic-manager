import type { IssueUnblockDescriptor } from "@greatstone/shared";
import { isHumanUnblockOwner } from "./human-wait-deadline.js";
import { hasScheduledIssueMonitorPath, type IssueLivenessIssueInput } from "./issue-graph-liveness.js";

/**
 * GRE-780: a `blocked` issue whose only way forward was an interaction card
 * strands when that card resolves under a policy that does not wake (for
 * example a rejected `wake_assignee_on_accept` confirmation). This is the
 * resolution-time twin of the `blocked_without_action_path` liveness finding
 * (GRE-72): if nothing else owns the next step once the card is gone, the
 * resolution itself wakes the assignee once.
 */
export const BLOCKED_PATH_RECOVERY_INSTRUCTION =
  "This issue is blocked and its last waiting path (an interaction card) was resolved without a continuation. Read the response, then choose an explicit next step: return to work, link the issue it waits on as a blocker, ask again, schedule a monitor, or move it to backlog if the work is paused.";

export type BlockedPathAfterResolutionInput = {
  issue: Pick<
    IssueLivenessIssueInput,
    "monitorNextCheckAt" | "monitorAttemptCount" | "executionPolicy" | "executionState"
  > & {
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId?: string | null;
    unblockDescriptor?: IssueUnblockDescriptor | null;
  };
  resolvedInteractionId: string;
  pendingInteractionIds: string[];
  unresolvedBlockerCount: number;
  now?: Date;
};

export function isBlockedPathLostAfterResolution(input: BlockedPathAfterResolutionInput) {
  const { issue } = input;
  if (issue.status !== "blocked" || !issue.assigneeAgentId) return false;
  if (issue.assigneeUserId) return false;
  if (input.unresolvedBlockerCount > 0) return false;
  if (input.pendingInteractionIds.some((id) => id !== input.resolvedInteractionId)) return false;
  // A wait on John or the board keeps its own 24h re-check (GRE-500).
  if (isHumanUnblockOwner(issue.unblockDescriptor)) return false;
  if (hasScheduledIssueMonitorPath(issue as IssueLivenessIssueInput, input.now ?? new Date())) return false;
  return true;
}
