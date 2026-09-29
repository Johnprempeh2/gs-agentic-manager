import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  createSystemDiskReader,
  createSystemMemoryReader,
  DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS,
  DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
  DEFAULT_RUN_ADMISSION_MIN_FREE_DISK_GB,
  evaluateRunAdmission,
  orderAgentsByOldestQueuedRun,
  parseDarwinPressureLevel,
  parseLinuxMemAvailableBytes,
  parseVmStatAvailableBytes,
  readFreeDiskBytes,
  readInstanceSystemMemory,
  resolveRunAdmissionSettings,
} from "../services/run-admission.js";

const GB = 1024 * 1024 * 1024;
const settings = { maxConcurrentRuns: 3, minAvailableMemoryMb: 2048, minFreeDiskGb: 20 };

describe("run admission (GRE-105)", () => {
  it("uses safe defaults when no setting is stored", () => {
    expect(DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB).toBe(2048);
    expect(resolveRunAdmissionSettings({})).toEqual({
      maxConcurrentRuns: DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS,
      minAvailableMemoryMb: DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
      minFreeDiskGb: DEFAULT_RUN_ADMISSION_MIN_FREE_DISK_GB,
    });
    expect(
      resolveRunAdmissionSettings({ runAdmission: { maxConcurrentRuns: 10 } }),
    ).toEqual({ maxConcurrentRuns: 10, minAvailableMemoryMb: 2048, minFreeDiskGb: 20 });
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
    expect(low.admit ? "" : low.message).toMatch(/^Waiting: low memory/);

    expect(
      evaluateRunAdmission({
        settings,
        runningCount: 0,
        memory: { availableBytes: 3 * GB, pressure: "normal" },
      }),
    ).toEqual({ admit: true, slots: 3 });
  });

  it("never holds on OS memory pressure while free memory is above the floor (GRE-198)", () => {
    // macOS reports "warn" as its normal state; John saw every run held with 6 GB free.
    for (const pressure of ["warn", "critical"] as const) {
      expect(
        evaluateRunAdmission({
          settings,
          runningCount: 0,
          memory: { availableBytes: 6 * GB, pressure },
        }),
      ).toEqual({ admit: true, slots: 3 });
    }
  });

  it("holds below the floor with a readable waiting message (GRE-198)", () => {
    const held = evaluateRunAdmission({
      settings,
      runningCount: 0,
      memory: { availableBytes: 1.6 * GB, pressure: "normal" },
    });
    expect(held).toEqual({
      admit: false,
      reason: "low_memory",
      message: "Waiting: low memory (1.6 GB free, floor 2 GB)",
    });
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

  describe("disk floor (GRE-207)", () => {
    const memory = { availableBytes: 8 * GB, pressure: "normal" as const };

    it("defaults the floor to 20 GB", () => {
      expect(DEFAULT_RUN_ADMISSION_MIN_FREE_DISK_GB).toBe(20);
    });

    it("holds below the floor with the waiting message", () => {
      expect(
        evaluateRunAdmission({
          settings,
          runningCount: 0,
          memory,
          disk: { availableBytes: 12.7 * GB },
        }),
      ).toEqual({
        admit: false,
        reason: "low_disk",
        message: "Waiting: low disk (12 GB free, floor 20 GB)",
      });
      // Near-empty disk keeps a decimal instead of reading "0 GB".
      const nearFull = evaluateRunAdmission({
        settings,
        runningCount: 0,
        memory,
        disk: { availableBytes: 0.5 * GB },
      });
      expect(nearFull.admit ? "" : nearFull.message).toBe(
        "Waiting: low disk (0.5 GB free, floor 20 GB)",
      );
    });

    it("admits at or above the floor", () => {
      for (const free of [20, 21, 200]) {
        expect(
          evaluateRunAdmission({
            settings,
            runningCount: 0,
            memory,
            disk: { availableBytes: free * GB },
          }),
        ).toEqual({ admit: true, slots: 3 });
      }
    });

    it("a 0 floor disables the disk check, and an unreadable disk fails open", () => {
      expect(
        evaluateRunAdmission({
          settings: { ...settings, minFreeDiskGb: 0 },
          runningCount: 0,
          memory,
          disk: { availableBytes: 0 },
        }),
      ).toEqual({ admit: true, slots: 3 });
      expect(
        evaluateRunAdmission({ settings, runningCount: 0, memory, disk: null }),
      ).toEqual({ admit: true, slots: 3 });
    });

    it("reports the global cap before disk", () => {
      expect(
        evaluateRunAdmission({
          settings,
          runningCount: 3,
          memory,
          disk: { availableBytes: 1 * GB },
        }),
      ).toMatchObject({ admit: false, reason: "global_cap" });
    });

    it("reads the fullest of the watched volumes and skips unreadable paths", async () => {
      const volumes: Record<string, { bavail: number; bsize: number }> = {
        "/data": { bavail: 30 * 1024 * 1024, bsize: 1024 },
        "/home": { bavail: 12 * 1024 * 1024, bsize: 1024 },
      };
      const statFs = async (path: string) => {
        const stats = volumes[path];
        if (!stats) throw new Error("ENOENT");
        return stats;
      };
      expect(await readFreeDiskBytes(["/data", "/home", "/missing"], statFs)).toEqual({
        availableBytes: 12 * GB,
      });
      expect(await readFreeDiskBytes(["/missing"], statFs)).toBeNull();
    });

    it("reads a real volume", async () => {
      const snapshot = await readFreeDiskBytes([os.tmpdir()]);
      expect(snapshot?.availableBytes).toBeGreaterThan(0);
    });

    it("caches disk reads briefly", async () => {
      let now = 0;
      const read = vi.fn(async () => ({ availableBytes: GB }));
      const reader = createSystemDiskReader(() => ["/data"], () => now, read);
      await reader();
      await reader();
      expect(read).toHaveBeenCalledTimes(1);
      now = 11_000;
      await reader();
      expect(read).toHaveBeenCalledTimes(2);
    });
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
