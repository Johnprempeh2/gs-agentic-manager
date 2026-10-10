import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// Guided tours a person has finished or skipped, so a tour stays dismissed on
// every device. Instance-wide personal preference, like announcement_dismissals:
// no auth foreign key, because local_trusted uses the synthetic local-board user.
export const userTourDismissals = pgTable("user_tour_dismissals", {
  userId: text("user_id").notNull(),
  tourKey: text("tour_key").notNull(),
  tourVersion: integer("tour_version").notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ pk: primaryKey({ columns: [table.userId, table.tourKey, table.tourVersion] }) }));
