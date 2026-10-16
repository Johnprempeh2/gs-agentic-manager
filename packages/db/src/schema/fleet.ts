import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { assets } from "./assets.js";
import { issues } from "./issues.js";
import { supportQueues, supportTickets } from "./support.js";

/**
 * Client instances a Greatstone hub oversees (GRE-1082). One row per
 * instance code. The hub keeps only the SHA-256 of the one-time registration
 * code and the spoke's Ed25519 public key; the private key never leaves the
 * spoke. Instance-level, not company-level: only the hub's instance admins
 * read it.
 */
export const fleetInstances = pgTable(
  "fleet_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    status: text("status").notNull().default("pending"),
    registrationCodeHash: text("registration_code_hash"),
    registrationCodeExpiresAt: timestamp("registration_code_expires_at", { withTimezone: true }),
    publicKeyX: text("public_key_x"),
    /** The highest message `seq` accepted; a message at or below it is a replay. */
    lastSeq: bigint("last_seq", { mode: "number" }),
    lastCheckInAt: timestamp("last_check_in_at", { withTimezone: true }),
    /**
     * From the last v2 check-in (GRE-1366): active, paused or archived. Kept
     * here, not only in the check-in rows, so a paused instance that sends
     * nothing more still shows paused. Null until the first v2 check-in.
     */
    lifecycle: text("lifecycle"),
    lifecycleChangedAt: timestamp("lifecycle_changed_at", { withTimezone: true }),
    /** `health.app` of the last check-in: ok or down. */
    lastAppHealth: text("last_app_health"),
    /** The support queue this instance's "Get help" tickets land in (GRE-1084). Null: the hub refuses its tickets. */
    supportQueueId: uuid("support_queue_id").references(() => supportQueues.id, { onDelete: "set null" }),
    registeredAt: timestamp("registered_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeUq: uniqueIndex("fleet_instances_code_uq").on(table.code),
    registrationCodeHashUq: uniqueIndex("fleet_instances_registration_code_hash_uq").on(table.registrationCodeHash),
  }),
);

/** Check-ins as received, after the schema check. Kept 7 days. */
export const fleetCheckIns = pgTable(
  "fleet_check_ins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fleetInstanceId: uuid("fleet_instance_id")
      .notNull()
      .references(() => fleetInstances.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    instanceReceivedIdx: index("fleet_check_ins_instance_received_idx").on(table.fleetInstanceId, table.receivedAt),
  }),
);

/**
 * A support ticket that came from a client instance (GRE-1084). Links the
 * spoke's ticket id to the hub's support ticket. The ticket itself (title,
 * summary, status, owner, priority, category, SLA times) lives in the issue
 * and support_tickets; nothing else from the spoke is kept.
 */
export const fleetSupportTickets = pgTable(
  "fleet_support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fleetInstanceId: uuid("fleet_instance_id")
      .notNull()
      .references(() => fleetInstances.id, { onDelete: "cascade" }),
    /** The spoke's ticket id. */
    spokeRef: uuid("spoke_ref").notNull(),
    kind: text("kind").$type<"support" | "quality-review" | "upgrade">().notNull(),
    revision: integer("revision").notNull(),
    supportTicketId: uuid("support_ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    instanceRefUq: uniqueIndex("fleet_support_tickets_instance_ref_uq").on(table.fleetInstanceId, table.spokeRef),
    issueUq: uniqueIndex("fleet_support_tickets_issue_uq").on(table.issueId),
  }),
);

/** A reply we chose to send to the client. Internal issue comments never go. */
export const fleetSupportReplies = pgTable(
  "fleet_support_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fleetSupportTicketId: uuid("fleet_support_ticket_id")
      .notNull()
      .references(() => fleetSupportTickets.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorAgentId: uuid("author_agent_id"),
    authorUserId: text("author_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ticketCreatedIdx: index("fleet_support_replies_ticket_created_idx").on(table.fleetSupportTicketId, table.createdAt),
  }),
);

/** A file the client picked, stored as an attachment of the hub issue. Keyed by the spoke's id, so a resend is kept once. */
export const fleetSupportAttachments = pgTable(
  "fleet_support_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fleetSupportTicketId: uuid("fleet_support_ticket_id")
      .notNull()
      .references(() => fleetSupportTickets.id, { onDelete: "cascade" }),
    spokeRef: uuid("spoke_ref").notNull(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ticketRefUq: uniqueIndex("fleet_support_attachments_ticket_ref_uq").on(table.fleetSupportTicketId, table.spokeRef),
  }),
);
