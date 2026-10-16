// CRM files (Pipedrive import, 16 Oct): every file Pipedrive holds on a deal,
// person, organisation, activity or note. The bytes are copied into GSAM
// storage as an asset; a file on a deal is also put on the case's files. A
// file linked from elsewhere (Google Drive and the like), or larger than the
// upload limit, keeps its details without the bytes. source + external_id is
// unique per company, so a rerun updates a row instead of adding it twice.
import { bigint, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { assets } from "./assets.js";
import { companies } from "./companies.js";
import { organisationContacts, organisations } from "./organisations.js";
import { pipelineCaseEvidence, pipelineCases } from "./pipeline_cases.js";

export const crmFiles = pgTable(
  "crm_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type"),
    byteSize: bigint("byte_size", { mode: "number" }),
    description: text("description"),
    ownerName: text("owner_name"),
    addedAt: timestamp("added_at", { withTimezone: true }),
    // Where the file lives when it is not copied: the CRM's link, or Google Drive and the like.
    remoteUrl: text("remote_url"),
    // The copied bytes, when the import could store them.
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    organisationId: uuid("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => organisationContacts.id, { onDelete: "set null" }),
    caseId: uuid("case_id").references(() => pipelineCases.id, { onDelete: "set null" }),
    // The case file made from it, when it is on a deal or lead.
    evidenceId: uuid("evidence_id").references(() => pipelineCaseEvidence.id, { onDelete: "set null" }),
    // Everything else: the activity, note or product it was on, why the bytes were not copied.
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    externalUq: uniqueIndex("crm_files_company_source_external_uq").on(table.companyId, table.source, table.externalId),
    companyOrganisationIdx: index("crm_files_company_organisation_idx").on(table.companyId, table.organisationId),
    companyCaseIdx: index("crm_files_company_case_idx").on(table.companyId, table.caseId),
    companyContactIdx: index("crm_files_company_contact_idx").on(table.companyId, table.contactId),
  }),
);
