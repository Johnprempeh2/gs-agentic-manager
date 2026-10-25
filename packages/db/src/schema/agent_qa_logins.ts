import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";

// Browser QA access for an agent (GRE-2387). A board owner gives an agent a
// member log-in of its own (`qa-<agent>@<company>.local`) with a Viewer or
// Operator role and an expiry. One row per grant; the log-in is reused when the
// same agent is given access again. A user with any row here is a QA account:
// it is let in only while one row is active and not past `expires_at`.
export const agentQaLogins = pgTable(
  "agent_qa_logins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    /** viewer or operator; never owner or admin. */
    role: text("role").notNull(),
    /** active, revoked or expired. */
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** The person who pressed Revoke; null when the grant expired. */
    endedByUserId: text("ended_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeAgentUq: uniqueIndex("agent_qa_logins_active_agent_uq")
      .on(table.companyId, table.agentId)
      .where(sql`${table.status} = 'active'`),
    userIdx: index("agent_qa_logins_user_idx").on(table.userId),
    statusExpiresIdx: index("agent_qa_logins_status_expires_idx").on(table.status, table.expiresAt),
  }),
);
