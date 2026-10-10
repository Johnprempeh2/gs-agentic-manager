import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { activityLog, agents, authUsers, pipelines, principalPermissionGrants } from "@greatstone/db";
import {
  PIPELINE_ADMIN_PERMISSION_KEY,
  PIPELINE_CASES_PERMISSION_KEY,
  pipelineAccessGrantScope,
  pipelineAccessLevelFor,
  pipelineAllPipelinesLevel,
  pipelinesTouchedByAccessChange,
  planPipelineLevelChange,
  resolvePipelineAccess,
  type PipelineAccess,
  type PipelineAccessLastChange,
  type PipelineAccessLevel,
  type PipelineAccessMatrix,
  type PipelineGrantScopeState,
} from "@greatstone/shared";
import { unprocessable } from "../errors.js";
import { accessService } from "./access.js";

/**
 * Sets an agent's pipeline access level (GRE-1072). One level and one scope
 * per agent: View clears both grants, Work cases holds pipelines:cases,
 * Administer holds pipelines:write (which covers Work cases on its own).
 * Picked pipelines must belong to the agent's company.
 */
export async function setAgentPipelineAccess(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    access: PipelineAccess;
    grantedByUserId: string | null;
  },
): Promise<{ before: PipelineAccess; after: PipelineAccess }> {
  const access = accessService(db);
  const pipelineIds = input.access.level === "view" ? null : input.access.pipelineIds;

  if (pipelineIds && pipelineIds.length > 0) {
    const unique = [...new Set(pipelineIds)];
    const found = await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(eq(pipelines.companyId, input.companyId), inArray(pipelines.id, unique)));
    if (found.length !== unique.length) {
      throw unprocessable("One or more pipelines were not found in this company", { code: "pipeline_not_found" });
    }
  }

  const before = resolvePipelineAccess(
    await access.listPrincipalGrants(input.companyId, "agent", input.agentId),
  );
  const scope = pipelineAccessGrantScope(pipelineIds);
  await access.setPrincipalPermission(
    input.companyId,
    "agent",
    input.agentId,
    PIPELINE_CASES_PERMISSION_KEY,
    input.access.level === "work_cases",
    input.grantedByUserId,
    scope,
  );
  await access.setPrincipalPermission(
    input.companyId,
    "agent",
    input.agentId,
    PIPELINE_ADMIN_PERMISSION_KEY,
    input.access.level === "administer",
    input.grantedByUserId,
    scope,
  );
  const after = resolvePipelineAccess(
    await access.listPrincipalGrants(input.companyId, "agent", input.agentId),
  );
  return { before, after };
}

export const PIPELINE_ACCESS_UPDATED_ACTION = "agent.pipeline_access_updated";

function writeGrantState(
  access: ReturnType<typeof accessService>,
  input: { companyId: string; agentId: string; grantedByUserId: string | null },
  permissionKey: typeof PIPELINE_CASES_PERMISSION_KEY | typeof PIPELINE_ADMIN_PERMISSION_KEY,
  state: PipelineGrantScopeState,
) {
  return access.setPrincipalPermission(
    input.companyId,
    "agent",
    input.agentId,
    permissionKey,
    state.granted,
    input.grantedByUserId,
    state.granted ? pipelineAccessGrantScope(state.pipelineIds) : null,
  );
}

/**
 * Sets an agent's level on one pipeline (GRE-1073). Other pipelines keep
 * their level; see planPipelineLevelChange for how the two grants change.
 */
export async function setAgentPipelineLevel(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    pipelineId: string;
    level: PipelineAccessLevel;
    grantedByUserId: string | null;
  },
): Promise<{ before: PipelineAccessLevel; after: PipelineAccessLevel }> {
  const access = accessService(db);
  const companyPipelineIds = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.companyId, input.companyId))
    .then((rows) => rows.map((row) => row.id));
  if (!companyPipelineIds.includes(input.pipelineId)) {
    throw unprocessable("Pipeline was not found in this company", { code: "pipeline_not_found" });
  }

  const grants = await access.listPrincipalGrants(input.companyId, "agent", input.agentId);
  const before = pipelineAccessLevelFor(grants, input.pipelineId);
  const plan = planPipelineLevelChange(grants, input.pipelineId, input.level, companyPipelineIds);
  await writeGrantState(access, input, PIPELINE_CASES_PERMISSION_KEY, plan.cases);
  await writeGrantState(access, input, PIPELINE_ADMIN_PERMISSION_KEY, plan.write);
  const after = pipelineAccessLevelFor(
    await access.listPrincipalGrants(input.companyId, "agent", input.agentId),
    input.pipelineId,
  );
  return { before, after };
}

