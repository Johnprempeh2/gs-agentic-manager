const APPROVAL_STATUS_LABELS: Record<string, string> = {
  pending: "Waiting on you",
  revision_requested: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Withdrawn",
};

/** Plain-English label for an approval status. Unknown statuses are sentence-cased. */
export function approvalStatusLabel(status: string): string {
  const known = APPROVAL_STATUS_LABELS[status];
  if (known) return known;
  const words = status.replaceAll("_", " ").trim();
  if (!words) return status;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}
