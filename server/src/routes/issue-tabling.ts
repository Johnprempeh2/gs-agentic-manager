import { Router } from "express";
import type { Db } from "@greatstone/db";
import { tableIssueSchema } from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  bringBackTabledIssue,
  heartbeatService,
  issueService,
  issueTablingService,
  logActivity,
} from "../services/index.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

// "Not now" (GRE-262): board-only routes to table a task, bring it back, and
// list tabled tasks for the "Tabled" list.

export function issueTablingRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const issuesSvc = issueService(db);
  const tablingSvc = issueTablingService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });

  router.post("/issues/:id/table", validate(tableIssueSchema), async (req, res) => {
    assertBoard(req);
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;
    const actor = getActorInfo(req);
    const returnAt = req.body.returnAt ? new Date(req.body.returnAt) : null;
    const result = await tablingSvc.table(issue.id, {
      until: returnAt,
      userId: req.actor.userId ?? actor.actorId,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.tabled",
      entityType: "issue",
      entityId: issue.id,
      issueId: issue.id,
      details: {
        tabledUntil: result.issue.tabledUntil?.toISOString() ?? null,
        tabledFromStatus: result.issue.tabledFromStatus,
        retabled: result.wasAlreadyTabled,
        interruptedRunIds: result.activeRunIds,
      },
    });
    // A tabled task keeps no live work. Stop what is already running; the
    // wake gates stop anything new.
    for (const runId of result.activeRunIds) {
      try {
        await heartbeat.cancelRun(runId, "Cancelled because the task was tabled (Not now)", {
          resultJson: { cancelledByActorType: "user", cancelledByUserId: req.actor.userId ?? null },
        });
      } catch (err) {
        logger.warn({ err, runId, issueId: issue.id }, "failed to cancel run on tabled issue");
      }
    }
    res.json(result.issue);
  });

  router.post("/issues/:id/bring-back", async (req, res) => {
    assertBoard(req);
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;
    const actor = getActorInfo(req);
    const result = await bringBackTabledIssue(db, { heartbeat }, issue.id, {
      reason: "manual",
      actorType: "user",
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
    });
    if (!result) {
      res.status(409).json({ error: "Issue is not tabled" });
      return;
    }
    res.json(result.issue);
  });

  router.get("/companies/:companyId/tabled-issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await tablingSvc.listTabled(companyId));
  });

  return router;
}
