import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { caseDocuments, cases } from "./cases.js";
import { companies } from "./companies.js";
import { pipelineCaseEvidence } from "./pipeline_cases.js";

// Deep Dive findings (GRE-2367, migration 0397). A finding is proposed by a
// person or an agent and validated by a person. It is never edited: a new
// finding supersedes it. It links to its Investigation Stream (a
// deep_dive_stream case), its GIF cell (that stream's gif-* document) and its
// evidence (rows of pipeline_case_evidence). The deep_dive_findings_guard
// trigger refuses every change except the one-way status steps and
// Internal/Shared.
export const deepDiveFindings = pgTable(
  "deep_dive_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    streamCaseId: uuid("stream_case_id").notNull().references(() => cases.id),
    gifDocumentId: uuid("gif_document_id").notNull().references(() => caseDocuments.id),
    statement: text("statement").notNull(),
    // proposed -> validated | rejected; validated -> superseded.
    status: text("status").$type<"proposed" | "validated" | "rejected" | "superseded">().notNull().default("proposed"),
    supersedesFindingId: uuid("supersedes_finding_id").references((): AnyPgColumn => deepDiveFindings.id),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    proposedByUserId: text("proposed_by_user_id"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStreamIdx: index("deep_dive_findings_company_stream_idx").on(table.companyId, table.streamCaseId),
    gifDocumentIdx: index("deep_dive_findings_gif_document_idx").on(table.gifDocumentId),
    // One live successor per finding: a rejected successor frees the slot.
    supersedesUq: uniqueIndex("deep_dive_findings_supersedes_uq")
      .on(table.supersedesFindingId)
      .where(sql`${table.supersedesFindingId} is not null and ${table.status} <> 'rejected'`),
    statusCheck: check(
      "deep_dive_findings_status_check",
      sql`${table.status} in ('proposed', 'validated', 'rejected', 'superseded')`,
    ),
    visibilityCheck: check("deep_dive_findings_visibility_check", sql`${table.visibility} in ('internal', 'shared')`),
    statementCheck: check("deep_dive_findings_statement_check", sql`length(btrim(${table.statement})) > 0`),
    decidedCheck: check(
      "deep_dive_findings_decided_check",
      sql`(${table.status} = 'proposed') = (${table.decidedAt} is null)
        and (${table.decidedAt} is null or ${table.decidedByUserId} is not null)`,
    ),
  }),
);

export const deepDiveFindingEvidence = pgTable(
  "deep_dive_finding_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id").notNull().references(() => deepDiveFindings.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id").notNull().references(() => pipelineCaseEvidence.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    findingEvidenceUq: uniqueIndex("deep_dive_finding_evidence_finding_evidence_uq").on(table.findingId, table.evidenceId),
    evidenceIdx: index("deep_dive_finding_evidence_evidence_idx").on(table.evidenceId),
  }),
);