/**
 * Sets one level on all pipelines (GRE-1073) and reports which pipelines
 * changed level, read per pipeline so mixed grants are not lost. The activity
 * log stores the list so each grant's last change can be shown.
 */
export async function setAgentAllPipelinesLevel(
  db: Db,
  input: { companyId: string; agentId: string; level: PipelineAccessLevel; grantedByUserId: string | null },
): Promise<{ before: PipelineAccess; after: PipelineAccess; changedPipelineIds: string[] }> {
  const access = accessService(db);
  const companyPipelineIds = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.companyId, input.companyId))
    .then((rows) => rows.map((row) => row.id));
  const levelsNow = async () => {
    const grants = await access.listPrincipalGrants(input.companyId, "agent", input.agentId);
    return new Map(companyPipelineIds.map((id) => [id, pipelineAccessLevelFor(grants, id)]));
  };
  const beforeLevels = await levelsNow();
  const change = await setAgentPipelineAccess(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    access: { level: input.level, pipelineIds: null },
    grantedByUserId: input.grantedByUserId,
  });
  const afterLevels = await levelsNow();
  return {
    ...change,
    changedPipelineIds: companyPipelineIds.filter((id) => beforeLevels.get(id) !== afterLevels.get(id)),
  };
}

/**
 * Agent × pipeline access for a company (GRE-1073), read from the same
 * grants the authorization service checks. Last change comes from the
 * activity log so removed grants are covered too: per agent, and per
 * pipeline from the newest entry that touched that pipeline.
 */
export async function loadPipelineAccessMatrix(
  db: Db,
  companyId: string,
): Promise<Pick<PipelineAccessMatrix, "pipelines" | "agents">> {
  const [pipelineRows, agentRows, grantRows, changeRows] = await Promise.all([
    db
      .select({ id: pipelines.id, name: pipelines.name, archivedAt: pipelines.archivedAt })
      .from(pipelines)
      .where(eq(pipelines.companyId, companyId))
      .orderBy(asc(pipelines.createdAt)),
    db
      .select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")))
      .orderBy(asc(agents.name)),
    db
      .select({
        principalId: principalPermissionGrants.principalId,
        permissionKey: principalPermissionGrants.permissionKey,
        scope: principalPermissionGrants.scope,
      })
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, companyId),
        eq(principalPermissionGrants.principalType, "agent"),
        inArray(principalPermissionGrants.permissionKey, [PIPELINE_CASES_PERMISSION_KEY, PIPELINE_ADMIN_PERMISSION_KEY]),
      )),
    db
      .select({
        agentId: activityLog.entityId,
        at: activityLog.createdAt,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        actorName: authUsers.name,
        details: activityLog.details,
      })
      .from(activityLog)
      .leftJoin(authUsers, eq(authUsers.id, activityLog.actorId))
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "agent"),
        eq(activityLog.action, PIPELINE_ACCESS_UPDATED_ACTION),
      ))
      .orderBy(desc(activityLog.createdAt)),
  ]);

  const grantsByAgent = new Map<string, typeof grantRows>();
  for (const row of grantRows) {
    const list = grantsByAgent.get(row.principalId) ?? [];
    list.push(row);
    grantsByAgent.set(row.principalId, list);
  }
  const pipelineIds = pipelineRows.map((row) => row.id);
  // Rows are newest first, so the first entry seen for an agent or a cell wins.
  const changeByAgent = new Map<string, PipelineAccessLastChange>();
  const changeByCell = new Map<string, PipelineAccessLastChange>();
  for (const row of changeRows) {
    const change: PipelineAccessLastChange = {
      at: row.at.toISOString(),
      actorType: row.actorType,
      actorId: row.actorId,
      actorName: row.actorName ?? null,
    };
    if (!changeByAgent.has(row.agentId)) changeByAgent.set(row.agentId, change);
    for (const pipelineId of pipelinesTouchedByAccessChange(row.details, pipelineIds)) {
      const key = `${row.agentId}:${pipelineId}`;
      if (!changeByCell.has(key)) changeByCell.set(key, change);
    }
  }

  return {
    pipelines: pipelineRows.map((row) => ({
      id: row.id,
      name: row.name,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    })),
    agents: agentRows.map((agent) => {
      const grants = grantsByAgent.get(agent.id) ?? [];
      return {
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        levels: Object.fromEntries(pipelineRows.map((pipeline) => [pipeline.id, pipelineAccessLevelFor(grants, pipeline.id)])),
        allPipelinesLevel: pipelineAllPipelinesLevel(grants),
        lastChange: changeByAgent.get(agent.id) ?? null,
        lastChanges: Object.fromEntries(
          pipelineIds.map((pipelineId) => [pipelineId, changeByCell.get(`${agent.id}:${pipelineId}`) ?? null]),
        ),
      };
    }),
  };
}
