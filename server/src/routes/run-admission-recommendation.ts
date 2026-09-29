import { Router } from "express";
import type { Db } from "@greatstone/db";
import { runAdmissionRecommendationService } from "../services/run-admission-recommendation.js";
import { assertBoardOrgAccess } from "./authz.js";

/**
 * Read-only suggestion for the instance `runAdmission` settings (GRE-116).
 * It never changes settings; the board applies it in Settings.
 */
export function runAdmissionRecommendationRoutes(
  db: Db,
  service = runAdmissionRecommendationService(db),
) {
  const router = Router();

  router.get("/instance/run-admission/recommendation", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.get());
  });

  return router;
}
