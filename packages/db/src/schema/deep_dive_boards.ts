import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
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

// Deep Dive boards (GRE-2369, migration 0398). The organisation board holds
// units, people and each person's tasks with the fate chosen for them (the
// target state). The process board holds offerings (its lanes), processes
// (cards, with an optional saved position) and handoffs. An arrow on the board
// is a handoff row: there is no other place an arrow could live. The
// deep_dive_board_guard trigger keeps every link inside one company, refuses a
// unit or reporting cycle, and makes every new item Internal.

const visibilityCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} in ('internal', 'shared')`);

export const deepDiveOrgUnits = pgTable(
  "deep_dive_org_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    unitType: text("unit_type").$type<"company" | "division" | "department" | "team">().notNull().default("team"),
    parentId: uuid("parent_id").references((): AnyPgColumn => deepDiveOrgUnits.id, { onDelete: "set null" }),
    leadPersonId: uuid("lead_person_id").references((): AnyPgColumn => deepDivePeople.id, { onDelete: "set null" }),
    headcount: integer("headcount"),
    position: integer("position").notNull().default(0),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("deep_dive_org_units_company_idx").on(table.companyId),
    nameCheck: check("deep_dive_org_units_name_check", sql`length(btrim(${table.name})) > 0`),
    typeCheck: check("deep_dive_org_units_type_check", sql`${table.unitType} in ('company', 'division', 'department', 'team')`),
    headcountCheck: check("deep_dive_org_units_headcount_check", sql`${table.headcount} is null or ${table.headcount} >= 0`),
    visibilityCheck: visibilityCheck("deep_dive_org_units_visibility_check", table.visibility),
  }),
);

export const deepDivePeople = pgTable(
  "deep_dive_people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull().default(""),
    side: text("side").$type<"client" | "greatstone" | "third_party">().notNull().default("client"),
    // Null: nobody has placed this person in a unit yet.
    unitId: uuid("unit_id").references(() => deepDiveOrgUnits.id, { onDelete: "set null" }),
    reportsToId: uuid("reports_to_id").references((): AnyPgColumn => deepDivePeople.id, { onDelete: "set null" }),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("deep_dive_people_company_idx").on(table.companyId),
    nameCheck: check("deep_dive_people_name_check", sql`length(btrim(${table.name})) > 0`),
    sideCheck: check("deep_dive_people_side_check", sql`${table.side} in ('client', 'greatstone', 'third_party')`),
    visibilityCheck: visibilityCheck("deep_dive_people_visibility_check", table.visibility),
  }),
);

export const deepDivePersonTasks = pgTable(
  "deep_dive_person_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull().references(() => deepDivePeople.id, { onDelete: "cascade" }),
    what: text("what").notNull(),
    // Null: nobody recorded the hours, so the target state says it does not know.
    hoursPerWeek: numeric("hours_per_week", { precision: 6, scale: 2, mode: "number" }),
    fate: text("fate").notNull().default("not_decided"),
    why: text("why").notNull().default(""),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    personIdx: index("deep_dive_person_tasks_person_idx").on(table.personId),
    companyIdx: index("deep_dive_person_tasks_company_idx").on(table.companyId),
    whatCheck: check("deep_dive_person_tasks_what_check", sql`length(btrim(${table.what})) > 0`),
    hoursCheck: check(
      "deep_dive_person_tasks_hours_check",
      sql`${table.hoursPerWeek} is null or (${table.hoursPerWeek} >= 0 and ${table.hoursPerWeek} <= 168)`,
    ),
    fateCheck: check(
      "deep_dive_person_tasks_fate_check",
      sql`${table.fate} in ('not_decided', 'eliminated', 'simplified', 'digitised', 'automated', 'augmented', 'agentic', 'moves', 'stays')`,
    ),
    visibilityCheck: visibilityCheck("deep_dive_person_tasks_visibility_check", table.visibility),
  }),
);

export const deepDiveOfferings = pgTable(
  "deep_dive_offerings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("deep_dive_offerings_company_idx").on(table.companyId),
    nameCheck: check("deep_dive_offerings_name_check", sql`length(btrim(${table.name})) > 0`),
    visibilityCheck: visibilityCheck("deep_dive_offerings_visibility_check", table.visibility),
  }),
);

export const deepDiveProcesses = pgTable(
  "deep_dive_processes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // The lane. Null: no offering names this process.
    offeringId: uuid("offering_id").references(() => deepDiveOfferings.id, { onDelete: "set null" }),
    runsPersonId: uuid("runs_person_id").references(() => deepDivePeople.id, { onDelete: "set null" }),
    unitId: uuid("unit_id").references(() => deepDiveOrgUnits.id, { onDelete: "set null" }),
    // Layout only, relative to the lane. Null until somebody moves the card.
    x: integer("x"),
    y: integer("y"),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("deep_dive_processes_company_idx").on(table.companyId),
    nameCheck: check("deep_dive_processes_name_check", sql`length(btrim(${table.name})) > 0`),
    positionCheck: check(
      "deep_dive_processes_position_check",
      sql`(${table.x} is null) = (${table.y} is null) and (${table.x} is null or (${table.x} >= 0 and ${table.y} >= 0))`,
    ),
    visibilityCheck: visibilityCheck("deep_dive_processes_visibility_check", table.visibility),
  }),
);

export const deepDiveHandoffs = pgTable(
  "deep_dive_handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    fromProcessId: uuid("from_process_id").notNull().references(() => deepDiveProcesses.id, { onDelete: "cascade" }),
    toProcessId: uuid("to_process_id").notNull().references(() => deepDiveProcesses.id, { onDelete: "cascade" }),
    // What is handed over. A handoff with nothing named is not recorded.
    what: text("what").notNull(),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("deep_dive_handoffs_company_idx").on(table.companyId),
    pairUq: uniqueIndex("deep_dive_handoffs_pair_uq").on(table.fromProcessId, table.toProcessId),
    toIdx: index("deep_dive_handoffs_to_idx").on(table.toProcessId),
    selfCheck: check("deep_dive_handoffs_self_check", sql`${table.fromProcessId} <> ${table.toProcessId}`),
    whatCheck: check("deep_dive_handoffs_what_check", sql`length(btrim(${table.what})) > 0`),
    visibilityCheck: visibilityCheck("deep_dive_handoffs_visibility_check", table.visibility),
  }),
);
