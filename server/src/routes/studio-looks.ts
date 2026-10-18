import { Router } from "express";
import type { Db } from "@greatstone/db";
import { createStudioLookSchema, updateStudioLookSchema } from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { studioLookService, toStudioLook } from "../services/studio-looks.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

// House looks for the studio. Board users and agents in the company can read,
// save, change and delete them; every change is in the activity log.

export function studioLookRoutes(db: Db) {
  const router = Router();
  const svc = studioLookService(db);

  router.get("/companies/:companyId/studio-looks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ looks: await svc.list(companyId) });
  });

  router.post("/companies/:companyId/studio-looks", validate(createStudioLookSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.status(201).json(await svc.create(companyId, req.body, getActorInfo(req)));
  });

  router.get("/studio-looks/:id", async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Look not found");
    if (!row) return;
    res.json(toStudioLook(row));
  });

  router.patch("/studio-looks/:id", validate(updateStudioLookSchema), async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Look not found");
    if (!row) return;
    res.json(await svc.update(row, req.body, getActorInfo(req)));
  });

  router.delete("/studio-looks/:id", async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Look not found");
    if (!row) return;
    await svc.remove(row, getActorInfo(req));
    res.status(204).end();
  });

  return router;
}
