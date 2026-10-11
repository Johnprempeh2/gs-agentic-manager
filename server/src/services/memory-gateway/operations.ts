import { and, count, desc, eq, gte, type SQL } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { memoryOperations } from "@greatstone/db";
import type { MemoryOperationRow, MemoryOperationsQuery, MemoryOperationsResult } from "@greatstone/shared";

const TRIGGER_RE = /^[a-z_]{1,32}$/;

/**
 * Only the numbers and yes/no flags in `detail`. The column also holds ids,
 * refusal messages and settings, so nothing else leaves the server.
 */
function safeDetail(detail: Record<string, unknown> | null) {
  const counts: MemoryOperationRow["counts"] = {};
  const flags: MemoryOperationRow["flags"] = {};
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) counts[key] = value;
    else if (typeof value === "boolean") flags[key] = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (entries.length > 0 && entries.every(([, n]) => typeof n === "number" && Number.isFinite(n))) {
        counts[key] = Object.fromEntries(entries) as Record<string, number>;
      }
    }
  }
  const trigger = typeof detail?.trigger === "string" && TRIGGER_RE.test(detail.trigger) ? detail.trigger : null;
  return { counts, flags, trigger };
}

/**
 * The scheduled pass records `deleted`; a manual applied pass records only
 * `count` (the records due), so its forgotten count is not known.
 */
function forgottenOf(kind: string, counts: MemoryOperationRow["counts"], flags: MemoryOperationRow["flags"]) {
  if (kind !== "retention") return null;
  if (typeof counts.deleted === "number") return counts.deleted;
  if (flags.dryRun === true) return 0;
  return null;
}

/** The memory operations log for live checks (GRE-1302). Read only. */
export function memoryOperationsReadService(db: Db) {
  async function list(companyId: string, query: MemoryOperationsQuery): Promise<MemoryOperationsResult> {
    const filters: SQL[] = [eq(memoryOperations.companyId, companyId)];
    if (query.kind) filters.push(eq(memoryOperations.operation, query.kind));
    if (query.since) filters.push(gte(memoryOperations.createdAt, query.since));
    const where = and(...filters);

    const [rows, grouped] = await Promise.all([
      db
        .select()
        .from(memoryOperations)
        .where(where)
        .orderBy(desc(memoryOperations.createdAt), desc(memoryOperations.id))
        .limit(query.limit),
      db
        .select({ kind: memoryOperations.operation, outcome: memoryOperations.outcome, n: count() })
        .from(memoryOperations)
        .where(where)
        .groupBy(memoryOperations.operation, memoryOperations.outcome),
    ]);

    const summary: MemoryOperationsResult["summary"] = { total: 0, byKind: {}, byOutcome: {} };
    for (const { kind, outcome, n } of grouped) {
      summary.total += n;
      summary.byKind[kind] = (summary.byKind[kind] ?? 0) + n;
      summary.byOutcome[outcome] = (summary.byOutcome[outcome] ?? 0) + n;
    }

    return {
      rows: rows.map((row) => {
        const { counts, flags, trigger } = safeDetail(row.detail);
        return {
          id: row.id,
          kind: row.operation,
          outcome: row.outcome,
          actor: { type: row.actorType, id: row.actorId, agentId: row.agentId },
          runId: row.runId,
          app: row.app,
          createdAt: row.createdAt,
          counts,
          flags,
          trigger,
          forgotten: forgottenOf(row.operation, counts, flags),
        };
      }),
      summary,
    };
  }

  return { list };
}
