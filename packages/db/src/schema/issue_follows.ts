import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * A board user following a task (and everything under it). Personal to the
 * user, scoped to the company: another user never sees these rows.
 */
export const issueFollows = pgTable(
  "issue_follows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("issue_follows_company_user_idx").on(table.companyId, table.userId),
    companyIssueUserUnique: uniqueIndex("issue_follows_company_issue_user_idx").on(
      table.companyId,
      table.issueId,
      table.userId,
    ),
  }),
);

/**
 * The tasks a board user opened most recently, per company. Trimmed to the
 * last few on every write so it stays tiny.
 */
export const issueRecentViews = pgTable(
  "issue_recent_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserViewedIdx: index("issue_recent_views_company_user_viewed_idx").on(
      table.companyId,
      table.userId,
      table.viewedAt,
    ),
    companyIssueUserUnique: uniqueIndex("issue_recent_views_company_issue_user_idx").on(
      table.companyId,
      table.issueId,
      table.userId,
    ),
  }),
);
