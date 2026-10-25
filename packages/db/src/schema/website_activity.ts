import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { websiteSite } from "./website_module.js";

/** Durable cursor and projection of the website's append-only event outbox. */
export const websiteActivityCursors = pgTable("website_activity_cursors", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").notNull(),
  sequence: bigint("sequence", { mode: "bigint" }).notNull().default(sql`0`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.companyId, t.siteId] }),
  foreignKey({ columns: [t.companyId, t.siteId], foreignColumns: [websiteSite.companyId, websiteSite.id] }).onDelete("cascade"),
  check("website_activity_cursor_positive", sql`${t.sequence} >= 0`),
]);

export const websiteActivityEvents = pgTable("website_activity_events", {
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").notNull(),
  sequence: bigint("sequence", { mode: "bigint" }).notNull(),
  id: uuid("id").notNull(),
  organisationId: uuid("organisation_id").notNull(),
  kind: text("kind").notNull(),
  subjectId: text("subject_id").notNull(),
  label: text("label").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.companyId, t.siteId, t.sequence] }),
  unique("website_activity_source_id_uq").on(t.companyId, t.siteId, t.id),
  foreignKey({ columns: [t.companyId, t.siteId], foreignColumns: [websiteSite.companyId, websiteSite.id] }).onDelete("cascade"),
  index("website_activity_client_idx").on(t.companyId, t.organisationId, t.occurredAt, t.sequence),
  check("website_activity_sequence_positive", sql`${t.sequence} > 0`),
]);
