import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { deepDiveOrgUnits, deepDivePeople } from "./deep_dive_boards.js";

// Parallel Interview rounds (GRE-2611, migration 0405). One round per
// company's Deep Dive, run per team or per person, with Everest's context
// pack. Each team or person on the organisation board gets one question set,
// drafted from what the Deep Dive already knows and approved by a person
// before any invite goes out. The deep_dive_interview_rounds_guard and
// deep_dive_interview_sets_guard triggers keep the order Setup -> Open ->
// Closed, freeze the setup once the round opens, and put an approved set back
// to Draft when its questions change.
export const deepDiveInterviewRounds = pgTable(
  "deep_dive_interview_rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    mode: text("mode").$type<"per_team" | "per_person">().notNull(),
    targetMinutes: integer("target_minutes").notNull().default(20),
    // Everest's context pack keys (company_background, org_summary, ...), all strings.
    contextPack: jsonb("context_pack").$type<Record<string, string>>().notNull().default({}),
    // setup -> open -> closed.
    status: text("status").$type<"setup" | "open" | "closed">().notNull().default("setup"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One round per engagement.
    companyUq: uniqueIndex("deep_dive_interview_rounds_company_uq").on(table.companyId),
    modeCheck: check("deep_dive_interview_rounds_mode_check", sql`${table.mode} in ('per_team', 'per_person')`),
    statusCheck: check("deep_dive_interview_rounds_status_check", sql`${table.status} in ('setup', 'open', 'closed')`),
    minutesCheck: check(
      "deep_dive_interview_rounds_minutes_check",
      sql`${table.targetMinutes} >= 5 and ${table.targetMinutes} <= 90`,
    ),
    contextCheck: check("deep_dive_interview_rounds_context_check", sql`jsonb_typeof(${table.contextPack}) = 'object'`),
  }),
);

export const deepDiveInterviewSets = pgTable(
  "deep_dive_interview_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    roundId: uuid("round_id").notNull().references(() => deepDiveInterviewRounds.id, { onDelete: "cascade" }),
    // Exactly one: a team (per team) or a person (per person).
    unitId: uuid("unit_id").references(() => deepDiveOrgUnits.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => deepDivePeople.id, { onDelete: "cascade" }),
    // [{ prompt, purpose, streamKey, gifKey }], in the order asked.
    questions: jsonb("questions").$type<unknown[]>().notNull().default([]),
    // [{ streamKey, gifKey, text }]: Known cells told to the interviewer, never asked.
    known: jsonb("known").$type<unknown[]>().notNull().default([]),
    leftOut: integer("left_out").notNull().default(0),
    // draft -> approved; any change to the questions puts it back to draft.
    status: text("status").$type<"draft" | "approved">().notNull().default("draft"),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    draftedByAgentId: uuid("drafted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    draftedByUserId: text("drafted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roundIdx: index("deep_dive_interview_sets_round_idx").on(table.roundId),
    companyIdx: index("deep_dive_interview_sets_company_idx").on(table.companyId),
    roundUnitUq: uniqueIndex("deep_dive_interview_sets_round_unit_uq")
      .on(table.roundId, table.unitId)
      .where(sql`${table.unitId} is not null`),
    roundPersonUq: uniqueIndex("deep_dive_interview_sets_round_person_uq")
      .on(table.roundId, table.personId)
      .where(sql`${table.personId} is not null`),
    targetCheck: check(
      "deep_dive_interview_sets_target_check",
      sql`(${table.unitId} is null) <> (${table.personId} is null)`,
    ),
    statusCheck: check("deep_dive_interview_sets_status_check", sql`${table.status} in ('draft', 'approved')`),
    approvedCheck: check(
      "deep_dive_interview_sets_approved_check",
      sql`(${table.status} = 'approved') = (${table.approvedAt} is not null)
        and (${table.approvedAt} is null) = (${table.approvedByUserId} is null)`,
    ),
    questionsCheck: check(
      "deep_dive_interview_sets_questions_check",
      sql`jsonb_typeof(${table.questions}) = 'array' and jsonb_typeof(${table.known}) = 'array'`,
    ),
    leftOutCheck: check("deep_dive_interview_sets_left_out_check", sql`${table.leftOut} >= 0`),
  }),
);
