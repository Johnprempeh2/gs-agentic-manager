import { z } from "zod";
import {
  DEEP_DIVE_GIF,
  DEEP_DIVE_STREAMS,
  type DeepDiveDepth,
  type DeepDiveGifKey,
  type DeepDiveKnowledge,
  type DeepDiveStreamKey,
} from "./deep-dive.js";
import type { DeepDiveFindingStatus } from "./deep-dive-findings.js";

/**
 * Parallel Interview rounds (GRE-2611). The first step of the Deep Dive: one
 * round per engagement, run per team (a large organisation) or per person (a
 * small one), about 20 minutes each. The interview itself runs on the
 * website; GSAM holds the round's setup, a question set per team or person
 * and a person's approval of each set before any invite goes out.
 *
 * Questions are drafted from what is already known: place the Known, validate
 * the Indicated, investigate only the Unknown. A Known cell is never asked.
 */

export const DEEP_DIVE_INTERVIEW_MODES = ["per_team", "per_person"] as const;
export type DeepDiveInterviewMode = (typeof DEEP_DIVE_INTERVIEW_MODES)[number];

/** setup -> open (invites may go out) -> closed. */
export const DEEP_DIVE_INTERVIEW_ROUND_STATUSES = ["setup", "open", "closed"] as const;
export type DeepDiveInterviewRoundStatus = (typeof DEEP_DIVE_INTERVIEW_ROUND_STATUSES)[number];

export const DEEP_DIVE_INTERVIEW_SET_STATUSES = ["draft", "approved"] as const;
export type DeepDiveInterviewSetStatus = (typeof DEEP_DIVE_INTERVIEW_SET_STATUSES)[number];

/** Validate what is Indicated; investigate what is Unknown. Known is placed, never asked. */
export const DEEP_DIVE_INTERVIEW_PURPOSES = ["validate", "investigate"] as const;
export type DeepDiveInterviewPurpose = (typeof DEEP_DIVE_INTERVIEW_PURPOSES)[number];

export const DEEP_DIVE_INTERVIEW_LABELS: Record<
  DeepDiveInterviewMode | DeepDiveInterviewRoundStatus | DeepDiveInterviewSetStatus | DeepDiveInterviewPurpose,
  string
> = {
  per_team: "Per team",
  per_person: "Per person",
  setup: "Setting up",
  open: "Open",
  closed: "Closed",
  draft: "Draft",
  approved: "Approved",
  validate: "Validate",
  investigate: "Investigate",
};

/**
 * The context pack, with the same keys as Everest's (parallel-discovery-agent,
 * CONTEXT_FIELDS) so the website engine reads it unchanged. Order is the
 * display order.
 */
export const DEEP_DIVE_INTERVIEW_CONTEXT_FIELDS = [
  { key: "company_background", label: "About the company", hint: "Who they are and the situation, so the interviewer sounds informed." },
  { key: "org_summary", label: "Teams and structure", hint: "The teams being interviewed and how they relate." },
  { key: "systems", label: "Systems", hint: "The main systems and tools people use." },
  { key: "scope", label: "Scope", hint: "What this round covers." },
  { key: "priority_questions", label: "Must-ask questions", hint: "What the client asked us to cover with everyone." },
  { key: "glossary", label: "Glossary", hint: "Their words for things." },
  { key: "do_not_discuss", label: "Do not discuss", hint: "Off-limits topics the interviewer must avoid." },
  { key: "working_pattern", label: "Working pattern", hint: "Typical cycles, busy periods, handoffs." },
] as const;

export type DeepDiveInterviewContextKey = (typeof DEEP_DIVE_INTERVIEW_CONTEXT_FIELDS)[number]["key"];
export type DeepDiveInterviewContextPack = Partial<Record<DeepDiveInterviewContextKey, string>>;

export const DEEP_DIVE_INTERVIEW_DEFAULT_MINUTES = 20;
export const DEEP_DIVE_INTERVIEW_MAX_QUESTIONS = 40;
/** About two minutes a question, so a 20-minute interview drafts ten. */
export const DEEP_DIVE_INTERVIEW_MINUTES_PER_QUESTION = 2;

const contextPackShape = Object.fromEntries(
  DEEP_DIVE_INTERVIEW_CONTEXT_FIELDS.map((field) => [field.key, z.string().max(8_000).optional()]),
) as Record<DeepDiveInterviewContextKey, z.ZodOptional<z.ZodString>>;

export const deepDiveInterviewContextPackSchema = z.object(contextPackShape).strict();

const minutesSchema = z.number().int().min(5).max(90);

export const createDeepDiveInterviewRoundSchema = z
  .object({
    mode: z.enum(DEEP_DIVE_INTERVIEW_MODES),
    targetMinutes: minutesSchema.optional(),
    contextPack: deepDiveInterviewContextPackSchema.optional(),
  })
  .strict();
export type CreateDeepDiveInterviewRound = z.infer<typeof createDeepDiveInterviewRoundSchema>;

