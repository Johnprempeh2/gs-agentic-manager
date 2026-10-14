import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

// Members of a team chat (an issue with origin kind "team_chat"): people and
// agents. Only members (and company owners, for moderation) read or post.
export const issueParticipants = pgTable(
  "issue_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    principalType: text("principal_type").$type<"user" | "agent">().notNull(),
    principalId: text("principal_id").notNull(),
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrincipalUq: uniqueIndex("issue_participants_issue_principal_uq").on(
      table.issueId,
      table.principalType,
      table.principalId,
    ),
    principalTypeCheck: check("issue_participants_principal_type_check", sql`${table.principalType} in ('user', 'agent')`),
    companyPrincipalIdx: index("issue_participants_company_principal_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
    ),
  }),
);
