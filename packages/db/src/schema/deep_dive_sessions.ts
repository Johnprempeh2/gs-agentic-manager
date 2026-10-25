import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { caseDocuments, cases } from "./cases.js";
import { companies } from "./companies.js";
import { deepDiveFindings } from "./deep_dive_findings.js";

// Deep Dive sessions (GRE-2368, migration 0397). A session is planned as an
// ordered list of questions, each in one GIF cell (a deep_dive_stream case and
// its gif-* document), run live, and closed. The deep_dive_sessions_guard and
// deep_dive_session_questions_guard triggers keep the order Planned -> Live ->
// Closed, allow answers only while Live, and freeze a closed session except
// for Internal/Shared and the one-time link from an answer to its finding.
export const deepDiveSessions = pgTable(
  "deep_dive_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    // planned -> live -> closed.
    status: text("status").$type<"planned" | "live" | "closed">().notNull().default("planned"),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    plannedFor: timestamp("planned_for", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("deep_dive_sessions_company_created_idx").on(table.companyId, table.createdAt),
    statusCheck: check("deep_dive_sessions_status_check", sql`${table.status} in ('planned', 'live', 'closed')`),
    visibilityCheck: check("deep_dive_sessions_visibility_check", sql`${table.visibility} in ('internal', 'shared')`),
    titleCheck: check("deep_dive_sessions_title_check", sql`length(btrim(${table.title})) > 0`),
    timesCheck: check(
      "deep_dive_sessions_times_check",
      sql`(${table.status} = 'planned') = (${table.startedAt} is null)
        and (${table.status} = 'closed') = (${table.closedAt} is not null)`,
    ),
  }),
);

export const deepDiveSessionQuestions = pgTable(
  "deep_dive_session_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => deepDiveSessions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    streamCaseId: uuid("stream_case_id").notNull().references(() => cases.id),
    gifDocumentId: uuid("gif_document_id").notNull().references(() => caseDocuments.id),
    prompt: text("prompt").notNull(),
    answer: text("answer"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredByAgentId: uuid("answered_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    answeredByUserId: text("answered_by_user_id"),
    // The proposed finding this answer became, set once.
    findingId: uuid("finding_id").references(() => deepDiveFindings.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionPositionIdx: index("deep_dive_session_questions_session_position_idx").on(table.sessionId, table.position),
    gifDocumentIdx: index("deep_dive_session_questions_gif_document_idx").on(table.gifDocumentId),
    findingUq: uniqueIndex("deep_dive_session_questions_finding_uq")
      .on(table.findingId)
      .where(sql`${table.findingId} is not null`),
    promptCheck: check("deep_dive_session_questions_prompt_check", sql`length(btrim(${table.prompt})) > 0`),
    answeredCheck: check(
      "deep_dive_session_questions_answered_check",
      sql`(${table.answer} is null) = (${table.answeredAt} is null)`,
    ),
  }),
);
