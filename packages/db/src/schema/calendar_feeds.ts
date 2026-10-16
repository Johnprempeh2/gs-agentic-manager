// Private calendar feed (iCalendar) of a company's deadlines, for Google
// Calendar, Outlook or Apple Calendar to subscribe to. Off until a person
// turns it on; the secret in the URL is stored only as a SHA-256 hash.
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const calendarFeeds = pgTable(
  "calendar_feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdByUserId: text("created_by_user_id"),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("calendar_feeds_company_uq").on(table.companyId),
    tokenHashUq: uniqueIndex("calendar_feeds_token_hash_uq").on(table.tokenHash),
  }),
);
