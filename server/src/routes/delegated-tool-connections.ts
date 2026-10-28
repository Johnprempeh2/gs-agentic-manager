import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agentApiKeys, agents, authUsers, companyMemberships, connectionGrants, issues, projects, toolConnections } from "@greatstone/db";
import { delegatedToolConnectionConfigureSchema, delegatedToolConnectionCreateSchema, isRemoteMcpConnectorMethod, isUuidLike, type DelegatedToolConnectionCreate } from "@greatstone/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { authorizationService } from "../services/authorization.js";
import { captureRunIdentity } from "../services/run-identity.js";
import { resolveCoreTrustPreset } from "../services/trust-preset-resolver.js";
import { logActivity, type toolAccessService } from "../services/index.js";
import { getActorInfo } from "./authz.js";

type Operation = "create" | "read" | "configure" | "reconnect" | "install";

/** This route is deliberately smaller than the board connection wizard. */
export function delegatedToolConnectionRoutes(db: Db, svc: ReturnType<typeof toolAccessService>) {
  const router = Router();
  const authz = authorizationService(db);

  async function authorize(req: Request, operation: Operation, input: {
    connectionId?: string;
    provider?: string;
    targetAgentId?: string;
  }) {
    const actor = req.actor;
    if (actor.type !== "agent" || !actor.agentId || !actor.companyId || !actor.runId || !actor.onBehalfOfUserId) {
      throw forbidden("An active assigned agent run and responsible user are required");
    }
    if (actor.keyScope && actor.keyScope.kind !== "standard") throw forbidden("A standard agent key is required");
    const companyId = actor.companyId;
    const userId = actor.onBehalfOfUserId;
    const [agent, activeUser, agentMembership, userMembership] = await Promise.all([
      db.select().from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId))).then(rows => rows[0]),
      db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId)).then(rows => rows[0]),
      db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "agent"), eq(companyMemberships.principalId, actor.agentId), eq(companyMemberships.status, "active"))).then(rows => rows[0]),
      db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))).then(rows => rows[0]),
    ]);
    if (!agent || !activeUser || ["terminated", "paused", "pending_approval"].includes(agent.status) || !agentMembership || !userMembership || userMembership.membershipRole === "viewer") {
      throw forbidden("Active agent and responsible-user membership are required");
    }
    if (actor.keyId) {
      const [key] = await db.select().from(agentApiKeys).where(and(eq(agentApiKeys.id, actor.keyId), eq(agentApiKeys.agentId, actor.agentId), eq(agentApiKeys.companyId, companyId)));
      if (!key || key.revokedAt || key.responsibleUserId !== userId || (key.scopeConfig && key.scopeConfig.kind !== "standard")) throw forbidden("Agent key authority has changed");
    }
    const { run, context } = await captureRunIdentity(db, { companyId, agentId: actor.agentId, runId: actor.runId });
    if ((context?.responsibleUserId ?? run.responsibleUserId) !== userId) throw forbidden("Run responsible user has changed");
    const issueId = typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId
      : typeof run.contextSnapshot?.taskId === "string" ? run.contextSnapshot.taskId : null;
    const [issue] = issueId ? await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))) : [];
    if (!issue || issue.assigneeAgentId !== actor.agentId || issue.checkoutRunId !== run.id || issue.workMode !== "standard" || ["cancelled", "done"].includes(issue.status) || run.contextSnapshot?.paperclipSkillTest) {
      throw forbidden("Connection management requires a standard assigned task");
    }
    const [project] = issue.projectId ? await db.select().from(projects).where(and(eq(projects.id, issue.projectId), eq(projects.companyId, companyId))) : [];
    if (resolveCoreTrustPreset({ companyId, agent, project, issue, run }).kind !== "standard") {
      throw forbidden("Low-trust runs cannot manage connections");
    }
    let connection: typeof toolConnections.$inferSelect | undefined;
    let provider = input.provider;
    if (input.connectionId) {
      if (!isUuidLike(input.connectionId)) throw notFound("Tool connection not found");
      [connection] = await db.select().from(toolConnections).where(and(eq(toolConnections.id, input.connectionId), eq(toolConnections.companyId, companyId)));
      if (!connection) throw notFound("Tool connection not found");
      if (connection.connectionPurpose !== "tool" || connection.credentialPolicy !== "per_user") throw forbidden("Only personal tool connections are available");
      const [personalGrant] = await db.select({ id: connectionGrants.id }).from(connectionGrants).where(and(
        eq(connectionGrants.companyId, companyId), eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "user"), eq(connectionGrants.subjectUserId, userId), eq(connectionGrants.status, "active"),
      ));
      if (connection.createdByUserId !== userId && !personalGrant) throw forbidden("Personal connection is unavailable to the responsible user");
      provider = typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey
        : typeof connection.config.provider === "string" ? connection.config.provider
          : typeof connection.transportConfig.sourceTemplateKey === "string" ? connection.transportConfig.sourceTemplateKey : undefined;
    }
    const scope = { ...(connection ? { connectionId: connection.id } : {}), provider, purpose: "tool", operation, ...(input.targetAgentId ? { targetAgentId: input.targetAgentId } : {}) };
    const agentDecision = await authz.decide({ actor, action: "tools:manage_connections", resource: { type: "company", companyId }, scope });
    if (!agentDecision.allowed) throw forbidden(agentDecision.explanation);
    // Enforce the human intersection directly even if the instance is running
    // the general responsible-user evaluator in shadow mode.
    const human = { type: "board" as const, userId, source: "session" as const, companyIds: [companyId], memberships: [userMembership], ignoreInstanceAdmin: true };
    const userDecision = await authz.decide({ actor: human, action: "tools:manage_connections", resource: { type: "company", companyId }, scope });
    if (!userDecision.allowed) throw forbidden(userDecision.explanation);
    if (input.targetAgentId) {
      if (!isUuidLike(input.targetAgentId)) throw notFound("Target agent not found");
      const [target] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.targetAgentId), eq(agents.companyId, companyId)));
      if (!target) throw notFound("Target agent not found");
      for (const principal of [actor, human]) {
        const decision = await authz.decide({ actor: principal, action: "agent_config:update", resource: { type: "agent", companyId, agentId: target.id } });
        if (!decision.allowed) throw forbidden(decision.explanation);
      }
    }
    return { companyId, userId, agentId: actor.agentId, connection };
  }

  router.post("/agents/me/tool-connections", validate(delegatedToolConnectionCreateSchema), async (req, res) => {
    const { galleryKey, connectionMethodKey, name, link } = req.body as DelegatedToolConnectionCreate;
    if (!isRemoteMcpConnectorMethod(galleryKey, connectionMethodKey)) throw forbidden("Delegated creation supports saved remote MCP drafts only");
    const endpoint = new URL(link);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/mcp") {
      throw forbidden("Delegated drafts require a credential-free HTTPS MCP endpoint");
    }
    const authorized = await authorize(req, "create", { provider: galleryKey });
    const result = await svc.connectGalleryApp(authorized.companyId, { galleryKey, connectionMethodKey, name, link, grantKind: "user", saveDraft: true }, {
      ...getActorInfo(req), responsibleUserId: authorized.userId,
      reauthorize: async (retainedConnectionId) => { await authorize(req, "create", { provider: galleryKey, connectionId: retainedConnectionId }); },
    });
    await authorize(req, "create", { connectionId: result.connectionId });
    await logActivity(db, { companyId: authorized.companyId, actorType: "agent", actorId: authorized.agentId,
      action: "tool_connection.delegated_created", entityType: "tool_connection", entityId: result.connectionId,
      details: { provider: galleryKey, responsibleUserId: authorized.userId } });
    res.status(201).json({ connectionId: result.connectionId, name: result.connection.name, status: result.connection.status,
      requiredUserAction: { userId: authorized.userId, setupPath: `/apps/connect?source=${encodeURIComponent(galleryKey)}&resume=${encodeURIComponent(result.connectionId)}`, reason: "The responsible user must finish authentication and credential entry." } });
  });

  router.get("/agents/me/tool-connections/:connectionId", async (req, res) => {
    const { connection } = await authorize(req, "read", { connectionId: String(req.params.connectionId) });
    res.json({ id: connection!.id, name: connection!.name, status: connection!.status, enabled: connection!.enabled,
      provider: connection!.config.sourceTemplateKey ?? null, credentialPolicy: connection!.credentialPolicy });
  });

  router.patch("/agents/me/tool-connections/:connectionId", validate(delegatedToolConnectionConfigureSchema), async (req, res) => {
    const id = String(req.params.connectionId);
    const authorized = await authorize(req, "configure", { connectionId: id });
    await authorize(req, "configure", { connectionId: id });
    const connection = await svc.updateConnection(id, { name: req.body.name });
    await logActivity(db, { companyId: authorized.companyId, actorType: "agent", actorId: authorized.agentId,
      action: "tool_connection.delegated_configured", entityType: "tool_connection", entityId: id, details: { name: connection.name } });
    res.json({ id: connection.id, name: connection.name, status: connection.status });
  });

  router.post("/agents/me/tool-connections/:connectionId/reconnect", async (req, res) => {
    const id = String(req.params.connectionId);
    const { userId } = await authorize(req, "reconnect", { connectionId: id });
    res.json({ requiredUserAction: { userId, setupPath: `/apps/${encodeURIComponent(id)}/permissions`, reason: "The responsible user must reconnect this personal account." } });
  });

  router.post("/agents/me/tool-connections/:connectionId/installs/:targetAgentId", async (req, res) => {
    const id = String(req.params.connectionId);
    const targetAgentId = String(req.params.targetAgentId);
    const authorized = await authorize(req, "install", { connectionId: id, targetAgentId });
    await authorize(req, "install", { connectionId: id, targetAgentId });
    await svc.putConnectionInstalls(id, { installs: [{ targetType: "agent", targetId: targetAgentId }] }, getActorInfo(req), { additionsOnly: true });
    await logActivity(db, { companyId: authorized.companyId, actorType: "agent", actorId: authorized.agentId,
      action: "tool_connection.delegated_installed", entityType: "tool_connection", entityId: id, details: { targetAgentId } });
    res.json({ connectionId: id, targetAgentId });
  });
  return router;
}
