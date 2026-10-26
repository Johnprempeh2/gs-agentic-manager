import { and, eq, inArray } from "drizzle-orm";
import { agents, projects, type Db } from "@greatstone/db";
import { trustAuthorizationPolicySchema } from "@greatstone/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import { accessService } from "./access.js";
import type { AuthorizationActor } from "./authorization.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

export async function readAgentProjectAccess(db: Db, actor: AuthorizationActor, companyId: string, agentId: string) {
  const [agent] = await db.select({ permissions: agents.permissions, status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
  if (!agent) throw notFound("Agent not found");
  const decision = await accessService(db).decide({ actor, action: "agents:create", resource: { type: "company", companyId } });
  const permissions = normalizeAgentPermissions(agent.permissions);
  const parsed = trustAuthorizationPolicySchema.safeParse(permissions.authorizationPolicy ?? {});
  const boundary = parsed.success ? parsed.data.trustBoundary : undefined;
  return {
    projectIds: boundary?.projectIds ?? [],
    canManage: actor.type === "board" && decision.allowed && agent.status !== "pending_approval"
      && parsed.success && permissions.trustPreset === "low_trust_review"
      && (!boundary || (!boundary.companyId || boundary.companyId === companyId)),
  };
}

/** The row lock makes concurrent additions additive, never a stale policy replacement. */
export async function addAgentProjectAccess(db: Db, actor: AuthorizationActor, companyId: string, agentId: string, projectIds: string[]) {
  if (actor.type !== "board") throw forbidden("Board access required");
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async tx => {
    const [agent] = await tx.select().from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("update");
    if (!agent) throw notFound("Agent not found");
    const transactionDb = tx as unknown as Db;
    const access = accessService(transactionDb);
    const decision = await access.decide({ actor, action: "agents:create", resource: { type: "company", companyId } });
    if (!decision.allowed) throw forbidden(decision.explanation);
    if (agent.status === "pending_approval") throw conflict("Pending approval agent permissions cannot be changed before board approval");
    const permissions = normalizeAgentPermissions(agent.permissions);
    const parsed = trustAuthorizationPolicySchema.safeParse(permissions.authorizationPolicy ?? {});
    if (!parsed.success) throw conflict("The agent trust settings need review before adding project access");
    const policy = parsed.data;
    const boundary = policy.trustBoundary;
    if (permissions.trustPreset !== "low_trust_review" || (boundary && (boundary.mode !== "low_trust_review"
      || (boundary.companyId && boundary.companyId !== companyId)))) {
      throw conflict("The agent trust settings changed. Refresh before adding project access");
    }
    const requested = [...new Set(projectIds)];
    const rows = await tx.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.companyId, companyId), inArray(projects.id, requested)));
    if (rows.length !== requested.length) throw notFound("A selected project is unavailable");
    for (const project of rows) {
      const projectDecision = await access.decide({ actor, action: "project:read", resource: { type: "project", companyId, projectId: project.id } });
      if (!projectDecision.allowed) throw forbidden("A selected project is unavailable");
    }
    const previous = boundary?.projectIds ?? [];
    const added = requested.filter(id => !previous.includes(id));
    const next = [...previous, ...added];
    if (added.length) {
      await tx.update(agents).set({ permissions: { ...agent.permissions, authorizationPolicy: {
        ...policy, trustBoundary: { ...boundary, mode: "low_trust_review", companyId, projectIds: next },
      } }, updatedAt: new Date() }).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
      await logActivity(transactionDb, { companyId, actorType: "user", actorId: actor.userId ?? "local-board",
        action: "agent.project_access_added", entityType: "agent", entityId: agentId,
        details: { addedProjectIds: added } }, publications);
    }
    return { projectIds: next, canManage: true };
  });
  for (const publication of publications) publishActivity(publication);
  return result;
}
