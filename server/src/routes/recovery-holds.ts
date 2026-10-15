import { Router } from "express";
import type { Db } from "@greatstone/db";
import { listRecoveryHolds } from "../services/recovery-holds.js";
import { assertCompanyAccess } from "./authz.js";

/** Tasks held after a run stopped part-way through an outside step. Read only. */
export function recoveryHoldRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/recovery-holds", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await listRecoveryHolds(db, companyId));
  });

  return router;
}
