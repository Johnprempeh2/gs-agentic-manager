/**
 * Runs lost to host sleep (GRE-200).
 *
 * On 29 Sep a closed laptop lid froze the server for an hour. Runs claimed
 * before the sleep woke to "Legacy controller lease lost" or an ACP startup
 * deadline that had passed while the host was dark. Each one spent a bounded
 * transient retry, the retries froze the same way, and recovery moved the
 * issues to `blocked` and the agent to `error`. Nothing was wrong with the
 * work: the host was asleep.
 *
 * A run is a host-sleep loss when it ended with one of those lease or
 * deadline errors and its lifetime overlaps host blind time (GRE-181: sleep,
 * a stalled event loop, or time before this process started, so a host
 * restart counts too). Such a run is retried in its own lane that does not
 * spend the failure budget. The lane is still bounded: after
 * `HOST_SLEEP_RETRY_MAX_ATTEMPTS` sleep losses in a row the next loss falls
 * back to the normal failure budget.
 */

export const HOST_SLEEP_RETRY_REASON = "host_sleep_resume";
export const HOST_SLEEP_RETRY_WAKE_REASON = "host_sleep_resume_retry";
/** A night of 15-minute dark wakes is about 32 losses; leave headroom. */
export const HOST_SLEEP_RETRY_MAX_ATTEMPTS = 48;
export const HOST_SLEEP_RETRY_DELAY_MS = 60_000;
/** Context key: the failure-retry count carried across the sleep lane. */
export const FAILURE_RETRIES_BEFORE_HOST_SLEEP_KEY = "failureRetriesBeforeHostSleepWait";

const HOST_SLEEP_LOSS_ERROR_RE =
  /legacy controller lease lost|native_session_lease_lost|startup handshake did not finish before the startup deadline/i;

const TERMINAL_UNSUCCESSFUL_STATUSES = new Set(["failed", "cancelled", "timed_out", "interrupted"]);

export type HostSleepLossRun = {
  status: string;
  error?: string | null;
  createdAt?: Date | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
};

/** True when the run ended with a lease or startup-deadline loss across host blind time. */
export function isHostSleepLoss(
  run: HostSleepLossRun | null | undefined,
  blindMsBetween: (from: number, to: number) => number,
  now: Date = new Date(),
): boolean {
  if (!run || !TERMINAL_UNSUCCESSFUL_STATUSES.has(run.status)) return false;
  if (!HOST_SLEEP_LOSS_ERROR_RE.test(run.error ?? "")) return false;
  const from = (run.startedAt ?? run.createdAt)?.getTime();
  if (from === undefined || !Number.isFinite(from)) return false;
  const to = (run.finishedAt ?? now).getTime();
  return blindMsBetween(from, to) > 0;
}
