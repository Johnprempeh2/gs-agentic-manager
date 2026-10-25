import { z } from "zod";
import { DEEP_DIVE_RECORD_DOCUMENTS, DEEP_DIVE_VISIBILITIES, type DeepDiveVisibility } from "./deep-dive.js";
import type { DeepDiveFindingStatus } from "./deep-dive-findings.js";
import type { DeepDiveBuildState } from "./deep-dive-opportunities.js";

/**
 * Deep Dive traceability (GRE-2371): Screen 8 of the GRE-2327 plan, from
 * Indago, made stronger. The chain
 *   North Star → Source → Finding → Opportunity → Design → Commercial → Roadmap → KPI
 * is held as real links, never text ids:
 * - North Star: the north-star document of the Deep Dive record (one per Deep Dive).
 * - Source: the evidence a finding rests on (deep_dive_finding_evidence).
 * - Finding → Opportunity: deep_dive_opportunity_findings.
 * - Design: a build that serves the opportunity (deep_dive_builds.opportunity_id).
 * - Commercial: the commercial case for a design (deep_dive_commercials.build_id).
 * - Roadmap: when that commercial case is delivered (deep_dive_roadmap_items.commercial_id).
 * - KPI: the numbers a roadmap item moves (deep_dive_roadmap_kpis).
 * deepDiveBrokenLinks lists every place the chain breaks.
 */

export const DEEP_DIVE_CHAIN_STEPS = [
  "north_star",
  "source",
  "finding",
  "opportunity",
  "design",
  "commercial",
  "roadmap",
  "kpi",
] as const;
export type DeepDiveChainStep = (typeof DEEP_DIVE_CHAIN_STEPS)[number];

export const DEEP_DIVE_CHAIN_STEP_LABELS: Record<DeepDiveChainStep, string> = {
  north_star: "North Star",
  source: "Source",
  finding: "Finding",
  opportunity: "Opportunity",
  design: "Design",
  commercial: "Commercial",
  roadmap: "Roadmap",
  kpi: "KPI",
};

/** A design that will not be built carries no chain onwards, so it needs no commercial case. */
export const DEEP_DIVE_DESIGN_STATES_OUT_OF_CHAIN: ReadonlySet<DeepDiveBuildState> = new Set(["tabled", "cancelled"]);

const name = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().trim().max(max);
const id = z.string().guid();
const visibility = z.enum(DEEP_DIVE_VISIBILITIES);

// Commercial ----------------------------------------------------------------

export const createDeepDiveCommercialSchema = z
  .object({
    /** The design (build) this is the commercial case for. Null: none yet, which the check reports. */
    buildId: id.nullable().optional(),
    name,
    /** What it costs and how it is paid. */
    terms: text(2_000).optional(),
    /** What it is worth to the client. */
    value: text(2_000).optional(),
  })
  .strict();
export type CreateDeepDiveCommercial = z.infer<typeof createDeepDiveCommercialSchema>;

export const updateDeepDiveCommercialSchema = createDeepDiveCommercialSchema
  .partial()
  .extend({ visibility: visibility.optional() })
  .strict();
export type UpdateDeepDiveCommercial = z.infer<typeof updateDeepDiveCommercialSchema>;

// Roadmap -------------------------------------------------------------------

export const createDeepDiveRoadmapItemSchema = z
  .object({
    /** The commercial case this delivers. Null: none yet, which the check reports. */
    commercialId: id.nullable().optional(),
    name,
    /** When, in the client's words: "Phase 1", "Q1 2027". */
    phase: text(200).optional(),
    /** The KPIs this moves. Replaces the whole set when sent. */
    kpiIds: z.array(id).max(200).optional(),
  })
  .strict();
export type CreateDeepDiveRoadmapItem = z.infer<typeof createDeepDiveRoadmapItemSchema>;

export const updateDeepDiveRoadmapItemSchema = createDeepDiveRoadmapItemSchema
  .partial()
  .extend({ visibility: visibility.optional() })
  .strict();
export type UpdateDeepDiveRoadmapItem = z.infer<typeof updateDeepDiveRoadmapItemSchema>;

// The chain -----------------------------------------------------------------

