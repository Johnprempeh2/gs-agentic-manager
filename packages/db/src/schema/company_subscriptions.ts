import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Model subscriptions a company pays for (for example Claude Max or ChatGPT
 * Pro), entered by the board so the Costs page can show what subscription
 * usage really costs next to its API-equivalent price.
 */
export const companySubscriptions = pgTable(
  "company_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    plan: text("plan").notNull(),
    monthlyPriceCents: integer("monthly_price_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_subscriptions_company_idx").on(table.companyId),
  }),
);
