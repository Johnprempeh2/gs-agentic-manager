import { pgTable, uuid, text, timestamp, index, integer, jsonb } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { goals } from "./goals.js";

export const goalCheckIns = pgTable(
  "goal_check_ins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    body: text("body").notNull(),
    progressPercent: integer("progress_percent"),
    blockers: jsonb("blockers").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalCreatedIdx: index("goal_check_ins_goal_created_idx").on(table.goalId, table.createdAt),
    companyIdx: index("goal_check_ins_company_idx").on(table.companyId),
  }),
);
