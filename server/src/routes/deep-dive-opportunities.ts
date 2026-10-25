import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import {
  createDeepDiveBuildSchema,
  createDeepDiveKpiSchema,
  createDeepDiveOpportunitySchema,
  updateDeepDiveBuildSchema,
  updateDeepDiveKpiSchema,
  updateDeepDiveOpportunitySchema,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import {
  deepDiveOpportunitiesService,
  type DeepDiveOpportunityActor,
  type DeepDiveOpportunityKind,
} from "../services/deep-dive-opportunities.js";
import { assertEntitled } from "../services/entitlements.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// Deep Dive opportunities and KPIs (GRE-2370): Screen 7 of the GRE-2327 plan.
// Anyone with access to the company may record them; only a person shares an
// item or validates an opportunity. Every write answers with the whole board.

function opportunityActor(req: Request): DeepDiveOpportunityActor {
  const actor = getActorInfo(req);
  return actor.actorType === "user" ? { type: "user", userId: actor.actorId } : { type: "agent", agentId: actor.agentId };
}

export function deepDiveOpportunitiesRoutes(db: Db) {
  const router = Router();
  const opportunities = deepDiveOpportunitiesService(db);
  const settings = instanceSettingsService(db);

  async function assertEnabled() {
    await assertEntitled(settings, "enableCases");
    await assertEntitled(settings, "enableDeepDive");
  }

  async function companyInScope(req: Request) {
    await assertEnabled();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  async function itemInScope(req: Request, kind: DeepDiveOpportunityKind, param: string) {
    await assertEnabled();
    const companyId = await opportunities.companyOf(kind, req.params[param] as string);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  async function log(req: Request, companyId: string, action: string, entityId: string, details: Record<string, unknown> = {}) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "deep_dive_opportunity",
      entityId,
      details,
    });
  }

  function changed(req: Request) {
    return { changed: Object.keys(req.body ?? {}) };
  }

  function reply(res: Response, status: number, board: unknown) {
    res.status(status).json(board);
  }

  router.get("/companies/:companyId/deep-dive/opportunities", async (req, res) => {
    const companyId = await companyInScope(req);
    res.json(await opportunities.board(companyId));
  });

  router.post("/companies/:companyId/deep-dive/opportunities", validate(createDeepDiveOpportunitySchema), async (req, res) => {
    const companyId = await companyInScope(req);
    const board = await opportunities.createOpportunity(companyId, req.body, opportunityActor(req));
    await log(req, companyId, "deep_dive_opportunity.opportunity_added", companyId, { name: req.body.name });
    reply(res, 201, board);
  });

  router.patch("/deep-dive/opportunities/:opportunityId", validate(updateDeepDiveOpportunitySchema), async (req, res) => {
    const companyId = await itemInScope(req, "opportunity", "opportunityId");
    const board = await opportunities.updateOpportunity(req.params.opportunityId as string, req.body, opportunityActor(req));
    await log(req, companyId, "deep_dive_opportunity.opportunity_changed", req.params.opportunityId as string, changed(req));
    reply(res, 200, board);
  });

  router.delete("/deep-dive/opportunities/:opportunityId", async (req, res) => {
    const companyId = await itemInScope(req, "opportunity", "opportunityId");
    const board = await opportunities.deleteOpportunity(req.params.opportunityId as string);
    await log(req, companyId, "deep_dive_opportunity.opportunity_removed", req.params.opportunityId as string);
    reply(res, 200, board);
  });

  router.post("/companies/:companyId/deep-dive/builds", validate(createDeepDiveBuildSchema), async (req, res) => {
    const companyId = await companyInScope(req);
    const board = await opportunities.createBuild(companyId, req.body);
    await log(req, companyId, "deep_dive_opportunity.build_added", companyId, { name: req.body.name });
    reply(res, 201, board);
  });

  router.patch("/deep-dive/builds/:buildId", validate(updateDeepDiveBuildSchema), async (req, res) => {
    const companyId = await itemInScope(req, "build", "buildId");
    const board = await opportunities.updateBuild(req.params.buildId as string, req.body, opportunityActor(req));
    await log(req, companyId, "deep_dive_opportunity.build_changed", req.params.buildId as string, changed(req));
    reply(res, 200, board);
  });

  router.delete("/deep-dive/builds/:buildId", async (req, res) => {
    const companyId = await itemInScope(req, "build", "buildId");
    const board = await opportunities.deleteBuild(req.params.buildId as string);
    await log(req, companyId, "deep_dive_opportunity.build_removed", req.params.buildId as string);
    reply(res, 200, board);
  });

  router.post("/companies/:companyId/deep-dive/kpis", validate(createDeepDiveKpiSchema), async (req, res) => {
    const companyId = await companyInScope(req);
    const board = await opportunities.createKpi(companyId, req.body);
    await log(req, companyId, "deep_dive_opportunity.kpi_added", companyId, { name: req.body.name });
    reply(res, 201, board);
  });

  router.patch("/deep-dive/kpis/:kpiId", validate(updateDeepDiveKpiSchema), async (req, res) => {
    const companyId = await itemInScope(req, "kpi", "kpiId");
    const board = await opportunities.updateKpi(req.params.kpiId as string, req.body, opportunityActor(req));
    await log(req, companyId, "deep_dive_opportunity.kpi_changed", req.params.kpiId as string, changed(req));
    reply(res, 200, board);
  });

  router.delete("/deep-dive/kpis/:kpiId", async (req, res) => {
    const companyId = await itemInScope(req, "kpi", "kpiId");
    const board = await opportunities.deleteKpi(req.params.kpiId as string);
    await log(req, companyId, "deep_dive_opportunity.kpi_removed", req.params.kpiId as string);
    reply(res, 200, board);
  });

  return router;
}
