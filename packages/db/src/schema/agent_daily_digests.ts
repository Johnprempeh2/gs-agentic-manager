// The nightly digest of what each agent did in one UTC day, with its spend.
// One row per company per day: the unique key is what keeps a restart from
// sending the same day twice. The weekly report reads these rows back.
import { date, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AgentDailyDigestPayload } from "@greatstone/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const agentDailyDigests = pgTable(
  "agent_daily_digests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** The UTC day the digest covers, YYYY-MM-DD. */
    digestDate: date("digest_date", { mode: "string" }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<AgentDailyDigestPayload>().notNull(),
    /** The digest as markdown, as the lead agent reads it. */
    body: text("body").notNull(),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** The standing "Daily digest" task the digest was written to. */
    deliveredIssueId: uuid("delivered_issue_id").references(() => issues.id, { onDelete: "set null" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Why it was stored but not delivered: no lead agent, company paused, task on hold. */
    skippedReason: text("skipped_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDateUq: uniqueIndex("agent_daily_digests_company_date_uq").on(table.companyId, table.digestDate),
    companyCreatedIdx: index("agent_daily_digests_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
