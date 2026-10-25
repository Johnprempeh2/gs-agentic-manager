import { z } from "zod";
import { DEEP_DIVE_GIF, DEEP_DIVE_VISIBILITIES, type DeepDiveGifKey, type DeepDiveVisibility } from "./deep-dive.js";

/**
 * Deep Dive findings (GRE-2367). A finding is proposed by a person or an
 * agent and validated by a person. It is never edited: a new finding
 * supersedes it. It sits in one GIF cell (stream x GIF question) and cites
 * the client's evidence.
 */
export const DEEP_DIVE_FINDING_STATUSES = ["proposed", "validated", "rejected", "superseded"] as const;
export type DeepDiveFindingStatus = (typeof DEEP_DIVE_FINDING_STATUSES)[number];

export const DEEP_DIVE_FINDING_LABELS: Record<DeepDiveFindingStatus, string> = {
  proposed: "Proposed",
  validated: "Validated",
  rejected: "Rejected",
  superseded: "Superseded",
};

export const DEEP_DIVE_FINDING_NEVER_EDITED = "A finding is never edited; propose a new finding that supersedes it.";

export const DEEP_DIVE_FINDING_MAX_EVIDENCE = 50;

const gifKeys = DEEP_DIVE_GIF.map((gif) => gif.key) as [DeepDiveGifKey, ...DeepDiveGifKey[]];

export const proposeDeepDiveFindingSchema = z
  .object({
    streamCaseId: z.string().guid(),
    gifKey: z.enum(gifKeys),
    statement: z.string().trim().min(1).max(4_000),
    evidenceIds: z.array(z.string().guid()).max(DEEP_DIVE_FINDING_MAX_EVIDENCE).optional(),
    supersedesFindingId: z.string().guid().nullable().optional(),
  })
  .strict();
export type ProposeDeepDiveFinding = z.infer<typeof proposeDeepDiveFindingSchema>;

export const decideDeepDiveFindingSchema = z
  .object({ decision: z.enum(["validated", "rejected"]) })
  .strict();
export type DecideDeepDiveFinding = z.infer<typeof decideDeepDiveFindingSchema>;

/** The only change a finding takes after it is proposed besides its decision. */
export const setDeepDiveFindingVisibilitySchema = z
  .object({ visibility: z.enum(DEEP_DIVE_VISIBILITIES) })
  .strict();

export const listDeepDiveFindingsQuerySchema = z.object({
  streamCaseId: z.string().guid().optional(),
});

export interface DeepDiveFindingEvidence {
  id: string;
  title: string;
  kind: string;
  clientCaseId: string;
}

export interface DeepDiveFinding {
  id: string;
  companyId: string;
  streamCaseId: string;
  gifKey: DeepDiveGifKey;
  gifDocumentId: string;
  statement: string;
  status: DeepDiveFindingStatus;
  visibility: DeepDiveVisibility;
  supersedesFindingId: string | null;
  supersededByFindingId: string | null;
  proposedByAgentId: string | null;
  proposedByUserId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  supersededAt: string | null;
  createdAt: string;
  evidence: DeepDiveFindingEvidence[];
}

/** Which way a finding may move next. Validation and rejection are a person's. */
export function deepDiveFindingNextSteps(status: DeepDiveFindingStatus): { decide: boolean; supersede: boolean } {
  return { decide: status === "proposed", supersede: status === "validated" };
}
