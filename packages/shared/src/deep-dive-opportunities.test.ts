import { describe, expect, it } from "vitest";
import {
  createDeepDiveBuildSchema,
  createDeepDiveKpiSchema,
  createDeepDiveOpportunitySchema,
  deepDiveBuildsFor,
  deepDiveKpiChange,
  deepDiveOpportunityGaps,
  updateDeepDiveBuildSchema,
  type DeepDiveBuild,
  type DeepDiveKpi,
  type DeepDiveOpportunity,
} from "./deep-dive-opportunities.js";

const owner = "6f1c2a52-6b7e-4a8e-9f00-000000000001";

const opportunity = (id: string, findingIds: string[] = []): DeepDiveOpportunity => ({
  id, ref: "", name: id, statement: "", rootCause: "", desiredOutcome: "Faster", potentialValue: "",
  state: "draft", findingIds, visibility: "internal",
});
const build = (id: string, opportunityId: string | null): DeepDiveBuild => ({
  id, ref: "", name: id, what: "", opportunityId, state: "proposed", stateWhy: "", visibility: "internal",
});
const kpi = (id: string, processIds: string[] = []): DeepDiveKpi => ({
  id, name: id, scope: "company", ownerPersonId: owner, unit: "days", direction: "down",
  baseline: 8.4, definition: "Mean days", baselinePeriod: "Q3", target: 3, processIds, visibility: "internal",
});

describe("opportunity validators", () => {
  it("needs a desired outcome", () => {
    expect(createDeepDiveOpportunitySchema.safeParse({ name: "Faster quotes" }).success).toBe(false);
    expect(createDeepDiveOpportunitySchema.safeParse({ name: "Faster quotes", desiredOutcome: " " }).success).toBe(false);
    expect(createDeepDiveOpportunitySchema.safeParse({ name: "Faster quotes", desiredOutcome: "Quotes in a day" }).success).toBe(true);
  });

  it("needs a reason for a build that is considered, deferred, tabled or cancelled", () => {
    expect(createDeepDiveBuildSchema.safeParse({ name: "Portal", state: "tabled" }).success).toBe(false);
    expect(createDeepDiveBuildSchema.safeParse({ name: "Portal", state: "tabled", stateWhy: "Cost" }).success).toBe(true);
    expect(createDeepDiveBuildSchema.safeParse({ name: "Portal", state: "agreed" }).success).toBe(true);
    expect(updateDeepDiveBuildSchema.safeParse({ state: "cancelled", stateWhy: "" }).success).toBe(false);
  });
});

describe("KPI validator", () => {
  const base = { name: "Days to quote", ownerPersonId: owner, baseline: 8.4, definition: "Mean days", baselinePeriod: "Q3 2026", target: 3 };

  it("needs an owner, a target and a baseline with its definition and period", () => {
    expect(createDeepDiveKpiSchema.safeParse(base).success).toBe(true);
    for (const key of ["ownerPersonId", "target", "baseline", "definition", "baselinePeriod"] as const) {
      const { [key]: _gone, ...rest } = base;
      expect(createDeepDiveKpiSchema.safeParse(rest).success, key).toBe(false);
    }
    expect(createDeepDiveKpiSchema.safeParse({ ...base, baseline: Number.NaN }).success).toBe(false);
  });
});

describe("opportunity board logic", () => {
  it("lists builds per opportunity and the gaps still needing a person", () => {
    const board = {
      opportunities: [opportunity("o1", ["f1", "f2"]), opportunity("o2")],
      builds: [build("b1", "o1"), build("b2", "o1"), build("b3", null)],
      kpis: [kpi("k1", ["p1"]), kpi("k2")],
    };
    expect(deepDiveBuildsFor(board.builds, "o1").map((b) => b.id)).toEqual(["b1", "b2"]);
    const gaps = deepDiveOpportunityGaps(board);
    expect(gaps.opportunitiesWithNoFinding.map((o) => o.id)).toEqual(["o2"]);
    expect(gaps.opportunitiesWithNoBuild.map((o) => o.id)).toEqual(["o2"]);
    expect(gaps.buildsServingNothing.map((b) => b.id)).toEqual(["b3"]);
    expect(gaps.kpisMovedByNoProcess.map((k) => k.id)).toEqual(["k2"]);
  });

  it("says whether a target moves the way the KPI counts as better", () => {
    expect(deepDiveKpiChange({ baseline: 8.4, target: 3, direction: "down" }).fitsDirection).toBe(true);
    expect(deepDiveKpiChange({ baseline: 8.4, target: 9, direction: "down" }).fitsDirection).toBe(false);
    expect(deepDiveKpiChange({ baseline: 70, target: 90, direction: "up" })).toEqual({ change: 20, fitsDirection: true });
    expect(deepDiveKpiChange({ baseline: 5, target: 5, direction: "steady" }).fitsDirection).toBe(true);
  });
});
