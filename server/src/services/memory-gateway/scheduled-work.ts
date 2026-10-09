import { and, desc, eq } from "drizzle-orm";
import { memoryOperations, memorySettings, type Db } from "@greatstone/db";
import { logger } from "../../middleware/logger.js";
import type { MemoryEngine } from "./engine.js";
import { drainMemoryIngestOutbox, memoryIngestEngineFor, type DrainMemoryIngestResult } from "./ingest-outbox.js";
import { createDbMemoryIngestStore } from "./ingest-outbox-db.js";
import { MEMORY_RETENTION_ACTOR_ID, memoryReviewService } from "./review.js";
import { memoryGatewayService } from "./service.js";

// Memory gateway M0 (GRE-1079): the two queues that had no live path forward.
// Both run from the server's execution-control sweep, single-flight per queue.

/** One scheduled retention pass per company with memory on, at most this often. */
export const MEMORY_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed pass, try again this much sooner than the full interval. */
const MEMORY_RETENTION_RETRY_MS = 60 * 60 * 1000;

/** Last scheduled pass per company, so the audit table is read once per company per boot. */
const lastRetentionAt = new Map<string, number>();

/**
 * Runs the 90/180/365-day rules (G1 decision 7) for each company with memory
 * on, at most once a day. The last pass is read from `memory_operations`, so
 * a restart does not run it again early and a missed day runs on the next
 * sweep. A failed company is logged and retried within the hour; it never
 * stops other companies.
 */
export async function runScheduledMemoryRetention(db: Db, now = new Date()) {
  const enabled = await db.select({ companyId: memorySettings.companyId }).from(memorySettings).where(eq(memorySettings.enabled, true));
  const reviews = memoryReviewService(db, memoryGatewayService(db));
  let ran = 0;
  for (const { companyId } of enabled) {
    if (!lastRetentionAt.has(companyId)) {
      const [last] = await db
        .select({ at: memoryOperations.createdAt })
        .from(memoryOperations)
        .where(
          and(
            eq(memoryOperations.companyId, companyId),
            eq(memoryOperations.operation, "retention"),
            eq(memoryOperations.actorId, MEMORY_RETENTION_ACTOR_ID),
          ),
        )
        .orderBy(desc(memoryOperations.createdAt))
        .limit(1);
      lastRetentionAt.set(companyId, last ? last.at.getTime() : 0);
    }
    if (now.getTime() - (lastRetentionAt.get(companyId) ?? 0) < MEMORY_RETENTION_INTERVAL_MS) continue;
    lastRetentionAt.set(companyId, now.getTime());
    try {
      const result = await reviews.runScheduledRetention(companyId, now);
      if (result.due > 0) logger.info({ companyId, ...result }, "memory retention deleted due records");
      ran += 1;
    } catch (error) {
      lastRetentionAt.set(companyId, now.getTime() - MEMORY_RETENTION_INTERVAL_MS + MEMORY_RETENTION_RETRY_MS);
      logger.warn({ err: error, companyId }, "memory retention failed; it runs again within the hour");
    }
  }
  return { ran };
}

/** The actor id on rows the scheduled drain writes. */
export const MEMORY_INGEST_ACTOR_ID = "memory-ingest-drain";
/** About five hours of failed attempts at the default backoff (30 s doubling, capped at 1 hour). */
export const MEMORY_INGEST_OVERDUE_AFTER_ATTEMPTS = 12;

/** For tests: forget the in-process schedule. */
export function resetMemoryRetentionSchedule() {
  lastRetentionAt.clear();
}

/**
 * One drain pass of the memory ingest outbox (the retry queue). Delivers due
 * entries to the engine and reports what failed: each entry the engine
 * refused for good, and each entry that reaches the overdue threshold, gets one
 * `ingest_failed` / `ingest_overdue` row in `memory_operations` and a warning
 * in the server log. With no engine configured the pass halts on the first
 * entry and defers the rest, so nothing is lost and nothing spins.
 */
export async function runScheduledMemoryIngestDrain(
  db: Db,
  engine: MemoryEngine,
  options: { now?: () => Date; engineTimeoutMs?: number; overdueAfterAttempts?: number } = {},
): Promise<DrainMemoryIngestResult> {
  const overdueAfterAttempts = options.overdueAfterAttempts ?? MEMORY_INGEST_OVERDUE_AFTER_ATTEMPTS;
  const result = await drainMemoryIngestOutbox({
    store: createDbMemoryIngestStore(db),
    engine: memoryIngestEngineFor(engine, { timeoutMs: options.engineTimeoutMs }),
    now: options.now,
    overdueAfterAttempts,
  });
  const reports = [
    ...result.failed.map((entry) => ({
      companyId: entry.companyId,
      recordId: entry.recordId,
      operation: "ingest_failed",
      // Ids and kind only: an engine error can echo the document, and the outbox row keeps it.
      detail: { outboxId: entry.id, op: entry.op, kind: entry.kind },
    })),
    // Once per entry: at the threshold, not on every later retry.
    ...result.overdue
      .filter((entry) => entry.attempts === overdueAfterAttempts)
      .map((entry) => ({
        companyId: entry.companyId,
        recordId: entry.recordId,
        operation: "ingest_overdue",
        detail: { outboxId: entry.id, attempts: entry.attempts, kind: entry.kind },
      })),
  ];
  for (const report of reports) {
    logger.warn({ ...report }, "memory ingest entry needs attention");
    await db.insert(memoryOperations).values({
      companyId: report.companyId,
      operation: report.operation,
      outcome: report.operation === "ingest_failed" ? "failed" : "overdue",
      actorType: "system",
      actorId: MEMORY_INGEST_ACTOR_ID,
      app: "gsam_scheduler",
      recordId: report.recordId,
      detail: report.detail,
    });
  }
  return result;
}
