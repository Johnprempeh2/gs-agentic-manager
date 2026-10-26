import { createHash } from "node:crypto";
import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { memoryOperations, memoryRecords, memoryReviewEvents, memoryScopes } from "@greatstone/db";
import {
  MEMORY_MY_WORK_SCOPE_REF,
  MEMORY_SYNC_DEFAULT_DAILY_CAP,
  memorySyncSourceKind,
  type MemorySyncEntryOutcome,
  type MemorySyncResult,
  type SyncMemory,
} from "@greatstone/shared";
import { notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import type { MemoryCardService } from "./card-writes.js";
import { MEMORY_RETENTION_ACTOR_ID } from "./review.js";
import { MemorySensitiveContentError } from "./sensitive-content.js";
import type { MemoryCaller, MemoryGatewayService } from "./service.js";

/**
 * One shared memory for a person's Claude Code, Codex and GSAM (GRE-2668).
 * Every entry lands in the caller's own person scope (`my_work`) through the
 * ordinary contribute and revise paths, so the sensitive-content check, the
 * outbox and review all apply. A resend of the same text is skipped by its
 * hash; a changed source replaces its old entry (revise), so recall finds one
 * live entry per source and the old one as history.
 */

export const MEMORY_SYNC_DAILY_CAP_OPERATION = "sync_daily_cap";

export function memorySyncContentHash(title: string | null | undefined, content: string) {
  return createHash("sha256").update(`${title ?? ""}\n${content}`).digest("hex");
}

export function memorySyncDailyCap(env: NodeJS.ProcessEnv = process.env) {
  const value = Number.parseInt(env.GSAM_MEMORY_SYNC_DAILY_CAP ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : MEMORY_SYNC_DEFAULT_DAILY_CAP;
}

function startOfUtcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function memorySyncService(
  db: Db,
  gateway: MemoryGatewayService,
  cards: MemoryCardService,
  options: { dailyCap?: number; now?: () => Date } = {},
) {
  const { logOperation } = gateway.internals;
  const now = options.now ?? (() => new Date());

  /** New or changed synced entries this scope took since the start of the UTC day. */
  async function usedSince(companyId: string, scopeId: string, since: Date) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.companyId, companyId),
          eq(memoryRecords.scopeId, scopeId),
          like(memoryRecords.sourceKind, "sync:%"),
          gte(memoryRecords.createdAt, since),
        ),
      );
    return Number(row?.count ?? 0);
  }

  async function capAlreadyReported(companyId: string, scopeId: string, since: Date) {
    const rows = await db
      .select({ id: memoryOperations.id })
      .from(memoryOperations)
      .where(
        and(
          eq(memoryOperations.companyId, companyId),
          eq(memoryOperations.operation, MEMORY_SYNC_DAILY_CAP_OPERATION),
          gte(memoryOperations.createdAt, since),
          sql`${memoryOperations.scopeIds} @> ${JSON.stringify([scopeId])}::jsonb`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The newest entry for one source, whatever its state, deleted ones included. */
  async function latestFor(companyId: string, scopeId: string, sourceKind: string, sourceId: string) {
    return db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.companyId, companyId),
          eq(memoryRecords.scopeId, scopeId),
          eq(memoryRecords.sourceKind, sourceKind),
          eq(memoryRecords.sourceId, sourceId),
        ),
      )
      .orderBy(desc(memoryRecords.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  /** A person deleted it (never stored again), or retention did (an old entry; a resend is new). */
  async function deletedByPerson(companyId: string, recordId: string) {
    const rows = await db
      .select({ actorId: memoryReviewEvents.actorId })
      .from(memoryReviewEvents)
      .where(and(eq(memoryReviewEvents.companyId, companyId), eq(memoryReviewEvents.recordId, recordId), eq(memoryReviewEvents.action, "delete")))
      .limit(1);
    return rows[0]?.actorId !== MEMORY_RETENTION_ACTOR_ID;
  }

  async function sync(caller: MemoryCaller, input: SyncMemory): Promise<MemorySyncResult> {
    const scopeId = await gateway.resolvePersonScopeRef(caller, MEMORY_MY_WORK_SCOPE_REF);
    if (!scopeId) throw notFound("Memory scope not found");
    const scope = await db
      .select()
      .from(memoryScopes)
      .where(eq(memoryScopes.id, scopeId))
      .then((rows) => rows[0]!);
    const dailyCap = options.dailyCap ?? memorySyncDailyCap();
    const dayStart = startOfUtcDay(now());
    let used = await usedSince(caller.companyId, scopeId, dayStart);
    let capped = 0;
    const entries: MemorySyncResult["entries"] = [];
    const push = (sourceId: string, outcome: MemorySyncEntryOutcome, recordId: string | null) =>
      entries.push({ sourceId, outcome, recordId });

    for (const entry of input.entries) {
      const sourceKind = memorySyncSourceKind(entry.source);
      const contentHash = memorySyncContentHash(entry.title, entry.content);
      let latest = await latestFor(caller.companyId, scopeId, sourceKind, entry.sourceId);
      if (latest?.status === "deleted") {
        if (await deletedByPerson(caller.companyId, latest.id)) {
          push(entry.sourceId, "deleted_before", null);
          continue;
        }
        latest = null;
      }
      const latestHash = (latest?.evidence as { contentHash?: unknown } | null)?.contentHash;
      if (latest && latestHash === contentHash) {
        push(entry.sourceId, "unchanged", latest.id);
        continue;
      }
      if (used >= dailyCap) {
        capped += 1;
        push(entry.sourceId, "capped", null);
        continue;
      }
      const evidence = {
        syncedFrom: entry.source,
        contentHash,
        occurredAt: entry.occurredAt.toISOString(),
        origin: entry.origin ?? null,
      };
      try {
        // Only an entry still in force is revised; a disputed, retired or
        // superseded one stays as it was and the changed text is a new entry.
        if (latest && (latest.status === "unreviewed" || latest.status === "approved")) {
          const revised = await cards.revise(
            caller,
            latest.id,
            {
              expectedVersion: latest.version,
              title: entry.title ?? null,
              content: entry.content,
              reason: `The source changed (${entry.source} ${entry.sourceId})`,
            },
            { evidence, effectiveFrom: entry.occurredAt },
          );
          push(entry.sourceId, "revised", revised.newRecord.id);
        } else {
          const contributed = await gateway.contribute(caller, {
            scopeId,
            content: entry.content,
            title: entry.title ?? null,
            entryType: "observation",
            decisionClass: "operational",
            sensitivity: "internal",
            entities: [],
            topics: [],
            sourceKind,
            sourceId: entry.sourceId,
            evidence,
            effectiveFrom: entry.occurredAt,
          });
          push(entry.sourceId, "added", contributed.record.id);
        }
        used += 1;
      } catch (error) {
        if (!(error instanceof MemorySensitiveContentError)) throw error;
        push(entry.sourceId, "held_back", null);
      }
    }

    const capReached = used >= dailyCap;
    if (capped > 0 && !(await capAlreadyReported(caller.companyId, scopeId, dayStart))) {
      // Once a day per scope: the alert line in the server log and the audit row.
      logger.warn(
        { companyId: caller.companyId, scopeId, bankId: scope.bankId, dailyCap },
        "shared memory sync reached its daily cap; the rest waits for tomorrow",
      );
      await logOperation(caller, MEMORY_SYNC_DAILY_CAP_OPERATION, "denied", {
        scopeIds: [scopeId],
        detail: { dailyCap, usedToday: used, capped },
      });
    }
    return { scopeId, bankName: scope.bankId, entries, usedToday: used, dailyCap, capReached };
  }

  return { sync };
}

export type MemorySyncService = ReturnType<typeof memorySyncService>;
