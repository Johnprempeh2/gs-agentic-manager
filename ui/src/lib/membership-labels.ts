const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {
  pending: "Invited",
  active: "Active",
  suspended: "Suspended",
  archived: "Removed",
};

/** Plain label for a membership status; unknown values read as words, not codes. */
export function membershipStatusLabel(status: string): string {
  const known = MEMBERSHIP_STATUS_LABELS[status];
  if (known) return known;
  const words = status.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
