import { bigint, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
