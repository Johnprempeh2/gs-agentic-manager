import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import {
  DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS,
  DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
  type InstanceGeneralSettings,
  type InstanceSystemMemory,
} from "@greatstone/shared";

/**
 * Instance-wide run admission (GRE-105).
 *
 * The per-agent `maxConcurrentRuns` limit alone lets 12 agents x 20 runs start
 * at once, which a 16 GB machine cannot hold. Before a queued run starts, the
 * heartbeat start gate asks this module whether the instance has room:
 *
 * - a global cap on concurrently running runs, and
 * - a free-memory floor plus the OS memory-pressure level.
 *
 * A "no" keeps the run `queued` (never failed or cancelled). The queue drain
 * and a short re-check timer start it again once a slot frees or memory
 * recovers. When memory cannot be read the check fails open, so a broken
 * reader never strands work.
 */

export {
  DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS,
  DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
};
export const RUN_ADMISSION_RECHECK_MS = 15_000;
const MEMORY_SNAPSHOT_CACHE_MS = 2_000;
const MEMORY_READ_TIMEOUT_MS = 2_000;
const BYTES_PER_MB = 1024 * 1024;

export type MemoryPressureLevel = "normal" | "warn" | "critical" | "unknown";

export interface MemorySnapshot {
  availableBytes: number;
  pressure: MemoryPressureLevel;
}

/** Returns null when memory cannot be read; admission then fails open. */
export type MemoryReader = () => Promise<MemorySnapshot | null>;

export interface RunAdmissionSettings {
  maxConcurrentRuns: number;
  minAvailableMemoryMb: number;
}

export type RunAdmissionHoldReason =
  | "global_cap"
  | "low_memory"
  | "memory_pressure";

export type RunAdmissionDecision =
  | { admit: true; slots: number }
  | { admit: false; reason: RunAdmissionHoldReason; message: string };

export function resolveRunAdmissionSettings(
  general: Pick<InstanceGeneralSettings, "runAdmission"> | null | undefined,
): RunAdmissionSettings {
  const stored = general?.runAdmission;
  return {
    maxConcurrentRuns:
      stored?.maxConcurrentRuns ?? DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS,
    minAvailableMemoryMb:
      stored?.minAvailableMemoryMb ??
      DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
  };
}

function formatGb(bytes: number) {
  return `${(bytes / (1024 * BYTES_PER_MB)).toFixed(1)} GB`;
}

/**
 * Pure admission decision. `runningCount` must include runs this process has
 * reserved but not yet marked running, so concurrent start gates cannot both
 * take the last slot.
 */
export function evaluateRunAdmission(input: {
  settings: RunAdmissionSettings;
  runningCount: number;
  memory: MemorySnapshot | null;
}): RunAdmissionDecision {
  const { settings, runningCount, memory } = input;
  const slots = settings.maxConcurrentRuns - runningCount;
  if (slots <= 0) {
    return {
      admit: false,
      reason: "global_cap",
      message: `Held: instance run cap reached (${runningCount}/${settings.maxConcurrentRuns} running)`,
    };
  }
  if (memory && settings.minAvailableMemoryMb > 0) {
    if (memory.pressure === "warn" || memory.pressure === "critical") {
      return {
        admit: false,
        reason: "memory_pressure",
        message: `Held: low memory (system memory pressure ${memory.pressure})`,
      };
    }
    const floorBytes = settings.minAvailableMemoryMb * BYTES_PER_MB;
    if (memory.availableBytes < floorBytes) {
      return {
        admit: false,
        reason: "low_memory",
        message: `Held: low memory (${formatGb(memory.availableBytes)} available, floor ${formatGb(floorBytes)})`,
      };
    }
  }
  return { admit: true, slots };
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: MEMORY_READ_TIMEOUT_MS, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** available = free + inactive + purgeable pages, from `vm_stat`. */
export function parseVmStatAvailableBytes(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string) => {
    const match = new RegExp(`^Pages ${label}:\\s+(\\d+)`, "m").exec(output);
    return match ? Number(match[1]) : null;
  };
  const free = pages("free");
  const inactive = pages("inactive");
  if (free === null || inactive === null) return null;
  return (free + inactive + (pages("purgeable") ?? 0)) * pageSize;
}

/** kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
export function parseDarwinPressureLevel(output: string): MemoryPressureLevel {
  switch (output.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return "unknown";
  }
}

export function parseLinuxMemAvailableBytes(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
  return match ? Number(match[1]) * 1024 : null;
}

async function readSystemMemoryUncached(): Promise<MemorySnapshot | null> {
  try {
    if (process.platform === "darwin") {
      const [vmStat, pressure] = await Promise.all([
        execText("vm_stat", []),
        execText("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).catch(
          () => "",
        ),
      ]);
      const availableBytes = parseVmStatAvailableBytes(vmStat);
      if (availableBytes === null) return null;
      return { availableBytes, pressure: parseDarwinPressureLevel(pressure) };
    }
    if (process.platform === "linux") {
      const availableBytes = parseLinuxMemAvailableBytes(
        await readFile("/proc/meminfo", "utf8"),
      );
      if (availableBytes !== null) return { availableBytes, pressure: "unknown" };
    }
    return { availableBytes: os.freemem(), pressure: "unknown" };
  } catch {
    return null;
  }
}

/**
 * System memory reader with a short cache, so draining many agents in one
 * pass spawns `vm_stat` once rather than once per agent.
 */
export function createSystemMemoryReader(
  readUncached: MemoryReader = readSystemMemoryUncached,
  now: () => number = Date.now,
): MemoryReader {
  let cached: { at: number; value: Promise<MemorySnapshot | null> } | null =
    null;
  return () => {
    const at = now();
    if (!cached || at - cached.at > MEMORY_SNAPSHOT_CACHE_MS) {
      cached = { at, value: readUncached() };
    }
    return cached.value;
  };
}

/**
 * Host memory for the Settings page (GRE-114): total RAM plus the same
 * available/pressure reading the admission guard uses.
 */
export async function readInstanceSystemMemory(
  readMemory: MemoryReader,
): Promise<InstanceSystemMemory> {
  const snapshot = await readMemory();
  return {
    totalBytes: os.totalmem(),
    availableBytes: snapshot?.availableBytes ?? null,
    pressure: snapshot?.pressure ?? "unknown",
  };
}

/**
 * Orders agents with queued work so the agent whose oldest queued run has
 * waited longest goes first. Combined with one admission per agent per pass,
 * this keeps a busy agent from taking every free slot.
 */
export function orderAgentsByOldestQueuedRun(
  rows: Array<{ agentId: string; createdAt: Date }>,
): string[] {
  const oldest = new Map<string, number>();
  for (const row of rows) {
    const at = row.createdAt.getTime();
    const prior = oldest.get(row.agentId);
    if (prior === undefined || at < prior) oldest.set(row.agentId, at);
  }
  return [...oldest.entries()]
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .map(([agentId]) => agentId);
}
