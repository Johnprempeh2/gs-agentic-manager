import { z } from "zod";
import { websiteUserIdSchema } from "./deep-dive-interview-invites.js";

/**
 * Parallel Interview synthesis (GRE-2666), slice 3 of GRE-2611.
 *
 * A GSAM agent pulls the round's completed interviews through gs-interview-v1
 * and writes the synthesis. The quality rules are code here, not prose in a
 * prompt: the agent writes the statements, these functions decide what may be
 * proposed.
 *
 * 1. Two voices: a theme is promoted only when at least two different people
 *    raised it and at least one of them saw it first-hand. A pain from one
 *    voice stays a candidate and is never proposed.
 * 2. Quote gate: a quote is used only when the person consented to take part,
 *    the website marked the insight quote-eligible and the quote is verbatim
 *    in it. Without attribution consent it is shown without the person.
 * 3. Label merge: near-duplicate labels ("Manual invoice matching",
 *    "manual invoices matching") are one theme.
 * 4. Roll-up: each theme is counted per team and again up the organisation
 *    board, so a theme raised once in two teams is promoted at their parent.
 *
 * The same checks run on the website before a release (contracts/gs-interview-v1,
 * `synthesis/released`). Raw answers (the turns) are never read into GSAM's
 * types: the schemas below drop them.
 */

export const DEEP_DIVE_SYNTHESIS_RULES_VERSION = "gsam-synthesis-rules-1";
/** Distinct people who must raise a theme before it is promoted. */
export const DEEP_DIVE_SYNTHESIS_MIN_VOICES = 2;
/** Of those, how many must have seen it first-hand. */
export const DEEP_DIVE_SYNTHESIS_MIN_FIRST_HAND = 1;
/** Labels whose words overlap this much are one theme. */
export const DEEP_DIVE_SYNTHESIS_WORD_OVERLAP = 0.6;
/** Or whose letters match this closely (a typo, a hyphen). */
export const DEEP_DIVE_SYNTHESIS_SPELLING_MATCH = 0.85;
export const DEEP_DIVE_SYNTHESIS_MAX_QUOTE = 600;

// ---------------------------------------------------------------------------
// What the bridge returns (gs-interview-v1 reads)
// ---------------------------------------------------------------------------

const textOrEmpty = z.string().nullable().optional().transform((v) => v ?? "");
const textOrNull = z.string().nullable().optional().transform((v) => v ?? null);

/** `GET rounds/{roundId}/interviews`: one interview that may enter synthesis. */
export const gsInterviewSummarySchema = z.object({
  interviewId: websiteUserIdSchema,
  employeeId: websiteUserIdSchema.nullable().optional().transform((v) => v ?? null),
  userId: websiteUserIdSchema.nullable().optional().transform((v) => v ?? null),
  /** One per person: two interviews with one voice key are one voice. */
  voiceKey: z.string().min(1),
  unitId: textOrNull,
  roleTitle: textOrEmpty,
  complete: z.boolean().default(false),
  partial: z.boolean().default(false),
  fingerprint: textOrEmpty,
});
export type GsInterviewSummary = z.infer<typeof gsInterviewSummarySchema>;

/** One insight. Missing flags fall to the safe side: not quotable, not attributable. */
export const gsInterviewInsightSchema = z.object({
  id: websiteUserIdSchema,
  type: z.string().default(""),
  label: z.string().trim().min(1),
  evidenceQuote: textOrEmpty,
  timePerWeekHours: z.number().nullable().optional().transform((v) => v ?? null),
  confidence: z.number().nullable().optional().transform((v) => v ?? null),
  secondHand: z.boolean().default(false),
  attributionRedacted: z.boolean().default(true),
  quoteEligible: z.boolean().default(false),
});
export type GsInterviewInsight = z.infer<typeof gsInterviewInsightSchema>;

/** Consent is given only when the website says so plainly; anything else is no. */
const consentFlag = z.unknown().optional().transform((v) => v === true || (typeof v === "string" && ["given", "granted", "yes", "true"].includes(v.toLowerCase())));

/**
 * `GET rounds/{roundId}/interviews/{interviewId}`. The turns (the raw answers)
 * are not in this schema, so parsing drops them before anything else sees them.
 */
