import { describe, expect, it } from "vitest";
import { computeKpiStatus, plannedKpiValue, rollUpKpiStatus, type KpiPlan } from "./goal-kpi-status.js";

// Revenue KPI: 100 on 1 Jan, 200 by 31 Dec 2026 (364 days). Mid-year plan ≈ 150.
const plan: KpiPlan = {
  baselineValue: 100,
  baselineDate: "2026-01-01",
  targetValue: 200,
  targetDate: "2026-12-31",
  kpiDirection: "up",
  amberThresholdPct: null,
  redThresholdPct: null,
  createdAt: "2026-01-01T09:00:00.000Z",
};
const MID_YEAR = "2026-07-02"; // day 182 of 364: plan is exactly 150
const reading = (value: number, readingDate = MID_YEAR) => ({ value, readingDate });

describe("plannedKpiValue", () => {
  it("draws a straight line from baseline to target and stays flat outside it", () => {
    const baseline = reading(100, "2026-01-01");
    const target = reading(200, "2026-12-31");
    expect(plannedKpiValue(baseline, target, MID_YEAR)).toBe(150);
    expect(plannedKpiValue(baseline, target, "2025-06-01")).toBe(100);
    expect(plannedKpiValue(baseline, target, "2027-03-01")).toBe(200);
  });
});

describe("computeKpiStatus", () => {
  it("is green when the latest reading is on the planned path", () => {
    const result = computeKpiStatus(plan, reading(148), reading(100, "2026-01-01"), MID_YEAR);
    expect(result).toMatchObject({ status: "green", reason: "on_track", plannedValue: 150, gapPercent: 2 });
  });

  it("is green with no gap when ahead of plan", () => {
    expect(computeKpiStatus(plan, reading(170), null, MID_YEAR)).toMatchObject({ status: "green", gapPercent: 0 });
  });

  it("is amber from 10% off the planned change, red from 20%", () => {
    // Planned change is 100, so 10 short is 10% and 20 short is 20%.
    expect(computeKpiStatus(plan, reading(141), null, MID_YEAR)).toMatchObject({ status: "green", gapPercent: 9 });
    expect(computeKpiStatus(plan, reading(140), null, MID_YEAR)).toMatchObject({ status: "amber", reason: "behind_plan", gapPercent: 10 });
    expect(computeKpiStatus(plan, reading(131), null, MID_YEAR)).toMatchObject({ status: "amber", gapPercent: 19 });
    expect(computeKpiStatus(plan, reading(130), null, MID_YEAR)).toMatchObject({ status: "red", reason: "behind_plan", gapPercent: 20 });
  });

  it("uses the KPI's own thresholds", () => {
    const strict = { ...plan, amberThresholdPct: 2, redThresholdPct: 5 };
    expect(computeKpiStatus(strict, reading(147), null, MID_YEAR).status).toBe("amber");
    expect(computeKpiStatus(strict, reading(145), null, MID_YEAR).status).toBe("red");
  });

  it("treats down as good: above the planned path is behind", () => {
    // Churn from 20% to 10%: mid-year plan is 15.
    const churn = { ...plan, baselineValue: 20, targetValue: 10, kpiDirection: "down" as const };
    expect(computeKpiStatus(churn, reading(14), null, MID_YEAR)).toMatchObject({ status: "green", gapPercent: 0 });
    expect(computeKpiStatus(churn, reading(16), null, MID_YEAR)).toMatchObject({ status: "amber", gapPercent: 10 });
    expect(computeKpiStatus(churn, reading(17), null, MID_YEAR)).toMatchObject({ status: "red", gapPercent: 20 });
  });

  it("has no status when there is no reading", () => {
    expect(computeKpiStatus(plan, null, null, MID_YEAR)).toMatchObject({ status: null, reason: "no_reading" });
  });

  it("has no status without a target or a deadline", () => {
    expect(computeKpiStatus({ ...plan, targetValue: null }, reading(150), null, MID_YEAR).reason).toBe("no_plan");
    expect(computeKpiStatus({ ...plan, targetDate: null }, reading(150), null, MID_YEAR).reason).toBe("no_plan");
  });

  it("past the deadline: red when the target is not met, green when it is", () => {
    const after = "2027-01-15";
    expect(computeKpiStatus(plan, reading(195, "2027-01-10"), null, after)).toMatchObject({
      status: "red",
      reason: "deadline_missed",
      plannedValue: 200,
      gapPercent: 5,
    });
    expect(computeKpiStatus(plan, reading(201, "2027-01-10"), null, after)).toMatchObject({
      status: "green",
      reason: "target_met",
    });
    // A reading taken before the deadline is still judged against the target once it has passed.
    expect(computeKpiStatus(plan, reading(160, "2026-09-01"), null, after).reason).toBe("deadline_missed");
  });

  it("uses the first reading as the baseline when none is set", () => {
    const noBaseline = { ...plan, baselineValue: null, baselineDate: null };
    const result = computeKpiStatus(noBaseline, reading(140), reading(100, "2026-01-01"), MID_YEAR);
    expect(result).toMatchObject({ status: "amber", plannedValue: 150 });
    // One reading only: it is the baseline, so it is on plan.
    expect(computeKpiStatus(noBaseline, reading(140), reading(140), MID_YEAR).status).toBe("green");
  });
});

