import { Router } from "express";
import type { Db } from "@greatstone/db";
import { badRequest } from "../errors.js";
import { TEAM_SCORECARD_DAY_OPTIONS, teamScorecardService } from "../services/team-scorecard.js";
import { assertCompanyAccess } from "./authz.js";

/** Team scorecard: each agent's finished work in the last 7, 14, 30 or 60 days, and what it holds now. */
export function teamScorecardRoutes(db: Db) {
  const router = Router();
  const svc = teamScorecardService(db);

  router.get("/companies/:companyId/team-scorecard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const raw = req.query.days;
    const days = raw === undefined ? 7 : Number(raw);
    if (!(TEAM_SCORECARD_DAY_OPTIONS as readonly number[]).includes(days)) {
      throw badRequest("`days` must be 7, 14, 30 or 60");
    }
    res.json(await svc.build(companyId, { days }));
  });

  return router;
}
