import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { pipelineCases } from "./pipeline_cases.js";

/**
 * The links register (GRE-4252): every link we share, by client and project.
 * One row per URL per company; registering the same URL again updates the row.
 * Archiving sets status "archived"; rows are never deleted.
 */
export const sharedLinks = pgTable(
  "links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    url: text("url").notNull(),
    title: text("title").notNull(),
    /** proposal, demo, recap, portal, deck, report, preview or other. */
    type: text("type").notNull().default("other"),
    /** live, draft, archived or broken. */
    status: text("status").notNull().default("live"),
    /** manual, deliverable, preview or import. */
    source: text("source").notNull().default("manual"),
    clientCaseId: uuid("client_case_id").references(() => pipelineCases.id, { onDelete: "set null" }),
    /** The client as written when no client page matched (imported rows). */
    clientName: text("client_name"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    projectName: text("project_name"),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    notes: text("notes"),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    addedByAgentId: uuid("added_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    addedByUserId: text("added_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUrlUq: uniqueIndex("links_company_url_uq").on(table.companyId, table.url),
    companyClientIdx: index("links_company_client_idx").on(table.companyId, table.clientCaseId),
    companyUpdatedIdx: index("links_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);
