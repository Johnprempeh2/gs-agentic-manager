import type { Issue } from "@greatstone/shared";

/**
 * Order two tasks by due date. Ascending puts the soonest first. Tasks with
 * no due date always go last, whichever way the list is sorted, so the
 * dated work stays at the top.
 */
export function compareIssueDueDates(
  a: Pick<Issue, "dueDate">,
  b: Pick<Issue, "dueDate">,
  dir: 1 | -1,
): number {
  const aDue = a.dueDate ? a.dueDate.slice(0, 10) : null;
  const bDue = b.dueDate ? b.dueDate.slice(0, 10) : null;
  if (aDue === bDue) return 0;
  if (aDue === null) return 1;
  if (bDue === null) return -1;
  return dir * (aDue < bDue ? -1 : 1);
}
