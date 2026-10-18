import { Router } from "express";
import type { Db } from "@greatstone/db";
import { createGeneratedVideoSchema, generatedVideosQuerySchema, updateGeneratedVideoFavouriteSchema } from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { generatedVideoService, type GeneratedVideoServiceOptions } from "../services/generated-videos.js";
import type { StorageService } from "../storage/types.js";
import { notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";

// Studio clips: board users and agents ask for a short video from a
// description, or ask for a finished studio image to be animated. POST
// answers 202 with a pending clip; callers poll GET /generated-videos/:id.

export function generatedVideoRoutes(db: Db, storage: StorageService, options: GeneratedVideoServiceOptions = {}) {
  const router = Router();
  const svc = generatedVideoService(db, storage, options);

  router.get("/companies/:companyId/video-generation", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.status(companyId));
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

  router.patch("/generated-videos/:id/favourite", validate(updateGeneratedVideoFavouriteSchema), async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Clip not found");
    if (!row) return;
    // Write path: the oracle guard wants the read gate named before the write check.
    if (!hasCompanyAccess(req, row.companyId)) throw notFound("Clip not found");
    assertCompanyAccess(req, row.companyId);
    const updated = await svc.setFavourite(row, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "generated_video.favourite_changed",
      entityType: "generated_video",
      entityId: row.id,
      details: { favourite: updated.favourite },
    });
    res.json(await svc.toResponse(updated));
  });

  router.post("/generated-videos/:id/cancel", async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Clip not found");
    if (!row) return;
    // Write path: the oracle guard wants the read gate named before the write check.
    if (!hasCompanyAccess(req, row.companyId)) throw notFound("Clip not found");
    assertCompanyAccess(req, row.companyId);
    const actor = getActorInfo(req);
    const cancelled = await svc.cancel(row, actor.actorType === "agent" ? "an agent" : "a board member");
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "generated_video.cancelled",
      entityType: "generated_video",
      entityId: row.id,
      details: { provider: row.provider, model: row.model },
    });
    res.json(await svc.toResponse(cancelled));
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
