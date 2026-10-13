import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Intelligence page: one report per company, date and kind (`daily_pulse`,
 * `ai_briefing`). An agent writes `sections`; the shared zod schemas define
 * their shape and the API refuses anything else.
 */
export const intelligenceReports = pgTable(
  "intelligence_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    reportDate: text("report_date").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("draft"),
    headline: text("headline"),
    sections: jsonb("sections").$type<Record<string, unknown>>().notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDateKindUq: uniqueIndex("intelligence_reports_company_date_kind_uq").on(
      table.companyId,
      table.reportDate,
      table.kind,
    ),
  }),
);

/** One snapshot per company, board and date; movement is computed against an earlier one. */
export const intelligenceBoardSnapshots = pgTable(
  "intelligence_board_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    board: text("board").notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    entries: jsonb("entries").$type<Record<string, unknown>[]>().notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyBoardDateUq: uniqueIndex("intelligence_board_snapshots_company_board_date_uq").on(
      table.companyId,
      table.board,
      table.snapshotDate,
    ),
  }),
);

/** GSAM feature and skill ideas an agent proposes; the board accepts, dismisses or turns one into a task. */
export const intelligenceRecommendations = pgTable(
  "intelligence_recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    why: text("why").notNull(),
    effort: text("effort").notNull(),
    status: text("status").notNull().default("new"),
    sourceUrl: text("source_url"),
    reportDate: text("report_date"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("intelligence_recommendations_company_status_idx").on(table.companyId, table.status),
    companyKindTitleUq: uniqueIndex("intelligence_recommendations_company_kind_title_uq").on(
      table.companyId,
      table.kind,
      table.title,
    ),
  }),
);
