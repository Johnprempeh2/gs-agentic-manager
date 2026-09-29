import { Router } from "express";
import type { Db } from "@greatstone/db";
import { createGoalCheckInSchema, createGoalSchema, updateGoalSchema } from "@greatstone/shared";
import { trackGoalCreated } from "@greatstone/shared/telemetry";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { goalService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";

export function goalRoutes(db: Db) {
  const router = Router();
  const svc = goalService(db);

  router.get("/companies/:companyId/goals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listWithProgress(companyId);
    res.json(result);
  });

  router.get("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const goal = await getAccessibleResource(req, res, svc.getDetail(id), "Goal not found");
    if (!goal) return;
    res.json(goal);
  });

  router.get("/goals/:id/check-ins", async (req, res) => {
    const id = req.params.id as string;
    const goal = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
    if (!goal) return;
    res.json(await svc.listCheckIns(goal.id));
  });

  router.post("/goals/:id/check-ins", validate(createGoalCheckInSchema), async (req, res) => {
    const id = req.params.id as string;
    const goal = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
    if (!goal) return;
    const actor = getActorInfo(req);
    // Agents check in on goals they own; the lead agent may check in on any
    // goal. Board users are not limited.
    if (actor.actorType === "agent") {
      const isOwner = actor.agentId != null && actor.agentId === goal.ownerAgentId;
      const isLead = !isOwner
        && actor.agentId != null
        && actor.agentId === (await svc.getCompanyLeadAgentId(goal.companyId));
      if (!isOwner && !isLead) {
        throw forbidden("Only the goal owner or the lead agent may post a check-in");
      }
    }
    const checkIn = await svc.createCheckIn(goal, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.check_in_created",
      entityType: "goal",
      entityId: goal.id,
      details: { checkInId: checkIn.id, progressPercent: checkIn.progressPercent },
    });
    res.status(201).json(checkIn);
  });

  router.post("/companies/:companyId/goals", validate(createGoalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const goal = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      details: { title: goal.title },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackGoalCreated(telemetryClient, { goalLevel: goal.level });
    }
    res.status(201).json(goal);
  });

  router.patch("/goals/:id", validate(updateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
    if (!existing) return;
    const goal = await svc.update(id, req.body);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.updated",
      entityType: "goal",
      entityId: goal.id,
      details: req.body,
    });

    res.json(goal);
  });

  router.delete("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
    if (!existing) return;
    const goal = await svc.remove(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.deleted",
      entityType: "goal",
      entityId: goal.id,
    });

    res.json(goal);
  });

  return router;
}
