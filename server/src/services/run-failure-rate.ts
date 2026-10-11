/**
 * Run failure rate over a time window (GRE-1325), for the Strategy Board KPI
 * "Failed runs per 100 runs, last 7 days". The run list stops at 1,000 rows
 * (about two days at our volume), so this counts in the database instead.
 *
 * Same rule as tracked number R2 (tests/lifecycle-baseline/metrics/README.md):
 * among runs that finished in the window, failed is `failed + timed_out +
 * interrupted`, and the base is those plus `succeeded`. Cancelled runs are
 * counted but left out of the base, because a cancel is usually a person's
 * choice or a newer run taking over. Queued and running runs have not finished
 * and are not counted.
 */

export const RUN_FAILURE_RATE_DEFAULT_DAYS = 7;

export const RUN_FAILURE_STATUSES = ["failed", "timed_out", "interrupted"] as const;

const FINISHED_STATUSES = ["succeeded", ...RUN_FAILURE_STATUSES, "cancelled"] as const;

type FinishedStatus = (typeof FINISHED_STATUSES)[number];

export interface RunFailureRate {
  /** Inclusive start and exclusive end of the window, on `finishedAt`. */
  since: string;
  before: string;
  agentId: string | null;
  byStatus: Record<FinishedStatus, number>;
  /** failed + timed_out + interrupted */
  failed: number;
  /** failed + succeeded: the base of the rate. Cancelled runs are not in it. */
  judged: number;
  /** Failed runs per 100 judged runs, to one decimal; null when no run finished. */
  failedPer100: number | null;
}

export function summarizeRunFailureRate(input: {
  since: Date;
  before: Date;
  agentId?: string | null;
  counts: ReadonlyArray<{ status: string; count: number }>;
}): RunFailureRate {
  const byStatus = Object.fromEntries(FINISHED_STATUSES.map((status) => [status, 0])) as Record<FinishedStatus, number>;
  for (const row of input.counts) {
    if ((FINISHED_STATUSES as readonly string[]).includes(row.status)) {
      byStatus[row.status as FinishedStatus] += Number(row.count);
    }
  }
  const failed = RUN_FAILURE_STATUSES.reduce((sum, status) => sum + byStatus[status], 0);
  const judged = failed + byStatus.succeeded;
  return {
    since: input.since.toISOString(),
    before: input.before.toISOString(),
    agentId: input.agentId ?? null,
    byStatus,
    failed,
    judged,
    failedPer100: judged === 0 ? null : Math.round((failed / judged) * 1000) / 10,
  };
}
