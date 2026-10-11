import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * The billing account of this instance (GRE-1369): one row per instance, like
 * `instance_settings`. Set by the hosting operator only. Every amount is a
 * value on the row, never a constant in code. `accessEndsOn` is set when
 * renewal stops (cancel, or auto-renew off) and is the last day of access.
 */
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    planKind: text("plan_kind").notNull(),
    planName: text("plan_name"),
    catalogueVersion: text("catalogue_version").notNull(),
    currency: text("currency").notNull(),
    serviceFeeCents: integer("service_fee_cents").notNull(),
    modules: jsonb("modules").$type<Array<{ key: string; feeCents: number | null; scope?: string }>>().notNull().default([]),
    allowanceMonthlyCents: integer("allowance_monthly_cents").notNull(),
    termKind: text("term_kind").notNull(),
    termStartsOn: date("term_starts_on").notNull(),
    autoRenew: boolean("auto_renew").notNull().default(true),
    endAction: text("end_action"),
    accessEndsOn: date("access_ends_on"),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    cancelRequestedByUserId: text("cancel_requested_by_user_id"),
    cancelReason: text("cancel_reason"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyIdx: uniqueIndex("billing_accounts_singleton_key_idx").on(table.singletonKey),
  }),
);

/** Invoice lines of this instance: a reference, period, amount, status and link. No card or bank data. */
export const billingInvoices = pgTable(
  "billing_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reference: text("reference").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
    url: text("url"),
    issuedOn: date("issued_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    referenceIdx: uniqueIndex("billing_invoices_reference_idx").on(table.reference),
    issuedOnIdx: index("billing_invoices_issued_on_idx").on(table.issuedOn),
  }),
);
