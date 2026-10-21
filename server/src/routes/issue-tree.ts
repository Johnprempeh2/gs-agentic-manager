import { Router } from "express";
import type { Db } from "@greatstone/db";
import { issueTreeService } from "../services/index.js";
import { issueReadAccess } from "./issue-follows.js";

/**
 * The task tree (GET /issues/:id/tree): a task and everything under it, with
 * what blocks what, for the Tree view. Same read access as the task page; a
 * branch the actor cannot read is left out. Capped in size and depth, and the
 * response says when it was cut.
 */
export function issueTreeRoutes(db: Db, service = issueTreeService(db)) {
  const router = Router();
  const { canRead, loadReadableIssue } = issueReadAccess(db);

  router.get("/issues/:id/tree", async (req, res) => {
    const issue = await loadReadableIssue(req, res);
    if (!issue) return;
    const tree = await service.getTree(issue.companyId, issue.id, canRead(req));
    if (!tree) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.json(tree);
  });

  return router;
}