export const gsInterviewDetailSchema = z.object({
  interview: gsInterviewSummarySchema,
  consent: z.object({ participation: consentFlag, attribution: consentFlag }).default({ participation: false, attribution: false }),
  insights: z.array(z.unknown()).default([]),
});
export interface GsInterviewDetail {
  interview: GsInterviewSummary;
  consent: { participation: boolean; attribution: boolean };
  insights: GsInterviewInsight[];
}

/** `GET rounds/{roundId}/withdrawals`: a hard delete on the website. `interviewId: null` is the whole person. */
export const gsInterviewWithdrawalSchema = z.object({
  cursor: z.union([z.string(), z.number()]).transform(String),
  userId: websiteUserIdSchema.nullable().optional().transform((v) => v ?? null),
  interviewId: websiteUserIdSchema.nullable().optional().transform((v) => v ?? null),
  at: textOrNull,
});
export type GsInterviewWithdrawal = z.infer<typeof gsInterviewWithdrawalSchema>;

// ---------------------------------------------------------------------------
// Rule 1: two voices
// ---------------------------------------------------------------------------

export interface SynthesisVoice {
  voiceKey: string;
  secondHand: boolean;
}

export interface TwoVoiceResult {
  promoted: boolean;
  voices: number;
  firstHand: number;
  /** Why it is not promoted, in words a person reads. */
  reason: string | null;
}

export function twoVoiceRule(voices: SynthesisVoice[]): TwoVoiceResult {
  const all = new Set(voices.map((v) => v.voiceKey));
  const firstHand = new Set(voices.filter((v) => !v.secondHand).map((v) => v.voiceKey));
  if (all.size < DEEP_DIVE_SYNTHESIS_MIN_VOICES) {
    return { promoted: false, voices: all.size, firstHand: firstHand.size, reason: all.size === 0 ? "Nobody raised it" : "Only one person raised it" };
  }
  if (firstHand.size < DEEP_DIVE_SYNTHESIS_MIN_FIRST_HAND) {
    return { promoted: false, voices: all.size, firstHand: 0, reason: "Nobody who raised it saw it first-hand" };
  }
  return { promoted: true, voices: all.size, firstHand: firstHand.size, reason: null };
}

// ---------------------------------------------------------------------------
// Rule 2: the quote gate
// ---------------------------------------------------------------------------

export const DEEP_DIVE_QUOTE_REFUSALS = ["no_consent", "not_quote_eligible", "not_verbatim", "too_long", "empty"] as const;
export type DeepDiveQuoteRefusal = (typeof DEEP_DIVE_QUOTE_REFUSALS)[number];

export const DEEP_DIVE_QUOTE_REFUSAL_LABELS: Record<DeepDiveQuoteRefusal, string> = {
  no_consent: "The person did not consent to take part",
  not_quote_eligible: "The website did not mark this insight as quotable",
  not_verbatim: "The quote is not word for word in the insight",
  too_long: `A quote is at most ${DEEP_DIVE_SYNTHESIS_MAX_QUOTE} characters`,
  empty: "The quote is empty",
};

export interface QuoteCandidate {
  quote: string;
  insight: Pick<GsInterviewInsight, "quoteEligible" | "evidenceQuote" | "attributionRedacted">;
  consent: GsInterviewDetail["consent"];
}

export type QuoteGateResult =
  | { ok: true; quote: string; /** Show without the person's name or role. */ anonymous: boolean }
  | { ok: false; reason: DeepDiveQuoteRefusal };

/** Same words, ignoring spacing and curly quotes. Case is kept: a quote is verbatim. */
function quoteText(value: string) {
  return value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

export function quoteGate(candidate: QuoteCandidate): QuoteGateResult {
  const quote = quoteText(candidate.quote).replace(/^"(.*)"$/, "$1").trim();
  if (!quote) return { ok: false, reason: "empty" };
  if (quote.length > DEEP_DIVE_SYNTHESIS_MAX_QUOTE) return { ok: false, reason: "too_long" };
  if (!candidate.consent.participation) return { ok: false, reason: "no_consent" };
  if (!candidate.insight.quoteEligible) return { ok: false, reason: "not_quote_eligible" };
  if (!quoteText(candidate.insight.evidenceQuote).includes(quote)) return { ok: false, reason: "not_verbatim" };
  return { ok: true, quote, anonymous: candidate.insight.attributionRedacted || !candidate.consent.attribution };
}

// ---------------------------------------------------------------------------
// Rule 3: near-duplicate labels merge
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "of", "on", "or", "our",
  "the", "their", "to", "too", "very", "we", "with",
]);

