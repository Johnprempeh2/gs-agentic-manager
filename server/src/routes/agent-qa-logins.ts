// Browser QA access for an agent (GRE-2387): a board owner gives an agent its
// own member log-in, sees it, and revokes it. See services/agent-qa-logins.ts.

import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { agents, type Db } from "@greatstone/db";
import { forbidden, notFound } from "../errors.js";
import { agentQaLoginService } from "../services/agent-qa-logins.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess, hasCompanyBoardRole } from "./authz.js";

export function agentQaLoginRoutes(db: Db) {
  const router = Router();
  const qaLogins = agentQaLoginService(db);

  async function loadAgent(req: Request) {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, req.params.id as string))
      .then((rows) => rows[0] ?? null);
    if (!agent || !hasCompanyAccess(req, agent.companyId)) throw notFound("Agent not found");
    return agent;
  }

  /** Only a board owner (or the hosting operator) gives or revokes QA access. */
  function assertBoardOwner(req: Request, companyId: string): string {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (req.actor.qaLogin || !hasCompanyBoardRole(req, companyId) || !req.actor.userId) {
      throw forbidden("Only a board owner can give or revoke browser QA access.");
    }
    return req.actor.userId;
  }

  router.get("/agents/:id/qa-login", async (req, res) => {
    const agent = await loadAgent(req);
    assertCompanyAccess(req, agent.companyId);
    assertBoard(req);
    res.json({ qaLogin: await qaLogins.getActive(agent.companyId, agent.id) });
  });

  router.post("/agents/:id/qa-login", async (req, res) => {
    const agent = await loadAgent(req);
    const userId = assertBoardOwner(req, agent.companyId);
    const qaLogin = await qaLogins.grant({
      companyId: agent.companyId,
      agentId: agent.id,
      role: req.body?.role,
      expiresInDays: req.body?.expiresInDays,
      grantedByUserId: userId,
    });
    res.status(201).json({ qaLogin });
  });

  router.delete("/agents/:id/qa-login", async (req, res) => {
    const agent = await loadAgent(req);
    const userId = assertBoardOwner(req, agent.companyId);
    res.json({ qaLogin: await qaLogins.revoke({ companyId: agent.companyId, agentId: agent.id, byUserId: userId }) });
  });

  return router;
}
