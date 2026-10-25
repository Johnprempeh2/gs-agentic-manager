// Browser QA access for an agent (GRE-2387): a board owner gives an agent its
// own member log-in, sees it, and revokes it. See services/agent-qa-logins.ts.

import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { agents, type Db } from "@greatstone/db";
import { forbidden, notFound, unauthorized } from "../errors.js";
import {
  buildQaBrowserLoginUrl,
  issueQaBrowserLoginTicket,
  resolveQaBrowserLoginKey,
} from "../auth/qa-browser-login.js";
import { agentQaLoginService } from "../services/agent-qa-logins.js";
import { runtimeCanonicalOrigin } from "../services/cloud-runtime-identity.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess, hasCompanyBoardRole } from "./authz.js";

/** Where the login link points: the configured public origin, else the origin the agent called. */
function linkOrigin(req: Request, authPublicBaseUrl: string | undefined): string {
  const configured = runtimeCanonicalOrigin() || authPublicBaseUrl;
  if (configured) return new URL(configured).origin;
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

export function agentQaLoginRoutes(db: Db, opts: { authPublicBaseUrl?: string } = {}) {
  const router = Router();
  const qaLogins = agentQaLoginService(db);

  /** 404 for a missing or cross-company agent (no existence oracle), then the membership checks. */
  async function loadAgent(req: Request) {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, req.params.id as string))
      .then((rows) => rows[0] ?? null);
    if (!agent || !hasCompanyAccess(req, agent.companyId)) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
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

  // During a run, the agent asks for a one-time browser login link for its own
  // QA log-in. The link works once, for 90 seconds, and only while the grant is
  // live. No password exists, so nothing is kept in secrets.
  router.post("/agents/me/qa-browser-login", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      throw unauthorized("Only an agent can ask for its QA login link.");
    }
    const { agentId, companyId } = req.actor;
    const login = await qaLogins.getActive(companyId, agentId);
    if (
      !login
      || !(await qaLogins.isGrantLive({ loginId: login.id, userId: login.userId, companyId, agentId }))
    ) {
      throw notFound("This agent has no live browser QA access. A board owner can give it on the agent's page.");
    }
    const key = resolveQaBrowserLoginKey();
    if (!key) {
      res.status(503).json({ error: "QA browser login is not configured on this server." });
      return;
    }
    const { ticket, payload } = issueQaBrowserLoginTicket({
      key,
      userId: login.userId,
      loginId: login.id,
      companyId,
      agentId,
    });
    const linkExpiresAt = new Date(payload.exp * 1000);
    await qaLogins.recordBrowserLoginIssued({
      login,
      companyId,
      runId: req.actor.runId ?? null,
      nonce: payload.jti,
      linkExpiresAt,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      url: buildQaBrowserLoginUrl({ origin: linkOrigin(req, opts.authPublicBaseUrl), ticket }),
      linkExpiresAt: linkExpiresAt.toISOString(),
      email: login.email,
      role: login.role,
      accessExpiresAt: login.expiresAt,
    });
  });

  return router;
}