function stem(word: string) {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The label's meaningful words, lower case, without hyphens or plurals. */
export function labelWords(label: string): string[] {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/(\w)-(\w)/g, "$1$2")
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .map(stem);
}

function bigrams(text: string) {
  const out = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const pair = text.slice(i, i + 2);
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}

/** Word overlap (Jaccard) and spelling match (letter-pair Dice), each 0 to 1. */
export function labelSimilarity(a: string, b: string): { words: number; spelling: number } {
  const wa = new Set(labelWords(a));
  const wb = new Set(labelWords(b));
  const union = new Set([...wa, ...wb]);
  const words = union.size === 0 ? 0 : [...wa].filter((w) => wb.has(w)).length / union.size;
  const ba = bigrams([...wa].sort().join(" "));
  const bb = bigrams([...wb].sort().join(" "));
  let shared = 0;
  for (const [pair, count] of ba) shared += Math.min(count, bb.get(pair) ?? 0);
  const total = [...ba.values()].reduce((s, n) => s + n, 0) + [...bb.values()].reduce((s, n) => s + n, 0);
  return { words, spelling: total === 0 ? 0 : (2 * shared) / total };
}

export function labelsMatch(a: string, b: string) {
  const { words, spelling } = labelSimilarity(a, b);
  return words >= DEEP_DIVE_SYNTHESIS_WORD_OVERLAP || spelling >= DEEP_DIVE_SYNTHESIS_SPELLING_MATCH;
}

export interface MergedLabel<T> {
  /** The label most items used (then the shortest, then A to Z). */
  label: string;
  /** Every distinct label merged in, A to Z. */
  labels: string[];
  items: T[];
}

/**
 * Join items whose labels match, directly or through a chain of matches. The
 * result does not depend on the input order.
 */
export function mergeLabels<T extends { label: string }>(items: T[]): MergedLabel<T>[] {
  const sorted = [...items].sort((a, b) => a.label.localeCompare(b.label));
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (find(i) !== find(j) && labelsMatch(sorted[i]!.label, sorted[j]!.label)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, T[]>();
  sorted.forEach((item, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), item]));
  return [...groups.values()]
    .map((group) => {
      const uses = new Map<string, number>();
      for (const item of group) uses.set(item.label.trim(), (uses.get(item.label.trim()) ?? 0) + 1);
      const labels = [...uses.keys()].sort((a, b) => a.localeCompare(b));
      const label = [...labels].sort((a, b) => uses.get(b)! - uses.get(a)! || a.length - b.length || a.localeCompare(b))[0]!;
      return { label, labels, items: group };
    })
    .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Rule 4: roll-up by team, up the organisation board
// ---------------------------------------------------------------------------

export interface RollUpUnit {
  id: string;
  parentId: string | null;
  name: string;
}

export interface RollUpTheme {
  key: string;
  voices: (SynthesisVoice & { unitId: string | null })[];
}

export interface RollUpNode {
  /** Null: people the board has not placed in a team. */
  unitId: string | null;
  parentId: string | null;
  name: string;
  depth: number;
  /** Themes raised in this unit or any unit under it, most voices first. */
  themes: ({ key: string } & TwoVoiceResult)[];
}

export const DEEP_DIVE_SYNTHESIS_NO_TEAM = "No team";

/**
 * Each unit counts the voices raised in it and in every unit below it, then
 * applies the two-voice rule at that level. Units are listed parents first.
 */
