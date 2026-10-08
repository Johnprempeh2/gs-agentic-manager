import { Router } from "express";
import type { Db } from "@greatstone/db";
import {
  memberHandoverRequestSchema,
  memberHandoverRestoreSchema,
  type DeploymentMode,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import {
  planOrExecuteMemberHandover,
  restoreHandedOverMember,
} from "../services/member-handover.js";

/**
 * Hand over and remove a person leaving the company, and restore their access.
 * Owners and admins only; only owners for an owner or admin. See
 * `services/member-handover.ts` and `doc/WHEN-SOMEONE-LEAVES.md`.
 */
export function memberHandoverRoutes(db: Db, opts: { deploymentMode: DeploymentMode }) {
  const router = Router();

  router.post(
    "/companies/:companyId/members/:memberId/handover",
    validate(memberHandoverRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await planOrExecuteMemberHandover(db, {
        companyId,
        memberId: req.params.memberId as string,
        deploymentMode: opts.deploymentMode,
        actor: req.actor,
        successorUserId: req.body.successorUserId,
        overrides: req.body.overrides,
        removeInstanceAdmin: req.body.removeInstanceAdmin,
        dryRun: req.body.dryRun,
      }));
    },
  );

  router.post(
    "/companies/:companyId/members/:memberId/restore",
    validate(memberHandoverRestoreSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await restoreHandedOverMember(db, {
        companyId,
        memberId: req.params.memberId as string,
        deploymentMode: opts.deploymentMode,
        actor: req.actor,
      }));
    },
  );

  return router;
}
