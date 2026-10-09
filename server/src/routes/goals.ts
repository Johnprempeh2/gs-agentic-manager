import { Router, type Request } from "express";
import type { Db } from "@greatstone/db";
import {
  createGoalCheckInSchema,
  createGoalKpiReadingSchema,
  createGoalSchema,
  isBoardGoalKind,
  updateGoalSchema,
  type KpiReadingSource,
} from "@greatstone/shared";
import { trackGoalCreated } from "@greatstone/shared/telemetry";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { goalService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyBoardRole } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";

export const BOARD_LAYER_REQUIRED_MESSAGE =
  "Only board members (company owners) may edit the vision, values and critical success factors";

/**
 * Layer rights, one role check: the board layers (vision, value, csf) need a
 * company owner. Pillars and below keep the normal write rules, so company
 * admins (Exco), operators and agents may edit them.
 */
function assertMayEditGoalKinds(req: Request, companyId: string, ...kinds: Array<string | null | undefined>) {
  if (kinds.some((kind) => isBoardGoalKind(kind)) && !hasCompanyBoardRole(req, companyId)) {
    throw forbidden(BOARD_LAYER_REQUIRED_MESSAGE, { code: "board_layer_required" });
  }
}

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

  router.get("/goals/:id/readings", async (req, res) => {
    const id = req.params.id as string;
    const goal = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
    if (!goal) return;
    res.json(await svc.listReadings(goal.id));
  });

  /**
   * Records a KPI reading. Source rules, so an owner cannot mark their own
   * number as checked:
   * - owner_reported: any board user, the owner agent or the lead agent.
   * - agent_verified / system: agents only, and not the KPI's owner agent.
   */
  router.post("/goals/:id/readings", validate(createGoalKpiReadingSchema), async (req, res) => {
    const id = req.params.id as string;
    const goal = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
    if (!goal) return;
    if (goal.kind !== "kpi") throw unprocessable("Readings can only be recorded on a KPI goal");
    const actor = getActorInfo(req);
    const source = req.body.source as KpiReadingSource;
    if (source === "owner_reported") {
      if (actor.actorType === "agent") {
        const isOwner = actor.agentId != null && actor.agentId === goal.ownerAgentId;
        const isLead = !isOwner
          && actor.agentId != null
          && actor.agentId === (await svc.getCompanyLeadAgentId(goal.companyId));
        if (!isOwner && !isLead) {
          throw forbidden("Only the KPI owner or the lead agent may post an owner-reported reading", {
            code: "kpi_reading_not_owner",
          });
        }
      }
    } else if (actor.actorType !== "agent") {
      throw forbidden("Only an agent that checked the data may post a verified or system reading", {
        code: "kpi_reading_agent_only",
      });
    } else if (actor.agentId != null && actor.agentId === goal.ownerAgentId) {
      throw forbidden("The KPI owner cannot verify its own reading; another agent must check it", {
        code: "kpi_reading_self_verify",
      });
    }
    const reading = await svc.createReading(goal, req.body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.kpi_reading_recorded",
      entityType: "goal",
      entityId: goal.id,
      details: { readingId: reading.id, value: reading.value, readingDate: reading.readingDate, source: reading.source },
    });
    res.status(201).json(reading);
  });

  router.post("/companies/:companyId/goals", validate(createGoalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertMayEditGoalKinds(req, companyId, req.body.kind);
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

  // One click: the empty one-page strategic plan (vision, values, CSF, objective, KPI).
  // It creates board layers, so it needs a board member like any vision edit.
  router.post("/companies/:companyId/goals/strategic-plan", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertMayEditGoalKinds(req, companyId, "vision");
    const created = await svc.createStrategicPlan(companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.strategic_plan_created",
      entityType: "goal",
      entityId: created[0].id,
      details: { goalIds: created.map((goal) => goal.id) },
    });
    res.status(201).json(created);
  });

  router.patch("/goals/:id", validate(updateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
    if (!existing) return;
    assertMayEditGoalKinds(req, existing.companyId, existing.kind, req.body.kind);
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
    assertMayEditGoalKinds(req, existing.companyId, existing.kind);
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