export function rollUpByUnit(units: RollUpUnit[], themes: RollUpTheme[]): RollUpNode[] {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const children = new Map<string | null, RollUpUnit[]>();
  for (const unit of units) {
    const parentId = unit.parentId && byId.has(unit.parentId) ? unit.parentId : null;
    children.set(parentId, [...(children.get(parentId) ?? []), unit]);
  }

  /** The unit and every ancestor, so a voice counts at each level above it. */
  function lineage(unitId: string | null): (string | null)[] {
    if (unitId === null || !byId.has(unitId)) return [null];
    const out: string[] = [];
    const seen = new Set<string>();
    for (let at: string | null = unitId; at && byId.has(at) && !seen.has(at); at = byId.get(at)!.parentId) {
      seen.add(at);
      out.push(at);
    }
    return out;
  }

  const voicesAt = new Map<string | null, Map<string, SynthesisVoice[]>>();
  for (const theme of themes) {
    for (const voice of theme.voices) {
      for (const at of lineage(voice.unitId)) {
        const perTheme = voicesAt.get(at) ?? new Map<string, SynthesisVoice[]>();
        perTheme.set(theme.key, [...(perTheme.get(theme.key) ?? []), voice]);
        voicesAt.set(at, perTheme);
      }
    }
  }

  const node = (unitId: string | null, parentId: string | null, name: string, depth: number): RollUpNode => ({
    unitId,
    parentId,
    name,
    depth,
    themes: [...(voicesAt.get(unitId) ?? new Map()).entries()]
      .map(([key, voices]) => ({ key, ...twoVoiceRule(voices) }))
      .sort((a, b) => b.voices - a.voices || a.key.localeCompare(b.key)),
  });

  const out: RollUpNode[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const unit of children.get(parentId) ?? []) {
      if (visited.has(unit.id)) continue;
      visited.add(unit.id);
      out.push(node(unit.id, parentId, unit.name, depth));
      walk(unit.id, depth + 1);
    }
  };
  walk(null, 0);
  if (voicesAt.has(null)) out.push(node(null, null, DEEP_DIVE_SYNTHESIS_NO_TEAM, 0));
  return out;
}

// ---------------------------------------------------------------------------
// The evidence the agent reads: every rule applied, nothing raw
// ---------------------------------------------------------------------------

export const DEEP_DIVE_SYNTHESIS_THEME_KINDS = ["pain", "process", "finding"] as const;
export type DeepDiveSynthesisThemeKind = (typeof DEEP_DIVE_SYNTHESIS_THEME_KINDS)[number];

/** The website's insight type, as a Deep Dive candidate: a pain, a process, or any other finding. */
export function synthesisKindOf(type: string): DeepDiveSynthesisThemeKind {
  const t = type.toLowerCase();
  if (/pain|frustrat|problem|blocker|issue|risk/.test(t)) return "pain";
  if (/process|task|workflow|handoff|hand_off|step|workaround|system|tool/.test(t)) return "process";
  return "finding";
}

export interface DeepDiveSynthesisInsight {
  insightId: string;
  interviewId: string;
  label: string;
  confidence: number | null;
  secondHand: boolean;
  timePerWeekHours: number | null;
  /** The quote the gate allows, or null with the reason it refused. */
  quote: string | null;
  quoteRefused: DeepDiveQuoteRefusal | null;
  anonymous: boolean;
}

export interface DeepDiveSynthesisTheme extends TwoVoiceResult {
  /** Stable for the same merged label: the agent names the theme by it. */
  key: string;
  kind: DeepDiveSynthesisThemeKind;
  label: string;
  labels: string[];
  unitIds: string[];
  insights: DeepDiveSynthesisInsight[];
}

export interface DeepDiveSynthesisPerson {
  interviewId: string;
  websiteEmployeeId: string | null;
  websiteUserId: string | null;
  roleTitle: string;
  unitId: string | null;
}

export interface DeepDiveSynthesisEvidence {
  roundId: string;
  rulesVersion: string;
  interviews: number;
  /** Interviews left out because the person did not consent to take part. */
  withoutConsent: number;
  themes: DeepDiveSynthesisTheme[];
  rollUp: RollUpNode[];
  /** People and roles for the organisation board: website ids only, never a name. */
  people: DeepDiveSynthesisPerson[];
}

function themeKey(kind: DeepDiveSynthesisThemeKind, label: string) {
  const slug = labelWords(label).sort().join("-").slice(0, 80) || "theme";
  return `${kind}:${slug}`;
}

