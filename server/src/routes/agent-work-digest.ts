import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { badRequest } from "../errors.js";
import { agentWorkDigestService } from "../services/agent-work-digest.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const digestQuerySchema = z.object({
  since: z.coerce.date().optional(),
});

function boardUserId(req: Request, res: Response, companyId: string) {
  assertCompanyAccess(req, companyId);
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

/**
 * "What happened since I was last here": agent work grouped by agent.
 * GET has no side effects; the client calls POST .../visit once the user has seen the digest.
 */
export function agentWorkDigestRoutes(db: Db) {
  const router = Router();
  const svc = agentWorkDigestService(db);

  router.get("/companies/:companyId/agent-work-digest", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = boardUserId(req, res, companyId);
    if (!userId) return;
    const parsed = digestQuerySchema.safeParse(req.query);
    if (!parsed.success || (parsed.data.since && Number.isNaN(parsed.data.since.getTime()))) {
      throw badRequest("`since` must be an ISO date-time");
    }
    res.json(await svc.build(companyId, { userId, since: parsed.data.since ?? null }));
  });

  router.post("/companies/:companyId/agent-work-digest/visit", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = boardUserId(req, res, companyId);
    if (!userId) return;
    res.json(await svc.recordVisit(companyId, userId));
  });

  return router;
}
