import { and, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  heartbeatRuns,
  memoryConflicts,
  memoryExtractedFacts,
  memoryOperations,
  memoryRecords,
  memoryReviewEvents,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
  projects,
} from "@greatstone/db";
import {
  MEMORY_CONFLICT_NOTE,
  MEMORY_EVIDENCE_NOTE,
  MEMORY_FLAG_NOTE,
  MEMORY_HARD_BOUNDARY_KINDS,
  MEMORY_UNAVAILABLE_MESSAGE,
  type ContributeMemory,
  type CreateMemoryScope,
  type MemoryConflictLink,
  type MemoryContributeResult,
  type MemoryContributionFlag,
  type MemoryDecisionClass,
  type MemoryEntryType,
  type MemoryRecallHit,
  type MemoryRecallResult,
  type MemoryRecord,
  type MemoryRecordKind,
  type MemoryRecordStatus,
  type MemoryRetainMode,
  type MemoryScope,
  type MemoryScopeKind,
  type MemorySensitivity,
  type MemorySettings,
  type MemorySyncState,
  type RecallMemory,
  type UpdateMemorySettings,
} from "@greatstone/shared";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import {
  MemoryEngineUnavailableError,
  unconfiguredMemoryEngine,
  MEMORY_ENGINE_TIMEOUT_MS,
  withEngineTimeout,
  type MemoryEngine,
  type MemoryEngineDocument,
  type MemoryEngineHit,
} from "./engine.js";
import { detectContributionFlags } from "./contribution-flags.js";
import { classifyEngineError, nextAttemptAt } from "./ingest-outbox.js";
import { enqueueMemoryIngest, settleDirectMemoryIngest } from "./ingest-outbox-db.js";
import { flagPossibleConflicts, insertReviewEvent, openConflictLinks } from "./review-store.js";
import {
  detectSensitiveContent,
  MEMORY_SENSITIVE_CONTENT_CODE,
  MemorySensitiveContentError,
} from "./sensitive-content.js";

/** Slack after the direct call's timeout before the drain may take the entry. */
export const DIRECT_RETAIN_GRACE_MS = 5_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who is calling the gateway. Built from the authenticated actor only; nothing
 * in a request body can change it.
 */
export type MemoryCaller = {
  companyId: string;
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  userId: string | null;
  runId: string | null;
  /** Local board, instance admin, or owner/admin of this company. */
  isBoardAdmin: boolean;
};

export type ScopeRow = typeof memoryScopes.$inferSelect;
export type RecordRow = typeof memoryRecords.$inferSelect;
export type MemoryPermission = "memory:read" | "memory:contribute" | "memory:approve" | "memory:delete" | "memory:admin";
export type GrantScopes = Map<string, Record<string, unknown> | null>;

export const MEMORY_DISABLED_MESSAGE = "Memory is not enabled for this company";

export function bankForCompany(companyId: string) {
  return `gs-${companyId}-main`;
}

function scopeTag(kind: MemoryScopeKind, ids: { scopeId: string; projectId?: string | null; agentId?: string | null }) {
  switch (kind) {
    case "organization":
      return "scope:org";
    case "project":
    case "restricted_project":
      return `scope:project:${ids.projectId}`;
    case "client":
      return `scope:client:${ids.scopeId}`;
    case "agent":
      return `scope:agent:${ids.agentId}`;
  }
}

export function isHardBoundary(kind: string) {
  return (MEMORY_HARD_BOUNDARY_KINDS as readonly string[]).includes(kind);
}

export function grantedScopeIds(scope: Record<string, unknown> | null | undefined): string[] | null {
  const ids = scope?.memoryScopeIds;
  if (!Array.isArray(ids)) return null;
  return ids.filter((id): id is string => typeof id === "string");
}

/**
 * Does a grant cover this scope? A grant without `memoryScopeIds` covers the
 * organization and ordinary project scopes only. Client and restricted-project
 * scopes must be named. Agent working scopes are never granted.
 */
export function grantCovers(grants: GrantScopes, key: MemoryPermission, scope: ScopeRow) {
  if (!grants.has(key)) return false;
  if (scope.kind === "agent") return false;
  const ids = grantedScopeIds(grants.get(key));
  if (ids) return ids.includes(scope.id);
  return scope.kind === "organization" || scope.kind === "project";
}

