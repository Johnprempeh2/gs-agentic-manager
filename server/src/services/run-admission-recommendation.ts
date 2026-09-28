import os from "node:os";
import { and, gte, isNotNull, isNull, lte, or } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@greatstone/db";
import {
  createSystemMemoryReader,
  DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
  resolveRunAdmissionSettings,
  type MemoryReader,
  type RunAdmissionHoldReason,
  type RunAdmissionSettings,
} from "./run-admission.js";
import { instanceSettingsService } from "./instance-settings.js";

/**
 * Usage-based run admission recommendation (GRE-116).
 *
 * Read-only: suggests a `runAdmission` ({ maxConcurrentRuns,
 * minAvailableMemoryMb }) from the machine and the last 7 days of runs. It
 * never writes settings; the board applies a suggestion in Settings.
 *
 * The rule, in order:
 * 1. RAM rule (same as the GRE-114 Settings hint): cap =
 *    floor((total RAM - RAM floor) / 500 MB per run), clamped to 1..1000.
 *    Runs use roughly 300-600 MB each.
 * 2. Low-RAM holds happen often (>= FREQUENT_HOLD_RUNS runs held for low
 *    memory or memory pressure): lower the cap to one below the smallest of
 *    the RAM rule, the current cap and the observed peak.
 * 3. Otherwise, cap holds happen often and free RAM stayed above the floor
 *    (no low-RAM holds, and available RAM now is above the floor): raise the
 *    current cap by one.
 * 4. Otherwise: the RAM rule.
 *
 * The RAM floor suggestion keeps the current floor, or the default when the
 * RAM check is off (0).
 *
 * Data limits, reported in `reasons`:
 * - Hold reasons are not stored on runs. This module keeps an in-process log
 *   of holds from the heartbeat start gate, so hold counts cover the time
 *   since the server started (bounded by the window), not a full 7 days.
 * - Memory use per run is not recorded, so only the RAM rule sizes runs.
 */

export const RECOMMENDATION_WINDOW_DAYS = 7;
export const ASSUMED_MEMORY_PER_RUN_MB = 500;
export const FREQUENT_HOLD_RUNS = 3;
const MAX_CAP = 1000;
const BYTES_PER_MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOLD_LOG_MAX_ENTRIES = 5000;

export type HoldKind = "global_cap" | "low_memory";

export function holdKindForReason(reason: string): HoldKind | null {
  if (reason === "global_cap") return "global_cap";
  if (reason === "low_memory" || reason === "memory_pressure") return "low_memory";
  return null;
}

// ---------------------------------------------------------------------------
// In-process hold log, fed by the heartbeat start gate.

interface HoldLogEntry {
  runId: string;
  kind: HoldKind;
  heldAt: number;
  releasedAt: number | null;
}

const holdLog: HoldLogEntry[] = [];
let holdLogSince = Date.now();

function pruneHoldLog(now: number) {
  const cutoff = now - RECOMMENDATION_WINDOW_DAYS * DAY_MS;
  while (
    holdLog.length > 0 &&
    (holdLog.length > HOLD_LOG_MAX_ENTRIES || (holdLog[0]!.releasedAt ?? now) < cutoff)
  ) {
    holdLog.shift();
  }
}

/** Called when a queued run is first held, or its hold reason changes. */
export function recordRunAdmissionHold(
  runId: string,
  reason: RunAdmissionHoldReason | string,
  now = Date.now(),
) {
  const kind = holdKindForReason(reason);
  if (!kind) return;
  for (let i = holdLog.length - 1; i >= 0; i--) {
    const entry = holdLog[i]!;
    if (entry.runId !== runId || entry.releasedAt !== null) continue;
    if (entry.kind === kind) return;
    entry.releasedAt = now;
    break;
  }
  holdLog.push({ runId, kind, heldAt: now, releasedAt: null });
  pruneHoldLog(now);
}

/** Called when a held run starts or leaves the queue. */
export function recordRunAdmissionRelease(runId: string, now = Date.now()) {
  for (let i = holdLog.length - 1; i >= 0; i--) {
    const entry = holdLog[i]!;
    if (entry.runId === runId && entry.releasedAt === null) {
      entry.releasedAt = now;
      return;
    }
  }
}

/** Test hook. */
export function resetRunAdmissionHoldLog(since = Date.now()) {
  holdLog.length = 0;
  holdLogSince = since;
}

export interface HoldSummary {
  /** Distinct runs held for this reason in the window. */
  runs: number;
  p95HoldMs: number | null;
}

