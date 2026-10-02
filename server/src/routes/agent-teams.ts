import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import {
  addAgentTeamMemberSchema,
  createAgentTeamSchema,
  updateAgentTeamSchema,
  type AgentTeam,
} from "@greatstone/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, agentTeamService, logActivity } from "../services/index.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

// Agent teams (GRE-436). Anyone with company access may read teams; changing
// them needs the same `agents:create` grant as hiring and re-organising agents.
export function agentTeamRoutes(db: Db) {
  const router = Router();
  const svc = agentTeamService(db);
  const access = accessService(db);

  async function assertCanManageTeams(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
  }

  async function loadTeamForWrite(req: Request, res: Response): Promise<AgentTeam | null> {
    const team = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Team not found");
    if (!team) return null;
    await assertCanManageTeams(req, team.companyId);
    return team;
  }

  async function logTeamActivity(req: Request, team: { id: string; companyId: string }, action: string, details?: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: team.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "agent_team",
      entityId: team.id,
      details,
    });
  }

  router.get("/companies/:companyId/agent-teams", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.post("/companies/:companyId/agent-teams", validate(createAgentTeamSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManageTeams(req, companyId);
    const team = await svc.create(companyId, req.body);
    await logTeamActivity(req, team, "agent_team.created", { name: team.name });
    res.status(201).json(team);
  });

  router.get("/agent-teams/:id", async (req, res) => {
    const team = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Team not found");
    if (!team) return;
    res.json(team);
  });

  router.patch("/agent-teams/:id", validate(updateAgentTeamSchema), async (req, res) => {
    const existing = await loadTeamForWrite(req, res);
    if (!existing) return;
    const team = await svc.update(existing, req.body);
    await logTeamActivity(req, team, "agent_team.updated", req.body);
    res.json(team);
  });

  router.delete("/agent-teams/:id", async (req, res) => {
    const existing = await loadTeamForWrite(req, res);
    if (!existing) return;
    const removed = await svc.remove(existing.id);
    if (!removed) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    await logTeamActivity(req, removed, "agent_team.deleted", { name: removed.name });
    res.json(removed);
  });

  router.post("/agent-teams/:id/members", validate(addAgentTeamMemberSchema), async (req, res) => {
    const existing = await loadTeamForWrite(req, res);
    if (!existing) return;
    const team = await svc.addMember(existing, req.body.agentId);
    await logTeamActivity(req, team, "agent_team.member_added", { agentId: req.body.agentId });
    res.json(team);
  });

  router.delete("/agent-teams/:id/members/:agentId", async (req, res) => {
    const existing = await loadTeamForWrite(req, res);
    if (!existing) return;
    const agentId = req.params.agentId as string;
    const team = await svc.removeMember(existing, agentId);
    await logTeamActivity(req, team, "agent_team.member_removed", { agentId });
    res.json(team);
  });

  return router;
}
