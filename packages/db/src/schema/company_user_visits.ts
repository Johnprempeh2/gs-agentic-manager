import { pgTable, uuid, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** When a board user last looked at a company. Default `since` for the agent work digest. */
export const companyUserVisits = pgTable(
  "company_user_visits",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    lastVisitedAt: timestamp("last_visited_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.userId] }),
  }),
);
