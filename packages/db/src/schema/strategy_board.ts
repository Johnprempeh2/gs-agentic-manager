import { sql } from "drizzle-orm";
import { check, date, doublePrecision, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { goalKpiReadings } from "./goal_kpi_readings.js";
import { goals } from "./goals.js";
import { issues } from "./issues.js";

/**
 * Board control panel (GRE-1135).
 *
 * A "Why?" request: a board member asks a KPI owner to explain a slippage.
 * The answer stays on the row, so it is logged on the KPI.
 */
export const goalWhyRequests = pgTable(
  "goal_why_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    /** open | answered */
    status: text("status").notNull().default("open"),
    askedByUserId: text("asked_by_user_id").notNull(),
    ownerUserId: text("owner_user_id"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ownerIssueId: uuid("owner_issue_id").references(() => issues.id, { onDelete: "set null" }),
    answer: text("answer"),
    answeredByUserId: text("answered_by_user_id"),
    answeredByAgentId: uuid("answered_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalIdx: index("goal_why_requests_goal_idx").on(table.goalId, table.createdAt),
    companyStatusIdx: index("goal_why_requests_company_status_idx").on(table.companyId, table.status),
    statusCheck: check("goal_why_requests_status_check", sql`${table.status} in ('open', 'answered')`),
  }),
);

/**
 * One red spell of a KPI. While a spell is open (cleared_at is null) no new
 * alert is sent; the partial unique index makes that hold under races.
 */
export const goalKpiAlerts = pgTable(
  "goal_kpi_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    readingId: uuid("reading_id").references(() => goalKpiReadings.id, { onDelete: "set null" }),
    /** The chair the alert went to; null when the board had no chair. */
    recipientUserId: text("recipient_user_id"),
    alertIssueId: uuid("alert_issue_id").references(() => issues.id, { onDelete: "set null" }),
    gapPercent: doublePrecision("gap_percent"),
    latestValue: doublePrecision("latest_value"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
  },
  (table) => ({
    openSpellIdx: uniqueIndex("goal_kpi_alerts_open_spell_idx").on(table.goalId).where(sql`${table.clearedAt} is null`),
    companyIdx: index("goal_kpi_alerts_company_idx").on(table.companyId, table.openedAt),
  }),
);

/** A board pack: a frozen snapshot of what the board saw for a period. */
export const strategyBoardPacks = pgTable(
  "strategy_board_packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    createdByUserId: text("created_by_user_id"),
    /** The board secretary agent that made a draft (GRE-1200); null when a person made it. */
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** draft | accepted. Only an accepted pack is the meeting's pack (GRE-1200). */
    status: text("status").notNull().default("accepted"),
    acceptedByUserId: text("accepted_by_user_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** StrategyBoardPackSnapshot (shared types). */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    /** The pack as Markdown. */
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("strategy_board_packs_company_created_idx").on(table.companyId, table.createdAt),
    statusCheck: check("strategy_board_packs_status_check", sql`${table.status} in ('draft', 'accepted')`),
  }),
);