export function toScope(row: ScopeRow): MemoryScope {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as MemoryScopeKind,
    name: row.name,
    projectId: row.projectId,
    agentId: row.agentId,
    createdAt: row.createdAt,
  };
}

export function toRecord(row: RecordRow, scope: ScopeRow): MemoryRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    scopeId: row.scopeId,
    scopeKind: scope.kind as MemoryScopeKind,
    kind: row.kind as MemoryRecordKind,
    status: row.status as MemoryRecordStatus,
    entryType: row.entryType as MemoryEntryType,
    decisionClass: row.decisionClass as MemoryDecisionClass,
    sensitivity: row.sensitivity as MemorySensitivity,
    title: row.title,
    content: row.content,
    entities: row.entities,
    topics: row.topics,
    contributorAgentId: row.contributorAgentId,
    contributorUserId: row.contributorUserId,
    runId: row.runId,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    supersedesId: row.supersedesId,
    supersededById: row.supersededById,
    supersededAt: row.supersededAt,
    reviewedAt: row.reviewedAt,
    version: row.version,
    retainMode: row.retainMode as MemoryRetainMode,
    syncState: row.syncState as MemorySyncState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * Cheap check used when deciding whether to give a run the memory tools. A
 * failed lookup means no memory tools for that run; the run itself goes on.
 */
