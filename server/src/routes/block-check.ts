import { Router } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { blockCheckService } from "../services/block-check.js";
import { badRequest } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

const blockCheckQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  /** An agent id, or `me` for the calling agent. */
  leadAgentId: z.union([z.literal("me"), z.string().uuid()]).optional(),
});

/**
 * The block check the project leads' routines call (GRE-2287): blocks nothing
 * recorded explains, blocks whose blocker or card is already closed or
 * answered, titles that name a condition, and old asks to a person. Read only.
 */
export function blockCheckRoutes(db: Db) {
  const router = Router();
  const svc = blockCheckService(db);

  router.get("/companies/:companyId/block-check", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = blockCheckQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("projectId and leadAgentId must be ids; leadAgentId may also be `me`");
    let leadAgentId = parsed.data.leadAgentId;
    if (leadAgentId === "me") {
      if (req.actor.type !== "agent" || !req.actor.agentId) throw badRequest("leadAgentId=me needs an agent caller");
      leadAgentId = req.actor.agentId;
    }
    res.json(await svc.check(companyId, { projectId: parsed.data.projectId, leadAgentId }));
  });

  return router;
}
