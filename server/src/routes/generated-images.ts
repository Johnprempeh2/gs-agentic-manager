import { Router } from "express";
import type { Db } from "@greatstone/db";
import { createGeneratedImageSchema, generatedImagesQuerySchema } from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { generatedImageService, type GeneratedImageServiceOptions } from "../services/generated-images.js";
import { describeImageGeneration } from "../services/image-generation/registry.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

// Image generation: board users and agents ask for a picture from a written
// description. Making it takes a while, so POST answers 202 with a pending
// image and callers poll GET /generated-images/:id until it completes.

export function generatedImageRoutes(
  db: Db,
  storage: StorageService,
  options: GeneratedImageServiceOptions = {},
) {
  const router = Router();
  const svc = generatedImageService(db, storage, options);

  router.get("/companies/:companyId/image-generation", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(describeImageGeneration(svc.status()));
  });

  router.get("/companies/:companyId/generated-images", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = generatedImagesQuerySchema.parse(req.query);
    res.json(await svc.list(companyId, query));
  });

  router.post(
    "/companies/:companyId/generated-images",
    validate(createGeneratedImageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const image = await svc.create(companyId, req.body, actor);
      res.status(202).json(image);
    },
  );

  router.get("/generated-images/:id", async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Image not found");
    if (!row) return;
    res.json(svc.toResponse(row));
  });

  router.delete("/generated-images/:id", async (req, res) => {
    assertBoard(req);
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Image not found");
    if (!row) return;
    await svc.remove(row.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "generated_image.deleted",
      entityType: "generated_image",
      entityId: row.id,
      details: { assetId: row.assetId },
    });
    res.status(204).end();
  });

  return router;
}
