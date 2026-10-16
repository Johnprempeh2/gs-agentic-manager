// Outbound webhooks: when something happens in a company (a task is done, a
// decision is needed, a client moves stage) GSAM posts a JSON payload to a URL
// a person pasted, such as a Slack or Teams incoming webhook, Zapier or Make.
// Nothing is sent until a person adds a URL. Each attempt is kept in a short
// delivery log so people can see what was sent and why it failed.
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const outboundWebhooks = pgTable(
  "outbound_webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Where payloads are posted. Treated as a secret: the API only ever returns a masked form. */
    url: text("url").notNull(),
    /** Event names this webhook receives, such as `task.done`. */
    events: jsonb("events").$type<string[]>().notNull().default([]),
    /** Key for the `X-GSAM-Signature` HMAC header, so receivers can check a payload came from here. */
    signingSecret: text("signing_secret").notNull(),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    lastDeliveryOk: boolean("last_delivery_ok"),
    lastError: text("last_error"),
    createdByUserId: text("created_by_user_id"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("outbound_webhooks_company_idx").on(table.companyId),
  }),
);

export const outboundWebhookDeliveries = pgTable(
  "outbound_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    webhookId: uuid("webhook_id").notNull().references(() => outboundWebhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    /** Short line saying what the payload was about, such as the task title. */
    summary: text("summary").notNull(),
    ok: boolean("ok").notNull(),
    httpStatus: integer("http_status"),
    error: text("error"),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    webhookCreatedIdx: index("outbound_webhook_deliveries_webhook_created_idx").on(table.webhookId, table.createdAt),
  }),
);
