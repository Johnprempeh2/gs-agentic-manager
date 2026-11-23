import { Router } from "express";
import type { Db } from "@greatstone/db";
import {
  runAdmissionRecommendationService,
  runAdmissionStatusService,
} from "../services/run-admission-recommendation.js";
import { assertBoardOrgAccess } from "./authz.js";

/**
 * Read-only suggestion for the instance `runAdmission` settings (GRE-116).
 * It never changes settings; the board applies it in Settings.
 */
export function runAdmissionRecommendationRoutes(
  db: Db,
  service = runAdmissionRecommendationService(db),
  status = runAdmissionStatusService(db),
) {
  const router = Router();

  router.get("/instance/run-admission/recommendation", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.get());
  });

  // The cap in force and how many runs are running and queued (GRE-6094).
  router.get("/instance/run-admission/status", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await status.get());
  });

  return router;
}
