import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { cases } from "./cases.js";
import { companies } from "./companies.js";

// Agent drafts in a Deep Dive (GRE-4430, migration 0421). An agent logs an
// interview or proposes a register row as a draft; only a person decides it.
// The deep_dive_drafts_guard trigger makes a decided draft final, keeps the
// author and the Deep Dive fixed, and refuses every delete.
export const deepDiveDrafts = pgTable(
  "deep_dive_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    recordCaseId: uuid("record_case_id").notNull().references(() => cases.id),
    kind: text("kind").$type<"interview_log" | "record_proposal">().notNull(),
    title: text("title").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"draft" | "approved" | "rejected">().notNull().default("draft"),
    version: integer("version").notNull().default(1),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByRunId: uuid("created_by_run_id"),
    createdByUserId: text("created_by_user_id"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    recordStatusIdx: index("deep_dive_drafts_record_status_idx").on(table.companyId, table.recordCaseId, table.status),
    kindCheck: check("deep_dive_drafts_kind_check", sql`${table.kind} in ('interview_log', 'record_proposal')`),
    statusCheck: check("deep_dive_drafts_status_check", sql`${table.status} in ('draft', 'approved', 'rejected')`),
    decidedByPersonCheck: check(
      "deep_dive_drafts_decided_by_person_check",
      sql`${table.status} = 'draft' or (${table.decidedByUserId} is not null and ${table.decidedAt} is not null)`,
    ),
    authorCheck: check("deep_dive_drafts_author_check", sql`${table.createdByAgentId} is not null or ${table.createdByUserId} is not null`),
  }),
);
