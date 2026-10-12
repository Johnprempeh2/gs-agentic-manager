import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * "Get help" tickets in a client instance (GRE-1084), the spoke side of the
 * support bridge. The client writes the title and summary; the host script
 * sends that summary to the Greatstone hub and brings back the status, SLA
 * times, owner and replies. `linkedIssueId` stays here: it is never sent.
 */
export const clientSupportTickets = pgTable(
  "client_support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"support" | "quality-review" | "upgrade">().notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    priority: text("priority").$type<"P1" | "P2" | "P3">().notNull(),
    /** One of the client's own issues, for the client's reference only. Never sent to the hub. */
    linkedIssueId: uuid("linked_issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    /** Grows with each client edit. The host script sends a ticket while `revision` is above `sentRevision`. */
    revision: integer("revision").notNull().default(1),
    sentRevision: integer("sent_revision"),
    /** queued until the hub answers, then the hub's status. */
    status: text("status").notNull().default("queued"),
    /** Why the hub refused the last send, if it did. The ticket stays queued. */
    refusedReason: text("refused_reason"),
    hubTicketId: text("hub_ticket_id"),
    hubPriority: text("hub_priority"),
    hubCategory: text("hub_category"),
    hubOwner: text("hub_owner"),
    hubReceivedAt: timestamp("hub_received_at", { withTimezone: true }),
    firstResponseDueAt: timestamp("first_response_due_at", { withTimezone: true }),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("client_support_tickets_company_created_idx").on(t.companyId, t.createdAt),
    check("client_support_tickets_kind_check", sql`${t.kind} in ('support', 'quality-review', 'upgrade')`),
    check("client_support_tickets_priority_check", sql`${t.priority} in ('P1', 'P2', 'P3')`),
  ],
);

/** A reply from Greatstone support, as the hub sent it. Kept once per hub reply id. */
export const clientSupportReplies = pgTable(
  "client_support_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id").notNull().references(() => clientSupportTickets.id, { onDelete: "cascade" }),
    hubReplyId: uuid("hub_reply_id").notNull(),
    body: text("body").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("client_support_replies_ticket_hub_reply_uq").on(t.ticketId, t.hubReplyId)],
);

/** A file the client picked for a ticket. Only these files ever go to the hub. */
export const clientSupportAttachments = pgTable(
  "client_support_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id").notNull().references(() => clientSupportTickets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    objectKey: text("object_key").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    createdByUserId: text("created_by_user_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("client_support_attachments_ticket_idx").on(t.ticketId)],
);