describe("rollUpKpiStatus", () => {
  // pillar → objective A → KPI 1 (green), KPI 2 (amber)
  //        → objective B → KPI 3 (red), KPI 4 (no reading)
  //        → objective C (cancelled) → KPI 5 (red)
  const goals = [
    { id: "pillar", parentId: null, kind: "pillar", status: "active" },
    { id: "objA", parentId: "pillar", kind: "objective", status: "active" },
    { id: "objB", parentId: "pillar", kind: "objective", status: "active" },
    { id: "objC", parentId: "pillar", kind: "objective", status: "cancelled" },
    { id: "kpi1", parentId: "objA", kind: "kpi", status: "active" },
    { id: "kpi2", parentId: "objA", kind: "kpi", status: "active" },
    { id: "kpi3", parentId: "objB", kind: "kpi", status: "active" },
    { id: "kpi4", parentId: "objB", kind: "kpi", status: "active" },
    { id: "kpi5", parentId: "objC", kind: "kpi", status: "active" },
  ];
  const statuses = new Map([
    ["kpi1", "green" as const],
    ["kpi2", "amber" as const],
    ["kpi3", "red" as const],
    ["kpi4", null],
    ["kpi5", "red" as const],
  ]);

  it("worst child wins from KPI to objective to pillar", () => {
    const rollup = rollUpKpiStatus(goals, statuses);
    expect(rollup.get("kpi1")).toEqual({ status: "green", red: 0, amber: 0, green: 1, noStatus: 0 });
    expect(rollup.get("objA")).toEqual({ status: "amber", red: 0, amber: 1, green: 1, noStatus: 0 });
    expect(rollup.get("objB")).toEqual({ status: "red", red: 1, amber: 0, green: 0, noStatus: 1 });
    // The cancelled objective's red KPI is left out of the pillar.
    expect(rollup.get("pillar")).toEqual({ status: "red", red: 1, amber: 1, green: 1, noStatus: 1 });
  });

  it("a branch with only unread KPIs has no status; one green KPI makes it green", () => {
    const rollup = rollUpKpiStatus(goals, new Map([["kpi1", "green" as const]]));
    expect(rollup.get("objB")?.status).toBeNull();
    expect(rollup.get("pillar")).toMatchObject({ status: "green", green: 1, noStatus: 3 });
  });

  it("survives a parent cycle in old data", () => {
    const cyclic = [
      { id: "a", parentId: "b", kind: "objective", status: "active" },
      { id: "b", parentId: "a", kind: "pillar", status: "active" },
    ];
    expect(() => rollUpKpiStatus(cyclic, new Map())).not.toThrow();
  });
});
