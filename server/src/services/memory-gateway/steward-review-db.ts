import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import {
  agents,
  memoryOperations,
  memoryRecords,
  memoryScopes,
  memoryStewardCursors,
  memoryStewardEscalations,
  memoryStewardGrants,
  memoryStewardQueueItems,
  memoryStewardRuns,
  projects,
  type Db,
} from "@greatstone/db";
import type { MemoryRecordStatus, MemoryScopeKind } from "@greatstone/shared";
import type {
  StewardApprovedPosition,
  StewardCursor,
  StewardEntry,
  StewardFindingKind,
  StewardGrant,
  StewardOwner,
  StewardOwnerResolver,
  StewardQueueItem,
  StewardRun,
  StewardRunState,
  StewardSource,
  StewardStore,
} from "./steward-review.js";

// Database store for the steward review (GRE-887). Same guarded, atomic
// semantics as the in-memory store in steward-review.ts.
//
// Timestamps are compared at millisecond precision. Postgres keeps
// microseconds and a JS Date does not, so a cursor taken from a Date would
// never equal the row it came from; truncating both sides keeps the
// `(updatedAt, id)` order exact.

type RunRow = typeof memoryStewardRuns.$inferSelect;
type GrantRow = typeof memoryStewardGrants.$inferSelect;

const updatedMs = sql<Date>`date_trunc('milliseconds', ${memoryRecords.updatedAt})`;
const createdMs = sql<Date>`date_trunc('milliseconds', ${memoryRecords.createdAt})`;
const contentHash = sql<string | null>`encode(sha256(convert_to(${memoryRecords.content}, 'UTF8')), 'hex')`;
/** Approved records an open conflict links this record to (GRE-886 contribution check). */
const conflictsWith = sql<string[]>`coalesce((
  select jsonb_agg(c.approved_record_id order by c.approved_record_id)
  from memory_conflicts c
  where c.record_id = ${memoryRecords.id} and c.state = 'open'
), '[]'::jsonb)`;

const entryColumns = {
  id: memoryRecords.id,
  companyId: memoryRecords.companyId,
  scopeId: memoryRecords.scopeId,
  scopeKind: memoryScopes.kind,
  status: memoryRecords.status,
  decisionClass: memoryRecords.decisionClass,
  version: memoryRecords.version,
  title: memoryRecords.title,
  contentHash,
  topics: memoryRecords.topics,
  entities: memoryRecords.entities,
  contributorAgentId: memoryRecords.contributorAgentId,
  contributorUserId: memoryRecords.contributorUserId,
  sourceKind: memoryRecords.sourceKind,
  sourceId: memoryRecords.sourceId,
  syncState: memoryRecords.syncState,
  conflictsWith,
  createdAt: createdMs,
  updatedAt: updatedMs,
  deletedAt: memoryRecords.deletedAt,
};

type EntryRow = {
  [K in keyof typeof entryColumns]: unknown;
};

/** A Date as a bound timestamptz. postgres-js cannot bind a bare Date inside raw SQL. */
const ts = (value: Date) => sql`${value.toISOString()}::timestamptz`;

const asDate = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));

function toEntry(row: EntryRow): StewardEntry {
  return {
    id: row.id as string,
    companyId: row.companyId as string,
    scopeId: row.scopeId as string,
    scopeKind: row.scopeKind as MemoryScopeKind,
    status: row.status as MemoryRecordStatus,
    decisionClass: row.decisionClass as string,
    version: row.version as number,
    title: (row.title as string | null) ?? null,
    contentHash: (row.contentHash as string | null) ?? null,
    topics: (row.topics as string[]) ?? [],
    entities: (row.entities as string[]) ?? [],
    contributorAgentId: (row.contributorAgentId as string | null) ?? null,
    contributorUserId: (row.contributorUserId as string | null) ?? null,
    sourceKind: (row.sourceKind as string | null) ?? null,
    sourceId: (row.sourceId as string | null) ?? null,
    syncState: row.syncState as string,
    conflictsWith: (row.conflictsWith as string[]) ?? [],
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
    deletedAt: row.deletedAt ? asDate(row.deletedAt) : null,
  };
}

