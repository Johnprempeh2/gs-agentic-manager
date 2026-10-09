import { pgTable, uuid, text, timestamp, index, date, doublePrecision, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { goals } from "./goals.js";

/**
 * Dated values of a KPI goal (GRE-1133). Rows are never edited: a correction
 * is a new reading, so the board sees every number and who gave it.
 */
export const goalKpiReadings = pgTable(
  "goal_kpi_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    value: doublePrecision("value").notNull(),
    readingDate: date("reading_date").notNull(),
    note: text("note"),
    /** owner_reported | agent_verified | system */
    source: text("source").notNull(),
    recordedByAgentId: uuid("recorded_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    recordedByUserId: text("recorded_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalDateIdx: index("goal_kpi_readings_goal_date_idx").on(table.goalId, table.readingDate, table.createdAt),
    companyIdx: index("goal_kpi_readings_company_idx").on(table.companyId),
    sourceCheck: check(
      "goal_kpi_readings_source_check",
      sql`${table.source} in ('owner_reported', 'agent_verified', 'system')`,
    ),
  }),
);
