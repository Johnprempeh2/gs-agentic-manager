import { createHash } from "node:crypto";
import { and, asc, eq, gte, isNotNull, lte, or, sql } from "drizzle-orm";
import { memoryIngestOutbox, memoryRecords, type Db } from "@greatstone/db";
import type { MemorySyncState } from "@greatstone/shared";
import type {
  MemoryEngineErrorKind,
  MemoryIngestEntry,
  MemoryIngestOp,
  MemoryIngestState,
  MemoryIngestStore,
  MemoryIngestUsage,
} from "./ingest-outbox.js";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type OutboxRow = typeof memoryIngestOutbox.$inferSelect;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function memoryIngestPayloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}

function toEntry(row: OutboxRow): MemoryIngestEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    recordId: row.recordId,
    op: row.op as MemoryIngestOp,
    payload: row.payload,
    state: row.state as MemoryIngestState,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    leaseUntil: row.leaseUntil,
    claimToken: row.claimToken,
    lastErrorKind: row.lastErrorKind as MemoryEngineErrorKind | null,
    lastError: row.lastError,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    syncedAt: row.syncedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Queues one engine call. Call it inside the transaction that writes the
 * `memory_records` row, so a record never exists without its outbox entry.
 * A repeat enqueue of the same payload returns the existing entry.
 */
export async function enqueueMemoryIngest(
  database: DbOrTransaction,
  input: {
    companyId: string;
    recordId: string;
    op: MemoryIngestOp;
    payload: Record<string, unknown>;
    now?: Date;
    /** First time the drain may pick the entry up (default: now). */
    notBefore?: Date;
  },
): Promise<MemoryIngestEntry> {
  const now = input.now ?? new Date();
  const payloadHash = memoryIngestPayloadHash(input.payload);
  const inserted = await database
    .insert(memoryIngestOutbox)
    .values({
      companyId: input.companyId,
      recordId: input.recordId,
      op: input.op,
      payload: input.payload,
      payloadHash,
      nextAttemptAt: input.notBefore ?? now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [memoryIngestOutbox.recordId, memoryIngestOutbox.op, memoryIngestOutbox.payloadHash],
    })
    .returning();
  if (inserted[0]) return toEntry(inserted[0]);
  const existing = await database
    .select()
    .from(memoryIngestOutbox)
    .where(
      and(
        eq(memoryIngestOutbox.recordId, input.recordId),
        eq(memoryIngestOutbox.op, input.op),
        eq(memoryIngestOutbox.payloadHash, payloadHash),
      ),
    );
  return toEntry(existing[0]!);
}

/**
 * Records the result of the gateway's own first engine call for an entry it
 * just queued. Guarded on `pending`: if a drain already claimed the entry, the
 * drain's outcome wins and this is a no-op (the replay is idempotent).
 * Returns false when nothing was written.
 */
export async function settleDirectMemoryIngest(
  database: DbOrTransaction,
  entryId: string,
  input:
    | { now: Date; outcome: "synced"; usage: MemoryIngestUsage | null }
    | { now: Date; outcome: "deferred"; nextAttemptAt: Date; kind: MemoryEngineErrorKind; error: string },
): Promise<boolean> {
  const guard = and(eq(memoryIngestOutbox.id, entryId), eq(memoryIngestOutbox.state, "pending"));
  const rows =
    input.outcome === "synced"
      ? await database
          .update(memoryIngestOutbox)
          .set({
            state: "synced",
            syncedAt: input.now,
            lastErrorKind: null,
            lastError: null,
            inputTokens: input.usage?.inputTokens ?? 0,
            outputTokens: input.usage?.outputTokens ?? 0,
            updatedAt: input.now,
          })
          .where(guard)
          .returning({ id: memoryIngestOutbox.id })
      : await database
          .update(memoryIngestOutbox)
          .set({
            attempts: sql`${memoryIngestOutbox.attempts} + 1`,
            nextAttemptAt: input.nextAttemptAt,
            lastErrorKind: input.kind,
            lastError: input.error,
            updatedAt: input.now,
          })
          .where(guard)
          .returning({ id: memoryIngestOutbox.id });
  return rows.length > 0;
}

/**
 * Mirrors the outcome onto the governance row. A plan limit or an outage keeps
 * the record `pending`; only a permanent engine rejection (a parked entry)
 * shows as `failed`, so a named owner can look at it.
 */