function toRun(row: RunRow): StewardRun {
  const cursor = (value: { updatedAt: string; id: string } | null) =>
    value ? { updatedAt: new Date(value.updatedAt), id: value.id } : null;
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId ?? "",
    grantId: row.grantId ?? "",
    state: row.state as StewardRunState,
    token: row.claimToken,
    leaseUntil: row.leaseUntil,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    until: row.until,
    cursorFrom: cursor(row.cursorFrom ?? null),
    cursorTo: cursor(row.cursorTo ?? null),
    entriesSeen: row.entriesSeen,
    escalationsCreated: row.escalationsCreated,
    escalationsDeduped: row.escalationsDeduped,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    durationMs: row.durationMs,
    resumedFromRunId: row.resumedFromRunId,
    error: row.error,
  };
}

function toGrant(row: GrantRow): StewardGrant {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    scopeIds: row.scopeIds,
    environment: row.environment as StewardGrant["environment"],
    grantedBy: row.grantedByUserId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

const cursorJson = (cursor: StewardCursor | null) =>
  cursor ? { updatedAt: cursor.updatedAt.toISOString(), id: cursor.id } : null;

function isUniqueViolation(error: unknown) {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

function afterCursor(cursor: StewardCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return or(gt(updatedMs, ts(cursor.updatedAt)), and(eq(updatedMs, ts(cursor.updatedAt)), gt(memoryRecords.id, cursor.id)));
}

export function createDbStewardStore(db: Db): StewardStore {
  const selectEntries = () =>
    db.select(entryColumns).from(memoryRecords).innerJoin(memoryScopes, eq(memoryScopes.id, memoryRecords.scopeId));

  const runningRuns = (companyId: string) =>
    and(eq(memoryStewardRuns.companyId, companyId), eq(memoryStewardRuns.state, "running"));

  return {
    async beginRun({ companyId, agentId, grantId, now, until, leaseMs, token }) {
      try {
        return await db.transaction(async (tx) => {
          const running = await tx.select().from(memoryStewardRuns).where(runningRuns(companyId)).for("update");
          let interrupted: StewardRun | null = null;
          for (const row of running) {
            if (row.leaseUntil.getTime() > now.getTime()) return { busy: toRun(row) };
            const [ended] = await tx
              .update(memoryStewardRuns)
              .set({ state: "interrupted", finishedAt: now, error: "lease expired before the run finished" })
              .where(and(eq(memoryStewardRuns.id, row.id), eq(memoryStewardRuns.state, "running")))
              .returning();
            if (ended) interrupted = toRun(ended);
          }
          const [cursor] = await tx
            .select()
            .from(memoryStewardCursors)
            .where(eq(memoryStewardCursors.companyId, companyId));
          const from = cursor ? { updatedAt: cursor.cursorUpdatedAt, id: cursor.cursorRecordId } : null;
          const [run] = await tx
            .insert(memoryStewardRuns)
            .values({
              companyId,
              agentId,
              grantId,
              state: "running",
              claimToken: token,
              leaseUntil: new Date(now.getTime() + leaseMs),
              until,
              cursorFrom: cursorJson(from),
              cursorTo: cursorJson(from),
              resumedFromRunId: interrupted?.id ?? null,
              startedAt: now,
            })
            .returning();
          return { run: toRun(run!), interrupted };
        });
      } catch (error) {
        // Another pass inserted its running row first (one-running index).
        if (!isUniqueViolation(error)) throw error;
        const [other] = await db.select().from(memoryStewardRuns).where(runningRuns(companyId));
        if (!other) throw error;
        return { busy: toRun(other) };
      }
    },

    async getCursor(companyId) {
      const [row] = await db.select().from(memoryStewardCursors).where(eq(memoryStewardCursors.companyId, companyId));
      return row ? { updatedAt: row.cursorUpdatedAt, id: row.cursorRecordId } : null;
    },

    async listChangedAfter({ companyId, scopeIds, cursor, until, limit }) {
      if (scopeIds.length === 0) return [];
      const rows = await selectEntries()
        .where(
          and(
            eq(memoryRecords.companyId, companyId),
            inArray(memoryRecords.scopeId, scopeIds),
            lte(updatedMs, ts(until)),
            afterCursor(cursor),
          ),
        )
        .orderBy(asc(updatedMs), asc(memoryRecords.id))
        .limit(limit);
      return rows.map(toEntry);
    },

    async listEarlierDuplicates(entry) {
      if (!entry.contentHash) return [];
      const rows = await selectEntries()
        .where(
          and(
            eq(memoryRecords.companyId, entry.companyId),
            eq(memoryRecords.scopeId, entry.scopeId),
            ne(memoryRecords.id, entry.id),
            isNull(memoryRecords.deletedAt),
            ne(memoryRecords.status, "deleted"),
            sql`${contentHash} = ${entry.contentHash}`,
            or(
              sql`${createdMs} < ${ts(entry.createdAt)}`,
              and(sql`${createdMs} = ${ts(entry.createdAt)}`, sql`${memoryRecords.id} < ${entry.id}`),
            ),
          ),
        )
        .orderBy(asc(createdMs), asc(memoryRecords.id));
      return rows.map(toEntry);
    },

    async getEntries(companyId, ids) {
      if (ids.length === 0) return [];
      const rows = await selectEntries().where(and(eq(memoryRecords.companyId, companyId), inArray(memoryRecords.id, ids)));
      return rows.map(toEntry);
    },

    async listSweepCandidates({ companyId, scopeIds, unreviewedBefore, supersededBefore, pendingBefore }) {
      if (scopeIds.length === 0) return [];
      const rows = await selectEntries().where(
        and(
          eq(memoryRecords.companyId, companyId),
          inArray(memoryRecords.scopeId, scopeIds),
          isNull(memoryRecords.deletedAt),
          or(
            and(ne(memoryRecords.syncState, "synced"), lte(updatedMs, ts(pendingBefore))),
            and(eq(memoryRecords.status, "unreviewed"), lte(updatedMs, ts(unreviewedBefore))),
            and(eq(memoryRecords.status, "superseded"), lte(updatedMs, ts(supersededBefore))),
          ),
        ),
      );
      return rows.map(toEntry);
    },

    async commitPage({ runId, token, now, leaseMs, cursor, entryIds, escalations, usage }) {
      return db.transaction(async (tx) => {
        // Lock the run: a pass that lost its lease writes nothing.
        const [run] = await tx
          .select()
          .from(memoryStewardRuns)
          .where(
            and(
              eq(memoryStewardRuns.id, runId),
              eq(memoryStewardRuns.state, "running"),
              eq(memoryStewardRuns.claimToken, token),
              gt(memoryStewardRuns.leaseUntil, now),
            ),
          )
          .for("update");
        if (!run) return null;
        const companyId = run.companyId;

        let created = 0;
        let deduped = 0;
        for (const item of escalations) {
          const [seen] = await tx
            .select({ id: memoryStewardEscalations.id })
            .from(memoryStewardEscalations)
            .where(
              and(eq(memoryStewardEscalations.companyId, companyId), eq(memoryStewardEscalations.dedupeKey, item.dedupeKey)),
            );
          if (seen) {
            deduped += 1;
            continue;
          }
          const [open] = await tx
            .select()
            .from(memoryStewardQueueItems)
            .where(
              and(
                eq(memoryStewardQueueItems.companyId, companyId),
                eq(memoryStewardQueueItems.groupKey, item.groupKey),
                eq(memoryStewardQueueItems.state, "open"),
              ),
            )
            .for("update");
          let queueItemId: string;
          if (open) {
            const sources = [
              ...(open.sources as unknown as StewardSource[]).filter((s) => s.recordId !== item.source.recordId),
              item.source,
            ];
            const known = new Set(open.approvedPosition.map((p) => p.recordId));
            const approvedPosition = [
              ...open.approvedPosition,
              ...item.approvedPosition.filter((p) => !known.has(p.recordId)),
            ];
            await tx
              .update(memoryStewardQueueItems)
              .set({
                sources: sources as unknown as Array<Record<string, unknown>>,
                approvedPosition,
                proposedResolution: item.proposedResolution,
                updatedAt: now,
              })
              .where(eq(memoryStewardQueueItems.id, open.id));
            queueItemId = open.id;
          } else {
            const [inserted] = await tx
              .insert(memoryStewardQueueItems)
              .values({
                companyId,
                groupKey: item.groupKey,
                kind: item.kind,
                scopeId: item.scopeId,
                routeTo: item.routeTo as unknown as Record<string, unknown>,
                sources: [item.source] as unknown as Array<Record<string, unknown>>,
                approvedPosition: item.approvedPosition,
                proposedResolution: item.proposedResolution,
                state: "open",
                openedAt: now,
                updatedAt: now,
              })
              .returning({ id: memoryStewardQueueItems.id });
            queueItemId = inserted!.id;
          }
          // Unique (company, dedupe key): a racing duplicate fails the page, which retries and dedupes.
          await tx.insert(memoryStewardEscalations).values({
            companyId,
            dedupeKey: item.dedupeKey,
            queueItemId,
            recordId: item.source.recordId,
            runId,
            createdAt: now,
          });
          created += 1;
        }

        if (cursor) {
          await tx
            .insert(memoryStewardCursors)
            .values({ companyId, cursorUpdatedAt: cursor.updatedAt, cursorRecordId: cursor.id, updatedAt: now })
            .onConflictDoUpdate({
              target: memoryStewardCursors.companyId,
              set: { cursorUpdatedAt: cursor.updatedAt, cursorRecordId: cursor.id, updatedAt: now },
            });
        }
        await tx
          .update(memoryStewardRuns)
          .set({
            ...(cursor ? { cursorTo: cursorJson(cursor) } : {}),
            entriesSeen: sql`${memoryStewardRuns.entriesSeen} + ${entryIds.length}`,
            escalationsCreated: sql`${memoryStewardRuns.escalationsCreated} + ${created}`,
            escalationsDeduped: sql`${memoryStewardRuns.escalationsDeduped} + ${deduped}`,
            inputTokens: sql`${memoryStewardRuns.inputTokens} + ${usage?.inputTokens ?? 0}`,
            outputTokens: sql`${memoryStewardRuns.outputTokens} + ${usage?.outputTokens ?? 0}`,
            leaseUntil: new Date(now.getTime() + leaseMs),
          })
          .where(eq(memoryStewardRuns.id, runId));
        return { created, deduped };
      });
    },

    async finishRun({ runId, token, now, state, error }) {
      const rows = await db
        .update(memoryStewardRuns)
        .set({
          state,
          finishedAt: now,
          durationMs: sql`greatest(0, floor(extract(epoch from (${ts(now)} - ${memoryStewardRuns.startedAt})) * 1000))::int`,
          error,
        })
        .where(
          and(
            eq(memoryStewardRuns.id, runId),
            eq(memoryStewardRuns.state, "running"),
            eq(memoryStewardRuns.claimToken, token),
            gt(memoryStewardRuns.leaseUntil, now),
          ),
        )
        .returning({ id: memoryStewardRuns.id });
      return rows.length > 0;
    },

    async listOpenItems(companyId) {
      const rows = await db
        .select({ item: memoryStewardQueueItems, scopeKind: memoryScopes.kind })
        .from(memoryStewardQueueItems)
        .innerJoin(memoryScopes, eq(memoryScopes.id, memoryStewardQueueItems.scopeId))
        .where(and(eq(memoryStewardQueueItems.companyId, companyId), eq(memoryStewardQueueItems.state, "open")))
        .orderBy(asc(memoryStewardQueueItems.openedAt));
      return rows.map(({ item, scopeKind }): StewardQueueItem => ({
        id: item.id,
        companyId: item.companyId,
        groupKey: item.groupKey,
        kind: item.kind as StewardFindingKind,
        scopeId: item.scopeId,
        scopeKind: scopeKind as MemoryScopeKind,
        routeTo: item.routeTo as unknown as StewardOwner,
        sources: item.sources as unknown as StewardSource[],
        approvedPosition: item.approvedPosition as StewardApprovedPosition[],
        proposedResolution: item.proposedResolution,
        state: "open",
        openedAt: item.openedAt,
        updatedAt: item.updatedAt,
      }));
    },

    async listRunsSince({ companyId, since }) {
      const rows = await db
        .select()
        .from(memoryStewardRuns)
        .where(and(eq(memoryStewardRuns.companyId, companyId), gte(memoryStewardRuns.startedAt, since)))
        .orderBy(asc(memoryStewardRuns.startedAt));
      return rows.map(toRun);
    },

    async audit({ companyId, agentId, runId, operation, outcome, scopeIds, detail, now }) {
      // `memory_operations.run_id` is the heartbeat run; the steward run id goes in the detail.
      await db.insert(memoryOperations).values({
        companyId,
        operation,
        outcome,
        actorType: "agent",
        actorId: agentId,
        agentId,
        scopeIds,
        detail: { ...detail, stewardRunId: runId },
        createdAt: now,
      });
    },
  };
}

/** The newest live grant for this agent, or null. `assertStewardGrant` still checks it. */
export async function getStewardGrant(db: Db, input: { companyId: string; agentId: string }): Promise<StewardGrant | null> {
  const [row] = await db
    .select()
    .from(memoryStewardGrants)
    .where(
      and(
        eq(memoryStewardGrants.companyId, input.companyId),
        eq(memoryStewardGrants.agentId, input.agentId),
        isNull(memoryStewardGrants.revokedAt),
      ),
    )
    .orderBy(desc(memoryStewardGrants.expiresAt))
    .limit(1);
  return row ? toGrant(row) : null;
}

/** Longest steward grant, sandbox or live. A live grant is then renewed (G3). */
export const STEWARD_GRANT_MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A live grant reaches only Greatstone scopes: never a client or restricted project. */
const LIVE_STEWARD_SCOPE_KINDS: readonly MemoryScopeKind[] = ["organization", "project", "agent"];

export class StewardGrantRefusal extends Error {
  constructor(
    readonly reason: "unknown_scope" | "client_scope" | "too_long" | "unknown_agent",
    message: string,
  ) {
    super(message);
    this.name = "StewardGrantRefusal";
  }
}

/**
 * Creates a steward grant. The caller checks who may grant (John only) and
 * audits the result, including a refusal.
 */
export async function createStewardGrant(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    scopeIds: string[];
    environment: StewardGrant["environment"];
    grantedByUserId: string;
    expiresAt: Date;
    reason?: string | null;
    now?: Date;
  },
): Promise<StewardGrant> {
  const now = input.now ?? new Date();
  const lifetimeMs = input.expiresAt.getTime() - now.getTime();
  // The sandbox route bounds its own grants; a sandbox test may pin a far date.
  if (input.environment === "live" && (lifetimeMs > STEWARD_GRANT_MAX_DAYS * DAY_MS || lifetimeMs <= 0)) {
    throw new StewardGrantRefusal("too_long", `A live steward grant lasts at most ${STEWARD_GRANT_MAX_DAYS} days`);
  }
  const scopes = input.scopeIds.length
    ? await db
        .select({ id: memoryScopes.id, kind: memoryScopes.kind })
        .from(memoryScopes)
        .where(and(eq(memoryScopes.companyId, input.companyId), inArray(memoryScopes.id, input.scopeIds)))
    : [];
  if (scopes.length !== new Set(input.scopeIds).size || scopes.length === 0) {
    throw new StewardGrantRefusal("unknown_scope", "Steward grant scopes must be existing scopes of this company");
  }
  if (input.environment === "live" && scopes.some((scope) => !LIVE_STEWARD_SCOPE_KINDS.includes(scope.kind as MemoryScopeKind))) {
    throw new StewardGrantRefusal("client_scope", "A live steward grant covers Greatstone scopes only, never a client or restricted scope");
  }
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
  if (!agent) throw new StewardGrantRefusal("unknown_agent", "Steward grant agent must belong to this company");
  const [row] = await db
    .insert(memoryStewardGrants)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      scopeIds: [...new Set(input.scopeIds)],
      environment: input.environment,
      grantedByUserId: input.grantedByUserId,
      reason: input.reason ?? null,
      expiresAt: input.expiresAt,
    })
    .returning();
  return toGrant(row!);
}

