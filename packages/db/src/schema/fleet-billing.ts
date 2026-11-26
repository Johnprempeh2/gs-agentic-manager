import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { fleetInstances } from "./fleet.js";

/**
 * GSAM for Mac (P3): what the hub sells and how Stripe payments reach an
 * install's signed document. Hub only (GSAM_FLEET_HUB=true).
 *
 * A catalogue item is a module (its own features and limits), a package (a
 * set of modules at its own price) or a deal (a package for one Stripe
 * customer only). Each priced item mirrors to one Stripe Product and one
 * Price per billing interval.
 */
export const fleetBillingItems = pgTable(
  "fleet_billing_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<"module" | "package" | "deal">().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Module only: the ENTITLEMENT_FEATURE_KEYS it turns on. */
    features: jsonb("features").$type<string[]>().notNull().default([]),
    /** Named limits (maxUsers, maxAgents). On a package or deal they replace the modules' limits. */
    limits: jsonb("limits").$type<Record<string, number>>().notNull().default({}),
    /** Package or deal: the modules it holds. */
    moduleIds: jsonb("module_ids").$type<string[]>().notNull().default([]),
    /** Prices in minor units (pence, cents). Null: not sold at that interval. */
    monthlyAmount: integer("monthly_amount"),
    annualAmount: integer("annual_amount"),
    currency: text("currency").notNull().default("gbp"),
    /** Deal only: the one Stripe customer it is for. */
    stripeCustomerId: text("stripe_customer_id"),
    stripeProductId: text("stripe_product_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Every Stripe Price ever made for an item. Stripe prices cannot change, so a
 * new amount archives the old price and makes a new one; the old row stays
 * (inactive) so subscriptions still on it keep mapping to the item.
 */
export const fleetBillingPrices = pgTable(
  "fleet_billing_prices",
  {
    stripePriceId: text("stripe_price_id").primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => fleetBillingItems.id, { onDelete: "cascade" }),
    interval: text("interval").$type<"month" | "year">().notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    itemIdx: index("fleet_billing_prices_item_idx").on(table.itemId),
  }),
);

/**
 * One Stripe customer to one install. `stripeSubscriptionId` is the
 * subscription that drives the install's document; events for any other
 * subscription of the customer are recorded and change nothing.
 */
export const fleetBillingCustomers = pgTable(
  "fleet_billing_customers",
  {
    stripeCustomerId: text("stripe_customer_id").primaryKey(),
    fleetInstanceId: uuid("fleet_instance_id")
      .notNull()
      .references(() => fleetInstances.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id"),
    /** As Stripe last said: active, past_due, canceled... */
    subscriptionStatus: text("subscription_status"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /** Stripe `created` of the newest subscription event applied; an older one is stale. */
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    instanceUq: uniqueIndex("fleet_billing_customers_instance_uq").on(table.fleetInstanceId),
  }),
);

/** Stripe events already handled, by Stripe event id: a repeat changes nothing. */
export const fleetBillingEvents = pgTable("fleet_billing_events", {
  stripeEventId: text("stripe_event_id").primaryKey(),
  type: text("type").notNull(),
  /** processed or ignored, and why. Never a licence key. */
  outcome: text("outcome").notNull(),
  fleetInstanceId: uuid("fleet_instance_id"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
