import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { assets } from "./assets.js";

/**
 * Words read out of an uploaded file (PDF, Word, text) so search can find
 * them. One row per asset; `status` says why there is no text when there is
 * none (an image, a file too big, or one that could not be read).
 */
export const assetTexts = pgTable(
  "asset_texts",
  {
    assetId: uuid("asset_id").primaryKey().references(() => assets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    text: text("text"),
    error: text("error"),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("asset_texts_company_idx").on(table.companyId),
  }),
);
