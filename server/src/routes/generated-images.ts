import { Router } from "express";
import type { Db } from "@greatstone/db";
import {
  createGeneratedImageSchema,
  createGeneratedImageVariationsSchema,
  generatedImagesQuerySchema,
  updateGeneratedImageCoverSchema,
  updateGeneratedImageFavouriteSchema,
  updateHiggsfieldPlanSettingsSchema,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { generatedImageService, type GeneratedImageServiceOptions } from "../services/generated-images.js";
import { setHiggsfieldPlanAgentsMaySpend } from "../services/image-generation/higgsfield-plan.js";
import type { StorageService } from "../storage/types.js";
import { notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";

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

  router.get("/companies/:companyId/image-generation", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.status(companyId));
  });

  // Board only: whether agents may spend the company's Higgsfield plan credits.
  router.patch("/companies/:companyId/higgsfield-plan", validate(updateHiggsfieldPlanSettingsSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await setHiggsfieldPlanAgentsMaySpend(db, companyId, req.body.agentsMaySpend);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "higgsfield_plan.agents_spend_changed",
      entityType: "company",
      entityId: companyId,
      details: result,
    });
    res.json(result);
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

  router.post(
    "/companies/:companyId/generated-images/variations",
    validate(createGeneratedImageVariationsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      res.status(202).json(await svc.createVariations(companyId, req.body, actor));
    },
  );

  router.get("/companies/:companyId/generated-images/covers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.covers(companyId));
  });

  router.patch("/generated-images/:id/cover", validate(updateGeneratedImageCoverSchema), async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Image not found");
    if (!row) return;
    // Write path: the oracle guard wants the read gate named before the write check.
    if (!hasCompanyAccess(req, row.companyId)) throw notFound("Image not found");
    assertCompanyAccess(req, row.companyId);
    const updated = await svc.setCover(row, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "generated_image.cover_changed",
      entityType: "generated_image",
      entityId: row.id,
      details: { ...req.body, issueId: row.issueId, organisationId: row.organisationId },
    });
    res.json(await svc.toResponse(updated));
  });

  router.patch("/generated-images/:id/favourite", validate(updateGeneratedImageFavouriteSchema), async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Image not found");
    if (!row) return;
    // Write path: the oracle guard wants the read gate named before the write check.
    if (!hasCompanyAccess(req, row.companyId)) throw notFound("Image not found");
    assertCompanyAccess(req, row.companyId);
    const updated = await svc.setFavourite(row, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "generated_image.favourite_changed",
      entityType: "generated_image",
      entityId: row.id,
      details: { favourite: updated.favourite },
    });
    res.json(await svc.toResponse(updated));
  });

  router.get("/generated-images/:id", async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Image not found");
    if (!row) return;
    res.json(await svc.toResponse(row));
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
