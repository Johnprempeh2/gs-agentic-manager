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

/**
 * GRE-181: silence the server was able to watch. Wall-clock silence minus the
 * host's blind time (sleep, stalled event loop, before this process started).
 * With the stop sweep on every scheduler tick, a silent run on an awake host is
 * stopped within `timeoutMs` plus one scheduler interval (30 s by default).
 */
export function awakeSilenceAgeMs(
  run: RunSilenceTimestamps,
  now: Date,
  blindMsBetween: (from: number, to: number) => number,
): { awakeMs: number; wallMs: number; blindMs: number } | null {
  const wallMs = silenceAgeMs(run, now);
  if (wallMs === null) return null;
  const to = now.getTime();
  const blindMs = blindMsBetween(to - wallMs, to);
  return { awakeMs: Math.max(0, wallMs - blindMs), wallMs, blindMs };
}

/**
 * GRE-181: a fresh-session retry started while the host is overloaded hangs
 * like the run it replaces. Hold the retry until the host has been awake for a
 * while, the instance has run room and memory (GRE-105 admission), and CPU load
 * is below this bar. After `SILENT_RETRY_MAX_DEFER_MS` of awake waiting the
 * issue escalates to `blocked` instead.
 */
export const SILENT_RETRY_RESUME_SETTLE_MS = 5 * 60 * 1000;
export const SILENT_RETRY_MAX_LOAD_PER_CPU = 1.5;
export const SILENT_RETRY_MAX_DEFER_MS = 30 * 60 * 1000;
/** Recovery leaves a held retry to the watchdog for at most this wall time. */
export const SILENT_RETRY_RECOVERY_HOLD_MS = 2 * 60 * 60 * 1000;

export type SilentRetryPressure =
  | { overloaded: false }
  | { overloaded: true; reason: "host_resumed" | "run_admission" | "cpu_load"; message: string };

export function evaluateSilentRetryPressure(input: {
  now: number;
  lastResumeAt: number;
  admission: { admit: true } | { admit: false; message: string };
  load: { load1: number; cpus: number } | null;
}): SilentRetryPressure {
  const sinceResume = input.now - input.lastResumeAt;
  if (sinceResume < SILENT_RETRY_RESUME_SETTLE_MS) {
    return {
      overloaded: true,
      reason: "host_resumed",
      message: `the host came back from sleep or a stall ${formatSilenceMinutes(sinceResume)} ago`,
    };
  }
  if (!input.admission.admit) {
    return { overloaded: true, reason: "run_admission", message: input.admission.message };
  }
  if (input.load && input.load.cpus > 0) {
    const perCpu = input.load.load1 / input.load.cpus;
    if (perCpu >= SILENT_RETRY_MAX_LOAD_PER_CPU) {
      return {
        overloaded: true,
        reason: "cpu_load",
        message: `host load ${input.load.load1.toFixed(1)} on ${input.load.cpus} CPUs`,
      };
    }
  }
  return { overloaded: false };
}

/** `resultJson.silentTimeout` retry hold, written by the stop and resolved once. */
export type SilentRetryHold = {
  retryDeferredAt?: string;
  retryDeferReason?: string;
  retryResolvedAt?: string;
  retryResolution?: "retried" | "escalated" | "superseded";
};

export function readSilentRetryHold(resultJson: unknown): SilentRetryHold {
  return asRecord(asRecord(resultJson).silentTimeout) as SilentRetryHold;
}

/** True while a silent stop's retry is held by the watchdog and not yet resolved. */
export function isSilentRetryHoldPending(
  run: { errorCode?: string | null; resultJson?: unknown } | null | undefined,
  now: Date,
): boolean {
  if (!run || run.errorCode !== RUN_SILENT_TIMEOUT_ERROR_CODE) return false;
  const hold = readSilentRetryHold(run.resultJson);
  if (!hold.retryDeferredAt || hold.retryResolvedAt) return false;
  const deferredAt = Date.parse(hold.retryDeferredAt);
  return Number.isFinite(deferredAt) && now.getTime() - deferredAt < SILENT_RETRY_RECOVERY_HOLD_MS;
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
