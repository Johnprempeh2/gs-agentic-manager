import { z } from "zod";
import { DEEP_DIVE_PILLARS, type DeepDivePillar } from "./deep-dive-records.js";

/**
 * Agent drafts in a Deep Dive (GRE-4430, copied from indago-portal PR #31's
 * log_interview / propose_record). An agent logs an interview from a Notion
 * transcript, or proposes a register row, as a DRAFT. A person approves or
 * rejects it in the portal. Agents never approve, publish or delete.
 */

export const DEEP_DIVE_DRAFT_KINDS = ["interview_log", "record_proposal"] as const;
export type DeepDiveDraftKind = (typeof DEEP_DIVE_DRAFT_KINDS)[number];

export const DEEP_DIVE_DRAFT_STATUSES = ["draft", "approved", "rejected"] as const;
export type DeepDiveDraftStatus = (typeof DEEP_DIVE_DRAFT_STATUSES)[number];

export const DEEP_DIVE_ANSWER_STATUSES = ["answered", "unclear", "not_answered"] as const;
export type DeepDiveAnswerStatus = (typeof DEEP_DIVE_ANSWER_STATUSES)[number];

export const DEEP_DIVE_ANSWER_LABELS: Record<DeepDiveAnswerStatus, string> = {
  answered: "Answered",
  unclear: "Unclear",
  not_answered: "Not answered",
};

export const DEEP_DIVE_DRAFT_LABELS: Record<DeepDiveDraftStatus | DeepDiveDraftKind, string> = {
  draft: "Waiting for review",
  approved: "Approved",
  rejected: "Rejected",
  interview_log: "Interview log",
  record_proposal: "Proposed record",
};

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const pillars = z.array(z.enum(DEEP_DIVE_PILLARS)).max(DEEP_DIVE_PILLARS.length).optional();

export const deepDiveInterviewItemSchema = z
  .object({
    ref: optionalText(80),
    question: text(1_000),
    status: z.enum(DEEP_DIVE_ANSWER_STATUSES),
    answer: optionalText(5_000),
    /** The speaker's exact words, two sentences at most. */
    quote: optionalText(600),
    /** Time in the recording, for example 00:14:05. */
    at: optionalText(20),
    workstream: optionalText(120),
    pillars,
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.status === "answered" && (!item.answer || !item.quote)) {
      ctx.addIssue({ code: "custom", message: "An answered question needs an answer and a verbatim quote", path: ["quote"] });
    }
    if (item.status === "not_answered" && item.answer) {
      ctx.addIssue({ code: "custom", message: "A not answered question has no answer; use unclear if something was said", path: ["answer"] });
    }
  });
export type DeepDiveInterviewItem = z.infer<typeof deepDiveInterviewItemSchema>;

export const deepDiveInterviewLogSchema = z
  .object({
    notionPage: text(500),
    meetingTitle: text(200),
    heldOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "heldOn must be a date (YYYY-MM-DD)"),
    /** Name and role as written in Notion. No contact details. */
    interviewee: text(200),
    /** Where the questions came from: the Deep Dive's questions or the document a person named. */
    questionSource: text(500),
    items: z.array(deepDiveInterviewItemSchema).min(1).max(150),
    outsideNotes: z
      .array(z.object({ note: text(2_000), quote: optionalText(600), at: optionalText(20), workstream: optionalText(120), pillars }).strict())
      .max(60)
      .optional(),
  })
  .strict();
export type DeepDiveInterviewLog = z.infer<typeof deepDiveInterviewLogSchema>;

export const deepDiveRecordProposalSchema = z
  .object({
    /** The register the row is for, for example Risks, Decisions or Evidence. */
    register: text(120),
    values: z.record(z.string().trim().min(1).max(120), z.string().max(5_000)).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 60, {
      message: "values holds 1 to 60 columns",
    }),
    workstream: optionalText(120),
    pillars,
  })
  .strict();
export type DeepDiveRecordProposal = z.infer<typeof deepDiveRecordProposalSchema>;

const revise = {
  /** Change this open draft instead of making a new one. */
  draftId: z.string().guid().optional(),
  /** Needed with draftId: the version last read. */
  expectedVersion: z.number().int().min(1).optional(),
};

export const logDeepDiveInterviewSchema = z
  .object({ ...revise, interview: deepDiveInterviewLogSchema })
  .strict()
  .refine((v) => !v.draftId || v.expectedVersion, { message: "expectedVersion is needed with draftId", path: ["expectedVersion"] });
export type LogDeepDiveInterview = z.infer<typeof logDeepDiveInterviewSchema>;

export const proposeDeepDiveRecordSchema = z
  .object({ ...revise, title: text(200), proposal: deepDiveRecordProposalSchema })
  .strict()
  .refine((v) => !v.draftId || v.expectedVersion, { message: "expectedVersion is needed with draftId", path: ["expectedVersion"] });
export type ProposeDeepDiveRecord = z.infer<typeof proposeDeepDiveRecordSchema>;

export const decideDeepDiveDraftSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    expectedVersion: z.number().int().min(1),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();
export type DecideDeepDiveDraft = z.infer<typeof decideDeepDiveDraftSchema>;

export interface DeepDiveDraft {
  id: string;
  companyId: string;
  recordCaseId: string;
  kind: DeepDiveDraftKind;
  title: string;
  payload: DeepDiveInterviewLog | DeepDiveRecordProposal;
  status: DeepDiveDraftStatus;
  version: number;
  createdByAgentId: string | null;
  createdByRunId: string | null;
  createdByUserId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Counts of an interview log's items, for a one-line summary. */
export function deepDiveInterviewCounts(log: DeepDiveInterviewLog): Record<DeepDiveAnswerStatus, number> & { notes: number } {
  const counts = { answered: 0, unclear: 0, not_answered: 0, notes: log.outsideNotes?.length ?? 0 };
  for (const item of log.items) counts[item.status] += 1;
  return counts;
}

/** Workstreams a payload names that the Deep Dive does not hold (empty list means any is allowed). */
export function deepDiveUnknownWorkstreams(
  payload: { items?: { workstream?: string }[]; outsideNotes?: { workstream?: string }[]; workstream?: string },
  workstreams: readonly string[],
): string[] {
  if (workstreams.length === 0) return [];
  const named = [
    payload.workstream,
    ...(payload.items ?? []).map((i) => i.workstream),
    ...(payload.outsideNotes ?? []).map((n) => n.workstream),
  ].filter((w): w is string => !!w);
  return [...new Set(named.filter((w) => !workstreams.includes(w)))];
}

export type { DeepDivePillar };
