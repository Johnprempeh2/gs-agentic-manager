import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { cases } from "./cases.js";
import { companies } from "./companies.js";
import { pipelineCaseDocumentRequests, pipelineCaseEvidence } from "./pipeline_cases.js";

// One client file, many Deep Dive items (GRE-2395, migration 0396). A link
// points a Deep Dive item at one of its client's evidence rows (a file we hold)
// or at one of its client's document requests (held once received, missing
// until then). The file itself stays where it is; unlinking removes only this
// row. Internal unless a person sets Shared, like every Deep Dive item. The
// deep_dive_item_files_guard_writes trigger keeps the target on the item's own
// client and refuses every write made for a client.
export const deepDiveItemFiles = pgTable(
  "deep_dive_item_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id").references(() => pipelineCaseEvidence.id, { onDelete: "cascade" }),
    documentRequestId: uuid("document_request_id")
      .references(() => pipelineCaseDocumentRequests.id, { onDelete: "cascade" }),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    linkedByUserId: text("linked_by_user_id"),
    linkedByAgentId: uuid("linked_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCaseIdx: index("deep_dive_item_files_company_case_idx").on(table.companyId, table.caseId),
    evidenceIdx: index("deep_dive_item_files_evidence_idx").on(table.evidenceId),
    documentRequestIdx: index("deep_dive_item_files_document_request_idx").on(table.documentRequestId),
    caseEvidenceUq: uniqueIndex("deep_dive_item_files_case_evidence_uq")
      .on(table.caseId, table.evidenceId)
      .where(sql`${table.evidenceId} is not null`),
    caseDocumentRequestUq: uniqueIndex("deep_dive_item_files_case_document_request_uq")
      .on(table.caseId, table.documentRequestId)
      .where(sql`${table.documentRequestId} is not null`),
    targetCheck: check(
      "deep_dive_item_files_target_check",
      sql`(${table.evidenceId} is null) <> (${table.documentRequestId} is null)`,
    ),
    visibilityCheck: check("deep_dive_item_files_visibility_check", sql`${table.visibility} in ('internal', 'shared')`),
  }),
);
