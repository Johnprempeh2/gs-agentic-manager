// Inbound task webhooks: a secret URL an outside tool (Zapier, a form, a CRM)
// posts to, which creates a task in the company and attaches any files sent.
// Only the SHA-256 hash of the token is stored; the token is shown once.
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const inboundTaskHooks = pgTable(
  "inbound_task_hooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Random id in the public URL; not a secret on its own. */
    publicId: text("public_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** Agent new tasks are assigned to; null leaves them unassigned so nothing runs until a person picks them up. */
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    useCount: integer("use_count").notNull().default(0),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    publicIdUq: uniqueIndex("inbound_task_hooks_public_id_uq").on(table.publicId),
    companyIdx: index("inbound_task_hooks_company_idx").on(table.companyId),
  }),
);
