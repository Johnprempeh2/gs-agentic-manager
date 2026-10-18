import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    metric: text("metric").notNull().default("billed_cents"),
    windowKind: text("window_kind").notNull(),
    amount: integer("amount").notNull().default(0),
    warnPercent: integer("warn_percent").notNull().default(80),
    hardStopEnabled: boolean("hard_stop_enabled").notNull().default(true),
    notifyEnabled: boolean("notify_enabled").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    // A dated change (GRE-1363): `pendingAmount` replaces `amount` from
    // `pendingEffectiveFrom`. Enforcement reads it as soon as it is due; the
    // budget sweep then writes it into `amount` and resumes or stops the scope.
    pendingAmount: integer("pending_amount"),
    pendingEffectiveFrom: timestamp("pending_effective_from", { withTimezone: true }),
    pendingReason: text("pending_reason"),
    pendingRequestedByUserId: text("pending_requested_by_user_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyScopeActiveIdx: index("budget_policies_company_scope_active_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.isActive,
    ),
    companyWindowIdx: index("budget_policies_company_window_idx").on(
      table.companyId,
      table.windowKind,
      table.metric,
    ),
    pendingEffectiveFromIdx: index("budget_policies_pending_effective_from_idx")
      .on(table.pendingEffectiveFrom)
      .where(sql`${table.pendingEffectiveFrom} is not null`),
    companyScopeMetricUniqueIdx: uniqueIndex("budget_policies_company_scope_metric_unique_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.metric,
      table.windowKind,
    ),
  }),
);