/** Setup changes only while the round is setting up; the mode only while it has no question sets. */
export const updateDeepDiveInterviewRoundSchema = z
  .object({
    mode: z.enum(DEEP_DIVE_INTERVIEW_MODES).optional(),
    targetMinutes: minutesSchema.optional(),
    contextPack: deepDiveInterviewContextPackSchema.optional(),
  })
  .strict();
export type UpdateDeepDiveInterviewRound = z.infer<typeof updateDeepDiveInterviewRoundSchema>;

const streamKeys = DEEP_DIVE_STREAMS.map((stream) => stream.key) as [DeepDiveStreamKey, ...DeepDiveStreamKey[]];
const gifKeys = DEEP_DIVE_GIF.map((gif) => gif.key) as [DeepDiveGifKey, ...DeepDiveGifKey[]];

export const deepDiveInterviewQuestionSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2_000),
    purpose: z.enum(DEEP_DIVE_INTERVIEW_PURPOSES),
    /** The GIF cell the answer feeds. Both or neither: a question of the person's own has no cell. */
    streamKey: z.enum(streamKeys).nullable(),
    gifKey: z.enum(gifKeys).nullable(),
  })
  .strict()
  .refine((q) => (q.streamKey === null) === (q.gifKey === null), {
    message: "A question names both its stream and its GIF question, or neither",
  });
export type DeepDiveInterviewQuestion = z.infer<typeof deepDiveInterviewQuestionSchema>;

/** Draft a set for one team (per team) or one person (per person) from what is known. */
export const draftDeepDiveInterviewSetSchema = z
  .object({
    unitId: z.string().guid().optional(),
    personId: z.string().guid().optional(),
  })
  .strict()
  .refine((input) => !!input.unitId !== !!input.personId, { message: "Name a team or a person, not both" });
export type DraftDeepDiveInterviewSet = z.infer<typeof draftDeepDiveInterviewSetSchema>;

/** The person's edit of a set: the whole list. Any edit puts an approved set back to Draft. */
export const updateDeepDiveInterviewSetSchema = z
  .object({
    questions: z.array(deepDiveInterviewQuestionSchema).min(1).max(DEEP_DIVE_INTERVIEW_MAX_QUESTIONS),
  })
  .strict();
export type UpdateDeepDiveInterviewSet = z.infer<typeof updateDeepDiveInterviewSetSchema>;

/** A Known cell, told to the interviewer so it is not asked again. */
export interface DeepDiveInterviewKnownItem {
  streamKey: DeepDiveStreamKey;
  gifKey: DeepDiveGifKey;
  text: string;
}

export interface DeepDiveInterviewTarget {
  kind: "unit" | "person";
  id: string;
  name: string;
  /** A person's role, or a team's type. */
  detail: string;
}

