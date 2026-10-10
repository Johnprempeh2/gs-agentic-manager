import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * A company's reusable issue-tree recipe (GRE-1145). The definition is data,
 * validated by `workflowTemplateDefinitionSchema` in @greatstone/shared; one
 * "start" call turns it into a coordinator issue, step child issues, review
 * stages and empty document slots in a single transaction.
 */
export const workflowTemplates = pgTable(
  "workflow_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("workflow_templates_company_key_uq").on(table.companyId, table.key),
    companyUpdatedIdx: index("workflow_templates_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);
