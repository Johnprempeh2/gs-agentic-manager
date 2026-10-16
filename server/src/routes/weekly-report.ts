import { Router } from "express";
import type { Db } from "@greatstone/db";
import { forbidden } from "../errors.js";
import { weeklyReportService } from "../services/weekly-report.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/** "This week at Greatstone": the weekly executive report for the signed-in board user. */
export function weeklyReportRoutes(db: Db, service = weeklyReportService(db)) {
  const router = Router();

  router.get("/companies/:companyId/weekly-report", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user context required");
    res.json(await service.build(companyId, req.actor.userId));
  });

  return router;
}
