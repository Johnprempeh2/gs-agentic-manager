import { silenceAgeMs, type RunSilenceTimestamps } from "../modules/active-run-watchdog/domain/policy.js";

/**
 * Silent-run stop (GRE-34). A running run that writes no output for this long
 * is stopped with `run_silent_timeout` and retried once in a fresh adapter
 * session. The recovery watchdog's one-hour "suspicious silence" bar stays as
 * the review signal; this is the earlier automatic stop.
 */
export const RUN_SILENT_TIMEOUT_ERROR_CODE = "run_silent_timeout";
export const RUN_SILENT_TIMEOUT_RETRY_WAKE_REASON = "run_silent_timeout_retry";
export const DEFAULT_RUN_SILENT_TIMEOUT_MS = 20 * 60 * 1000;
const MIN_RUN_SILENT_TIMEOUT_MS = 60 * 1000;

/** Result-json flag: the task session that ran this run must not be resumed. */
export const FRESH_SESSION_ON_RETRY_KEY = "freshSessionOnRetry";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Per-agent timeout from `runtimeConfig.heartbeat.silentTimeoutSec`.
 * Unset uses the 20-minute default; `0` (or a negative value) turns the stop
 * off for that agent. Values under one minute are raised to one minute.
 */
export function resolveRunSilentTimeoutMs(runtimeConfig: unknown): number | null {
  const heartbeat = asRecord(asRecord(runtimeConfig).heartbeat);
  const raw = heartbeat.silentTimeoutSec;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RUN_SILENT_TIMEOUT_MS;
  const seconds = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(seconds)) return DEFAULT_RUN_SILENT_TIMEOUT_MS;
  if (seconds <= 0) return null;
  return Math.max(MIN_RUN_SILENT_TIMEOUT_MS, Math.trunc(seconds * 1000));
}

/** True when a running run has been silent at least its agent's timeout. */
export function isRunSilentPastTimeout(
  run: RunSilenceTimestamps & { status: string },
  timeoutMs: number | null,
  now: Date,
): boolean {
  if (run.status !== "running" || timeoutMs === null) return false;
  const age = silenceAgeMs(run, now);
  return age !== null && age >= timeoutMs;
}

/** True when the run's saved adapter session must be dropped, not resumed. */
export function runRequiresFreshSession(
  run: { errorCode?: string | null; resultJson?: unknown } | null | undefined,
): boolean {
  if (!run) return false;
  if (run.errorCode === RUN_SILENT_TIMEOUT_ERROR_CODE) return true;
  return asRecord(run.resultJson)[FRESH_SESSION_ON_RETRY_KEY] === true;
}

export function formatSilenceMinutes(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} min`;
}