export interface DeepDiveTraceSource {
  id: string;
  title: string;
}

export interface DeepDiveTraceFinding {
  id: string;
  statement: string;
  status: DeepDiveFindingStatus;
  sourceIds: string[];
}

export interface DeepDiveTraceOpportunity {
  id: string;
  name: string;
  findingIds: string[];
}

export interface DeepDiveTraceDesign {
  id: string;
  name: string;
  state: DeepDiveBuildState;
  opportunityId: string | null;
}

export interface DeepDiveCommercial {
  id: string;
  name: string;
  terms: string;
  value: string;
  buildId: string | null;
  visibility: DeepDiveVisibility;
}

export interface DeepDiveRoadmapItem {
  id: string;
  name: string;
  phase: string;
  commercialId: string | null;
  kpiIds: string[];
  visibility: DeepDiveVisibility;
}

export interface DeepDiveTraceKpi {
  id: string;
  name: string;
}

export interface DeepDiveTraceability {
  companyId: string;
  /** The North Star document, or null when it is not recorded yet. */
  northStar: { documentId: string; words: string } | null;
  sources: DeepDiveTraceSource[];
  /** Validated findings, and any finding an opportunity points at. */
  findings: DeepDiveTraceFinding[];
  opportunities: DeepDiveTraceOpportunity[];
  designs: DeepDiveTraceDesign[];
  commercials: DeepDiveCommercial[];
  roadmap: DeepDiveRoadmapItem[];
  kpis: DeepDiveTraceKpi[];
  /** Every place the chain breaks, worked out by deepDiveBrokenLinks. */
  broken: DeepDiveBrokenLink[];
}

export interface DeepDiveBrokenLink {
  /** The item that is missing a link, or null for the North Star itself. */
  step: DeepDiveChainStep;
  itemId: string | null;
  itemName: string;
  /** The step on the other side of the missing link. */
  missing: DeepDiveChainStep;
  message: string;
}

