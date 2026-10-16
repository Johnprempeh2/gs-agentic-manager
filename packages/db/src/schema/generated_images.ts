import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { assets } from "./assets.js";

// Images made from a written description (image generation). The picture
// itself is an ordinary company asset; this row keeps the prompt, the shape,
// the provider and how the request went, so the gallery can show and retry it.
export const generatedImages = pgTable(
  "generated_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    prompt: text("prompt").notNull(),
    aspectRatio: text("aspect_ratio").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    providerRequestId: text("provider_request_id"),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyCreatedIdx: index("generated_images_company_created_idx").on(table.companyId, table.createdAt),
    companyStatusIdx: index("generated_images_company_status_idx").on(table.companyId, table.status),
  }),
);
