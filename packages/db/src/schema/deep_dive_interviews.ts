import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { deepDiveOrgUnits, deepDivePeople } from "./deep_dive_boards.js";

// Parallel Interview rounds (GRE-2611, migration 0406). One round per
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
    // The client's one id (John, 25 Oct): the website organisation id. Every
    // bridge call for the round is keyed by it; it never changes.
    websiteOrganisationId: text("website_organisation_id").notNull(),
    mode: text("mode").$type<"per_team" | "per_person">().notNull(),
    targetMinutes: integer("target_minutes").notNull().default(20),
    // Everest's context pack keys (company_background, org_summary, ...), all strings.
    contextPack: jsonb("context_pack").$type<Record<string, string>>().notNull().default({}),
    // setup -> open -> closed.
    status: text("status").$type<"setup" | "open" | "closed">().notNull().default("setup"),
    // Set when the round opens on the website (GRE-2665, migration 0408): who may
    // join with the round's link, and how many may take part.
    allowedEmailDomains: jsonb("allowed_email_domains").$type<string[]>().notNull().default([]),
    seatTotal: integer("seat_total"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One round per engagement.
    companyUq: uniqueIndex("deep_dive_interview_rounds_company_uq").on(table.companyId),
    // The target of the invites' composite key: an invite carries its round's company and organisation.
    scopeUq: uniqueIndex("deep_dive_interview_rounds_scope_uq").on(table.id, table.companyId, table.websiteOrganisationId),
    seatCheck: check("deep_dive_interview_rounds_seat_check", sql`${table.seatTotal} is null or ${table.seatTotal} > 0`),
    domainsCheck: check(
      "deep_dive_interview_rounds_domains_check",
      sql`jsonb_typeof(${table.allowedEmailDomains}) = 'array'`,
    ),
    websiteOrganisationIdx: index("deep_dive_interview_rounds_website_organisation_idx").on(table.websiteOrganisationId),
    websiteOrganisationCheck: check(
      "deep_dive_interview_rounds_website_organisation_check",
      sql`${table.websiteOrganisationId} ~ '^[A-Za-z0-9_-]{1,128}$'`,
    ),
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

// Invites (GRE-2665, migration 0408). One row per website user invited to a
// round. It holds only website ids (the user and the organisation) and the
// question set the person gets: never a name or an email. Those, and the
// person's status, are read live from the website through gs-interview-v1.
// The id checks refuse anything but letters, numbers, - and _, so an email
// cannot be stored by mistake, and the composite key ties the invite to its
// round's company and organisation.
export const deepDiveInterviewInvites = pgTable(
  "deep_dive_interview_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    roundId: uuid("round_id").notNull(),
    websiteOrganisationId: text("website_organisation_id").notNull(),
    websiteUserId: text("website_user_id").notNull(),
    setId: uuid("set_id").references(() => deepDiveInterviewSets.id, { onDelete: "set null" }),
    sentCount: integer("sent_count").notNull().default(1),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull().defaultNow(),
    remindedCount: integer("reminded_count").notNull().default(0),
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roundFk: foreignKey({
      name: "deep_dive_interview_invites_round_scope_fk",
      columns: [table.roundId, table.companyId, table.websiteOrganisationId],
      foreignColumns: [deepDiveInterviewRounds.id, deepDiveInterviewRounds.companyId, deepDiveInterviewRounds.websiteOrganisationId],
    }).onDelete("cascade"),
    roundUserUq: uniqueIndex("deep_dive_interview_invites_round_user_uq").on(table.roundId, table.websiteUserId),
    companyIdx: index("deep_dive_interview_invites_company_idx").on(table.companyId),
    userCheck: check("deep_dive_interview_invites_user_check", sql`${table.websiteUserId} ~ '^[A-Za-z0-9_-]{1,128}$'`),
    countsCheck: check(
      "deep_dive_interview_invites_counts_check",
      sql`${table.sentCount} >= 1 and ${table.remindedCount} >= 0`,
    ),
  }),
);
