import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { assets } from "./assets.js";
import { agents } from "./agents.js";

/**
 * The reference studio (2 Nov 2026): labelled images (brand elements, approved
 * designs, competitor examples) people and agents point at when instructing work.
 */
export const referenceItems = pgTable(
  "reference_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    assetId: uuid("asset_id").notNull().references(() => assets.id),
    title: text("title").notNull(),
    /** How to use it: "primary logo, dark backgrounds only". Agents read this. */
    notes: text("notes"),
    tags: text("tags").array().notNull().default([]),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("reference_items_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