export interface DeepDiveInterviewSet {
  id: string;
  roundId: string;
  target: DeepDiveInterviewTarget;
  status: DeepDiveInterviewSetStatus;
  questions: DeepDiveInterviewQuestion[];
  known: DeepDiveInterviewKnownItem[];
  /** Unknown cells left out to keep the interview near its target length. */
  leftOut: number;
  approvedByUserId: string | null;
  approvedAt: string | null;
  draftedByAgentId: string | null;
  draftedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeepDiveInterviewRound {
  id: string;
  companyId: string;
  mode: DeepDiveInterviewMode;
  targetMinutes: number;
  contextPack: DeepDiveInterviewContextPack;
  status: DeepDiveInterviewRoundStatus;
  createdAt: string;
  updatedAt: string;
  sets: DeepDiveInterviewSet[];
}

/** The round page: the round (or null before setup) and who could be interviewed. */
export interface DeepDiveInterviewRoundView {
  round: DeepDiveInterviewRound | null;
  /** Teams and people on the organisation board not yet given a set. */
  available: DeepDiveInterviewTarget[];
}

/** Read the stored context pack defensively: only known keys, only strings. */
export function readDeepDiveInterviewContextPack(raw: unknown): DeepDiveInterviewContextPack {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pack: DeepDiveInterviewContextPack = {};
  for (const field of DEEP_DIVE_INTERVIEW_CONTEXT_FIELDS) {
    const value = source[field.key];
    if (typeof value === "string") pack[field.key] = value;
  }
  return pack;
}

/** Invites may go out only when the round has a set and a person approved every one. */
export function deepDiveInterviewReadiness(round: Pick<DeepDiveInterviewRound, "sets">) {
  const approved = round.sets.filter((set) => set.status === "approved").length;
  return { total: round.sets.length, approved, ready: round.sets.length > 0 && approved === round.sets.length };
}

// ---------------------------------------------------------------------------
// Drafting: place the Known, validate the Indicated, investigate the Unknown.
// ---------------------------------------------------------------------------

/** One GIF cell of one stream, as the draft sees it. */
export interface DeepDiveInterviewCell {
  streamKey: DeepDiveStreamKey;
  gifKey: DeepDiveGifKey;
  depth: DeepDiveDepth;
  knowledge: DeepDiveKnowledge;
  /** The cell's GIF document beyond its stub, or null. */
  cellText: string | null;
  findings: { statement: string; status: DeepDiveFindingStatus }[];
}

/** Which GIF questions come first when the interview is too short for all of them. */
const GIF_PRIORITY: DeepDiveGifKey[] = [
  "current-state",
  "business-impact",
  "transformation-opportunity",
  "future-state",
  "evidence",
];

const STREAM_LABEL = new Map(DEEP_DIVE_STREAMS.map((stream) => [stream.key, stream.label]));
const GIF_QUESTIONS = new Set<string>(DEEP_DIVE_GIF.map((gif) => gif.question));

function topic(streamKey: DeepDiveStreamKey) {
  const label = STREAM_LABEL.get(streamKey) ?? streamKey;
  return label === "Innovation and Artificial Intelligence" ? "innovation and AI" : label.toLowerCase();
}

function audience(target: DeepDiveInterviewTarget) {
  return target.kind === "unit" ? "your team" : "your role";
}

function investigatePrompt(cell: DeepDiveInterviewCell, target: DeepDiveInterviewTarget): string {
  const about = topic(cell.streamKey);
  switch (cell.gifKey) {
    case "current-state":
      return `How does ${about} work today in ${audience(target)}? Walk us through a normal week.`;
    case "evidence":
      return `What shows how ${about} is going: reports, numbers or examples you could point us to?`;
    case "business-impact":
      return `When ${about} works badly, what does it cost the business: time, money, customers or risk?`;
    case "future-state":
      return `If ${about} worked the way you want, what would be different for ${audience(target)}?`;
    case "transformation-opportunity":
      return `What would you change first about ${about}, and what has stopped it so far?`;
  }
}

/** The single line a person would recognise: a validated or proposed finding first, else the cell text. */
function firstLine(cell: DeepDiveInterviewCell): string | null {
  const finding =
    cell.findings.find((f) => f.status === "validated") ?? cell.findings.find((f) => f.status === "proposed");
  const text = finding?.statement ?? cell.cellText ?? "";
  // The cell document opens with its heading and the GIF question; skip both.
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !part.startsWith("#") && !GIF_QUESTIONS.has(part));
  if (!line) return null;
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

function validatePrompt(cell: DeepDiveInterviewCell, target: DeepDiveInterviewTarget): string {
  const line = firstLine(cell);
  if (!line) {
    return `We have early signs about ${topic(cell.streamKey)} but nothing confirmed. What is true for ${audience(target)}?`;
  }
  const statement = line.replace(/[.!?]+$/, "");
  return `We understand that ${statement.charAt(0).toLowerCase()}${statement.slice(1)}. Is that right for ${audience(target)}? What would you add or correct?`;
}

/**
 * Draft one set from the Deep Dive's cells. Known cells become context for the
 * interviewer and are never asked. Indicated cells are validated first (they
 * are quick), then Unknown cells are investigated in GIF priority order across
 * the streams, Full streams before Reduced ones, until the target length is
 * used. What does not fit is counted in `leftOut`, never dropped silently.
 */
export function draftDeepDiveInterviewSet(input: {
  cells: readonly DeepDiveInterviewCell[];
  target: DeepDiveInterviewTarget;
  targetMinutes: number;
}): { questions: DeepDiveInterviewQuestion[]; known: DeepDiveInterviewKnownItem[]; leftOut: number } {
  const budget = Math.min(
    DEEP_DIVE_INTERVIEW_MAX_QUESTIONS,
    Math.max(3, Math.floor(input.targetMinutes / DEEP_DIVE_INTERVIEW_MINUTES_PER_QUESTION)),
  );
  const streamOrder = new Map(DEEP_DIVE_STREAMS.map((stream, index) => [stream.key, index]));
  const gifOrder = new Map(GIF_PRIORITY.map((key, index) => [key, index]));
  const sorted = [...input.cells].sort(
    (a, b) =>
      (a.depth === b.depth ? 0 : a.depth === "full" ? -1 : 1) ||
      gifOrder.get(a.gifKey)! - gifOrder.get(b.gifKey)! ||
      streamOrder.get(a.streamKey)! - streamOrder.get(b.streamKey)!,
  );

  const known: DeepDiveInterviewKnownItem[] = sorted
    .filter((cell) => cell.knowledge === "known")
    .map((cell) => ({
      streamKey: cell.streamKey,
      gifKey: cell.gifKey,
      text: firstLine(cell) ?? "Marked Known in the Deep Dive.",
    }));

  const candidates: DeepDiveInterviewQuestion[] = [
    ...sorted
      .filter((cell) => cell.knowledge === "indicated")
      .map((cell) => ({
        prompt: validatePrompt(cell, input.target),
        purpose: "validate" as const,
        streamKey: cell.streamKey,
        gifKey: cell.gifKey,
      })),
    ...sorted
      .filter((cell) => cell.knowledge === "unknown")
      .map((cell) => ({
        prompt: investigatePrompt(cell, input.target),
        purpose: "investigate" as const,
        streamKey: cell.streamKey,
        gifKey: cell.gifKey,
      })),
  ];

  return { questions: candidates.slice(0, budget), known, leftOut: Math.max(0, candidates.length - budget) };
}
