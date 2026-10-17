import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// House looks for the image studio: a company's saved style, camera picks and
// extra words under one name, so images and clips for a client match.
export const studioLooks = pgTable(
  "studio_looks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    /** An image style preset id from @greatstone/shared. */
    style: text("style"),
    camera: jsonb("camera").$type<{ camera?: string; lens?: string; focalLength?: number; aperture?: string }>(),
    words: text("words"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameIdx: uniqueIndex("studio_looks_company_name_idx").on(table.companyId, table.name),
  }),
);
