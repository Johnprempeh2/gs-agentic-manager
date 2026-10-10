import type { DocumentEvidenceSource } from "@greatstone/shared";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";
import { issues } from "./issues.js";

/**
 * Evidence trail on issue documents (GRE-1146): the source links and labels of
 * one bullet, keyed by the bullet's ID in the document ("S1", "E3"). Sources
 * are validated by `documentEvidenceSourceSchema` in @greatstone/shared.
 */
export const documentEvidenceLinks = pgTable(
  "document_evidence_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    documentKey: text("document_key").notNull(),
    bulletId: text("bullet_id").notNull(),
    sources: jsonb("sources").$type<DocumentEvidenceSource[]>().notNull().default([]),
    inference: boolean("inference").notNull().default(false),
    judgement: boolean("judgement").notNull().default(false),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentBulletUq: uniqueIndex("document_evidence_links_document_bullet_uq").on(table.documentId, table.bulletId),
    companyIssueIdx: index("document_evidence_links_company_issue_idx").on(table.companyId, table.issueId),
  }),
);
