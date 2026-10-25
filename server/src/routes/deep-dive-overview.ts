import { Router } from "express";
import type { Db } from "@greatstone/db";
import { deepDiveOverviewService } from "../services/deep-dive-overview.js";
import { assertEntitled } from "../services/entitlements.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertCompanyAccess } from "./authz.js";

// Deep Dive overview (GRE-2372): Screen 1 of the GRE-2327 plan. One read, no
// writes: what is next, progress by stream, the next session, open findings
// and the work only a person can do, all from the models of the other screens.

export function deepDiveOverviewRoutes(db: Db) {
  const router = Router();
  const overview = deepDiveOverviewService(db);
  const settings = instanceSettingsService(db);

  router.get("/companies/:companyId/deep-dive/overview", async (req, res) => {
    await assertEntitled(settings, "enableCases");
    await assertEntitled(settings, "enableDeepDive");
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await overview.overview(companyId));
  });

  return router;
}
