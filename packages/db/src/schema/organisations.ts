// CRM organisations (GRE-1477). The organisation is the primary CRM record:
// one row per company the user works with, and the people there. Imports set
// source + external_id so a second import updates instead of duplicating.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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
    status: text("status").notNull().default("target"),
    notes: text("notes"),
    // Global CRM fields (GRE-1539). `country` above is the address country.
    legalName: text("legal_name"),
    domain: text("domain"),
    phone: text("phone"),
    email: text("email"),
    addressStreet: text("address_street"),
    addressCity: text("address_city"),
    addressRegion: text("address_region"),
    addressPostalCode: text("address_postal_code"),
    employeeCount: integer("employee_count"),
    sizeBand: text("size_band"),
    annualRevenue: numeric("annual_revenue", { precision: 20, scale: 2 }),
    annualRevenueCurrency: text("annual_revenue_currency"),
    ownershipType: text("ownership_type"),
    parentOrganisationId: uuid("parent_organisation_id").references((): AnyPgColumn => organisations.id, {
      onDelete: "set null",
    }),
    linkedinUrl: text("linkedin_url"),
    accountOwnerUserId: text("account_owner_user_id"),
    accountOwnerAgentId: uuid("account_owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    segment: text("segment"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    description: text("description"),
    registrationNumber: text("registration_number"),
    taxId: text("tax_id"),
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
    companyDomainIdx: index("organisations_company_domain_idx").on(table.companyId, table.domain),
    parentIdx: index("organisations_parent_idx").on(table.parentOrganisationId),
    companyStatusIdx: index("organisations_company_status_idx").on(table.companyId, table.status),
    externalUq: uniqueIndex("organisations_company_source_external_uq")
      .on(table.companyId, table.source, table.externalId)
      .where(sql`${table.externalId} is not null`),
    statusCheck: check("organisations_status_check", sql`${table.status} in ('target', 'prospect', 'client', 'former')`),
    sourceCheck: check("organisations_source_check", sql`${table.source} in ('manual', 'pipedrive', 'csv')`),
    sizeBandCheck: check(
      "organisations_size_band_check",
      sql`${table.sizeBand} is null or ${table.sizeBand} in ('1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001+')`,
    ),
    ownershipTypeCheck: check(
      "organisations_ownership_type_check",
      sql`${table.ownershipType} is null or ${table.ownershipType} in ('private', 'public', 'subsidiary', 'government', 'non_profit', 'partnership', 'other')`,
    ),
    oneAccountOwnerCheck: check(
      "organisations_one_account_owner_check",
      sql`${table.accountOwnerUserId} is null or ${table.accountOwnerAgentId} is null`,
    ),
    notOwnParentCheck: check("organisations_not_own_parent_check", sql`${table.parentOrganisationId} <> ${table.id}`),
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
    sourceCheck: check("organisation_contacts_source_check", sql`${table.source} in ('manual', 'pipedrive', 'csv')`),
  }),
);
