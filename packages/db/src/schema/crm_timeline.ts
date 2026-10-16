// The CRM timeline (Pipedrive import, 16 Oct): activities, notes and calls
// from a CRM, each linked to the organisation, contact and case it was about.
// source + kind + external_id is unique per company, so a rerun of an import
// updates an entry instead of adding it twice.
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { organisationContacts, organisations } from "./organisations.js";
import { pipelineCases } from "./pipeline_cases.js";

export const crmTimelineEntries = pgTable(
  "crm_timeline_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    // activity (a call, meeting, task or email logged as an activity), note or call (a call log).
    kind: text("kind").notNull(),
    // The CRM's own activity type, such as call, meeting, task, deadline, email or lunch.
    activityType: text("activity_type"),
    subject: text("subject"),
    body: text("body"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    durationMinutes: integer("duration_minutes"),
    done: boolean("done"),
    ownerName: text("owner_name"),
    organisationId: uuid("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => organisationContacts.id, { onDelete: "set null" }),
    caseId: uuid("case_id").references(() => pipelineCases.id, { onDelete: "set null" }),
    // Everything else the CRM holds about the entry: location, participants, outcome, pinned.
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    externalUq: uniqueIndex("crm_timeline_entries_company_source_kind_external_uq")
      .on(table.companyId, table.source, table.kind, table.externalId),
    companyOrganisationIdx: index("crm_timeline_entries_company_organisation_idx").on(table.companyId, table.organisationId, table.occurredAt),
    companyCaseIdx: index("crm_timeline_entries_company_case_idx").on(table.companyId, table.caseId, table.occurredAt),
    companyContactIdx: index("crm_timeline_entries_company_contact_idx").on(table.companyId, table.contactId),
    kindCheck: check("crm_timeline_entries_kind_check", sql`${table.kind} in ('activity', 'note', 'call')`),
  }),
);
