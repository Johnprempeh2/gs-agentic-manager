import type { IssueUnblockWaitingOn } from "./constants.js";

/**
 * "Waiting on someone outside, until a date": a blocked task can say who it
 * waits on (a client, the board, someone outside the company) and the day it
 * expects to hear back by. When that day has passed, the assignee is woken
 * once to chase or set a new date.
 */

type WaitingDescriptor = {
  waitingOn?: IssueUnblockWaitingOn | null;
  expectedBy?: string | null;
  expectedByWokenFor?: string | null;
};

/** Today's calendar day in UTC, "YYYY-MM-DD". */
export function utcCalendarDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * True when the day the task expected to hear back by is over: the whole of
 * `expectedBy` (UTC) has gone by. A task expecting an answer by 20 Oct is
 * still on time during 20 Oct.
 */
export function isUnblockExpectedByPassed(
  descriptor: WaitingDescriptor | null | undefined,
  now: Date,
): boolean {
  const expectedBy = descriptor?.expectedBy;
  if (!expectedBy || !/^\d{4}-\d{2}-\d{2}$/.test(expectedBy)) return false;
  return utcCalendarDay(now) > expectedBy;
}

/** True when the date has passed and the assignee was not yet woken for this date. */
export function needsUnblockWaitingDateWake(
  descriptor: WaitingDescriptor | null | undefined,
  now: Date,
): boolean {
  if (!isUnblockExpectedByPassed(descriptor, now)) return false;
  return descriptor?.expectedByWokenFor !== descriptor?.expectedBy;
}
