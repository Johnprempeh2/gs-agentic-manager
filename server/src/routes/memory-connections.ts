import { Router, type Request } from "express";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { agentApiKeys, agents, memoryOperations, memoryRecords, principalPermissionGrants, type Db } from "@greatstone/db";
import {
  createMemoryConnectionSchema,
  MEMORY_CONNECTION_APP_LABEL,
  MEMORY_CONNECTION_APPS,
  normalizeAgentApiKeyScope,
  type CreateMemoryConnection,
  type CreatedMemoryConnection,
  type MemoryConnectionActivity,
  type MemoryConnection,
  type MemoryConnectionApp,
} from "@greatstone/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { agentService, logActivity } from "../services/index.js";
import type { MemoryEngine } from "../services/memory-gateway/engine.js";
import { memoryGrantService } from "../services/memory-gateway/grants.js";
import { memoryGatewayService, type MemoryCaller, type MemoryGatewayService } from "../services/memory-gateway/service.js";
import { getActorInfo } from "./authz.js";
import { memoryCallerFromRequest } from "./memory.js";

type ConnectionMeta = { app: MemoryConnectionApp; createdByUserId: string | null };

function connectionMeta(metadata: unknown): ConnectionMeta | null {
  const value = (metadata as { memoryConnection?: unknown } | null)?.memoryConnection as Partial<ConnectionMeta> | undefined;
  if (!value || !MEMORY_CONNECTION_APPS.includes(value.app as MemoryConnectionApp)) return null;
  return { app: value.app as MemoryConnectionApp, createdByUserId: typeof value.createdByUserId === "string" ? value.createdByUserId : null };
}

/**
 * Live links from Claude, Codex and other MCP apps to organization memory.
 * Built on memory-only keys (GRE-958): a link is a paused agent that never
 * runs, holds those keys and, if asked, a memory contribute grant. Since
 * GRE-1081 every person connects their own apps, one link per person and
 * app, each with its own key that can be cut off alone. A person sees and
 * disconnects their own links; an owner or admin sees and disconnects all.
 * A memory-only key reaches these paths but is refused here.
 */
/**
 * Link agents and their memory-only keys. Shared by the connect button and the
 * OAuth sign-in, so both make the same kind of link.
 */
export function memoryConnectionService(db: Db, gateway: MemoryGatewayService) {
  const grants = memoryGrantService(db, gateway);
  const agentsSvc = agentService(db);

  async function load(companyId: string, agentId?: string): Promise<MemoryConnection[]> {
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"), ...(agentId ? [eq(agents.id, agentId)] : [])));
    const linked = rows.flatMap((row) => {
      const meta = connectionMeta(row.metadata);
      return meta ? [{ row, meta }] : [];
    });
    const result: MemoryConnection[] = [];
    for (const { row, meta } of linked) {
      const keys = (
        await db
          .select()
          .from(agentApiKeys)
          .where(and(eq(agentApiKeys.agentId, row.id), eq(agentApiKeys.companyId, companyId), isNull(agentApiKeys.revokedAt)))
      ).filter((key) => normalizeAgentApiKeyScope(key.scopeConfig).kind === "memory_only");
      const contribute = await db
        .select({ id: principalPermissionGrants.id })
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, "agent"),
            eq(principalPermissionGrants.principalId, row.id),
            eq(principalPermissionGrants.permissionKey, "memory:contribute"),
          ),
        );
      result.push({
        agentId: row.id,
        app: meta.app,
        name: row.name,
        createdByUserId: meta.createdByUserId,
        canContribute: contribute.length > 0,
        keys: keys.map((key) => ({ id: key.id, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt })),
      });
    }
    return result;
  }

  /** One link agent per person and app, made on first use. The caller is that person. */
  async function connect(caller: MemoryCaller, app: MemoryConnectionApp, canContribute: boolean) {
    const userId = caller.userId;
    const existing = (await load(caller.companyId)).find(
      (connection) => connection.app === app && connection.createdByUserId === userId,
    );
    let agentId = existing?.agentId ?? null;
    if (!agentId) {
      const created = await agentsSvc.create(caller.companyId, {
        name: `${MEMORY_CONNECTION_APP_LABEL[app]} memory link`,
        role: "general",
        title: "Memory link, never runs",
        status: "paused",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        capabilities: `Reads and adds to organization memory from ${MEMORY_CONNECTION_APP_LABEL[app]}. It never runs tasks.`,
        metadata: { memoryConnection: { app, createdByUserId: userId } },
      });
      agentId = created.id;
    }
    if (canContribute && !existing?.canContribute) {
      await grants.change(caller, {
        principalType: "agent",
        principalId: agentId,
        permission: "memory:contribute",
        enabled: true,
        reason: `Set up the ${MEMORY_CONNECTION_APP_LABEL[app]} memory link`,
      });
    }
    return { agentId };
  }

  /** A new key for a link agent that already exists in the company (OAuth token exchange). */
  async function mintKey(companyId: string, agentId: string, keyName: string, responsibleUserId: string | null) {
    const [connection] = await load(companyId, agentId);
    if (!connection) return null;
    const key = await agentsSvc.createApiKey(agentId, keyName, { kind: "memory_only" }, { responsibleUserId });
    return { token: key.token, keyId: key.id, connection };
  }

  return { load, connect, mintKey };
}

