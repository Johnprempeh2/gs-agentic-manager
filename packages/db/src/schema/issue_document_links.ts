import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { documents } from "./documents.js";
import { agents } from "./agents.js";

/**
 * A task pointing at a document owned by another task in the same company, so
 * stage tasks share one live document instead of copies. The link grants no
 * write access; writes still go through the owning task.
 */
export const issueDocumentLinks = pgTable(
  "issue_document_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueDocumentUq: uniqueIndex("issue_document_links_issue_document_uq").on(table.issueId, table.documentId),
    companyIssueIdx: index("issue_document_links_company_issue_idx").on(table.companyId, table.issueId),
    documentIdx: index("issue_document_links_document_idx").on(table.documentId),
  }),
);