export function summarizeHoldLog(now = Date.now()): {
  trackedSince: string;
  globalCap: HoldSummary;
  lowMemory: HoldSummary;
} {
  const windowStart = now - RECOMMENDATION_WINDOW_DAYS * DAY_MS;
  const summarize = (kind: HoldKind): HoldSummary => {
    const entries = holdLog.filter(
      (entry) => entry.kind === kind && (entry.releasedAt ?? now) >= windowStart,
    );
    return {
      runs: new Set(entries.map((entry) => entry.runId)).size,
      p95HoldMs: percentile(
        entries.map((entry) => (entry.releasedAt ?? now) - entry.heldAt),
        0.95,
      ),
    };
  };
  return {
    trackedSince: new Date(Math.max(holdLogSince, windowStart)).toISOString(),
    globalCap: summarize("global_cap"),
    lowMemory: summarize("low_memory"),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers.

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

/**
 * Highest number of runs running at the same time, from start/finish times.
 * A null finish means still running (counts until `now`).
 */
export function computePeakConcurrentRuns(
  intervals: Array<{ startedAt: number; finishedAt: number | null }>,
  now = Date.now(),
): number {
  const events: Array<[number, number]> = [];
  for (const interval of intervals) {
    const end = interval.finishedAt ?? now;
    if (end < interval.startedAt) continue;
    events.push([interval.startedAt, 1], [end, -1]);
  }
  // Ends before starts at the same instant, so back-to-back runs do not overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0;
  let peak = 0;
  for (const [, delta] of events) {
    running += delta;
    if (running > peak) peak = running;
  }
  return peak;
}

export function ramRuleCap(totalMemoryMb: number, minAvailableMemoryMb: number): number {
  const usable = totalMemoryMb - minAvailableMemoryMb;
  return clampCap(Math.floor(usable / ASSUMED_MEMORY_PER_RUN_MB));
}

function clampCap(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_CAP, Math.max(1, Math.floor(value)));
}

export interface RecommendationInput {
  current: RunAdmissionSettings;
  system: { totalMemoryMb: number; availableMemoryMb: number | null; cpuCount: number };
  usage: {
    runsStarted: number;
    peakConcurrentRuns: number;
    globalCapHeldRuns: number;
    lowMemoryHeldRuns: number;
    perRunMemoryRecorded: boolean;
  };
}

export interface RunAdmissionSuggestion {
  suggested: RunAdmissionSettings;
  reasons: string[];
}

/** The rule. Pure; see the module comment. */
export function recommendRunAdmission(input: RecommendationInput): RunAdmissionSuggestion {
  const { current, system, usage } = input;
  const reasons: string[] = [];

  const floorMb =
    current.minAvailableMemoryMb > 0
      ? current.minAvailableMemoryMb
      : DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB;
  if (current.minAvailableMemoryMb <= 0) {
    reasons.push(
      `RAM check is off; suggest turning it back on with the default floor of ${floorMb} MB.`,
    );
  }

  const base = ramRuleCap(system.totalMemoryMb, floorMb);
  reasons.push(
    `RAM rule: (${system.totalMemoryMb} MB total - ${floorMb} MB floor) / ${ASSUMED_MEMORY_PER_RUN_MB} MB per run = ${base} runs.`,
  );
  if (!usage.perRunMemoryRecorded) {
    reasons.push(
      `Memory use per run is not recorded, so runs are sized at about ${ASSUMED_MEMORY_PER_RUN_MB} MB each (RAM rule only).`,
    );
  }

  const noData =
    usage.runsStarted === 0 &&
    usage.globalCapHeldRuns === 0 &&
    usage.lowMemoryHeldRuns === 0;
  if (noData) {
    reasons.push(
      `No runs in the last ${RECOMMENDATION_WINDOW_DAYS} days; the suggestion uses the RAM rule only.`,
    );
    return { suggested: { maxConcurrentRuns: base, minAvailableMemoryMb: floorMb }, reasons };
  }

  let cap = base;
  if (usage.lowMemoryHeldRuns >= FREQUENT_HOLD_RUNS) {
    const ceiling = Math.min(
      base,
      current.maxConcurrentRuns,
      usage.peakConcurrentRuns > 0 ? usage.peakConcurrentRuns : Number.POSITIVE_INFINITY,
    );
    cap = clampCap(ceiling - 1);
    reasons.push(
      `${usage.lowMemoryHeldRuns} runs were held for low RAM; lower the cap to ${cap} (one below ${ceiling}, the smallest of the RAM rule, current cap and peak of ${usage.peakConcurrentRuns}).`,
    );
  } else {
    const freeAboveFloor =
      usage.lowMemoryHeldRuns === 0 &&
      (system.availableMemoryMb === null || system.availableMemoryMb > floorMb);
    if (usage.globalCapHeldRuns >= FREQUENT_HOLD_RUNS && freeAboveFloor) {
      cap = clampCap(current.maxConcurrentRuns + 1);
      reasons.push(
        `${usage.globalCapHeldRuns} runs waited on the run cap while free RAM stayed above the floor; raise the cap by one to ${cap}.`,
      );
    } else if (usage.globalCapHeldRuns >= FREQUENT_HOLD_RUNS) {
      reasons.push(
        `${usage.globalCapHeldRuns} runs waited on the run cap, but free RAM is not clearly above the floor, so the cap is not raised.`,
      );
    } else {
      reasons.push(
        `Few or no admission holds (${usage.globalCapHeldRuns} cap, ${usage.lowMemoryHeldRuns} low RAM); peak was ${usage.peakConcurrentRuns} concurrent runs.`,
      );
    }
  }

  return { suggested: { maxConcurrentRuns: cap, minAvailableMemoryMb: floorMb }, reasons };
}

// ---------------------------------------------------------------------------
// Service: gathers inputs and applies the rule.

export interface RunAdmissionRecommendation {
  windowDays: number;
  current: RunAdmissionSettings;
  suggested: RunAdmissionSettings;
  reasons: string[];
  system: { totalMemoryMb: number; availableMemoryMb: number | null; cpuCount: number };
  usage: {
    runsStarted: number;
    peakConcurrentRuns: number;
    queueWaitP50Ms: number | null;
    queueWaitP95Ms: number | null;
    holds: ReturnType<typeof summarizeHoldLog>;
    perRunMemoryRecorded: boolean;
  };
}

const defaultMemoryReader = createSystemMemoryReader();

export function runAdmissionRecommendationService(
  db: Db,
  deps: { memoryReader?: MemoryReader; now?: () => number } = {},
) {
  const settings = instanceSettingsService(db);
  const memoryReader = deps.memoryReader ?? defaultMemoryReader;
  const clock = deps.now ?? Date.now;

  return {
    async get(): Promise<RunAdmissionRecommendation> {
      const now = clock();
      const windowStart = new Date(now - RECOMMENDATION_WINDOW_DAYS * DAY_MS);
      const [general, memory, rows] = await Promise.all([
        settings.getGeneral(),
        memoryReader().catch(() => null),
        db
          .select({
            createdAt: heartbeatRuns.createdAt,
            scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
            startedAt: heartbeatRuns.startedAt,
            finishedAt: heartbeatRuns.finishedAt,
          })
          .from(heartbeatRuns)
          .where(
            and(
              isNotNull(heartbeatRuns.startedAt),
              lte(heartbeatRuns.startedAt, new Date(now)),
              or(isNull(heartbeatRuns.finishedAt), gte(heartbeatRuns.finishedAt, windowStart)),
            ),
          ),
      ]);
      const current = resolveRunAdmissionSettings(general);

      const intervals = rows.map((row) => ({
        startedAt: Math.max(row.startedAt!.getTime(), windowStart.getTime()),
        finishedAt: row.finishedAt ? row.finishedAt.getTime() : null,
      }));
      const startedInWindow = rows.filter((row) => row.startedAt! >= windowStart);
      // Queue wait: from creation (or the scheduled retry time) to start.
      const waits = startedInWindow.map((row) => {
        const readyAt = Math.max(
          row.createdAt.getTime(),
          row.scheduledRetryAt ? row.scheduledRetryAt.getTime() : 0,
        );
        return Math.max(0, row.startedAt!.getTime() - readyAt);
      });

      const holds = summarizeHoldLog(now);
      const system = {
        totalMemoryMb: Math.round(os.totalmem() / BYTES_PER_MB),
        availableMemoryMb: memory ? Math.round(memory.availableBytes / BYTES_PER_MB) : null,
        cpuCount: os.cpus().length,
      };
      const usage = {
        runsStarted: startedInWindow.length,
        peakConcurrentRuns: computePeakConcurrentRuns(intervals, now),
        globalCapHeldRuns: holds.globalCap.runs,
        lowMemoryHeldRuns: holds.lowMemory.runs,
        perRunMemoryRecorded: false,
      };
      const { suggested, reasons } = recommendRunAdmission({ current, system, usage });
      reasons.push(
        `Hold reasons are counted since ${holds.trackedSince} (server start or window start, whichever is later).`,
      );

      return {
        windowDays: RECOMMENDATION_WINDOW_DAYS,
        current,
        suggested,
        reasons,
        system,
        usage: {
          runsStarted: usage.runsStarted,
          peakConcurrentRuns: usage.peakConcurrentRuns,
          queueWaitP50Ms: percentile(waits, 0.5),
          queueWaitP95Ms: percentile(waits, 0.95),
          holds,
          perRunMemoryRecorded: false,
        },
      };
    },
  };
}