export type MemoryConnectionService = ReturnType<typeof memoryConnectionService>;

export function memoryConnectionRoutes(db: Db, options: { engine?: MemoryEngine } = {}) {
  const router = Router();
  const gateway = memoryGatewayService(db, options);
  const links = memoryConnectionService(db, gateway);
  const agentsSvc = agentService(db);

  function personCaller(req: Request, companyId: string) {
    const caller = memoryCallerFromRequest(req, companyId);
    if (caller.actorType !== "user" || !caller.userId) throw forbidden("Only a person can manage memory connections");
    return caller;
  }

  /** A person manages their own links; an owner or admin manages every link. */
  function mayManage(caller: MemoryCaller, connection: MemoryConnection) {
    return caller.isBoardAdmin || connection.createdByUserId === caller.userId;
  }

  async function loadManaged(req: Request, companyId: string) {
    const caller = personCaller(req, companyId);
    const agentId = req.params.agentId as string;
    if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw notFound("Memory connection not found");
    const [connection] = await links.load(companyId, agentId);
    // Someone else's link answers like a missing one.
    if (!connection || !mayManage(caller, connection)) throw notFound("Memory connection not found");
    return { caller, agentId, connection };
  }

  router.get("/companies/:companyId/memory/connections", async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = personCaller(req, companyId);
    await gateway.assertEnabled(companyId);
    res.json((await links.load(companyId)).filter((connection) => connection.keys.length > 0 && mayManage(caller, connection)));
  });

  router.post("/companies/:companyId/memory/connections", validate(createMemoryConnectionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = personCaller(req, companyId);
    await gateway.assertEnabled(companyId);
    const { app, canContribute } = req.body as CreateMemoryConnection;
    const { agentId } = await links.connect(caller, app, canContribute);
    const minted = await links.mintKey(companyId, agentId, `${MEMORY_CONNECTION_APP_LABEL[app]} memory`, caller.userId);
    if (!minted) throw notFound("Memory connection not found");
    const { token, keyId } = minted;
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "memory.connection_created",
      entityType: "agent",
      entityId: agentId,
      details: { app, keyId, canContribute },
    });
    const [connection] = await links.load(companyId, agentId);
    const body: CreatedMemoryConnection = { connection, token };
    res.status(201).json(body);
  });

  // "Check it works": the link's own calls and what it suggested, so the owner
  // sees the first search arrive after pasting the setup.
  router.get("/companies/:companyId/memory/connections/:agentId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    personCaller(req, companyId);
    await gateway.assertEnabled(companyId);
    const { agentId, connection } = await loadManaged(req, companyId);
    const [operations, contributions] = await Promise.all([
      db
        .select({
          id: memoryOperations.id,
          operation: memoryOperations.operation,
          outcome: memoryOperations.outcome,
          recordId: memoryOperations.recordId,
          createdAt: memoryOperations.createdAt,
        })
        .from(memoryOperations)
        .where(and(eq(memoryOperations.companyId, companyId), eq(memoryOperations.agentId, agentId)))
        .orderBy(desc(memoryOperations.createdAt))
        .limit(20),
      db
        .select({ id: memoryRecords.id, title: memoryRecords.title, status: memoryRecords.status, createdAt: memoryRecords.createdAt })
        .from(memoryRecords)
        .where(and(eq(memoryRecords.companyId, companyId), eq(memoryRecords.contributorAgentId, agentId), isNull(memoryRecords.deletedAt)))
        .orderBy(desc(memoryRecords.createdAt))
        .limit(20),
    ]);
    const lastUsedAt =
      connection.keys
        .map((key) => key.lastUsedAt)
        .filter((value): value is Date => value instanceof Date)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const body: MemoryConnectionActivity = { lastUsedAt, operations, contributions };
    res.json(body);
  });

  router.delete("/companies/:companyId/memory/connections/:agentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const { agentId, connection } = await loadManaged(req, companyId);
    for (const key of connection.keys) await agentsSvc.revokeKey(agentId, key.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "memory.connection_revoked",
      entityType: "agent",
      entityId: agentId,
      details: { app: connection.app, keyIds: connection.keys.map((key) => key.id) },
    });
    res.json({ ok: true });
  });

  return router;
}
