import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { pipelineCases } from "./pipeline_cases.js";

// A link a client opens, without signing in, to read the engagement pack and
// accept it online (Ben, 12 Oct; John's yes, 16 Oct). Only the token's hash is
// kept, like an invite, so the link is shown once when it is made. A newer
// link revokes the older one for the same client.
export const clientAcceptanceLinks = pgTable(
  "client_acceptance_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Who accepted, as they typed it on the page, and when.
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedName: text("accepted_name"),
    acceptedRole: text("accepted_role"),
    acceptedEmail: text("accepted_email"),
    acceptedIp: text("accepted_ip"),
    acceptedUserAgent: text("accepted_user_agent"),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("client_acceptance_links_token_hash_uq").on(table.tokenHash),
    caseIdx: index("client_acceptance_links_case_idx").on(table.companyId, table.caseId),
    openCaseIdx: index("client_acceptance_links_open_case_idx")
      .on(table.caseId)
      .where(sql`${table.revokedAt} is null`),
  }),
);
