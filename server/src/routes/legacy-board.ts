import { Router } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import type { DeploymentMode } from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import {
  assertCanManageLegacyBoard,
  restoreLegacyBoard,
  retireLegacyBoard,
} from "../services/legacy-board-retirement.js";

// Strict: the target is always the literal `local-board` user, never a
// caller-chosen id, so any extra field is refused.
export const retireLegacyBoardSchema = z.object({ dryRun: z.boolean() }).strict();
export const restoreLegacyBoardSchema = z.object({}).strict();

/**
 * Retire or restore the legacy `local-board` account of one company. Owner
 * only, authenticated mode only. See `services/legacy-board-retirement.ts`.
 */
export function legacyBoardRoutes(db: Db, opts: { deploymentMode: DeploymentMode }) {
  const router = Router();

  router.post(
    "/companies/:companyId/legacy-board/retire",
    validate(retireLegacyBoardSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const ownerUserId = await assertCanManageLegacyBoard(db, {
        companyId,
        deploymentMode: opts.deploymentMode,
        actor: req.actor,
      });
      res.json(await retireLegacyBoard(db, { companyId, ownerUserId, dryRun: req.body.dryRun }));
    },
  );

  router.post(
    "/companies/:companyId/legacy-board/restore",
    validate(restoreLegacyBoardSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const ownerUserId = await assertCanManageLegacyBoard(db, {
        companyId,
        deploymentMode: opts.deploymentMode,
        actor: req.actor,
      });
      res.json(await restoreLegacyBoard(db, { companyId, ownerUserId }));
    },
  );

  return router;
}
