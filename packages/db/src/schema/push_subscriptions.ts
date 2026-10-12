import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// A board user's Home Screen app on one device, for one company (Web Push).
// Holds only the browser's push endpoint and the keys to encrypt for it.
// No auth foreign key: local_trusted uses the synthetic local-board principal.
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("push_subscriptions_company_user_idx").on(table.companyId, table.userId),
    companyEndpointUnique: uniqueIndex("push_subscriptions_company_endpoint_idx").on(table.companyId, table.endpoint),
  }),
);

// Decision cards a user has been told about, so each card notifies once. A
// card that leaves the feed is forgotten, so a later decision on the same task
// notifies again.
export const pushNotifiedDecisions = pgTable(
  "push_notified_decisions",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    cardId: text("card_id").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.companyId, table.userId, table.cardId] }) }),
);
