import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/**
 * Website view (GRE-1087): one row per website a company watches. The Google
 * refresh token lives in the secrets vault; this row keeps only its id.
 */
export const websiteProperties = pgTable(
  "website_properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    siteUrl: text("site_url").notNull(),
    ga4PropertyId: text("ga4_property_id").notNull(),
    connectionStatus: text("connection_status").notNull().default("not_connected"),
    googleTokenSecretId: uuid("google_token_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    connectedByUserId: text("connected_by_user_id"),
    lastPullAt: timestamp("last_pull_at", { withTimezone: true }),
    lastPullStatus: text("last_pull_status"),
    lastPullErrors: jsonb("last_pull_errors").$type<{ source: string; message: string }[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("website_properties_company_idx").on(table.companyId),
    companySiteUq: uniqueIndex("website_properties_company_site_uq").on(table.companyId, table.siteUrl),
  }),
);

/** One row per pull attempt, holding the reports that pull returned. */
export const websitePulls = pgTable(
  "website_pulls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").notNull().references(() => websiteProperties.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    rangeStart: text("range_start").notNull(),
    rangeEnd: text("range_end").notNull(),
    ga4Report: jsonb("ga4_report").$type<Record<string, unknown>>(),
    searchConsoleReport: jsonb("search_console_report").$type<Record<string, unknown>>(),
    errors: jsonb("errors").$type<{ source: string; message: string }[]>().notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    propertyStartedIdx: index("website_pulls_property_started_idx").on(table.propertyId, table.startedAt),
    companyIdx: index("website_pulls_company_idx").on(table.companyId),
  }),
);
