import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import {
  DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS,
  DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
  DEFAULT_RUN_ADMISSION_MIN_FREE_DISK_GB,
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
 * - a free-memory floor (GRE-198: the only memory rule), and
 * - a free-disk floor on the data dir and worktree volumes (GRE-207: a full
 *   disk fails every run with ENOSPC).
 *
 * The OS memory-pressure level is read for the Settings page but never holds
 * a run: macOS reports "warn" as its normal state on a 16 GB Mac with ordinary
 * apps open, so holding on it stranded every new run with 6 GB free.
 *
 * A "no" keeps the run `queued` (never failed or cancelled). The queue drain
 * and a short re-check timer start it again once a slot frees or memory or
 * disk recovers. When memory or disk cannot be read the check fails open, so
 * a broken reader never strands work.
 */

export {
  DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS,
  DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
  DEFAULT_RUN_ADMISSION_MIN_FREE_DISK_GB,
};
export const RUN_ADMISSION_RECHECK_MS = 15_000;
const MEMORY_SNAPSHOT_CACHE_MS = 2_000;
const MEMORY_READ_TIMEOUT_MS = 2_000;
const DISK_SNAPSHOT_CACHE_MS = 10_000;
const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * BYTES_PER_MB;

export type MemoryPressureLevel = "normal" | "warn" | "critical" | "unknown";

export interface MemorySnapshot {
  availableBytes: number;
  pressure: MemoryPressureLevel;
}

/** Returns null when memory cannot be read; admission then fails open. */
export type MemoryReader = () => Promise<MemorySnapshot | null>;

/** Free bytes on the fullest watched volume. */
export interface DiskSnapshot {
  availableBytes: number;
}

/** Returns null when disk cannot be read; admission then fails open. */
export type DiskReader = () => Promise<DiskSnapshot | null>;

export interface RunAdmissionSettings {
  maxConcurrentRuns: number;
  minAvailableMemoryMb: number;
  minFreeDiskGb: number;
}

export type RunAdmissionHoldReason = "global_cap" | "low_memory" | "low_disk";

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
    minFreeDiskGb:
      stored?.minFreeDiskGb ?? DEFAULT_RUN_ADMISSION_MIN_FREE_DISK_GB,
  };
}

/** "1.6 GB"; whole numbers drop the decimal ("2 GB"). */
function formatGb(bytes: number) {
  const gb = (bytes / BYTES_PER_GB).toFixed(1);
  return `${gb.endsWith(".0") ? gb.slice(0, -2) : gb} GB`;
}

/**
 * Whole GB for disk ("12 GB"), rounded down so the shown number never reads
 * as at or above the floor while the run is held. Below 1 GB keep a decimal.
 */
function formatDiskGb(bytes: number) {
  const gb = bytes / BYTES_PER_GB;
  if (gb < 1) return `${(Math.floor(gb * 10) / 10).toFixed(1)} GB`;
  return `${Math.floor(gb)} GB`;
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
  /** Omitted or null fails open (disk not read). */
  disk?: DiskSnapshot | null;
}): RunAdmissionDecision {
  const { settings, runningCount, memory, disk } = input;
  const slots = settings.maxConcurrentRuns - runningCount;
  if (slots <= 0) {
    return {
      admit: false,
      reason: "global_cap",
      message: `Waiting: instance run cap reached (${runningCount}/${settings.maxConcurrentRuns} running)`,
    };
  }
  if (memory && settings.minAvailableMemoryMb > 0) {
    const floorBytes = settings.minAvailableMemoryMb * BYTES_PER_MB;
    if (memory.availableBytes < floorBytes) {
      return {
        admit: false,
        reason: "low_memory",
        message: `Waiting: low memory (${formatGb(memory.availableBytes)} free, floor ${formatGb(floorBytes)})`,
      };
    }
  }
  if (disk && settings.minFreeDiskGb > 0) {
    const floorBytes = settings.minFreeDiskGb * BYTES_PER_GB;
    if (disk.availableBytes < floorBytes) {
      return {
        admit: false,
        reason: "low_disk",
        message: `Waiting: low disk (${formatDiskGb(disk.availableBytes)} free, floor ${formatDiskGb(floorBytes)})`,
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
 * Free disk on the fullest of `paths` (data dir, worktree roots). Paths that
 * cannot be read are skipped; null when none can be read.
 */
export async function readFreeDiskBytes(
  paths: string[],
  statFs: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> = statfs,
): Promise<DiskSnapshot | null> {
  let min: number | null = null;
  for (const path of new Set(paths)) {
    try {
      const stats = await statFs(path);
      const available = Number(stats.bavail) * Number(stats.bsize);
      if (!Number.isFinite(available)) continue;
      if (min === null || available < min) min = available;
    } catch {
      // Missing or unreadable path: skip it.
    }
  }
  return min === null ? null : { availableBytes: min };
}

/** Disk reader with a short cache, like the memory reader. */
export function createSystemDiskReader(
  paths: () => string[],
  now: () => number = Date.now,
  read: (paths: string[]) => Promise<DiskSnapshot | null> = readFreeDiskBytes,
): DiskReader {
  let cached: { at: number; value: Promise<DiskSnapshot | null> } | null = null;
  return () => {
    const at = now();
    if (!cached || at - cached.at > DISK_SNAPSHOT_CACHE_MS) {
      cached = { at, value: read(paths()).catch(() => null) };
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
