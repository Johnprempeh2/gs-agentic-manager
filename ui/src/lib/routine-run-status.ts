const ROUTINE_RUN_STATUS_LABELS: Record<string, string> = {
  received: "Starting",
  issue_created: "Task created",
  issue_reopened: "Task reopened",
  coalesced: "Joined the queued one",
  skipped: "Skipped",
  completed: "Done",
  failed: "Failed",
};

/** Plain-words label for a routine run status such as `issue_created`. */
export function routineRunStatusLabel(status: string): string {
  const known = ROUTINE_RUN_STATUS_LABELS[status];
  if (known) return known;
  const words = status.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const CONCURRENCY_POLICY_LABELS: Record<string, string> = {
  coalesce_if_active: "Keep one follow-up",
  always_enqueue: "Queue every one",
  skip_if_active: "Skip while busy",
  reuse_standing_task: "Reuse the same task",
};

const CATCH_UP_POLICY_LABELS: Record<string, string> = {
  skip_missed: "Skip missed times",
  enqueue_missed_with_cap: "Catch up missed times",
};

export function concurrencyPolicyLabel(policy: string): string {
  return CONCURRENCY_POLICY_LABELS[policy] ?? policy.replaceAll("_", " ");
}

export function catchUpPolicyLabel(policy: string): string {
  return CATCH_UP_POLICY_LABELS[policy] ?? policy.replaceAll("_", " ");
}
