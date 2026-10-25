import { z } from "zod";
import { DEEP_DIVE_VISIBILITIES, type DeepDiveVisibility } from "./deep-dive.js";
import type { DeepDiveFindingStatus } from "./deep-dive-findings.js";

/**
 * Deep Dive opportunities and KPIs (GRE-2370): Screen 7 of the GRE-2327 plan,
 * from the website Deep Dive Portal.
 *
 * An opportunity is a record, not a sentence on a finding: many validated
 * findings point at one opportunity, and one opportunity needs many builds.
 * A KPI is a number somebody owns, with a target and a baseline it can be
 * compared against, wired to the processes on the process board that move it.
 * Every link is a real foreign key, never a text id.
 */

export const DEEP_DIVE_OPPORTUNITY_STATES = ["draft", "refined", "validated"] as const;
export type DeepDiveOpportunityState = (typeof DEEP_DIVE_OPPORTUNITY_STATES)[number];

export const DEEP_DIVE_OPPORTUNITY_STATE_LABELS: Record<DeepDiveOpportunityState, string> = {
  draft: "Draft",
  refined: "Refined",
  validated: "Validated",
};

export const DEEP_DIVE_BUILD_STATES = [
  "proposed",
  "considering",
  "agreed",
  "building",
  "live",
  "deferred",
  "tabled",
  "cancelled",
] as const;
export type DeepDiveBuildState = (typeof DEEP_DIVE_BUILD_STATES)[number];

export const DEEP_DIVE_BUILD_STATE_LABELS: Record<DeepDiveBuildState, string> = {
  proposed: "Proposed",
  considering: "Considering",
  agreed: "Agreed",
  building: "Building",
  live: "Live",
  deferred: "Deferred",
  tabled: "Tabled",
  cancelled: "Cancelled",
};

/** A build in one of these states needs a reason, so somebody can revisit the decision later. */
export const DEEP_DIVE_BUILD_STATES_NEEDING_WHY: ReadonlySet<DeepDiveBuildState> = new Set([
  "considering",
  "deferred",
  "tabled",
  "cancelled",
]);

/** The same levels as an organisation unit, plus one person's own number. */
export const DEEP_DIVE_KPI_SCOPES = ["company", "division", "department", "team", "individual"] as const;
export type DeepDiveKpiScope = (typeof DEEP_DIVE_KPI_SCOPES)[number];

export const DEEP_DIVE_KPI_DIRECTIONS = ["up", "down", "steady"] as const;
export type DeepDiveKpiDirection = (typeof DEEP_DIVE_KPI_DIRECTIONS)[number];

export const DEEP_DIVE_KPI_DIRECTION_LABELS: Record<DeepDiveKpiDirection, string> = {
  up: "Higher is better",
  down: "Lower is better",
  steady: "Hold steady",
};

const name = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().trim().max(max);
const id = z.string().guid();
const visibility = z.enum(DEEP_DIVE_VISIBILITIES);
const links = z.array(id).max(200);
const value = z.number().finite().min(-1e12).max(1e12);

// Opportunities -------------------------------------------------------------

export const createDeepDiveOpportunitySchema = z
  .object({
    ref: text(40).optional(),
    name,
    statement: text(2_000).optional(),
    rootCause: text(2_000).optional(),
    /** Without a desired outcome it is an observation, not an opportunity. */
    desiredOutcome: z.string().trim().min(1).max(2_000),
    potentialValue: text(500).optional(),
    state: z.enum(DEEP_DIVE_OPPORTUNITY_STATES).optional(),
    /** The validated findings that point here. Replaces the whole set when sent. */
    findingIds: links.optional(),
  })
  .strict();
export type CreateDeepDiveOpportunity = z.infer<typeof createDeepDiveOpportunitySchema>;

export const updateDeepDiveOpportunitySchema = createDeepDiveOpportunitySchema
  .partial()
  .extend({ visibility: visibility.optional() })
  .strict();
export type UpdateDeepDiveOpportunity = z.infer<typeof updateDeepDiveOpportunitySchema>;

// Builds --------------------------------------------------------------------

const buildFields = {
  ref: text(40).optional(),
  name,
  what: text(2_000).optional(),
  /** The opportunity this build serves. Null: it serves none yet. */
  opportunityId: id.nullable().optional(),
  state: z.enum(DEEP_DIVE_BUILD_STATES).optional(),
  stateWhy: text(2_000).optional(),
};

function whyGiven(input: { state?: DeepDiveBuildState; stateWhy?: string }, ctx: z.RefinementCtx) {
  if (input.state && DEEP_DIVE_BUILD_STATES_NEEDING_WHY.has(input.state) && input.stateWhy !== undefined && !input.stateWhy) {
    ctx.addIssue({ code: "custom", path: ["stateWhy"], message: `"${input.state}" needs a reason` });
  }
}

