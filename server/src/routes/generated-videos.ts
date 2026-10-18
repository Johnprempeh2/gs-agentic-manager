import { Router } from "express";
import type { Db } from "@greatstone/db";
import { createGeneratedVideoSchema, generatedVideosQuerySchema } from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { generatedVideoService, type GeneratedVideoServiceOptions } from "../services/generated-videos.js";
import { describeVideoGeneration } from "../services/video-generation/registry.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

// Studio clips: board users and agents ask for a short video from a
// description, or ask for a finished studio image to be animated. POST
// answers 202 with a pending clip; callers poll GET /generated-videos/:id.

export function generatedVideoRoutes(db: Db, storage: StorageService, options: GeneratedVideoServiceOptions = {}) {
  const router = Router();
  const svc = generatedVideoService(db, storage, options);

  router.get("/companies/:companyId/video-generation", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(describeVideoGeneration(svc.status()));
  });

  router.get("/companies/:companyId/generated-videos", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId, generatedVideosQuerySchema.parse(req.query)));
  });

  router.post("/companies/:companyId/generated-videos", validate(createGeneratedVideoSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.status(202).json(await svc.create(companyId, req.body, getActorInfo(req)));
  });

  router.get("/generated-videos/:id", async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Clip not found");
    if (!row) return;
    res.json(await svc.toResponse(row));
  });

  router.delete("/generated-videos/:id", async (req, res) => {
    assertBoard(req);
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Clip not found");
    if (!row) return;
    await svc.remove(row.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "generated_video.deleted",
      entityType: "generated_video",
      entityId: row.id,
      details: { assetId: row.assetId },
    });
    res.status(204).end();
  });

  return router;
}
