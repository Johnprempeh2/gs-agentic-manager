import { z } from "zod";

/**
 * One Deep Dive per client engagement (GRE-4430, John 11 Nov). A Deep Dive is
 * a `deep_dive` record case whose `client_case_id` is the client's journey
 * case. A client can hold more than one over time, so the record carries no
 * fixed key. Everything in the Deep Dive belongs to one record.
 *
 * Grouping follows Ben's portal: the record's own workstreams, named per
 * Deep Dive. Every item may also carry pillar tags. Method vocabulary only:
 * never client data.
 */

/** The eight working pillars (Operating Standard v2.3, Appendix A), used as tags. */
export const DEEP_DIVE_PILLARS = [
  "data",
  "technology",
  "people",
  "communication",
  "process",
  "governance",
  "customer",
  "competitor",
] as const;
export type DeepDivePillar = (typeof DEEP_DIVE_PILLARS)[number];

export const DEEP_DIVE_PILLAR_LABELS: Record<DeepDivePillar, string> = {
  data: "Data",
  technology: "Technology",
  people: "People",
  communication: "Communication",
  process: "Process",
  governance: "Governance",
  customer: "Customer",
  competitor: "Competitor",
};

export const DEEP_DIVE_RECORD_STATUSES = ["active", "finished"] as const;
export type DeepDiveRecordStatus = (typeof DEEP_DIVE_RECORD_STATUSES)[number];

/** The `fields` object of a record case. Workstreams start empty until Ben's plan template lands. */
export interface DeepDiveRecordFields {
  workstreams: string[];
  status: DeepDiveRecordStatus;
}

export function readDeepDiveRecordFields(raw: Record<string, unknown> | null | undefined): DeepDiveRecordFields {
  const workstreams = Array.isArray(raw?.workstreams)
    ? [...new Set(raw.workstreams.filter((w): w is string => typeof w === "string" && w.trim().length > 0).map((w) => w.trim()))]
    : [];
  return { workstreams, status: raw?.status === "finished" ? "finished" : "active" };
}

export const startDeepDiveSchema = z
  .object({
    clientCaseId: z.string().guid(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type StartDeepDive = z.infer<typeof startDeepDiveSchema>;

export const updateDeepDiveRecordSchema = z
  .object({
    workstreams: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
    status: z.enum(DEEP_DIVE_RECORD_STATUSES).optional(),
  })
  .strict();
export type UpdateDeepDiveRecord = z.infer<typeof updateDeepDiveRecordSchema>;

/** One tile on the Deep Dive page. */
export interface DeepDiveRecordSummary {
  id: string;
  identifier: string | null;
  title: string;
  clientCaseId: string;
  clientName: string;
  organisationId: string | null;
  workstreams: string[];
  status: DeepDiveRecordStatus;
  draftsWaiting: number;
  findingsToValidate: number;
  createdAt: string;
}

/** A client a person can start a Deep Dive for. */
export interface DeepDiveStartableClient {
  id: string;
  name: string;
  stageName: string;
  atDeepDiveStage: boolean;
}

/** A scope every Deep Dive read and write runs in. */
export interface DeepDiveScope {
  companyId: string;
  recordCaseId: string;
}