/** The words of the North Star document: neither headings nor the stub's own prompt. */
export function deepDiveNorthStarWords(body: string | null | undefined): string {
  const prompt = DEEP_DIVE_RECORD_DOCUMENTS[0].prompt;
  return (body ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^[-*+]\s+/, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#") && line !== prompt)
    .join(" ");
}

/**
 * Every place the chain breaks. Walks the links forward from the North Star:
 * a finding an opportunity rests on needs a source and must not be
 * superseded; an opportunity needs a finding and a live design; a live design
 * needs its opportunity and a commercial case; a commercial case needs its
 * design and a roadmap item; a roadmap item needs its commercial case and a
 * KPI; a KPI needs a roadmap item that moves it. A finding no opportunity
 * rests on is not part of a chain yet, so it is not listed.
 */
export function deepDiveBrokenLinks(
  chain: Omit<DeepDiveTraceability, "companyId" | "broken">,
): DeepDiveBrokenLink[] {
  const broken: DeepDiveBrokenLink[] = [];
  const add = (step: DeepDiveChainStep, itemId: string | null, itemName: string, missing: DeepDiveChainStep, message: string) =>
    broken.push({ step, itemId, itemName, missing, message });

  if (!chain.northStar || !chain.northStar.words) {
    add("north_star", null, "North Star", "source", "No North Star is recorded, so no chain has a start.");
  }

  const sourceIds = new Set(chain.sources.map((s) => s.id));
  const findings = new Map(chain.findings.map((f) => [f.id, f]));
  const opportunityIds = new Set(chain.opportunities.map((o) => o.id));
  const live = chain.designs.filter((d) => !DEEP_DIVE_DESIGN_STATES_OUT_OF_CHAIN.has(d.state));
  const designIds = new Set(chain.designs.map((d) => d.id));
  const commercialIds = new Set(chain.commercials.map((c) => c.id));
  const kpiIds = new Set(chain.kpis.map((k) => k.id));

  const usedFindingIds = new Set(chain.opportunities.flatMap((o) => o.findingIds));
  for (const finding of chain.findings) {
    if (!usedFindingIds.has(finding.id)) continue;
    if (!finding.sourceIds.some((s) => sourceIds.has(s))) {
      add("finding", finding.id, finding.statement, "source", "This finding rests on no source.");
    }
    if (finding.status === "superseded") {
      add("finding", finding.id, finding.statement, "opportunity", "This finding is superseded. Link the finding that replaced it.");
    }
  }

  for (const opportunity of chain.opportunities) {
    if (!opportunity.findingIds.some((f) => findings.has(f))) {
      add("opportunity", opportunity.id, opportunity.name, "finding", "This opportunity rests on no finding.");
    }
    if (!live.some((d) => d.opportunityId === opportunity.id)) {
      add("opportunity", opportunity.id, opportunity.name, "design", "No design serves this opportunity.");
    }
  }

  for (const design of live) {
    if (!design.opportunityId || !opportunityIds.has(design.opportunityId)) {
      add("design", design.id, design.name, "opportunity", "This design serves no opportunity.");
    }
    if (!chain.commercials.some((c) => c.buildId === design.id)) {
      add("design", design.id, design.name, "commercial", "This design has no commercial case.");
    }
  }

  for (const commercial of chain.commercials) {
    if (!commercial.buildId || !designIds.has(commercial.buildId)) {
      add("commercial", commercial.id, commercial.name, "design", "This commercial case is for no design.");
    }
    if (!chain.roadmap.some((r) => r.commercialId === commercial.id)) {
      add("commercial", commercial.id, commercial.name, "roadmap", "This commercial case is on no roadmap.");
    }
  }

  for (const item of chain.roadmap) {
    if (!item.commercialId || !commercialIds.has(item.commercialId)) {
      add("roadmap", item.id, item.name, "commercial", "This roadmap item delivers no commercial case.");
    }
    if (!item.kpiIds.some((k) => kpiIds.has(k))) {
      add("roadmap", item.id, item.name, "kpi", "This roadmap item moves no KPI.");
    }
  }

  const movedKpiIds = new Set(chain.roadmap.flatMap((r) => r.kpiIds));
  for (const kpi of chain.kpis) {
    if (!movedKpiIds.has(kpi.id)) {
      add("kpi", kpi.id, kpi.name, "roadmap", "No roadmap item moves this KPI.");
    }
  }

  return broken;
}

/** One opportunity's whole chain, step by step, for the chain view. */
export interface DeepDiveChain {
  opportunity: DeepDiveTraceOpportunity;
  steps: Record<DeepDiveChainStep, { id: string; name: string }[]>;
}

/** The chain through each opportunity. An empty step is where that chain breaks. */
export function deepDiveChains(chain: Omit<DeepDiveTraceability, "companyId" | "broken">): DeepDiveChain[] {
  return chain.opportunities.map((opportunity) => {
    const findings = chain.findings.filter((f) => opportunity.findingIds.includes(f.id));
    const sourceIds = new Set(findings.flatMap((f) => f.sourceIds));
    const designs = chain.designs.filter(
      (d) => d.opportunityId === opportunity.id && !DEEP_DIVE_DESIGN_STATES_OUT_OF_CHAIN.has(d.state),
    );
    const commercials = chain.commercials.filter((c) => designs.some((d) => d.id === c.buildId));
    const roadmap = chain.roadmap.filter((r) => commercials.some((c) => c.id === r.commercialId));
    const kpiIds = new Set(roadmap.flatMap((r) => r.kpiIds));
    return {
      opportunity,
      steps: {
        north_star: chain.northStar?.words ? [{ id: chain.northStar.documentId, name: chain.northStar.words }] : [],
        source: chain.sources.filter((s) => sourceIds.has(s.id)).map((s) => ({ id: s.id, name: s.title })),
        finding: findings.map((f) => ({ id: f.id, name: f.statement })),
        opportunity: [{ id: opportunity.id, name: opportunity.name }],
        design: designs.map((d) => ({ id: d.id, name: d.name })),
        commercial: commercials.map((c) => ({ id: c.id, name: c.name })),
        roadmap: roadmap.map((r) => ({ id: r.id, name: r.name })),
        kpi: chain.kpis.filter((k) => kpiIds.has(k.id)).map((k) => ({ id: k.id, name: k.name })),
      },
    };
  });
}
