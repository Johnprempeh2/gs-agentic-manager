import { Router } from "express";
import type { Db } from "@greatstone/db";
import { blockedWorkService } from "../services/blocked-work.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Blocked work at a glance: how long each blocked task has waited, who must act,
 * and which single task holds each chain. Read only, so board and agents can both use it.
 */
export function blockedWorkRoutes(db: Db) {
  const router = Router();
  const svc = blockedWorkService(db);

  router.get("/companies/:companyId/blocked-work", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.overview(companyId));
  });

  return router;
}
