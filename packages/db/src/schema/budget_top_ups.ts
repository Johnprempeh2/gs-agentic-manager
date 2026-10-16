import { date, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";
import { financeEvents } from "./finance_events.js";

/**
 * The top-up ledger of a company (GRE-1371). One row per top-up and per
 * pre-authorised extra ceiling, each for one calendar month (UTC). Rows are
 * never deleted: a refused request stays as `rejected`. An applied top-up has
 * its `finance_events` row; a top-up accepted under a pre-authorised ceiling
 * points at it, so the ceiling's headroom is its amount less those top-ups.
 */
export const budgetTopUps = pgTable(
  "budget_top_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    windowStart: date("window_start").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    reason: text("reason").notNull(),
    requestedByUserId: text("requested_by_user_id"),
    approvedByUserId: text("approved_by_user_id"),
    approvals: jsonb("approvals").$type<Array<{ side: string; userId: string; at: string }>>().notNull().default([]),
    approvalRule: text("approval_rule"),
    awaitingSide: text("awaiting_side"),
    preAuthorisationId: uuid("pre_authorisation_id"),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    invoiceReference: text("invoice_reference"),
    financeEventId: uuid("finance_event_id").references(() => financeEvents.id, { onDelete: "set null" }),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWindowIdx: index("budget_top_ups_company_window_idx").on(table.companyId, table.windowStart, table.kind, table.status),
    approvalIdx: index("budget_top_ups_approval_idx").on(table.approvalId),
  }),
);
