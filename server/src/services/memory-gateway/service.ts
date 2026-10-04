import { and, eq, inArray, like, ne } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  memoryOperations,
  memoryRecords,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
  projects,
} from "@greatstone/db";
import {
  MEMORY_EVIDENCE_NOTE,
  MEMORY_HARD_BOUNDARY_KINDS,
  MEMORY_UNAVAILABLE_MESSAGE,
  type ContributeMemory,
  type CreateMemoryScope,
  type MemoryContributeResult,
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
  withEngineTimeout,
  type MemoryEngine,
} from "./engine.js";

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

type ScopeRow = typeof memoryScopes.$inferSelect;
type RecordRow = typeof memoryRecords.$inferSelect;
type MemoryPermission = "memory:read" | "memory:contribute" | "memory:admin";
type GrantScopes = Map<string, Record<string, unknown> | null>;

export const MEMORY_DISABLED_MESSAGE = "Memory is not enabled for this company";

function bankForCompany(companyId: string) {
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

function isHardBoundary(kind: string) {
  return (MEMORY_HARD_BOUNDARY_KINDS as readonly string[]).includes(kind);
}

function grantedScopeIds(scope: Record<string, unknown> | null | undefined): string[] | null {
  const ids = scope?.memoryScopeIds;
  if (!Array.isArray(ids)) return null;
  return ids.filter((id): id is string => typeof id === "string");
}

/**
 * Does a grant cover this scope? A grant without `memoryScopeIds` covers the
 * organization and ordinary project scopes only. Client and restricted-project
 * scopes must be named. Agent working scopes are never granted.
 */
function grantCovers(grants: GrantScopes, key: MemoryPermission, scope: ScopeRow) {
  if (!grants.has(key)) return false;
  if (scope.kind === "agent") return false;
  const ids = grantedScopeIds(grants.get(key));
  if (ids) return ids.includes(scope.id);
  return scope.kind === "organization" || scope.kind === "project";
}

function toScope(row: ScopeRow): MemoryScope {
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

function toRecord(row: RecordRow, scope: ScopeRow): MemoryRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    scopeId: row.scopeId,
    scopeKind: scope.kind as MemoryScopeKind,
    kind: row.kind as MemoryRecordKind,
    status: row.status as MemoryRecordStatus,
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
    version: row.version,
    retainMode: row.retainMode as MemoryRetainMode,
    syncState: row.syncState as MemorySyncState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function memoryGatewayService(
  db: Db,
  options: { engine?: MemoryEngine; engineTimeoutMs?: number } = {},
) {
  const engine = options.engine ?? unconfiguredMemoryEngine();
  const callEngine = <T>(work: () => Promise<T>) =>
    withEngineTimeout(Promise.resolve().then(work), options.engineTimeoutMs);

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

    const [row] = await db
      .insert(memoryRecords)
      .values({
        companyId: caller.companyId,
        scopeId: scope.id,
        kind: "source_statement",
        status: input.status,
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

    let engineAvailable = true;
    let synced = row;
    try {
      await callEngine(() =>
        engine.retain({
          bankId: scope.bankId,
          documentId: row.id,
          content: row.title ? `${row.title}\n\n${row.content}` : row.content!,
          context: row.sourceKind ? `${row.sourceKind}:${row.sourceId ?? ""}` : null,
          tags: [
            scope.tag,
            `status:${row.status}`,
            `sens:${row.sensitivity}`,
            caller.agentId ? `by:agent:${caller.agentId}` : `by:user:${caller.userId}`,
          ],
          entities: row.entities,
          metadata: { gsamRecordId: row.id, gsamScopeId: scope.id },
          timestamp: (row.effectiveFrom ?? row.createdAt).toISOString(),
          mode: settings.retainMode,
        }),
      );
      [synced] = await db
        .update(memoryRecords)
        .set({ syncState: "synced", syncedAt: new Date(), syncError: null, updatedAt: new Date() })
        .where(eq(memoryRecords.id, row.id))
        .returning();
    } catch (error) {
      engineAvailable = false;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error, recordId: row.id }, "memory engine retain failed; record kept as pending");
      [synced] = await db
        .update(memoryRecords)
        .set({ syncError: message.slice(0, 500), updatedAt: new Date() })
        .where(eq(memoryRecords.id, row.id))
        .returning();
    }

    await logOperation(caller, "contribute", engineAvailable ? "ok" : "unavailable", {
      scopeIds: [scope.id],
      recordId: row.id,
      detail: { retainMode: settings.retainMode, status: row.status },
    });
    return {
      record: toRecord(synced, scope),
      engineAvailable,
      message: engineAvailable ? null : MEMORY_UNAVAILABLE_MESSAGE,
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
    return toRecord(row, scope);
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

    const hits: Array<{ documentId: string; text: string; score: number | null }> = [];
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
      best.set(row.id, { record: toRecord(row, scopesById.get(row.scopeId)!), excerpt: hit.text, score: hit.score });
    }
    // Approved knowledge first; newest is never treated as correct.
    const results = [...best.values()]
      .sort((a, b) => {
        const approved = Number(b.record.status === "approved") - Number(a.record.status === "approved");
        return approved !== 0 ? approved : (b.score ?? 0) - (a.score ?? 0);
      })
      .slice(0, input.limit);

    await logOperation(caller, "recall", "ok", {
      scopeIds,
      detail: { returned: results.length, engineHits: hits.length },
    });
    return { available: true, note: MEMORY_EVIDENCE_NOTE, results };
  }

  return {
    getSettings,
    updateSettings,
    assertEnabled,
    listScopes,
    createScope,
    contribute,
    getRecord,
    recall,
  };
}

export type MemoryGatewayService = ReturnType<typeof memoryGatewayService>;
