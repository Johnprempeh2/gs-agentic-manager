import { Router, type Request } from "express";
import { and, eq, isNull, ne } from "drizzle-orm";
import { agentApiKeys, agents, principalPermissionGrants, type Db } from "@greatstone/db";
import {
  createMemoryConnectionSchema,
  MEMORY_CONNECTION_APP_LABEL,
  MEMORY_CONNECTION_APPS,
  normalizeAgentApiKeyScope,
  type CreateMemoryConnection,
  type CreatedMemoryConnection,
  type MemoryConnection,
  type MemoryConnectionApp,
} from "@greatstone/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { agentService, logActivity } from "../services/index.js";
import type { MemoryEngine } from "../services/memory-gateway/engine.js";
import { memoryGrantService } from "../services/memory-gateway/grants.js";
import { memoryGatewayService } from "../services/memory-gateway/service.js";
import { assertCompanyOwnerOrAdmin, getActorInfo } from "./authz.js";
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
 * runs, holds those keys and, if asked, a memory contribute grant. Only a
 * company owner or admin signed in as a person manages them; a memory-only
 * key reaches these paths but is refused here.
 */
export function memoryConnectionRoutes(db: Db, options: { engine?: MemoryEngine } = {}) {
  const router = Router();
  const gateway = memoryGatewayService(db, options);
  const grants = memoryGrantService(db, gateway);
  const agentsSvc = agentService(db);

  function ownerCaller(req: Request, companyId: string) {
    const caller = memoryCallerFromRequest(req, companyId);
    if (caller.actorType !== "user") throw forbidden("Only a person can manage memory connections");
    assertCompanyOwnerOrAdmin(req, companyId);
    return caller;
  }

  async function loadConnections(companyId: string, agentId?: string): Promise<MemoryConnection[]> {
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

  router.get("/companies/:companyId/memory/connections", async (req, res) => {
    const companyId = req.params.companyId as string;
    ownerCaller(req, companyId);
    await gateway.assertEnabled(companyId);
    res.json((await loadConnections(companyId)).filter((connection) => connection.keys.length > 0));
  });

  router.post("/companies/:companyId/memory/connections", validate(createMemoryConnectionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = ownerCaller(req, companyId);
    await gateway.assertEnabled(companyId);
    const { app, canContribute } = req.body as CreateMemoryConnection;
    const userId = caller.userId;

    // One link agent per person and app; a new key is added to it each time.
    const existing = (await loadConnections(companyId)).find(
      (connection) => connection.app === app && connection.createdByUserId === userId,
    );
    let agentId = existing?.agentId ?? null;
    if (!agentId) {
      const created = await agentsSvc.create(companyId, {
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
    const key = await agentsSvc.createApiKey(agentId, `${MEMORY_CONNECTION_APP_LABEL[app]} memory`, { kind: "memory_only" }, {
      responsibleUserId: userId,
    });
    if (canContribute && !existing?.canContribute) {
      await grants.change(caller, {
        principalType: "agent",
        principalId: agentId,
        permission: "memory:contribute",
        enabled: true,
        reason: `Set up the ${MEMORY_CONNECTION_APP_LABEL[app]} memory link`,
      });
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "memory.connection_created",
      entityType: "agent",
      entityId: agentId,
      details: { app, keyId: key.id, canContribute },
    });
    const [connection] = await loadConnections(companyId, agentId);
    const body: CreatedMemoryConnection = { connection, token: key.token };
    res.status(201).json(body);
  });

  router.delete("/companies/:companyId/memory/connections/:agentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    ownerCaller(req, companyId);
    const agentId = req.params.agentId as string;
    if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw notFound("Memory connection not found");
    const [connection] = await loadConnections(companyId, agentId);
    if (!connection) throw notFound("Memory connection not found");
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
