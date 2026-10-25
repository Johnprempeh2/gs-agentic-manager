import { Router, type Request } from "express";
import type { Db } from "@greatstone/db";
import {
  createDeepDiveCommercialSchema,
  createDeepDiveRoadmapItemSchema,
  updateDeepDiveCommercialSchema,
  updateDeepDiveRoadmapItemSchema,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import type { DeepDiveOpportunityActor } from "../services/deep-dive-opportunities.js";
import { deepDiveTraceabilityService, type DeepDiveTraceKind } from "../services/deep-dive-traceability.js";
import { assertEntitled } from "../services/entitlements.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// Deep Dive traceability (GRE-2371): Screen 8 of the GRE-2327 plan. GET reads
// the whole chain with its broken links; commercial cases and roadmap items
// are written here. Anyone with access to the company may record them; only a
// person shares one. Every write answers with the whole chain.

function traceActor(req: Request): DeepDiveOpportunityActor {
  const actor = getActorInfo(req);
  return actor.actorType === "user" ? { type: "user", userId: actor.actorId } : { type: "agent", agentId: actor.agentId };
}

export function deepDiveTraceabilityRoutes(db: Db) {
  const router = Router();
  const trace = deepDiveTraceabilityService(db);
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

  async function itemInScope(req: Request, kind: DeepDiveTraceKind, param: string) {
    await assertEnabled();
    const companyId = await trace.companyOf(kind, req.params[param] as string);
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
      entityType: "deep_dive_traceability",
      entityId,
      details,
    });
  }

  const changed = (req: Request) => ({ changed: Object.keys(req.body ?? {}) });

  router.get("/companies/:companyId/deep-dive/traceability", async (req, res) => {
    const companyId = await companyInScope(req);
    res.json(await trace.chain(companyId));
  });

  router.post("/companies/:companyId/deep-dive/commercials", validate(createDeepDiveCommercialSchema), async (req, res) => {
    const companyId = await companyInScope(req);
    const chain = await trace.createCommercial(companyId, req.body);
    await log(req, companyId, "deep_dive_traceability.commercial_added", companyId, { name: req.body.name });
    res.status(201).json(chain);
  });

  router.patch("/deep-dive/commercials/:commercialId", validate(updateDeepDiveCommercialSchema), async (req, res) => {
    const companyId = await itemInScope(req, "commercial", "commercialId");
    const chain = await trace.updateCommercial(req.params.commercialId as string, req.body, traceActor(req));
    await log(req, companyId, "deep_dive_traceability.commercial_changed", req.params.commercialId as string, changed(req));
    res.json(chain);
  });

  router.delete("/deep-dive/commercials/:commercialId", async (req, res) => {
    const companyId = await itemInScope(req, "commercial", "commercialId");
    const chain = await trace.deleteCommercial(req.params.commercialId as string);
    await log(req, companyId, "deep_dive_traceability.commercial_removed", req.params.commercialId as string);
    res.json(chain);
  });

  router.post("/companies/:companyId/deep-dive/roadmap", validate(createDeepDiveRoadmapItemSchema), async (req, res) => {
    const companyId = await companyInScope(req);
    const chain = await trace.createRoadmapItem(companyId, req.body);
    await log(req, companyId, "deep_dive_traceability.roadmap_item_added", companyId, { name: req.body.name });
    res.status(201).json(chain);
  });

  router.patch("/deep-dive/roadmap/:roadmapItemId", validate(updateDeepDiveRoadmapItemSchema), async (req, res) => {
    const companyId = await itemInScope(req, "roadmap", "roadmapItemId");
    const chain = await trace.updateRoadmapItem(req.params.roadmapItemId as string, req.body, traceActor(req));
    await log(req, companyId, "deep_dive_traceability.roadmap_item_changed", req.params.roadmapItemId as string, changed(req));
    res.json(chain);
  });

  router.delete("/deep-dive/roadmap/:roadmapItemId", async (req, res) => {
    const companyId = await itemInScope(req, "roadmap", "roadmapItemId");
    const chain = await trace.deleteRoadmapItem(req.params.roadmapItemId as string);
    await log(req, companyId, "deep_dive_traceability.roadmap_item_removed", req.params.roadmapItemId as string);
    res.json(chain);
  });

  return router;
}
