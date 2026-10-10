import { sql } from "drizzle-orm";
import { check, date, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chatEndpoints } from "./chat_channels.js";
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

/**
 * Board email (GRE-1187): the company's next board meeting and the inbox the
 * board secretary sends from. One row per company.
 */
export const strategyBoardSettings = pgTable("strategy_board_settings", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id),
  /** The chat_endpoints row of the board secretary's AgentMail inbox; null = no board email. */
  secretaryEndpointId: uuid("secretary_endpoint_id").references(() => chatEndpoints.id, { onDelete: "set null" }),
  nextMeetingDate: date("next_meeting_date"),
  /** Owners get their reminder this many days before the meeting. */
  reminderLeadDays: integer("reminder_lead_days").notNull().default(7),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One board email to one person. `dedupe_key` is unique per company, so the
 * same reminder, alert or "Why?" request is never emailed twice. GRE-1196
 * reads `kpi_codes` and the ids to store a reply on the plan.
 */
export const strategyBoardEmails = pgTable(
  "strategy_board_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** meeting_reminder | slippage_alert | why_request */
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    recipientUserId: text("recipient_user_id").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    endpointId: uuid("endpoint_id").references(() => chatEndpoints.id, { onDelete: "set null" }),
    alertId: uuid("alert_id").references(() => goalKpiAlerts.id, { onDelete: "set null" }),
    whyRequestId: uuid("why_request_id").references(() => goalWhyRequests.id, { onDelete: "set null" }),
    meetingDate: date("meeting_date"),
    /** Meeting reminders: reply code ("K1") to KPI goal id. */
    kpiCodes: jsonb("kpi_codes").$type<Record<string, string>>(),
    /** The email send (chat_publications id) once it is queued. */
    publicationId: uuid("publication_id"),
    /** queued | failed */
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dedupeIdx: uniqueIndex("strategy_board_emails_dedupe_idx").on(table.companyId, table.dedupeKey),
    publicationIdx: index("strategy_board_emails_publication_idx").on(table.publicationId),
    kindCheck: check("strategy_board_emails_kind_check", sql`${table.kind} in ('meeting_reminder', 'slippage_alert', 'why_request')`),
    statusCheck: check("strategy_board_emails_status_check", sql`${table.status} in ('queued', 'failed')`),
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
    /** StrategyBoardPackSnapshot (shared types). */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    /** The pack as Markdown. */
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("strategy_board_packs_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
