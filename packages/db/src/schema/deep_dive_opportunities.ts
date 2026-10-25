import { sql } from "drizzle-orm";
import {
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { deepDivePeople, deepDiveProcesses } from "./deep_dive_boards.js";
import { deepDiveFindings } from "./deep_dive_findings.js";

// Deep Dive opportunities and KPIs (GRE-2370, migration 0399). Many validated
// findings point at one opportunity (deep_dive_opportunity_findings), and one
// opportunity needs many builds (deep_dive_builds.opportunity_id). A KPI is
// owned by a person on the organisation board, has a target and a baseline it
// can be compared against, and names the processes on the process board that
// move it (deep_dive_kpi_processes). Every link is a foreign key. The
// deep_dive_opportunity_guard trigger keeps links inside one company, makes
// new items Internal and links only validated findings, for any writer.

const visibilityCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} in ('internal', 'shared')`);

export const deepDiveOpportunities = pgTable(
  "deep_dive_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ref: text("ref").notNull().default(""),
    name: text("name").notNull(),
    statement: text("statement").notNull().default(""),
    rootCause: text("root_cause").notNull().default(""),
    // Without a desired outcome it is an observation, not an opportunity.
    desiredOutcome: text("desired_outcome").notNull(),
    potentialValue: text("potential_value").notNull().default(""),
    state: text("state").$type<"draft" | "refined" | "validated">().notNull().default("draft"),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("deep_dive_opportunities_company_idx").on(table.companyId),
    nameCheck: check("deep_dive_opportunities_name_check", sql`length(btrim(${table.name})) > 0`),
    outcomeCheck: check("deep_dive_opportunities_outcome_check", sql`length(btrim(${table.desiredOutcome})) > 0`),
    stateCheck: check("deep_dive_opportunities_state_check", sql`${table.state} in ('draft', 'refined', 'validated')`),
    visibilityCheck: visibilityCheck("deep_dive_opportunities_visibility_check", table.visibility),
  }),
);

export const deepDiveOpportunityFindings = pgTable(
  "deep_dive_opportunity_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").notNull().references(() => deepDiveOpportunities.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id").notNull().references(() => deepDiveFindings.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pairUq: uniqueIndex("deep_dive_opportunity_findings_pair_uq").on(table.opportunityId, table.findingId),
    findingIdx: index("deep_dive_opportunity_findings_finding_idx").on(table.findingId),
  }),
);

export const deepDiveBuilds = pgTable(
  "deep_dive_builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Null: a proposed build that serves no opportunity yet. Removing the
    // opportunity keeps the build.
    opportunityId: uuid("opportunity_id").references(() => deepDiveOpportunities.id, { onDelete: "set null" }),
    ref: text("ref").notNull().default(""),
    name: text("name").notNull(),
    what: text("what").notNull().default(""),
    state: text("state")
      .$type<"proposed" | "considering" | "agreed" | "building" | "live" | "deferred" | "tabled" | "cancelled">()
      .notNull()
      .default("proposed"),
    stateWhy: text("state_why").notNull().default(""),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("deep_dive_builds_company_idx").on(table.companyId),
    opportunityIdx: index("deep_dive_builds_opportunity_idx").on(table.opportunityId),
    nameCheck: check("deep_dive_builds_name_check", sql`length(btrim(${table.name})) > 0`),
    stateCheck: check(
      "deep_dive_builds_state_check",
      sql`${table.state} in ('proposed', 'considering', 'agreed', 'building', 'live', 'deferred', 'tabled', 'cancelled')`,
    ),
    whyCheck: check(
      "deep_dive_builds_why_check",
      sql`${table.state} not in ('considering', 'deferred', 'tabled', 'cancelled') or length(btrim(${table.stateWhy})) > 0`,
    ),
    visibilityCheck: visibilityCheck("deep_dive_builds_visibility_check", table.visibility),
  }),
);

export const deepDiveKpis = pgTable(
  "deep_dive_kpis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scope: text("scope").$type<"company" | "division" | "department" | "team" | "individual">().notNull().default("company"),
    // Whose number it is: a person on the organisation board. A person who
    // owns a KPI cannot be removed until the KPI has another owner.
    ownerPersonId: uuid("owner_person_id").notNull().references(() => deepDivePeople.id, { onDelete: "no action" }),
    unit: text("unit").notNull().default(""),
    direction: text("direction").$type<"up" | "down" | "steady">().notNull().default("up"),
    // A baseline is a number with how it is calculated and the period it
    // covers; without both, a later number cannot be compared with it.
    baseline: numeric("baseline").notNull(),
    definition: text("definition").notNull(),
    baselinePeriod: text("baseline_period").notNull(),
    target: numeric("target").notNull(),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("deep_dive_kpis_company_idx").on(table.companyId),
    ownerIdx: index("deep_dive_kpis_owner_idx").on(table.ownerPersonId),
    nameCheck: check("deep_dive_kpis_name_check", sql`length(btrim(${table.name})) > 0`),
    scopeCheck: check(
      "deep_dive_kpis_scope_check",
      sql`${table.scope} in ('company', 'division', 'department', 'team', 'individual')`,
    ),
    directionCheck: check("deep_dive_kpis_direction_check", sql`${table.direction} in ('up', 'down', 'steady')`),
    baselineCheck: check(
      "deep_dive_kpis_baseline_check",
      sql`length(btrim(${table.definition})) > 0 and length(btrim(${table.baselinePeriod})) > 0`,
    ),
    visibilityCheck: visibilityCheck("deep_dive_kpis_visibility_check", table.visibility),
  }),
);

export const deepDiveKpiProcesses = pgTable(
  "deep_dive_kpi_processes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kpiId: uuid("kpi_id").notNull().references(() => deepDiveKpis.id, { onDelete: "cascade" }),
    processId: uuid("process_id").notNull().references(() => deepDiveProcesses.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pairUq: uniqueIndex("deep_dive_kpi_processes_pair_uq").on(table.kpiId, table.processId),
    processIdx: index("deep_dive_kpi_processes_process_idx").on(table.processId),
  }),
);