export function buildDeepDiveSynthesisEvidence(roundId: string, interviews: GsInterviewDetail[], units: RollUpUnit[]): DeepDiveSynthesisEvidence {
  const used = interviews.filter((detail) => detail.consent.participation);
  const sorted = [...used].sort((a, b) => a.interview.interviewId.localeCompare(b.interview.interviewId));
  const unitIds = new Set(units.map((unit) => unit.id));
  const unitOf = (detail: GsInterviewDetail) => (detail.interview.unitId && unitIds.has(detail.interview.unitId) ? detail.interview.unitId : null);

  const themes: DeepDiveSynthesisTheme[] = [];
  const keys = new Set<string>();
  for (const kind of DEEP_DIVE_SYNTHESIS_THEME_KINDS) {
    const rows = sorted.flatMap((detail) =>
      detail.insights.filter((insight) => synthesisKindOf(insight.type) === kind).map((insight) => ({ label: insight.label, insight, detail })),
    );
    for (const group of mergeLabels(rows)) {
      let key = themeKey(kind, group.label);
      for (let n = 2; keys.has(key); n += 1) key = `${themeKey(kind, group.label)}-${n}`;
      keys.add(key);
      themes.push({
        key,
        kind,
        label: group.label,
        labels: group.labels,
        unitIds: [...new Set(group.items.flatMap(({ detail }) => (unitOf(detail) ? [unitOf(detail)!] : [])))].sort(),
        ...twoVoiceRule(group.items.map(({ insight, detail }) => ({ voiceKey: detail.interview.voiceKey, secondHand: insight.secondHand }))),
        insights: group.items.map(({ insight, detail }) => {
          const gate = quoteGate({ quote: insight.evidenceQuote, insight, consent: detail.consent });
          return {
            insightId: insight.id,
            interviewId: detail.interview.interviewId,
            label: insight.label,
            confidence: insight.confidence,
            secondHand: insight.secondHand,
            timePerWeekHours: insight.timePerWeekHours,
            quote: gate.ok ? gate.quote : null,
            quoteRefused: gate.ok ? null : gate.reason,
            anonymous: gate.ok ? gate.anonymous : true,
          };
        }),
      });
    }
  }
  themes.sort((a, b) => Number(b.promoted) - Number(a.promoted) || b.voices - a.voices || a.key.localeCompare(b.key));

  const rollUp = rollUpByUnit(units, themes.map((theme) => ({
    key: theme.key,
    voices: theme.insights.map((insight) => {
      const detail = sorted.find((d) => d.interview.interviewId === insight.interviewId)!;
      return { voiceKey: detail.interview.voiceKey, secondHand: insight.secondHand, unitId: unitOf(detail) };
    }),
  })));

  return {
    roundId,
    rulesVersion: DEEP_DIVE_SYNTHESIS_RULES_VERSION,
    interviews: interviews.length,
    withoutConsent: interviews.length - used.length,
    themes,
    rollUp,
    people: sorted.map((detail) => ({
      interviewId: detail.interview.interviewId,
      websiteEmployeeId: detail.interview.employeeId,
      websiteUserId: detail.interview.userId,
      roleTitle: detail.interview.roleTitle,
      unitId: unitOf(detail),
    })),
  };
}

// ---------------------------------------------------------------------------
// The agent's submission, checked against fresh evidence
// ---------------------------------------------------------------------------

export const DEEP_DIVE_SYNTHESIS_MAX_ITEMS = 200;

export const submitDeepDiveSynthesisSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            themeKey: z.string().trim().min(1).max(200),
            /** The agent's prose: what the theme says, in plain words. */
            statement: z.string().trim().min(1).max(2_000),
            quotes: z
              .array(z.object({ insightId: websiteUserIdSchema, quote: z.string().trim().min(1).max(DEEP_DIVE_SYNTHESIS_MAX_QUOTE * 2) }).strict())
              .max(10)
              .default([]),
          })
          .strict(),
      )
      .min(1)
      .max(DEEP_DIVE_SYNTHESIS_MAX_ITEMS),
    /** Also propose each interviewee's role on the organisation board. */
    people: z.boolean().default(true),
  })
  .strict();
export type SubmitDeepDiveSynthesis = z.infer<typeof submitDeepDiveSynthesisSchema>;
export type SubmitDeepDiveSynthesisInput = z.input<typeof submitDeepDiveSynthesisSchema>;

export interface DeepDiveSynthesisRefusal {
  item: number;
  themeKey: string;
  quote: number | null;
  reason: string;
}

export interface CheckedDeepDiveSynthesisItem {
  theme: DeepDiveSynthesisTheme;
  statement: string;
  quotes: { insight: DeepDiveSynthesisInsight; quote: string; anonymous: boolean }[];
}

/**
 * Every rule, applied to what the agent wrote. All or nothing: any refusal
 * means nothing is written, and the agent gets every reason at once.
 */
