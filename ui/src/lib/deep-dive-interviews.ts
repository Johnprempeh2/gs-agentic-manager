import { DEEP_DIVE_INTERVIEW_INVITE_LABELS, type DeepDiveInterviewStatusCounts } from "@greatstone/shared";

// Parallel Interview status helpers shared by the Parallel Interview page and
// the client hub's Interviews tab, so both show one person's status the same way.

/** The StatusBadge tone per invite status. */
export const INTERVIEW_INVITE_TONE = {
  invited: "pending",
  started: "running",
  completed: "succeeded",
  abandoned: "warning",
  declined: "rejected",
} as const;

/** Most finished first: the order of the progress bar and the counts line. */
export const INTERVIEW_STATUS_ORDER = ["completed", "started", "invited", "abandoned", "declined"] as const;

/** "3 completed, 1 started", leaving out statuses nobody is in. */
export function interviewCountsText(counts: DeepDiveInterviewStatusCounts) {
  return INTERVIEW_STATUS_ORDER.filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${DEEP_DIVE_INTERVIEW_INVITE_LABELS[status].toLowerCase()}`)
    .join(", ");
}