async function setRecordSyncState(
  database: DbOrTransaction,
  recordId: string,
  input: { state: MemorySyncState; error: string | null; now: Date },
) {
  await database
    .update(memoryRecords)
    .set({
      syncState: input.state,
      syncError: input.error,
      ...(input.state === "synced" ? { syncedAt: input.now } : {}),
      updatedAt: input.now,
    })
    .where(eq(memoryRecords.id, recordId));
}

export function createDbMemoryIngestStore(db: Db): MemoryIngestStore {
  const held = (id: string, token: string) =>
    and(
      eq(memoryIngestOutbox.id, id),
      eq(memoryIngestOutbox.state, "in_flight"),
      eq(memoryIngestOutbox.claimToken, token),
    );

  return {
    enqueue: (input) => enqueueMemoryIngest(db, input),

    async claimDue({ now, limit, leaseMs, newToken }) {
      return db.transaction(async (tx) => {
        const due = await tx
          .select({ id: memoryIngestOutbox.id })
          .from(memoryIngestOutbox)
          .where(
            or(
              and(eq(memoryIngestOutbox.state, "pending"), lte(memoryIngestOutbox.nextAttemptAt, now)),
              and(
                eq(memoryIngestOutbox.state, "in_flight"),
                isNotNull(memoryIngestOutbox.leaseUntil),
                lte(memoryIngestOutbox.leaseUntil, now),
              ),
            ),
          )
          .orderBy(asc(memoryIngestOutbox.nextAttemptAt))
          .limit(limit)
          .for("update", { skipLocked: true });
        const claimed: MemoryIngestEntry[] = [];
        for (const { id } of due) {
          const [row] = await tx
            .update(memoryIngestOutbox)
            .set({
              state: "in_flight",
              claimToken: newToken(),
              leaseUntil: new Date(now.getTime() + leaseMs),
              updatedAt: now,
            })
            .where(eq(memoryIngestOutbox.id, id))
            .returning();
          if (row) claimed.push(toEntry(row));
        }
        return claimed;
      });
    },

    async markSynced(id, token, { now, usage }) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(memoryIngestOutbox)
          .set({
            state: "synced",
            syncedAt: now,
            leaseUntil: null,
            claimToken: null,
            lastErrorKind: null,
            lastError: null,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            updatedAt: now,
          })
          .where(held(id, token))
          .returning({ recordId: memoryIngestOutbox.recordId, op: memoryIngestOutbox.op });
        if (!row) return false;
        if (row.op !== "delete") {
          await setRecordSyncState(tx, row.recordId, { state: "synced", error: null, now });
        }
        return true;
      });
    },

    async defer(id, token, { now, nextAttemptAt, kind, error, countAttempt }) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(memoryIngestOutbox)
          .set({
            state: "pending",
            attempts: countAttempt ? sql`${memoryIngestOutbox.attempts} + 1` : memoryIngestOutbox.attempts,
            nextAttemptAt,
            leaseUntil: null,
            claimToken: null,
            lastErrorKind: kind,
            lastError: error,
            updatedAt: now,
          })
          .where(held(id, token))
          .returning({ recordId: memoryIngestOutbox.recordId });
        if (!row) return false;
        await setRecordSyncState(tx, row.recordId, { state: "pending", error: `${kind}: ${error}`.slice(0, 500), now });
        return true;
      });
    },

    async park(id, token, { now, kind, error }) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(memoryIngestOutbox)
          .set({
            state: "needs_attention",
            attempts: sql`${memoryIngestOutbox.attempts} + 1`,
            leaseUntil: null,
            claimToken: null,
            lastErrorKind: kind,
            lastError: error,
            updatedAt: now,
          })
          .where(held(id, token))
          .returning({ recordId: memoryIngestOutbox.recordId });
        if (!row) return false;
        await setRecordSyncState(tx, row.recordId, {
          state: "failed",
          error: `${kind}: ${error}`.slice(0, 500),
          now,
        });
        return true;
      });
    },

    async listSyncedSince({ companyId, since }) {
      const rows = await db
        .select()
        .from(memoryIngestOutbox)
        .where(
          and(
            eq(memoryIngestOutbox.companyId, companyId),
            eq(memoryIngestOutbox.state, "synced"),
            gte(memoryIngestOutbox.syncedAt, since),
          ),
        );
      return rows.map(toEntry);
    },
  };
}
