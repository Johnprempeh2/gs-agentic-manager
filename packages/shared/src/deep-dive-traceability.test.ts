import { describe, expect, it } from "vitest";
import {
  createDeepDiveCommercialSchema,
  createDeepDiveRoadmapItemSchema,
  deepDiveBrokenLinks,
  deepDiveChains,
  deepDiveNorthStarWords,
  updateDeepDiveRoadmapItemSchema,
  type DeepDiveTraceability,
} from "./deep-dive-traceability.js";

type Chain = Omit<DeepDiveTraceability, "companyId" | "broken">;

/** North Star → Source → Finding → Opportunity → Design → Commercial → Roadmap → KPI, every link made. */
function fullChain(): Chain {
  return {
    northStar: { documentId: "ns", words: "Same-day quotes for every customer" },
    sources: [{ id: "src", title: "Quote log 2026" }],
    findings: [{ id: "f", statement: "Quotes take 8 days", status: "validated", sourceIds: ["src"] }],
    opportunities: [{ id: "o", name: "Faster quotes", findingIds: ["f"] }],
    designs: [{ id: "d", name: "Quote builder", state: "agreed", opportunityId: "o" }],
    commercials: [{ id: "c", name: "Fixed fee", terms: "", value: "", buildId: "d", visibility: "internal" }],
    roadmap: [{ id: "r", name: "Phase 1", phase: "Q1 2027", commercialId: "c", kpiIds: ["k"], visibility: "internal" }],
    kpis: [{ id: "k", name: "Days to quote" }],
  };
}

const where = (chain: Chain) => deepDiveBrokenLinks(chain).map((b) => `${b.step}->${b.missing}`);

describe("deepDiveBrokenLinks", () => {
  it("finds nothing broken in a full chain", () => {
    expect(deepDiveBrokenLinks(fullChain())).toEqual([]);
  });

  it("lists the break on both sides when a commercial case is missing", () => {
    const chain = { ...fullChain(), commercials: [] };
    expect(where(chain)).toEqual(["design->commercial", "roadmap->commercial"]);
    const [design] = deepDiveBrokenLinks(chain);
    expect(design).toMatchObject({ itemId: "d", itemName: "Quote builder", message: "This design has no commercial case." });
  });

  it("reports a missing North Star", () => {
    expect(where({ ...fullChain(), northStar: null })).toEqual(["north_star->source"]);
    expect(where({ ...fullChain(), northStar: { documentId: "ns", words: "" } })).toEqual(["north_star->source"]);
  });

  it("reports a finding with no source, and a superseded finding still linked", () => {
    const chain = fullChain();
    chain.findings = [{ id: "f", statement: "Quotes take 8 days", status: "superseded", sourceIds: [] }];
    expect(where(chain)).toEqual(["finding->source", "finding->opportunity"]);
  });

  it("does not list a finding no opportunity rests on", () => {
    const chain = fullChain();
    chain.findings.push({ id: "loose", statement: "Unused", status: "validated", sourceIds: [] });
    expect(deepDiveBrokenLinks(chain)).toEqual([]);
  });

  it("reports an opportunity with no finding and no live design; a cancelled design does not count", () => {
    const chain = fullChain();
    chain.opportunities = [{ id: "o", name: "Faster quotes", findingIds: [] }];
    chain.designs = [{ id: "d", name: "Quote builder", state: "cancelled", opportunityId: "o" }];
    expect(where(chain)).toEqual([
      "opportunity->finding",
      "opportunity->design",
      // The commercial case points at a design, so it stays linked; the cancelled design is not reported.
    ]);
  });

  it("reports a roadmap item that moves no KPI, and a KPI no roadmap item moves", () => {
    const chain = fullChain();
    chain.roadmap = [{ ...chain.roadmap[0]!, kpiIds: [] }];
    expect(where(chain)).toEqual(["roadmap->kpi", "kpi->roadmap"]);
  });

  it("reports a design, commercial case or roadmap item whose upstream item is gone", () => {
    const chain = fullChain();
    chain.designs = [{ id: "d", name: "Quote builder", state: "agreed", opportunityId: null }];
    chain.commercials = [{ ...chain.commercials[0]!, buildId: null }, { id: "c2", name: "Orphan", terms: "", value: "", buildId: "d", visibility: "internal" }];
    chain.roadmap = [{ ...chain.roadmap[0]!, commercialId: "c2" }];
    expect(where(chain)).toEqual([
      "opportunity->design",
      "design->opportunity",
      "commercial->design",
      "commercial->roadmap",
    ]);
  });
});

describe("deepDiveChains", () => {
  it("shows every step of a full chain", () => {
    const [chain] = deepDiveChains(fullChain());
    expect(Object.values(chain!.steps).map((items) => items.map((i) => i.name))).toEqual([
      ["Same-day quotes for every customer"],
      ["Quote log 2026"],
      ["Quotes take 8 days"],
      ["Faster quotes"],
      ["Quote builder"],
      ["Fixed fee"],
      ["Phase 1"],
      ["Days to quote"],
    ]);
  });

  it("leaves every step after the break empty", () => {
    const [chain] = deepDiveChains({ ...fullChain(), commercials: [] });
    expect(chain!.steps.design).toHaveLength(1);
    expect(chain!.steps.commercial).toEqual([]);
    expect(chain!.steps.roadmap).toEqual([]);
    expect(chain!.steps.kpi).toEqual([]);
  });
});

describe("North Star words", () => {
  it("ignores headings and the stub prompt", () => {
    expect(deepDiveNorthStarWords("# North Star\n\nThe chief executive's words, who said them and when.\n")).toBe("");
    expect(deepDiveNorthStarWords("# North Star\n\n- Same-day quotes\n- CEO, 3 Oct")).toBe("Same-day quotes CEO, 3 Oct");
  });
});

describe("validators", () => {
  it("needs a name for a commercial case and a roadmap item", () => {
    expect(createDeepDiveCommercialSchema.safeParse({ terms: "Fixed fee" }).success).toBe(false);
    expect(createDeepDiveCommercialSchema.safeParse({ name: "Fixed fee", buildId: null }).success).toBe(true);
    expect(createDeepDiveRoadmapItemSchema.safeParse({ name: "Phase 1", kpiIds: ["not-an-id"] }).success).toBe(false);
    expect(updateDeepDiveRoadmapItemSchema.safeParse({ visibility: "shared" }).success).toBe(true);
    expect(updateDeepDiveRoadmapItemSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