export const createDeepDiveBuildSchema = z
  .object(buildFields)
  .strict()
  .superRefine((input, ctx) => {
    if (input.state && DEEP_DIVE_BUILD_STATES_NEEDING_WHY.has(input.state) && !input.stateWhy) {
      ctx.addIssue({ code: "custom", path: ["stateWhy"], message: `"${input.state}" needs a reason` });
    }
  });
export type CreateDeepDiveBuild = z.infer<typeof createDeepDiveBuildSchema>;

export const updateDeepDiveBuildSchema = z
  .object(buildFields)
  .partial()
  .extend({ visibility: visibility.optional() })
  .strict()
  .superRefine(whyGiven);
export type UpdateDeepDiveBuild = z.infer<typeof updateDeepDiveBuildSchema>;

// KPIs ----------------------------------------------------------------------

export const createDeepDiveKpiSchema = z
  .object({
    name,
    scope: z.enum(DEEP_DIVE_KPI_SCOPES).optional(),
    /** Whose number it is: a person on the organisation board. */
    ownerPersonId: id,
    unit: text(40).optional(),
    direction: z.enum(DEEP_DIVE_KPI_DIRECTIONS).optional(),
    baseline: value,
    /** How the number is calculated. Without it a later number cannot be compared. */
    definition: z.string().trim().min(1).max(2_000),
    /** The stretch of time the baseline covers. */
    baselinePeriod: z.string().trim().min(1).max(200),
    target: value,
    /** The processes on the process board that move it. Replaces the whole set when sent. */
    processIds: links.optional(),
  })
  .strict();
export type CreateDeepDiveKpi = z.infer<typeof createDeepDiveKpiSchema>;

export const updateDeepDiveKpiSchema = createDeepDiveKpiSchema
  .partial()
  .extend({ visibility: visibility.optional() })
  .strict();
export type UpdateDeepDiveKpi = z.infer<typeof updateDeepDiveKpiSchema>;

// The board -----------------------------------------------------------------

export interface DeepDiveOpportunity {
  id: string;
  ref: string;
  name: string;
  statement: string;
  rootCause: string;
  desiredOutcome: string;
  potentialValue: string;
  state: DeepDiveOpportunityState;
  /** The findings that point here, oldest link first. */
  findingIds: string[];
  visibility: DeepDiveVisibility;
}

export interface DeepDiveBuild {
  id: string;
  ref: string;
  name: string;
  what: string;
  opportunityId: string | null;
  state: DeepDiveBuildState;
  stateWhy: string;
  visibility: DeepDiveVisibility;
}

export interface DeepDiveKpi {
  id: string;
  name: string;
  scope: DeepDiveKpiScope;
  ownerPersonId: string;
  unit: string;
  direction: DeepDiveKpiDirection;
  baseline: number;
  definition: string;
  baselinePeriod: string;
  target: number;
  processIds: string[];
  visibility: DeepDiveVisibility;
}

/** A finding as the board shows it: every validated finding, and any finding already linked. */
export interface DeepDiveOpportunityFinding {
  id: string;
  statement: string;
  status: DeepDiveFindingStatus;
  streamTitle: string;
}

export interface DeepDiveOpportunityBoard {
  companyId: string;
  opportunities: DeepDiveOpportunity[];
  builds: DeepDiveBuild[];
  kpis: DeepDiveKpi[];
  findings: DeepDiveOpportunityFinding[];
  /** For pickers and labels: the process board's processes and the organisation board's people. */
  processes: { id: string; name: string }[];
  people: { id: string; name: string }[];
}

// Logic ---------------------------------------------------------------------

export function deepDiveBuildsFor(builds: readonly DeepDiveBuild[], opportunityId: string): DeepDiveBuild[] {
  return builds.filter((b) => b.opportunityId === opportunityId);
}

/** What still needs a person: the gaps the website portal counts on its overview. */
export function deepDiveOpportunityGaps(board: Pick<DeepDiveOpportunityBoard, "opportunities" | "builds" | "kpis">) {
  const served = new Set(board.builds.map((b) => b.opportunityId).filter(Boolean));
  return {
    opportunitiesWithNoFinding: board.opportunities.filter((o) => o.findingIds.length === 0),
    opportunitiesWithNoBuild: board.opportunities.filter((o) => !served.has(o.id)),
    buildsServingNothing: board.builds.filter((b) => !b.opportunityId),
    kpisMovedByNoProcess: board.kpis.filter((k) => k.processIds.length === 0),
  };
}

/** How far the target is from the baseline, in the direction that counts as better. */
export function deepDiveKpiChange(kpi: Pick<DeepDiveKpi, "baseline" | "target" | "direction">): {
  change: number;
  fitsDirection: boolean;
} {
  const change = kpi.target - kpi.baseline;
  const fitsDirection = kpi.direction === "up" ? change > 0 : kpi.direction === "down" ? change < 0 : change === 0;
  return { change, fitsDirection };
}
