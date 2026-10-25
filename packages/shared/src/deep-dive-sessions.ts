import { z } from "zod";
import {
  DEEP_DIVE_GIF,
  DEEP_DIVE_VISIBILITIES,
  type DeepDiveGifKey,
  type DeepDiveKnowledge,
  type DeepDiveVisibility,
} from "./deep-dive.js";
import type { DeepDiveFindingStatus } from "./deep-dive-findings.js";

/**
 * Deep Dive sessions (GRE-2368). A session is planned as a list of questions,
 * each in one GIF cell (stream x GIF question), run live one question at a
 * time, and closed. What is already known about a cell shows beside its
 * question so nothing is asked twice. An answer can become a proposed finding
 * in the same cell.
 */
export const DEEP_DIVE_SESSION_STATUSES = ["planned", "live", "closed"] as const;
export type DeepDiveSessionStatus = (typeof DEEP_DIVE_SESSION_STATUSES)[number];

export const DEEP_DIVE_SESSION_LABELS: Record<DeepDiveSessionStatus, string> = {
  planned: "Planned",
  live: "Live",
  closed: "Closed",
};

export const DEEP_DIVE_SESSION_MAX_QUESTIONS = 100;

const gifKeys = DEEP_DIVE_GIF.map((gif) => gif.key) as [DeepDiveGifKey, ...DeepDiveGifKey[]];

export const addDeepDiveSessionQuestionSchema = z
  .object({
    streamCaseId: z.string().guid(),
    gifKey: z.enum(gifKeys),
    /** Defaults to the GIF question. */
    prompt: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
export type AddDeepDiveSessionQuestion = z.infer<typeof addDeepDiveSessionQuestionSchema>;

export const planDeepDiveSessionSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    plannedFor: z.string().datetime({ offset: true }).nullable().optional(),
    questions: z.array(addDeepDiveSessionQuestionSchema).max(DEEP_DIVE_SESSION_MAX_QUESTIONS).optional(),
  })
  .strict();
export type PlanDeepDiveSession = z.infer<typeof planDeepDiveSessionSchema>;

/** Title and date change until the session closes; Internal/Shared is a person's choice. */
export const updateDeepDiveSessionSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    plannedFor: z.string().datetime({ offset: true }).nullable().optional(),
    visibility: z.enum(DEEP_DIVE_VISIBILITIES).optional(),
  })
  .strict();
export type UpdateDeepDiveSession = z.infer<typeof updateDeepDiveSessionSchema>;

/** The prompt changes only while planned; the answer only while live. */
export const updateDeepDiveSessionQuestionSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2_000).optional(),
    answer: z.string().max(8_000).nullable().optional(),
  })
  .strict();
export type UpdateDeepDiveSessionQuestion = z.infer<typeof updateDeepDiveSessionQuestionSchema>;

/** Turn an answer into a proposed finding. The statement defaults to the answer. */
export const answerToDeepDiveFindingSchema = z
  .object({
    statement: z.string().trim().min(1).max(4_000).optional(),
    evidenceIds: z.array(z.string().guid()).max(50).optional(),
  })
  .strict();
export type AnswerToDeepDiveFinding = z.infer<typeof answerToDeepDiveFindingSchema>;

/** One thing already known about a GIF cell, shown beside its question. */
export interface DeepDiveCellKnown {
  knowledge: DeepDiveKnowledge;
  /** The cell's GIF document, or null while it holds only the stub. */
  cellText: string | null;
  findings: { id: string; statement: string; status: DeepDiveFindingStatus }[];
  /** Answers to the same cell in other sessions, newest first. */
  earlierAnswers: { questionId: string; sessionId: string; sessionTitle: string; answer: string; answeredAt: string }[];
}

export interface DeepDiveSessionQuestion {
  id: string;
  sessionId: string;
  position: number;
  streamCaseId: string;
  gifKey: DeepDiveGifKey;
  gifDocumentId: string;
  prompt: string;
  answer: string | null;
  answeredAt: string | null;
  answeredByUserId: string | null;
  answeredByAgentId: string | null;
  findingId: string | null;
  known: DeepDiveCellKnown;
}

export interface DeepDiveSessionSummary {
  id: string;
  companyId: string;
  title: string;
  status: DeepDiveSessionStatus;
  visibility: DeepDiveVisibility;
  plannedFor: string | null;
  startedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  questionCount: number;
  answeredCount: number;
}

export interface DeepDiveSession extends DeepDiveSessionSummary {
  questions: DeepDiveSessionQuestion[];
}

/** What a session allows next. */
export function deepDiveSessionNextSteps(status: DeepDiveSessionStatus) {
  return {
    start: status === "planned",
    close: status === "live",
    addQuestion: status !== "closed",
    editPrompt: status === "planned",
    removeQuestion: status === "planned",
    answer: status === "live",
  };
}

/** The question to ask now: the first one in order with no answer, else null. */
export function currentDeepDiveSessionQuestion<T extends { answer: string | null; position: number }>(
  questions: readonly T[],
): T | null {
  return [...questions].sort((a, b) => a.position - b.position).find((q) => !q.answer?.trim()) ?? null;
}

/** True when something is already known about a cell, so the question may not need asking. */
export function deepDiveCellHasKnown(known: DeepDiveCellKnown): boolean {
  return (
    known.knowledge !== "unknown" ||
    !!known.cellText ||
    known.findings.some((finding) => finding.status === "validated" || finding.status === "proposed") ||
    known.earlierAnswers.length > 0
  );
}
