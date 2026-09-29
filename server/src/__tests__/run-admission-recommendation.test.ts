import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { runAdmissionRecommendationRoutes } from "../routes/run-admission-recommendation.js";
import {
  computePeakConcurrentRuns,
  percentile,
  ramRuleCap,
  recommendRunAdmission,
  recordRunAdmissionHold,
  recordRunAdmissionRelease,
  resetRunAdmissionHoldLog,
  summarizeHoldLog,
  type RecommendationInput,
} from "../services/run-admission-recommendation.js";

const GB = 1024;

function input(overrides: {
  current?: Partial<RecommendationInput["current"]>;
  system?: Partial<RecommendationInput["system"]>;
  usage?: Partial<RecommendationInput["usage"]>;
} = {}): RecommendationInput {
  return {
    current: { maxConcurrentRuns: 6, minAvailableMemoryMb: 2048, ...overrides.current },
    system: { totalMemoryMb: 16 * GB, availableMemoryMb: 8 * GB, cpuCount: 10, ...overrides.system },
    usage: {
      runsStarted: 40,
      peakConcurrentRuns: 5,
      globalCapHeldRuns: 0,
      lowMemoryHeldRuns: 0,
      perRunMemoryRecorded: false,
      ...overrides.usage,
    },
  };
}

describe("recommendRunAdmission", () => {
  it("RAM rule: (total - floor) / 500 MB, clamped to at least 1", () => {
    expect(ramRuleCap(16 * GB, 2048)).toBe(28);
    expect(ramRuleCap(8 * GB, 2048)).toBe(12);
    expect(ramRuleCap(1 * GB, 2048)).toBe(1);
  });

  it("no holds: suggests the RAM rule and keeps the floor", () => {
    const result = recommendRunAdmission(input());
    expect(result.suggested).toEqual({ maxConcurrentRuns: 28, minAvailableMemoryMb: 2048 });
    expect(result.reasons.join("\n")).toMatch(/RAM rule/);
    expect(result.reasons.join("\n")).toMatch(/Memory use per run is not recorded/);
  });

  it("many cap holds with spare RAM: raises the current cap by one", () => {
    const result = recommendRunAdmission(
      input({ usage: { globalCapHeldRuns: 12, peakConcurrentRuns: 6 } }),
    );
    expect(result.suggested.maxConcurrentRuns).toBe(7);
    expect(result.reasons.join("\n")).toMatch(/raise the cap by one to 7/);
  });

  it("many cap holds but free RAM at the floor: does not raise", () => {
    const result = recommendRunAdmission(
      input({ usage: { globalCapHeldRuns: 12 }, system: { availableMemoryMb: 1500 } }),
    );
    expect(result.suggested.maxConcurrentRuns).toBe(28);
    expect(result.reasons.join("\n")).toMatch(/not raised/);
  });

  it("many low-RAM holds: lowers the cap below the smallest of rule, cap and peak", () => {
    const result = recommendRunAdmission(
      input({ usage: { lowMemoryHeldRuns: 5, globalCapHeldRuns: 9, peakConcurrentRuns: 4 } }),
    );
    expect(result.suggested.maxConcurrentRuns).toBe(3);
    expect(result.reasons.join("\n")).toMatch(/held for low RAM/);
  });

  it("low-RAM holds never push the cap below 1", () => {
    const result = recommendRunAdmission(
      input({ current: { maxConcurrentRuns: 1 }, usage: { lowMemoryHeldRuns: 3 } }),
    );
    expect(result.suggested.maxConcurrentRuns).toBe(1);
  });

  it("no data: RAM rule only, and says so", () => {
    const result = recommendRunAdmission(
      input({ usage: { runsStarted: 0, peakConcurrentRuns: 0 } }),
    );
    expect(result.suggested).toEqual({ maxConcurrentRuns: 28, minAvailableMemoryMb: 2048 });
    expect(result.reasons.join("\n")).toMatch(/No runs in the last 7 days/);
  });

  it("RAM check off: suggests the default floor", () => {
    const result = recommendRunAdmission(input({ current: { minAvailableMemoryMb: 0 } }));
    expect(result.suggested.minAvailableMemoryMb).toBe(2048);
    expect(result.reasons[0]).toMatch(/RAM check is off/);
  });
});

describe("computePeakConcurrentRuns", () => {
  it("counts overlaps, treats back-to-back runs as not overlapping", () => {
    expect(computePeakConcurrentRuns([])).toBe(0);
    expect(
      computePeakConcurrentRuns([
        { startedAt: 0, finishedAt: 10 },
        { startedAt: 10, finishedAt: 20 },
      ]),
    ).toBe(1);
    expect(
      computePeakConcurrentRuns(
        [
          { startedAt: 0, finishedAt: 10 },
          { startedAt: 5, finishedAt: 15 },
          { startedAt: 6, finishedAt: null },
        ],
        100,
      ),
    ).toBe(3);
  });

  it("percentile uses nearest rank", () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });
});

describe("run admission hold log", () => {
  beforeEach(() => resetRunAdmissionHoldLog(0));

  it("counts distinct held runs per kind and their hold time", () => {
    recordRunAdmissionHold("a", "global_cap", 1_000);
    recordRunAdmissionHold("a", "global_cap", 2_000); // same hold, ignored
    recordRunAdmissionHold("b", "global_cap", 1_000);
    recordRunAdmissionHold("b", "memory_pressure", 4_000); // reason change
    recordRunAdmissionRelease("a", 11_000);
    recordRunAdmissionRelease("b", 9_000);
    const summary = summarizeHoldLog(20_000);
    expect(summary.globalCap).toEqual({ runs: 2, p95HoldMs: 10_000 });
    expect(summary.lowMemory).toEqual({ runs: 1, p95HoldMs: 5_000 });
  });

  it("ignores unknown reasons", () => {
    recordRunAdmissionHold("a", "something_else", 1_000);
    expect(summarizeHoldLog(2_000).globalCap.runs).toBe(0);
    expect(summarizeHoldLog(2_000).lowMemory.runs).toBe(0);
  });
});

describe("GET /instance/run-admission/recommendation", () => {
  function createApp(actor: unknown) {
    const body = {
      windowDays: 7,
      current: { maxConcurrentRuns: 6, minAvailableMemoryMb: 2048 },
      suggested: { maxConcurrentRuns: 7, minAvailableMemoryMb: 2048 },
      reasons: ["x"],
    };
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", runAdmissionRecommendationRoutes({} as any, { get: async () => body as any }));
    app.use(errorHandler);
    return { app, body };
  }

  it("returns the suggestion to a board user", async () => {
    const { app, body } = createApp({ type: "board", source: "local_implicit" });
    const res = await request(app).get("/api/instance/run-admission/recommendation");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
  });

  it("rejects agents", async () => {
    const { app } = createApp({ type: "agent", agentId: "a", companyId: "c" });
    const res = await request(app).get("/api/instance/run-admission/recommendation");
    expect(res.status).toBe(403);
  });
});
