// CRM organisations (GRE-1477). The organisation is the primary CRM record:
// one row per company the user works with, and the people there. Imports set
// source + external_id so a second import updates instead of duplicating.

/**
 * A field a CRM holds that GSAM has no column for (custom fields, labels,
 * full address, every email and phone), kept in the CRM's order under the
 * CRM's own name so the record shows it as a named field.
 */
export type CrmRecordField = {
  key: string;
  label: string;
  value: string | number | boolean | string[];
};
import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const organisations = pgTable(
  "organisations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    website: text("website"),
    industry: text("industry"),
    country: text("country"),
    countryOwner: text("country_owner"),
    // The GSAM user who owns the country (Ben, 12 Oct), when the owner is a
    // member. country_owner keeps their name for search and imports.
    countryOwnerUserId: text("country_owner_user_id"),
    status: text("status").notNull().default("target"),
    notes: text("notes"),
    // Imported fields with no column of their own (0356).
    crmFields: jsonb("crm_fields").$type<CrmRecordField[]>().notNull().default([]),
    source: text("source").notNull().default("manual"),
    externalId: text("external_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameIdx: index("organisations_company_name_idx").on(table.companyId, table.name),
    companyStatusIdx: index("organisations_company_status_idx").on(table.companyId, table.status),
    externalUq: uniqueIndex("organisations_company_source_external_uq")
      .on(table.companyId, table.source, table.externalId)
      .where(sql`${table.externalId} is not null`),
    statusCheck: check("organisations_status_check", sql`${table.status} in ('target', 'prospect', 'client', 'former')`),
    sourceCheck: check("organisations_source_check", sql`${table.source} in ('manual', 'pipedrive', 'csv', 'hubspot', 'notion')`),
  }),
);

export const organisationContacts = pgTable(
  "organisation_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    organisationId: uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role"),
    email: text("email"),
    phone: text("phone"),
    isKeyContact: boolean("is_key_contact").notNull().default(false),
    crmFields: jsonb("crm_fields").$type<CrmRecordField[]>().notNull().default([]),
    source: text("source").notNull().default("manual"),
    externalId: text("external_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOrganisationIdx: index("organisation_contacts_company_organisation_idx").on(table.companyId, table.organisationId),
    externalUq: uniqueIndex("organisation_contacts_company_source_external_uq")
      .on(table.companyId, table.source, table.externalId)
      .where(sql`${table.externalId} is not null`),
    sourceCheck: check("organisation_contacts_source_check", sql`${table.source} in ('manual', 'pipedrive', 'csv', 'hubspot', 'notion')`),
  }),
);
