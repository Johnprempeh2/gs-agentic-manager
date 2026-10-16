import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { documents } from "./documents.js";
import { agents } from "./agents.js";

export const issueDocuments = pgTable(
  "issue_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    // One extra agent the owning task names as allowed to write this document,
    // besides the owning task's assignee. Null means only the assignee.
    makerAgentId: uuid("maker_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueKeyUq: uniqueIndex("issue_documents_company_issue_key_uq").on(
      table.companyId,
      table.issueId,
      table.key,
    ),
    documentUq: uniqueIndex("issue_documents_document_uq").on(table.documentId),
    companyIssueUpdatedIdx: index("issue_documents_company_issue_updated_idx").on(
      table.companyId,
      table.issueId,
      table.updatedAt,
    ),
  }),
);
