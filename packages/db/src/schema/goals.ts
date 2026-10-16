import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  date,
  doublePrecision,
  bigint,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    description: text("description"),
    level: text("level").notNull().default("task"),
    /** Strategy layer (vision, value, csf, pillar, objective, kpi, initiative). Null for plain goals. */
    kind: text("kind"),
    status: text("status").notNull().default("planned"),
    parentId: uuid("parent_id").references((): AnyPgColumn => goals.id),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id),
    /** A person who owns the goal. A goal has a person or an agent owner, not both. */
    ownerUserId: text("owner_user_id"),
    targetDate: date("target_date"),
    doneWhen: text("done_when"),
    targetValue: doublePrecision("target_value"),
    currentValue: doublePrecision("current_value"),
    unit: text("unit"),
    /** KPI plan (GRE-1133): baseline to target by targetDate. See shared goal-kpi-status.ts. */
    baselineValue: doublePrecision("baseline_value"),
    baselineDate: date("baseline_date"),
    /** "up" or "down" is good; null means up. */
    kpiDirection: text("kpi_direction"),
    amberThresholdPct: doublePrecision("amber_threshold_pct"),
    redThresholdPct: doublePrecision("red_threshold_pct"),
    /** Initiative budget in minor units of budgetCurrency. */
    budgetPlannedCents: bigint("budget_planned_cents", { mode: "number" }),
    budgetSpentCents: bigint("budget_spent_cents", { mode: "number" }),
    budgetCurrency: text("budget_currency"),
    /** Peer benchmark from a research pack (GRE-1161): context for the target, never the target. */
    benchmarkNote: text("benchmark_note"),
    /** Research pack document a pre-filled KPI came from: issue, document key and bullet ID. */
    sourceIssueId: uuid("source_issue_id").references((): AnyPgColumn => issues.id, { onDelete: "set null" }),
    sourceDocumentKey: text("source_document_key"),
    sourceBulletId: text("source_bullet_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("goals_company_idx").on(table.companyId),
  }),
);
