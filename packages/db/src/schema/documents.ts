import { pgTable, uuid, text, integer, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import type { SourceTrustMetadata } from "@greatstone/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title"),
    format: text("format").notNull().default("markdown"),
    latestBody: text("latest_body").notNull(),
    latestRevisionId: uuid("latest_revision_id"),
    latestRevisionNumber: integer("latest_revision_number").notNull().default(1),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedByAgentId: uuid("locked_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    lockedByUserId: text("locked_by_user_id"),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    // The revision a board user or the owning assignee marked as the current
    // approved one. Revision numbers never change, so the number is kept here
    // for display without a join.
    approvedRevisionId: uuid("approved_revision_id"),
    approvedRevisionNumber: integer("approved_revision_number"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByAgentId: uuid("approved_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    approvedByUserId: text("approved_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUpdatedIdx: index("documents_company_updated_idx").on(table.companyId, table.updatedAt),
    companyCreatedIdx: index("documents_company_created_idx").on(table.companyId, table.createdAt),
    titleSearchIdx: index("documents_title_search_idx").using("gin", table.title.op("gin_trgm_ops")),
    bodySearchIdx: index("documents_latest_body_search_idx").using("gin", table.latestBody.op("gin_trgm_ops")),
  }),
);
