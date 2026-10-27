import { z } from "zod";
import type { DeepDiveInterviewProposal } from "./deep-dive-interview-synthesis.js";

/**
 * Parallel Interview release (GRE-2667), slice 4 of GRE-2611.
 *
 * A person releases the reviewed synthesis: GSAM builds it from the accepted
 * themes and their accepted quotes, and pushes it to the website keyed by the
 * organisation id (`POST rounds/{roundId}/synthesis/released`,
 * contracts/gs-interview-v1). The client sees only what was released, and
 * withdraw takes it away at once. Rejected and undecided items, people and
 * roles never leave GSAM.
 */

export const GS_INTERVIEW_SYNTHESIS_SCHEMA = "gs-interview-synthesis-v1";
export const DEEP_DIVE_RELEASE_MODEL_VERSION = "gsam-reviewed-1";
export const DEEP_DIVE_RELEASE_MAX_HEADLINE = 1_000;

export const releaseDeepDiveInterviewSynthesisSchema = z
  .object({
    /** The one-line read the client sees first, in the person's words. */
    headline: z.string().trim().min(1, "Write the headline the client reads first").max(DEEP_DIVE_RELEASE_MAX_HEADLINE),
  })
  .strict();
export type ReleaseDeepDiveInterviewSynthesis = z.infer<typeof releaseDeepDiveInterviewSynthesisSchema>;

export interface GsInterviewEvidenceQuote {
  insight_id: string;
  quote: string;
}

export interface GsInterviewReleasedTheme {
  theme_id: string;
  label: string;
  summary: string;
  evidence_quotes: GsInterviewEvidenceQuote[];
}

/** `POST rounds/{roundId}/synthesis/released`: the body, in the stored synthesis shape. */
export interface GsInterviewReleasedSynthesis {
  schema: typeof GS_INTERVIEW_SYNTHESIS_SCHEMA;
  synthesisId: string;
  headlineRead: { text: string; supporting_insight_ids: string[] };
  themes: GsInterviewReleasedTheme[];
  hotSpots: { team: string; local_themes: GsInterviewReleasedTheme[] }[];
  recommendations: { rec_id: string; evidence_quotes: GsInterviewEvidenceQuote[] }[];
  followUps: unknown[];
  methodology: Record<string, unknown>;
  modelVersion: string;
  rulesVersion: string;
  inputInsightIds: string[];
}

export const DEEP_DIVE_RELEASE_BLOCKERS = ["nothing_accepted", "undecided", "theme_without_quote"] as const;
export type DeepDiveReleaseBlocker = (typeof DEEP_DIVE_RELEASE_BLOCKERS)[number];

export interface DeepDiveReleaseReadiness {
  ready: boolean;
  blockers: { code: DeepDiveReleaseBlocker; message: string }[];
  /** What would reach the client on release. */
  themes: number;
  quotes: number;
}

const THEME_KINDS = new Set(["pain", "process", "finding"]);

/** The accepted themes, each with its accepted quotes, oldest first. */
function acceptedThemes(proposals: readonly DeepDiveInterviewProposal[]) {
  return proposals
    .filter((p) => THEME_KINDS.has(p.kind) && p.status === "accepted")
    .map((theme) => ({
      theme,
      quotes: proposals.filter((q) => q.kind === "quote" && q.parentId === theme.id && q.status === "accepted"),
    }));
}

/**
 * Reviewed means a person decided every theme and quote, accepted at least
 * one theme, and each accepted theme keeps a quote as its evidence (the
 * website refuses a theme without one). People and roles do not block: they
 * are for the board and never go to the client.
 */
export function deepDiveReleaseReadiness(proposals: readonly DeepDiveInterviewProposal[]): DeepDiveReleaseReadiness {
  const blockers: DeepDiveReleaseReadiness["blockers"] = [];
  const undecided = proposals.filter((p) => p.kind !== "person" && p.status === "proposed").length;
  if (undecided > 0) {
    blockers.push({ code: "undecided", message: `${undecided} theme${undecided === 1 ? "" : "s"} or quote${undecided === 1 ? "" : "s"} still wait${undecided === 1 ? "s" : ""} for a decision` });
  }
  const themes = acceptedThemes(proposals);
  if (themes.length === 0) blockers.push({ code: "nothing_accepted", message: "Accept at least one theme" });
  const bare = themes.filter((t) => t.quotes.length === 0);
  if (bare.length > 0) {
    blockers.push({ code: "theme_without_quote", message: `Accept a quote for: ${bare.map((t) => t.theme.label || t.theme.statement).join(", ")}` });
  }
  return { ready: blockers.length === 0, blockers, themes: themes.length, quotes: themes.reduce((n, t) => n + t.quotes.length, 0) };
}

/**
 * The synthesis the client sees: accepted themes with accepted quotes only.
 * A theme with one team is also that team's hot spot.
 */
export function buildGsInterviewReleasedSynthesis(input: {
  synthesisId: string;
  headline: string;
  proposals: readonly DeepDiveInterviewProposal[];
  unitNames: ReadonlyMap<string, string>;
  rulesVersion: string;
}): GsInterviewReleasedSynthesis {
  const accepted = acceptedThemes(input.proposals);
  const themeOf = ({ theme, quotes }: (typeof accepted)[number]): GsInterviewReleasedTheme => ({
    theme_id: theme.themeKey ?? theme.id,
    label: theme.label,
    summary: theme.statement,
    evidence_quotes: quotes.map((q) => ({ insight_id: q.websiteInsightId!, quote: q.statement })),
  });
  const themes = accepted.map(themeOf);
  const byTeam = new Map<string, GsInterviewReleasedTheme[]>();
  accepted.forEach((item, index) => {
    const team = item.theme.unitId ? input.unitNames.get(item.theme.unitId) : undefined;
    if (team) byTeam.set(team, [...(byTeam.get(team) ?? []), themes[index]!]);
  });
  const insightIds = [...new Set(themes.flatMap((t) => t.evidence_quotes.map((q) => q.insight_id)))];
  return {
    schema: GS_INTERVIEW_SYNTHESIS_SCHEMA,
    synthesisId: input.synthesisId,
    headlineRead: { text: input.headline, supporting_insight_ids: insightIds },
    themes,
    hotSpots: [...byTeam].map(([team, local]) => ({ team, local_themes: local })),
    recommendations: [],
    followUps: [],
    methodology: { madeIn: "gsam", reviewedBy: "person", themes: themes.length, quotes: insightIds.length },
    modelVersion: DEEP_DIVE_RELEASE_MODEL_VERSION,
    rulesVersion: input.rulesVersion,
    inputInsightIds: insightIds,
  };
}

/** What the website shows the client now, read live: GSAM keeps no copy. */
export interface DeepDiveInterviewReleaseView {
  roundId: string;
  websiteOrganisationId: string;
  released: { synthesisId: string; releasedAt: string | null } | null;
  readiness: DeepDiveReleaseReadiness;
}
