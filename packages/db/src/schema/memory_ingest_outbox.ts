import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { memoryRecords } from "./memory.js";

// Memory ingest outbox (GRE-673, ADR-0001). Each row is one engine call the
// gateway owes the engine. A plan limit or an engine outage defers the row;
// rows never move to a failed state. Rollback: drop this table.
export const memoryIngestOutbox = pgTable(
  "memory_ingest_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => memoryRecords.id, { onDelete: "cascade" }),
    /** `retain` | `delete` | `retag` */
    op: text("op").notNull(),
    /** The exact engine request, so a retry sends what was first queued. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** sha256 of the canonical payload; makes a repeat enqueue a no-op. */
    payloadHash: text("payload_hash").notNull(),
    /** `pending` | `in_flight` | `synced` | `needs_attention` | `cancelled` (a retain whose record was deleted first) */
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    claimToken: text("claim_token"),
    /** `plan_limit` | `engine_unavailable` | `transient` | `rejected` */
    lastErrorKind: text("last_error_kind"),
    lastError: text("last_error"),
    /** Model tokens the engine reported for this call (Claude plan use). Null until synced. */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dedupeIdx: uniqueIndex("memory_ingest_outbox_dedupe_idx").on(table.recordId, table.op, table.payloadHash),
    dueIdx: index("memory_ingest_outbox_due_idx").on(table.state, table.nextAttemptAt),
    companySyncedIdx: index("memory_ingest_outbox_company_synced_idx").on(table.companyId, table.syncedAt),
  }),
);