export function checkDeepDiveSynthesis(
  evidence: DeepDiveSynthesisEvidence,
  interviews: GsInterviewDetail[],
  submission: SubmitDeepDiveSynthesis,
): { ok: true; items: CheckedDeepDiveSynthesisItem[] } | { ok: false; refusals: DeepDiveSynthesisRefusal[] } {
  const themes = new Map(evidence.themes.map((theme) => [theme.key, theme]));
  const detailById = new Map(interviews.map((detail) => [detail.interview.interviewId, detail]));
  const refusals: DeepDiveSynthesisRefusal[] = [];
  const items: CheckedDeepDiveSynthesisItem[] = [];
  const seen = new Set<string>();

  submission.items.forEach((item, index) => {
    const theme = themes.get(item.themeKey);
    if (!theme) {
      refusals.push({ item: index, themeKey: item.themeKey, quote: null, reason: "No theme has this key in the round's evidence" });
      return;
    }
    if (seen.has(theme.key)) {
      refusals.push({ item: index, themeKey: item.themeKey, quote: null, reason: "This theme is in the submission twice" });
      return;
    }
    seen.add(theme.key);
    if (!theme.promoted) {
      refusals.push({ item: index, themeKey: item.themeKey, quote: null, reason: `Not promoted: ${theme.reason}` });
      return;
    }
    const quotes: CheckedDeepDiveSynthesisItem["quotes"] = [];
    item.quotes.forEach((proposed, q) => {
      const insight = theme.insights.find((i) => i.insightId === proposed.insightId);
      const detail = insight ? detailById.get(insight.interviewId) : undefined;
      const source = detail?.insights.find((i) => i.id === proposed.insightId);
      if (!insight || !detail || !source) {
        refusals.push({ item: index, themeKey: item.themeKey, quote: q, reason: "The insight is not part of this theme" });
        return;
      }
      const gate = quoteGate({ quote: proposed.quote, insight: source, consent: detail.consent });
      if (!gate.ok) {
        refusals.push({ item: index, themeKey: item.themeKey, quote: q, reason: DEEP_DIVE_QUOTE_REFUSAL_LABELS[gate.reason] });
        return;
      }
      quotes.push({ insight, quote: gate.quote, anonymous: gate.anonymous });
    });
    items.push({ theme, statement: item.statement, quotes });
  });

  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, items };
}

// ---------------------------------------------------------------------------
// What GSAM keeps: proposed items a person confirms
// ---------------------------------------------------------------------------

export const DEEP_DIVE_PROPOSAL_KINDS = ["pain", "process", "finding", "person", "quote"] as const;
export type DeepDiveProposalKind = (typeof DEEP_DIVE_PROPOSAL_KINDS)[number];

export const DEEP_DIVE_PROPOSAL_STATUSES = ["proposed", "accepted", "rejected"] as const;
export type DeepDiveProposalStatus = (typeof DEEP_DIVE_PROPOSAL_STATUSES)[number];

export const DEEP_DIVE_PROPOSAL_LABELS: Record<DeepDiveProposalKind | DeepDiveProposalStatus, string> = {
  pain: "Pain",
  process: "Process",
  finding: "Finding",
  person: "Person and role",
  quote: "Quote",
  proposed: "Proposed",
  accepted: "Accepted",
  rejected: "Rejected",
};

/** Where a proposal came from on the website: ids only. */
export interface DeepDiveProposalSource {
  interviewId: string;
  userId: string | null;
  employeeId: string | null;
}

export interface DeepDiveInterviewProposal {
  id: string;
  roundId: string;
  kind: DeepDiveProposalKind;
  themeKey: string | null;
  /** The parent theme, for a quote. */
  parentId: string | null;
  label: string;
  statement: string;
  unitId: string | null;
  voices: number;
  firstHandVoices: number;
  websiteInsightId: string | null;
  websiteEmployeeId: string | null;
  anonymous: boolean;
  sources: DeepDiveProposalSource[];
  status: DeepDiveProposalStatus;
  visibility: "internal";
  rulesVersion: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export const decideDeepDiveInterviewProposalSchema = z
  .object({ decision: z.enum(["accepted", "rejected"]) })
  .strict();
export type DecideDeepDiveInterviewProposal = z.infer<typeof decideDeepDiveInterviewProposalSchema>;
