import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  createSystemMemoryReader,
  DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS,
  DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
  evaluateRunAdmission,
  orderAgentsByOldestQueuedRun,
  parseDarwinPressureLevel,
  parseLinuxMemAvailableBytes,
  parseVmStatAvailableBytes,
  readInstanceSystemMemory,
  resolveRunAdmissionSettings,
} from "../services/run-admission.js";

const GB = 1024 * 1024 * 1024;
const settings = { maxConcurrentRuns: 3, minAvailableMemoryMb: 2048 };

describe("run admission (GRE-105)", () => {
  it("uses safe defaults when no setting is stored", () => {
    expect(resolveRunAdmissionSettings({})).toEqual({
      maxConcurrentRuns: DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS,
      minAvailableMemoryMb: DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
    });
    expect(
      resolveRunAdmissionSettings({ runAdmission: { maxConcurrentRuns: 10 } }),
    ).toEqual({ maxConcurrentRuns: 10, minAvailableMemoryMb: 2048 });
  });

  it("admits with the remaining instance slots", () => {
    expect(
      evaluateRunAdmission({
        settings,
        runningCount: 1,
        memory: { availableBytes: 8 * GB, pressure: "normal" },
      }),
    ).toEqual({ admit: true, slots: 2 });
  });

  it("holds when the global cap is reached", () => {
    expect(
      evaluateRunAdmission({
        settings,
        runningCount: 3,
        memory: { availableBytes: 8 * GB, pressure: "normal" },
      }),
    ).toMatchObject({ admit: false, reason: "global_cap" });
  });

  it("holds when available memory is below the floor, and admits once it recovers", () => {
    const low = evaluateRunAdmission({
      settings,
      runningCount: 0,
      memory: { availableBytes: 1 * GB, pressure: "normal" },
    });
    expect(low).toMatchObject({ admit: false, reason: "low_memory" });
    expect(low.admit ? "" : low.message).toMatch(/^Held: low memory/);

    expect(
      evaluateRunAdmission({
        settings,
        runningCount: 0,
        memory: { availableBytes: 3 * GB, pressure: "normal" },
      }),
    ).toEqual({ admit: true, slots: 3 });
  });

  it("holds on warn or critical memory pressure even with free RAM", () => {
    for (const pressure of ["warn", "critical"] as const) {
      expect(
        evaluateRunAdmission({
          settings,
          runningCount: 0,
          memory: { availableBytes: 8 * GB, pressure },
        }),
      ).toMatchObject({ admit: false, reason: "memory_pressure" });
    }
  });

  it("fails open when memory cannot be read, and a 0 floor disables the memory check", () => {
    expect(
      evaluateRunAdmission({ settings, runningCount: 0, memory: null }),
    ).toEqual({ admit: true, slots: 3 });
    expect(
      evaluateRunAdmission({
        settings: { ...settings, minAvailableMemoryMb: 0 },
        runningCount: 0,
        memory: { availableBytes: 0, pressure: "critical" },
      }),
    ).toEqual({ admit: true, slots: 3 });
  });

  it("orders agents by their oldest queued run for fairness", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
    expect(
      orderAgentsByOldestQueuedRun([
        { agentId: "busy", createdAt: at(5) },
        { agentId: "busy", createdAt: at(6) },
        { agentId: "busy", createdAt: at(7) },
        { agentId: "waiting", createdAt: at(1) },
        { agentId: "late", createdAt: at(9) },
      ]),
    ).toEqual(["waiting", "busy", "late"]);
  });

  it("reads macOS available memory as free + inactive + purgeable", () => {
    const vmStat = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               10000.",
      "Pages active:                            273829.",
      "Pages inactive:                          20000.",
      "Pages speculative:                         3594.",
      "Pages wired down:                        194746.",
      "Pages purgeable:                          5000.",
    ].join("\n");
    expect(parseVmStatAvailableBytes(vmStat)).toBe(35000 * 16384);
    expect(parseVmStatAvailableBytes("garbage")).toBeNull();
    expect(parseDarwinPressureLevel("1\n")).toBe("normal");
    expect(parseDarwinPressureLevel("2")).toBe("warn");
    expect(parseDarwinPressureLevel("4")).toBe("critical");
    expect(parseDarwinPressureLevel("")).toBe("unknown");
    expect(parseLinuxMemAvailableBytes("MemTotal: 100 kB\nMemAvailable:   2048 kB\n")).toBe(
      2048 * 1024,
    );
  });

  it("caches memory reads briefly so one drain pass reads once", async () => {
    let now = 0;
    const read = vi.fn(async () => ({ availableBytes: GB, pressure: "normal" as const }));
    const reader = createSystemMemoryReader(read, () => now);
    await reader();
    await reader();
    expect(read).toHaveBeenCalledTimes(1);
    now = 5_000;
    await reader();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("instance system memory (GRE-114)", () => {
  it("reports total RAM with the admission guard's available reading", async () => {
    const memory = await readInstanceSystemMemory(async () => ({
      availableBytes: 5 * GB,
      pressure: "normal",
    }));
    expect(memory).toEqual({
      totalBytes: os.totalmem(),
      availableBytes: 5 * GB,
      pressure: "normal",
    });
  });

  it("reports null available memory when it cannot be read", async () => {
    const memory = await readInstanceSystemMemory(async () => null);
    expect(memory.availableBytes).toBeNull();
    expect(memory.pressure).toBe("unknown");
    expect(memory.totalBytes).toBeGreaterThan(0);
  });
});
