import { Router, type Request, type Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issues } from "@greatstone/db";
import { normalizeIssueIdentifier } from "@greatstone/shared";
import { accessService, issueFollowService } from "../services/index.js";
import type { IssueAccessFields } from "../services/issue-follows.js";
import { assertCompanyAccess, getAccessibleResource } from "./authz.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireBoardUser(req: Request, res: Response) {
  if (req.actor.type !== "board") {
    res.status(403).json({ error: "Board authentication required" });
    return null;
  }
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

/**
 * Read access for routes that take a task id or key (GRE-123): the same
 * issue:read decision as the task page, inside the actor's companies.
 */
export function issueReadAccess(db: Db) {
  const access = accessService(db);

  const canRead = (req: Request) => async (issue: IssueAccessFields) => {
    const decision = await access.decide({
      actor: req.actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
      scope: {
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
      },
    });
    return decision.allowed;
  };

  // Accepts a task id or its key (GRE-123), like the other /issues/:id routes.
  async function loadReadableIssue(req: Request, res: Response) {
    const id = req.params.id as string;
    const identifier = normalizeIssueIdentifier(id);
    const match = UUID_RE.test(id)
      ? eq(issues.id, id)
      : identifier ? eq(issues.identifier, identifier) : null;
    const issue = match
      ? await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          parentId: issues.parentId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          status: issues.status,
        })
        .from(issues)
        .where(and(match, isNull(issues.hiddenAt)))
        .then((rows) => rows[0] ?? null)
      : null;
    const accessible = await getAccessibleResource(req, res, issue, "Issue not found");
    if (!accessible) return null;
    if (!(await canRead(req)(accessible))) {
      res.status(403).json({ error: "Issue is outside this actor's authorization boundary" });
      return null;
    }
    return accessible;
  }

  return { canRead, loadReadableIssue };
}

/**
 * Following a task and the recently opened list (Desk). Both are personal
 * preferences of the signed-in board user, kept per company, so they are not
 * written to the activity log. Every task they name must be readable by the
 * user; another user's follows and opens are never returned.
 */
export function issueFollowRoutes(db: Db) {
  const router = Router();
  const svc = issueFollowService(db);
  const { canRead, loadReadableIssue } = issueReadAccess(db);

  router.get("/companies/:companyId/issue-follows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    res.json(await svc.listWithRollups(companyId, userId, canRead(req)));
  });

  router.get("/issues/:id/follow", async (req, res) => {
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    const issue = await loadReadableIssue(req, res);
    if (!issue) return;
    res.json({ issueId: issue.id, following: await svc.isFollowing(issue.companyId, userId, issue.id) });
  });

  router.put("/issues/:id/follow", async (req, res) => {
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    const issue = await loadReadableIssue(req, res);
    if (!issue) return;
    await svc.follow(issue.companyId, userId, issue.id);
    res.json({ issueId: issue.id, following: true });
  });

  router.delete("/issues/:id/follow", async (req, res) => {
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    const issue = await loadReadableIssue(req, res);
    if (!issue) return;
    await svc.unfollow(issue.companyId, userId, issue.id);
    res.json({ issueId: issue.id, following: false });
  });

  router.get("/companies/:companyId/recent-issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    res.json(await svc.listRecent(companyId, userId, canRead(req)));
  });

  router.post("/issues/:id/recent-view", async (req, res) => {
    const userId = requireBoardUser(req, res);
    if (!userId) return;
    const issue = await loadReadableIssue(req, res);
    if (!issue) return;
    await svc.recordView(issue.companyId, userId, issue.id);
    res.status(204).send();
  });

  return router;
}
