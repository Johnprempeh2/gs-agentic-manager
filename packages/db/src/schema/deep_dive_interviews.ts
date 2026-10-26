import { sql } from "drizzle-orm";
import { type AnyPgColumn, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    // Set when the round opens on the website (GRE-2665, migration 0409): who may
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

// Invites (GRE-2665, migration 0409). One row per person invited to a round,
// keyed by the website's employee id. It holds only website ids (the employee,
// the user and the organisation) and the question set the person gets: never a
// name or an email. The user id is null while the website holds the invitation
// by email, until the person makes their account. Names, emails and status are
// read live from the website through gs-interview-v1. The id checks refuse
// anything but letters, numbers, - and _, so an email cannot be stored by
// mistake, and the composite key ties the invite to its round's company and
// organisation.
export const deepDiveInterviewInvites = pgTable(
  "deep_dive_interview_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    roundId: uuid("round_id").notNull(),
    websiteOrganisationId: text("website_organisation_id").notNull(),
    websiteEmployeeId: text("website_employee_id").notNull(),
    websiteUserId: text("website_user_id"),
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
    roundEmployeeUq: uniqueIndex("deep_dive_interview_invites_round_employee_uq").on(table.roundId, table.websiteEmployeeId),
    roundUserUq: uniqueIndex("deep_dive_interview_invites_round_user_uq").on(table.roundId, table.websiteUserId),
    companyIdx: index("deep_dive_interview_invites_company_idx").on(table.companyId),
    employeeCheck: check("deep_dive_interview_invites_employee_check", sql`${table.websiteEmployeeId} ~ '^[A-Za-z0-9_-]{1,128}$'`),
    userCheck: check(
      "deep_dive_interview_invites_user_check",
      sql`${table.websiteUserId} is null or ${table.websiteUserId} ~ '^[A-Za-z0-9_-]{1,128}$'`,
    ),
    countsCheck: check(
      "deep_dive_interview_invites_counts_check",
      sql`${table.sentCount} >= 1 and ${table.remindedCount} >= 0`,
    ),
  }),
);

// Synthesis proposals (GRE-2666, migration 0410). What a GSAM agent's synthesis
// of a round proposes for the Deep Dive: pain, process and finding themes in
// the agent's words, quotes as evidence under their theme, and each
// interviewee's role for the organisation board. Every row starts Proposed and
// a person accepts or rejects it; sharing stays Internal (the check refuses
// anything else). Raw answers stay on the website: a row keeps only the
// statement, a quote the gate allowed, and website ids in `sources`, so a
// withdrawal on the website can find and remove it.
export const deepDiveInterviewProposals = pgTable(
  "deep_dive_interview_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    roundId: uuid("round_id").notNull(),
    websiteOrganisationId: text("website_organisation_id").notNull(),
    kind: text("kind").$type<"pain" | "process" | "finding" | "person" | "quote">().notNull(),
    // The merged label's key in the round's evidence; null for a person.
    themeKey: text("theme_key"),
    // A quote's theme. Removing the theme removes its quotes.
    parentId: uuid("parent_id").references((): AnyPgColumn => deepDiveInterviewProposals.id, { onDelete: "cascade" }),
    label: text("label").notNull().default(""),
    // A theme: the agent's prose. A quote: the verbatim line. A person: their role title.
    statement: text("statement").notNull(),
    unitId: uuid("unit_id").references(() => deepDiveOrgUnits.id, { onDelete: "set null" }),
    voices: integer("voices").notNull().default(0),
    firstHandVoices: integer("first_hand_voices").notNull().default(0),
    websiteInsightId: text("website_insight_id"),
    websiteEmployeeId: text("website_employee_id"),
    // Shown without the person: no attribution consent, or the website redacted it.
    anonymous: boolean("anonymous").notNull().default(true),
    // [{ interviewId, userId, employeeId }]: website ids only.
    sources: jsonb("sources").$type<unknown[]>().notNull().default([]),
    status: text("status").$type<"proposed" | "accepted" | "rejected">().notNull().default("proposed"),
    visibility: text("visibility").$type<"internal">().notNull().default("internal"),
    rulesVersion: text("rules_version").notNull(),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    proposedByUserId: text("proposed_by_user_id"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roundFk: foreignKey({
      name: "deep_dive_interview_proposals_round_scope_fk",
      columns: [table.roundId, table.companyId, table.websiteOrganisationId],
      foreignColumns: [deepDiveInterviewRounds.id, deepDiveInterviewRounds.companyId, deepDiveInterviewRounds.websiteOrganisationId],
    }).onDelete("cascade"),
    roundIdx: index("deep_dive_interview_proposals_round_idx").on(table.roundId, table.status),
    companyIdx: index("deep_dive_interview_proposals_company_idx").on(table.companyId),
    parentIdx: index("deep_dive_interview_proposals_parent_idx").on(table.parentId),
    kindCheck: check(
      "deep_dive_interview_proposals_kind_check",
      sql`${table.kind} in ('pain', 'process', 'finding', 'person', 'quote')`,
    ),
    statusCheck: check("deep_dive_interview_proposals_status_check", sql`${table.status} in ('proposed', 'accepted', 'rejected')`),
    visibilityCheck: check("deep_dive_interview_proposals_visibility_check", sql`${table.visibility} = 'internal'`),
    statementCheck: check("deep_dive_interview_proposals_statement_check", sql`length(btrim(${table.statement})) > 0`),
    quoteCheck: check(
      "deep_dive_interview_proposals_quote_check",
      sql`(${table.kind} = 'quote') = (${table.parentId} is not null)
        and (${table.kind} <> 'quote' or ${table.websiteInsightId} is not null)`,
    ),
    decidedCheck: check(
      "deep_dive_interview_proposals_decided_check",
      sql`(${table.status} = 'proposed') = (${table.decidedAt} is null)
        and (${table.decidedAt} is null) = (${table.decidedByUserId} is null)`,
    ),
    idsCheck: check(
      "deep_dive_interview_proposals_ids_check",
      sql`(${table.websiteEmployeeId} is null or ${table.websiteEmployeeId} ~ '^[A-Za-z0-9_-]{1,128}$')
        and (${table.websiteInsightId} is null or ${table.websiteInsightId} ~ '^[A-Za-z0-9_-]{1,128}$')
        and jsonb_typeof(${table.sources}) = 'array'`,
    ),
    votesCheck: check(
      "deep_dive_interview_proposals_voices_check",
      sql`${table.voices} >= 0 and ${table.firstHandVoices} >= 0 and ${table.firstHandVoices} <= ${table.voices}`,
    ),
  }),
);
