import {
  needsUnblockWaitingDateWake,
  type IssueUnblockDescriptor,
} from "@greatstone/shared";

/**
 * "Waiting on someone outside, until a date": a blocked task can name who it
 * waits on (a client, the board, someone outside the company) and the day it
 * expects to hear back by. Once that day is over, its assignee is woken once
 * to chase the person or set a new date.
 *
 * `unblockDescriptor.expectedByWokenFor` records the date the wake fired for.
 * It is server-owned: a client value is ignored, and it survives a rewrite of
 * the descriptor only while `expectedBy` stays the same, so a new date gets a
 * new wake and the same date never gets a second one.
 */
export const WAITING_DATE_PASSED_WAKE_REASON = "waiting_date_passed";

export type WaitingDateIssue = {
  status: string;
  hiddenAt?: Date | null;
  assigneeAgentId?: string | null;
  unblockDescriptor?: IssueUnblockDescriptor | null;
};

/** Pure selection rule for the sweep. */
export function needsWaitingDatePassedWake(issue: WaitingDateIssue, now: Date) {
  return issue.status === "blocked"
    && !issue.hiddenAt
    && Boolean(issue.assigneeAgentId)
    && needsUnblockWaitingDateWake(issue.unblockDescriptor, now);
}

/**
 * Applies the server-owned marker to a descriptor written by a client: drops
 * the value sent, and keeps the stored one only while the date is unchanged.
 */
export function carryWaitingDateMarker<T extends IssueUnblockDescriptor | null | undefined>(
  incoming: T,
  existing: IssueUnblockDescriptor | null | undefined,
): T {
  if (!incoming) return incoming;
  const { expectedByWokenFor: _ignored, ...rest } = incoming as IssueUnblockDescriptor;
  const keep = existing?.expectedByWokenFor
    && rest.expectedBy
    && existing.expectedByWokenFor === rest.expectedBy;
  return (keep ? { ...rest, expectedByWokenFor: existing!.expectedByWokenFor } : rest) as T;
}

export function buildWaitingDatePassedIdempotencyKey(issueId: string, expectedBy: string) {
  return `${WAITING_DATE_PASSED_WAKE_REASON}:${issueId}:${expectedBy}`;
}