export async function companyMemoryEnabled(db: Db, companyId: string) {
  try {
    const row = await db
      .select({ enabled: memorySettings.enabled })
      .from(memorySettings)
      .where(eq(memorySettings.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    return row?.enabled === true;
  } catch (error) {
    logger.warn({ err: error, companyId }, "memory setting lookup failed; run starts without memory tools");
    return false;
  }
}

export function memoryGatewayService(
  db: Db,
  options: { engine?: MemoryEngine; engineTimeoutMs?: number } = {},
) {
  const engine = options.engine ?? unconfiguredMemoryEngine();
  const engineTimeoutMs = options.engineTimeoutMs ?? MEMORY_ENGINE_TIMEOUT_MS;
  const callEngine = <T>(work: () => Promise<T>) =>
    withEngineTimeout(Promise.resolve().then(work), engineTimeoutMs);

  async function logOperation(
    caller: MemoryCaller,
    operation: string,
    outcome: "ok" | "denied" | "unavailable",
    extra: { scopeIds?: string[]; recordId?: string | null; detail?: Record<string, unknown> } = {},
  ) {
    await db.insert(memoryOperations).values({
      companyId: caller.companyId,
      operation,
      outcome,
      actorType: caller.actorType,
      actorId: caller.actorId,
      agentId: caller.agentId,
      runId: caller.runId,
      scopeIds: extra.scopeIds ?? [],
      recordId: extra.recordId ?? null,
      detail: extra.detail ?? null,
    });
  }

  /**
   * An agent may name only its own running run (GRE-867). Anything else is
   * refused and logged without the claimed run, so another agent's run never
   * appears as the run of this call.
   */
  async function assertLiveRun(caller: MemoryCaller, operation: string, claimedRunId: string) {
    if (caller.actorType !== "agent" || !caller.agentId) return;
    const live = UUID_RE.test(claimedRunId)
      ? await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, claimedRunId),
              eq(heartbeatRuns.companyId, caller.companyId),
              eq(heartbeatRuns.agentId, caller.agentId),
              eq(heartbeatRuns.status, "running"),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    if (live) return;
    await logOperation({ ...caller, runId: null }, operation, "denied", {
      detail: { reason: "run_not_live", claimedRunId: claimedRunId.slice(0, 100) },
    });
    throw forbidden("X-Paperclip-Run-Id is not a running run of this agent");
  }

  /** A refused write still leaves a trace under the real caller (GRE-651, GRE-867). Field names only, never values. */
  async function recordRejectedContribute(caller: MemoryCaller, rejected: { unrecognizedFields: string[]; invalidFields: string[] }) {
    await logOperation(caller, "contribute", "denied", { detail: { reason: "invalid_body", ...rejected } });
  }

  async function getSettings(companyId: string): Promise<MemorySettings> {
    const row = await db
      .select()
      .from(memorySettings)
      .where(eq(memorySettings.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    return {
      companyId,
      enabled: row?.enabled ?? false,
      retainMode: (row?.retainMode as MemoryRetainMode | undefined) ?? "extract",
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** Memory is off by default; while off, no memory route or tool does anything. */
  async function assertEnabled(companyId: string) {
    const settings = await getSettings(companyId);
    if (!settings.enabled) throw notFound(MEMORY_DISABLED_MESSAGE);
    return settings;
  }

  async function updateSettings(caller: MemoryCaller, patch: UpdateMemorySettings): Promise<MemorySettings> {
    if (caller.actorType !== "user" || !caller.isBoardAdmin) {
      await logOperation(caller, "settings_update", "denied", { detail: { ...patch } });
      throw forbidden("Only a company owner or admin can change memory settings");
    }
    const now = new Date();
    await db
      .insert(memorySettings)
      .values({ companyId: caller.companyId, ...patch, updatedByUserId: caller.userId, updatedAt: now })
      .onConflictDoUpdate({
        target: memorySettings.companyId,
        set: { ...patch, updatedByUserId: caller.userId, updatedAt: now },
      });
    await logOperation(caller, "settings_update", "ok", { detail: { ...patch } });
    return getSettings(caller.companyId);
  }

  async function loadGrants(caller: MemoryCaller): Promise<GrantScopes> {
    const rows = await db
      .select({ key: principalPermissionGrants.permissionKey, scope: principalPermissionGrants.scope })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, caller.companyId),
          eq(principalPermissionGrants.principalType, caller.actorType),
          eq(principalPermissionGrants.principalId, caller.actorId),
          like(principalPermissionGrants.permissionKey, "memory:%"),
        ),
      );
    return new Map(rows.map((row) => [row.key, row.scope ?? null]));
  }

  /** Access is checked on every call, never cached (G1 decision 6). */
  async function accessFor(caller: MemoryCaller) {
    const grants = await loadGrants(caller);
    const isAdmin = (caller.actorType === "user" && caller.isBoardAdmin) || grants.has("memory:admin");
    const ownsAgentScope = (scope: ScopeRow) =>
      scope.kind === "agent" && caller.agentId !== null && scope.agentId === caller.agentId;
    return {
      /** John: a person who owns or administers the company. Never an agent, whatever its grants. */
      isOwner: caller.actorType === "user" && caller.isBoardAdmin,
      grants,
      ownsAgentScope,
      canRead(scope: ScopeRow) {
        if (scope.companyId !== caller.companyId) return false;
        if (isAdmin || ownsAgentScope(scope)) return true;
        // Every member of the company reads organization memory by default.
        if (scope.kind === "organization") return true;
        return grantCovers(grants, "memory:read", scope);
      },
      canContribute(scope: ScopeRow) {
        if (scope.companyId !== caller.companyId) return false;
        if (isAdmin || ownsAgentScope(scope)) return true;
        return grantCovers(grants, "memory:contribute", scope);
      },
    };
  }

  async function insertScopeIfMissing(values: typeof memoryScopes.$inferInsert) {
    await db.insert(memoryScopes).values(values).onConflictDoNothing({
      target: [memoryScopes.companyId, memoryScopes.tag],
    });
  }

  /** The organization scope and the calling agent's working scope always exist. */
  async function ensureDefaultScopes(caller: MemoryCaller) {
    await insertScopeIfMissing({
      companyId: caller.companyId,
      kind: "organization",
      name: "Organization",
      bankId: bankForCompany(caller.companyId),
      tag: "scope:org",
    });
    if (caller.agentId) {
      const agent = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, caller.agentId), eq(agents.companyId, caller.companyId)))
        .then((rows) => rows[0] ?? null);
      if (agent) {
        await insertScopeIfMissing({
          companyId: caller.companyId,
          kind: "agent",
          name: `${agent.name} working notes`,
          agentId: agent.id,
          bankId: bankForCompany(caller.companyId),
          tag: scopeTag("agent", { scopeId: "", agentId: agent.id }),
        });
      }
    }
  }

  async function listCompanyScopes(companyId: string) {
    return db.select().from(memoryScopes).where(eq(memoryScopes.companyId, companyId));
  }

  async function listScopes(caller: MemoryCaller): Promise<MemoryScope[]> {
    await assertEnabled(caller.companyId);
    await ensureDefaultScopes(caller);
    const access = await accessFor(caller);
    const scopes = (await listCompanyScopes(caller.companyId)).filter((scope) => access.canRead(scope));
    return scopes.map(toScope);
  }

  async function createScope(caller: MemoryCaller, input: CreateMemoryScope): Promise<MemoryScope> {
    await assertEnabled(caller.companyId);
    if (caller.actorType !== "user" || !caller.isBoardAdmin) {
      await logOperation(caller, "scope_create", "denied", { detail: { kind: input.kind } });
      throw forbidden("Only a company owner or admin can create memory scopes");
    }
    const needsProject = input.kind === "project" || input.kind === "restricted_project";
    if (needsProject !== Boolean(input.projectId)) {
      throw badRequest(needsProject ? "projectId is required for a project scope" : "projectId is only for project scopes");
    }
    if ((input.kind === "agent") !== Boolean(input.agentId)) {
      throw badRequest(input.kind === "agent" ? "agentId is required for an agent scope" : "agentId is only for agent scopes");
    }
    if (input.projectId) {
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.companyId, caller.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Project not found");
    }
    if (input.agentId) {
      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, caller.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");
    }
    const id = crypto.randomUUID();
    const tag = scopeTag(input.kind, { scopeId: id, projectId: input.projectId, agentId: input.agentId });
    // Client and restricted-project memory live in their own bank: knowing the
    // company bank never reaches them.
    const bankId = isHardBoundary(input.kind) ? `gs-${caller.companyId}-${id}` : bankForCompany(caller.companyId);
    const [row] = await db
      .insert(memoryScopes)
      .values({
        id,
        companyId: caller.companyId,
        kind: input.kind,
        name: input.name,
        projectId: input.projectId ?? null,
        agentId: input.agentId ?? null,
        bankId,
        tag,
      })
      .onConflictDoNothing({ target: [memoryScopes.companyId, memoryScopes.tag] })
      .returning();
    if (!row) throw conflict("A memory scope for this target already exists");
    await logOperation(caller, "scope_create", "ok", { scopeIds: [row.id], detail: { kind: row.kind } });
    return toScope(row);
  }

  async function loadScope(companyId: string, scopeId: string) {
    return db
      .select()
      .from(memoryScopes)
      .where(and(eq(memoryScopes.id, scopeId), eq(memoryScopes.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  }

  async function contribute(caller: MemoryCaller, input: ContributeMemory): Promise<MemoryContributeResult> {
    const settings = await assertEnabled(caller.companyId);
    await ensureDefaultScopes(caller);
    const scope = await loadScope(caller.companyId, input.scopeId);
    const access = await accessFor(caller);
    if (!scope || !access.canContribute(scope)) {
      await logOperation(caller, "contribute", "denied", { scopeIds: [input.scopeId] });
      // Same answer for "no such scope" and "not yours", so ids leak nothing.
      throw notFound("Memory scope not found");
    }
    if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
      throw badRequest("effectiveTo must not be before effectiveFrom");
    }
    if (input.entryType && input.status && input.entryType !== input.status) {
      throw badRequest("entryType and status must match; send entryType only");
    }
    const entryType = input.entryType ?? input.status ?? "proposal";
    // Checked before anything is written, so a refused value is in no table
    // here or in the engine (GRE-868). The audit row names pattern types only.
    const matchedTypes = detectSensitiveContent(
      [input.title, input.content, input.sourceId, ...input.entities, ...input.topics, input.evidence ? JSON.stringify(input.evidence) : null]
        .filter(Boolean)
        .join("\n"),
    );
    if (matchedTypes.length > 0) {
      await logOperation(caller, "contribute", "denied", {
        scopeIds: [scope.id],
        detail: { reason: MEMORY_SENSITIVE_CONTENT_CODE, matchedTypes },
      });
      throw new MemorySensitiveContentError(matchedTypes);
    }

    // The record and its outbox entry are written together, so a record never
    // exists without a way to reach the engine (GRE-673).
    const { row, document, entry, possibleConflicts } = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(memoryRecords)
        .values({
          companyId: caller.companyId,
          scopeId: scope.id,
          kind: "source_statement",
          // Every contribution starts unreviewed; only review can approve it (GRE-886).
          status: "unreviewed",
          entryType,
          decisionClass: input.decisionClass,
          sensitivity: input.sensitivity,
          title: input.title ?? null,
          content: input.content,
          entities: input.entities,
          topics: input.topics,
          contributorAgentId: caller.agentId,
          contributorUserId: caller.userId,
          runId: caller.runId,
          sourceKind: input.sourceKind ?? null,
          sourceId: input.sourceId ?? null,
          evidence: input.evidence ?? null,
          effectiveFrom: input.effectiveFrom ?? null,
          effectiveTo: input.effectiveTo ?? null,
          retainMode: settings.retainMode,
          syncState: "pending",
        })
        .returning();
      const doc: MemoryEngineDocument = {
        bankId: scope.bankId,
        documentId: inserted.id,
        content: inserted.title ? `${inserted.title}\n\n${inserted.content}` : inserted.content!,
        context: inserted.sourceKind ? `${inserted.sourceKind}:${inserted.sourceId ?? ""}` : null,
        tags: [
          scope.tag,
          // Review state lives in GSAM only; the engine tag never changes, so it is not a status.
          `type:${inserted.entryType}`,
          `sens:${inserted.sensitivity}`,
          caller.agentId ? `by:agent:${caller.agentId}` : `by:user:${caller.userId}`,
        ],
        entities: inserted.entities,
        metadata: { gsamRecordId: inserted.id, gsamScopeId: scope.id },
        timestamp: (inserted.effectiveFrom ?? inserted.createdAt).toISOString(),
        mode: settings.retainMode,
      };
      const queued = await enqueueMemoryIngest(tx, {
        companyId: caller.companyId,
        recordId: inserted.id,
        op: "retain",
        payload: doc as unknown as Record<string, unknown>,
        // Keep the drain off the entry while the call below is in flight.
        notBefore: new Date(Date.now() + engineTimeoutMs + DIRECT_RETAIN_GRACE_MS),
      });
      const now = inserted.createdAt;
      await insertReviewEvent(tx, caller, inserted, { action: "contribute", toStatus: "unreviewed", now });
      // A new entry never overwrites an approved one: it only opens a conflict for review.
      const conflicts = scope.kind === "agent" ? [] : await flagPossibleConflicts(tx, caller, inserted, now);
      return { row: inserted, document: doc, entry: queued, possibleConflicts: conflicts };
    });

    // One direct call so the caller hears "ok" when the engine is up. On any
    // failure the entry stays queued and the drain retries it; a plan limit
    // or an outage never fails the record.
    let engineAvailable = true;
    let synced = row;
    try {
      const result = await callEngine(() => engine.retain(document));
      const now = new Date();
      await settleDirectMemoryIngest(db, entry.id, { now, outcome: "synced", usage: result?.usage ?? null });
      [synced] = await db
        .update(memoryRecords)
        .set({ syncState: "synced", syncedAt: now, syncError: null, updatedAt: now })
        .where(eq(memoryRecords.id, row.id))
        .returning();
    } catch (error) {
      engineAvailable = false;
      const now = new Date();
      const classified = classifyEngineError(error, now);
      logger.warn(
        { err: error, recordId: row.id, kind: classified.kind },
        "memory engine retain failed; record kept as pending and queued for retry",
      );
      await settleDirectMemoryIngest(db, entry.id, {
        now,
        outcome: "deferred",
        // A rejection is retried once by the drain, which parks it for a named owner.
        nextAttemptAt:
          classified.kind === "rejected"
            ? now
            : nextAttemptAt({ now, attempts: entry.attempts + 1, classified }),
        kind: classified.kind,
        error: classified.message,
      });
      [synced] = await db
        .update(memoryRecords)
        .set({ syncError: `${classified.kind}: ${classified.message}`.slice(0, 500), updatedAt: now })
        .where(eq(memoryRecords.id, row.id))
        .returning();
    }

    // Marks for the reviewer only; nothing here changes the record's status.
    const flags: MemoryContributionFlag[] = detectContributionFlags([input.title, input.content].filter(Boolean).join("\n"));
    if (possibleConflicts.length > 0) flags.push("possible_conflict");
    await logOperation(caller, "contribute", engineAvailable ? "ok" : "unavailable", {
      scopeIds: [scope.id],
      recordId: row.id,
      detail: { retainMode: settings.retainMode, entryType: row.entryType, possibleConflicts: possibleConflicts.length, flags },
    });
    return {
      record: toRecord(synced, scope),
      engineAvailable,
      message: engineAvailable ? null : MEMORY_UNAVAILABLE_MESSAGE,
      possibleConflicts,
      conflictNote: possibleConflicts.length > 0 ? MEMORY_CONFLICT_NOTE : null,
      flags,
      flagNote: flags.length > 0 ? MEMORY_FLAG_NOTE : null,
    };
  }

  async function getRecord(caller: MemoryCaller, recordId: string): Promise<MemoryRecord> {
    await assertEnabled(caller.companyId);
    const row = await db
      .select()
      .from(memoryRecords)
      .where(and(eq(memoryRecords.id, recordId), eq(memoryRecords.companyId, caller.companyId)))
      .then((rows) => rows[0] ?? null);
    const scope = row ? await loadScope(caller.companyId, row.scopeId) : null;
    const access = await accessFor(caller);
    if (!row || !scope || !access.canRead(scope)) {
      await logOperation(caller, "get", "denied", { recordId: row ? row.id : null, detail: { requestedId: recordId } });
      throw notFound("Memory record not found");
    }
    await logOperation(caller, "get", "ok", { scopeIds: [scope.id], recordId: row.id });
    if (row.status !== "deleted") {
      await db.update(memoryRecords).set({ lastUsedAt: new Date() }).where(eq(memoryRecords.id, row.id));
    }
    return toRecord(row, scope);
  }

  /**
   * Links every engine fact the gateway sees to the record and contributor it
   * came from (plan 8.5). Ids only; the fact text stays in the engine. A
   * failure here never fails the recall.
   */
  async function recordExtractedFacts(
    companyId: string,
    hits: MemoryEngineHit[],
    rowsById: Map<string, RecordRow>,
    scopesById: Map<string, ScopeRow>,
    now: Date,
  ) {
    const values = hits.flatMap((hit) => {
      const row = rowsById.get(hit.documentId);
      if (!row || !hit.unitId) return [];
      return [{
        companyId,
        recordId: row.id,
        bankId: scopesById.get(row.scopeId)!.bankId,
        engineUnitId: hit.unitId.slice(0, 200),
        factType: hit.factType?.slice(0, 50) ?? null,
        contributorAgentId: row.contributorAgentId,
        contributorUserId: row.contributorUserId,
        firstSeenAt: now,
        lastSeenAt: now,
      }];
    });
    if (values.length === 0) return;
    const unique = [...new Map(values.map((value) => [`${value.bankId}:${value.engineUnitId}`, value])).values()];
    try {
      await db
        .insert(memoryExtractedFacts)
        .values(unique)
        .onConflictDoUpdate({
          target: [memoryExtractedFacts.companyId, memoryExtractedFacts.bankId, memoryExtractedFacts.engineUnitId],
          set: { lastSeenAt: now },
        });
    } catch (error) {
      logger.warn({ err: error, companyId }, "memory extracted-fact provenance write failed; recall goes on");
    }
  }

  /**
   * Records that held approval and were in their effective window on `asOf`.
   * A superseded record counts when it was ever approved; supersession sets
   * its `effectiveTo` to the replacement's start. The window is the dates the
   * contributor gave (or the creation time), not when the review happened.
   */
  async function inForceAsOf(companyId: string, records: MemoryRecord[], asOf: Date) {
    const inWindow = records.filter((record) => {
      const from = new Date(record.effectiveFrom ?? record.createdAt);
      const to = record.effectiveTo ? new Date(record.effectiveTo) : null;
      return from <= asOf && (!to || to > asOf);
    });
    const superseded = inWindow.filter((record) => record.status === "superseded").map((record) => record.id);
    const wasApproved = new Set(
      superseded.length === 0
        ? []
        : await db
            .selectDistinct({ recordId: memoryReviewEvents.recordId })
            .from(memoryReviewEvents)
            .where(
              and(
                eq(memoryReviewEvents.companyId, companyId),
                inArray(memoryReviewEvents.recordId, superseded),
                eq(memoryReviewEvents.toStatus, "approved"),
              ),
            )
            .then((rows) => rows.map((row) => row.recordId)),
    );
    return new Set(
      inWindow
        .filter((record) => record.status === "approved" || wasApproved.has(record.id))
        .map((record) => record.id),
    );
  }

  async function recall(caller: MemoryCaller, input: RecallMemory): Promise<MemoryRecallResult> {
    await assertEnabled(caller.companyId);
    await ensureDefaultScopes(caller);
    const access = await accessFor(caller);
    const companyScopes = await listCompanyScopes(caller.companyId);

    let scopes: ScopeRow[];
    if (input.scopeIds && input.scopeIds.length > 0) {
      const byId = new Map(companyScopes.map((scope) => [scope.id, scope]));
      const denied = input.scopeIds.filter((id) => {
        const scope = byId.get(id);
        return !scope || !access.canRead(scope);
      });
      if (denied.length > 0) {
        await logOperation(caller, "recall", "denied", { scopeIds: input.scopeIds, detail: { deniedScopeIds: denied } });
        throw notFound("Memory scope not found");
      }
      scopes = input.scopeIds.map((id) => byId.get(id)!);
    } else {
      // Without explicit scopes, recall never crosses a client or
      // restricted-project boundary, even for an admin.
      scopes = companyScopes.filter((scope) => !isHardBoundary(scope.kind) && access.canRead(scope));
    }
    const scopeIds = scopes.map((scope) => scope.id);

    const tagsByBank = new Map<string, string[]>();
    for (const scope of scopes) {
      tagsByBank.set(scope.bankId, [...(tagsByBank.get(scope.bankId) ?? []), scope.tag]);
    }

    const hits: MemoryEngineHit[] = [];
    try {
      for (const [bankId, tags] of tagsByBank) {
        hits.push(...(await callEngine(() => engine.recall({ bankId, query: input.query, tags, limit: input.limit }))));
      }
    } catch (error) {
      if (!(error instanceof MemoryEngineUnavailableError)) throw error;
      logger.warn({ err: error, companyId: caller.companyId }, "memory engine recall failed");
      await logOperation(caller, "recall", "unavailable", { scopeIds });
      return { available: false, message: MEMORY_UNAVAILABLE_MESSAGE, results: [] };
    }

    // The engine is never trusted on its own: every hit is checked against the
    // GSAM record, its company, its scope and its status.
    const documentIds = [...new Set(hits.map((hit) => hit.documentId))].filter((id) =>
      /^[0-9a-f-]{36}$/i.test(id),
    );
    const rows = documentIds.length === 0 || scopeIds.length === 0
      ? []
      : await db
          .select()
          .from(memoryRecords)
          .where(
            and(
              eq(memoryRecords.companyId, caller.companyId),
              inArray(memoryRecords.id, documentIds),
              inArray(memoryRecords.scopeId, scopeIds),
              ne(memoryRecords.status, "deleted"),
            ),
          );
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const scopesById = new Map(scopes.map((scope) => [scope.id, scope]));

    const best = new Map<string, MemoryRecallHit>();
    for (const hit of hits) {
      const row = rowsById.get(hit.documentId);
      if (!row) continue;
      const existing = best.get(row.id);
      if (existing && (existing.score ?? 0) >= (hit.score ?? 0)) continue;
      best.set(row.id, { record: toRecord(row, scopesById.get(row.scopeId)!), excerpt: hit.text, score: hit.score, conflicts: [] });
    }
    const matched = [...best.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, input.limit);

    // Material disputes travel with the result: open conflicts on each record,
    // plus the approved record a match conflicts with and the record that
    // replaced a superseded match, even when the engine did not return them.
    const matchedIds = matched.map((hit) => hit.record.id);
    const { links } = await openConflictLinks(db, caller.companyId, matchedIds);
    const relatedIds = new Set<string>();
    for (const hit of matched) {
      for (const link of links.get(hit.record.id) ?? []) if (!link.isApprovedSide) relatedIds.add(link.otherRecordId);
      if (hit.record.supersededById) relatedIds.add(hit.record.supersededById);
      // As of a past date the answer may be the record a match replaced.
      if (input.asOf && hit.record.supersedesId) relatedIds.add(hit.record.supersedesId);
    }
    matchedIds.forEach((id) => relatedIds.delete(id));
    const relatedRows = relatedIds.size === 0
      ? []
      : await db
          .select()
          .from(memoryRecords)
          .where(
            and(
              eq(memoryRecords.companyId, caller.companyId),
              inArray(memoryRecords.id, [...relatedIds]),
              inArray(memoryRecords.scopeId, scopeIds),
              ne(memoryRecords.status, "deleted"),
            ),
          );
    const added: MemoryRecallHit[] = relatedRows.map((row) => ({
      record: toRecord(row, scopesById.get(row.scopeId)!),
      excerpt: [row.title, row.content].filter(Boolean).join("\n\n").slice(0, 2_000),
      score: null,
      conflicts: [],
      addedBecause: matched.some((hit) => hit.record.supersededById === row.id || hit.record.supersedesId === row.id)
        ? "supersession"
        : "conflict",
    }));
    // Both sides of a conflict always sit in one scope, so every link here is
    // to a record this caller may read.
    const addedLinks = (await openConflictLinks(db, caller.companyId, added.map((hit) => hit.record.id))).links;
    for (const hit of matched) hit.conflicts = links.get(hit.record.id) ?? [];
    for (const hit of added) hit.conflicts = addedLinks.get(hit.record.id) ?? [];

    // Approved knowledge first, then disputes, then unreviewed, then history.
    // Newest is never treated as correct. With `asOf`, what was in force on
    // that date goes before everything else.
    const rank: Record<string, number> = { approved: 0, disputed: 1, unreviewed: 2, superseded: 3 };
    const candidates = [...matched, ...added];
    if (input.asOf) {
      const inForce = await inForceAsOf(caller.companyId, candidates.map((hit) => hit.record), input.asOf);
      for (const hit of candidates) hit.inForceAsOf = inForce.has(hit.record.id);
    }
    const order = (hit: MemoryRecallHit) => (hit.inForceAsOf === false ? 10 : 0) + (rank[hit.record.status] ?? 9);
    const results = candidates.sort((a, b) => {
      const byStatus = order(a) - order(b);
      return byStatus !== 0 ? byStatus : (b.score ?? -1) - (a.score ?? -1);
    });

    const now = new Date();
    if (matchedIds.length > 0) {
      await db
        .update(memoryRecords)
        .set({ lastUsedAt: now })
        .where(and(eq(memoryRecords.companyId, caller.companyId), inArray(memoryRecords.id, matchedIds)));
    }
    await recordExtractedFacts(caller.companyId, hits, rowsById, scopesById, now);

    await logOperation(caller, "recall", "ok", {
      scopeIds,
      detail: { returned: results.length, engineHits: hits.length },
    });
    return {
      available: true,
      note: MEMORY_EVIDENCE_NOTE,
      conflictNote: MEMORY_CONFLICT_NOTE,
      ...(input.asOf ? { asOf: input.asOf.toISOString() } : {}),
      results,
    };
  }

  return {
    /** For the review service (review.ts) only; routes use the methods below. */
    internals: { accessFor, logOperation, loadScope, callEngine, engine, engineTimeoutMs },
    getSettings,
    updateSettings,
    assertEnabled,
    assertLiveRun,
    recordRejectedContribute,
    listScopes,
    createScope,
    contribute,
    getRecord,
    recall,
  };
}

export type MemoryGatewayService = ReturnType<typeof memoryGatewayService>;
