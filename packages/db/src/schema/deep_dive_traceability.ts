import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { deepDiveBuilds, deepDiveKpis } from "./deep_dive_opportunities.js";

// Deep Dive traceability (GRE-2371, migration 0400). The last links of the
// chain North Star → Source → Finding → Opportunity → Design → Commercial →
// Roadmap → KPI. A design is a build (deep_dive_builds). A commercial case is
// for one design; a roadmap item delivers one commercial case and moves the
// KPIs in deep_dive_roadmap_kpis. Removing the item upstream leaves the link
// empty instead of removing the item, so the broken-link check can show it.
// The deep_dive_traceability_guard trigger keeps links inside one company and
// makes new items Internal, for any writer.

export const deepDiveCommercials = pgTable(
  "deep_dive_commercials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    buildId: uuid("build_id").references(() => deepDiveBuilds.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    terms: text("terms").notNull().default(""),
    value: text("value").notNull().default(""),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("deep_dive_commercials_company_idx").on(table.companyId),
    buildIdx: index("deep_dive_commercials_build_idx").on(table.buildId),
    nameCheck: check("deep_dive_commercials_name_check", sql`length(btrim(${table.name})) > 0`),
    visibilityCheck: check("deep_dive_commercials_visibility_check", sql`${table.visibility} in ('internal', 'shared')`),
  }),
);

export const deepDiveRoadmapItems = pgTable(
  "deep_dive_roadmap_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    commercialId: uuid("commercial_id").references(() => deepDiveCommercials.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    phase: text("phase").notNull().default(""),
    visibility: text("visibility").$type<"internal" | "shared">().notNull().default("internal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("deep_dive_roadmap_items_company_idx").on(table.companyId),
    commercialIdx: index("deep_dive_roadmap_items_commercial_idx").on(table.commercialId),
    nameCheck: check("deep_dive_roadmap_items_name_check", sql`length(btrim(${table.name})) > 0`),
    visibilityCheck: check("deep_dive_roadmap_items_visibility_check", sql`${table.visibility} in ('internal', 'shared')`),
  }),
);

export const deepDiveRoadmapKpis = pgTable(
  "deep_dive_roadmap_kpis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    roadmapItemId: uuid("roadmap_item_id").notNull().references(() => deepDiveRoadmapItems.id, { onDelete: "cascade" }),
    kpiId: uuid("kpi_id").notNull().references(() => deepDiveKpis.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pairUq: uniqueIndex("deep_dive_roadmap_kpis_pair_uq").on(table.roadmapItemId, table.kpiId),
    kpiIdx: index("deep_dive_roadmap_kpis_kpi_idx").on(table.kpiId),
  }),
);