/** Sandbox grant. The route makes one only where sandbox grants are on. */
export function createSandboxStewardGrant(
  db: Db,
  input: { companyId: string; agentId: string; scopeIds: string[]; grantedByUserId: string; expiresAt: Date; reason?: string | null },
) {
  return createStewardGrant(db, { ...input, environment: "sandbox" });
}

export async function revokeStewardGrant(db: Db, input: { companyId: string; grantId: string; now?: Date }) {
  const rows = await db
    .update(memoryStewardGrants)
    .set({ revokedAt: input.now ?? new Date() })
    .where(
      and(
        eq(memoryStewardGrants.id, input.grantId),
        eq(memoryStewardGrants.companyId, input.companyId),
        isNull(memoryStewardGrants.revokedAt),
      ),
    )
    .returning({ id: memoryStewardGrants.id });
  return rows.length > 0;
}

/**
 * Scope owner: the agent for an agent scope, the project lead for a project
 * scope. Anything else has no known owner, so the finding goes to John.
 */
export function createDbStewardOwnerResolver(db: Db): StewardOwnerResolver {
  return async (entry) => {
    const [row] = await db
      .select({ kind: memoryScopes.kind, agentId: memoryScopes.agentId, leadAgentId: projects.leadAgentId, project: projects.name })
      .from(memoryScopes)
      .leftJoin(projects, eq(projects.id, memoryScopes.projectId))
      .where(eq(memoryScopes.id, entry.scopeId));
    if (!row) return null;
    if (row.kind === "agent" && row.agentId) {
      return { kind: "agent", agentId: row.agentId, label: "agent scope owner", reason: "owner of this agent scope" };
    }
    if (row.kind === "project" && row.leadAgentId) {
      return {
        kind: "agent",
        agentId: row.leadAgentId,
        label: `lead of ${row.project ?? "the project"}`,
        reason: "project lead owns this project scope",
      };
    }
    return null;
  };
}
