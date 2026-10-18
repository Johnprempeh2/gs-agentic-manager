import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Spending authority for one company (GRE-1363). Set by the hosting operator
 * (instance admin) only. `ceilingCents` caps every budget amount a non-operator
 * can set or raise to; null means no ceiling. `approverUserIds` names the users
 * who may resolve a budget override; empty means any board user (the old rule).
 * `topUpApprovalByRoute` says, per AI route, who accepts a top-up (GRE-1371).
 */
export const budgetAuthorities = pgTable("budget_authorities", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  ceilingCents: integer("ceiling_cents"),
  approverUserIds: text("approver_user_ids").array().notNull().default([]),
  topUpApprovalByRoute: jsonb("top_up_approval_by_route").$type<Record<string, string>>().notNull().default({}),
  updatedByUserId: text("updated_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
