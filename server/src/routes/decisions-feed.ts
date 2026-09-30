import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { issueComments, issues } from "@greatstone/db";
import type { DecisionClarityResponse, DecisionsFeedCount } from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { DECISIONS_CLARITY_SOURCE, decisionsFeedService } from "../services/decisions-feed.js";
import type { AttentionServiceOptions } from "../services/attention.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

type Heartbeat = ReturnType<typeof heartbeatService>;

const clarityRequestSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  clientRequestId: z.string().uuid().optional(),
}).strict();

function boardUserId(req: Request, res: Response, companyId: string) {
  assertCompanyAccess(req, companyId);
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

function clarityCommentBody(question: string) {
  return `**Question from the board** (asked from Decisions)\n\n${question}\n\nPlease answer in a short comment on this task.`;
}

export function decisionsFeedRoutes(
  db: Db,
  opts: { heartbeat?: Pick<Heartbeat, "wakeup">; serviceOptions?: AttentionServiceOptions } = {},
) {
  const router = Router();
  const feeds = decisionsFeedService(db, opts.serviceOptions);
  let heartbeat = opts.heartbeat ?? null;
  const wakeup: Heartbeat["wakeup"] = (...args) => (heartbeat ??= heartbeatService(db)).wakeup(...args);

  router.get("/companies/:companyId/decisions-feed", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = boardUserId(req, res, companyId);
    if (!userId) return;
    res.json(await feeds.build(companyId, { userId }));
  });

  router.get("/companies/:companyId/decisions-feed/count", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = boardUserId(req, res, companyId);
    if (!userId) return;
    const feed = await feeds.build(companyId, { userId });
    const body: DecisionsFeedCount = { companyId, generatedAt: feed.generatedAt, count: feed.count };
    res.json(body);
  });

  // Ask for clarity: post the board's short question on the task and wake the
  // owning agent. The answer is the agent's next comment, shown on the card.
  router.post(
    "/companies/:companyId/decisions-feed/cards/:cardId/clarity",
    validate(clarityRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const cardId = req.params.cardId as string;
      const userId = boardUserId(req, res, companyId);
      if (!userId) return;
      const { question, clientRequestId } = req.body as z.infer<typeof clarityRequestSchema>;

      // Re-check the card at use time: a card whose cause is gone takes no question.
      const feed = await feeds.build(companyId, { userId });
      const card = feed.cards.find((candidate) => candidate.id === cardId);
      if (!card?.task) {
        res.status(404).json({ error: "Decision card not found" });
        return;
      }
      const [issue] = await db
        .select({ id: issues.id, identifier: issues.identifier, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.id, card.task.id), eq(issues.companyId, companyId)));
      if (!issue) {
        res.status(404).json({ error: "Decision card not found" });
        return;
      }
      const agentId = issue.assigneeAgentId;
      if (!agentId) {
        res.status(409).json({ error: "No agent owns this task. Reassign it first." });
        return;
      }

      if (clientRequestId) {
        const [existing] = await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(and(
            eq(issueComments.issueId, issue.id),
            eq(issueComments.authorUserId, userId),
            eq(issueComments.clientRequestId, clientRequestId),
          ));
        if (existing) {
          const body: DecisionClarityResponse = { cardId, issueId: issue.id, commentId: existing.id, agentId, woken: false };
          res.status(200).json(body);
          return;
        }
      }

      const comment = await issueService(db).addComment(issue.id, clarityCommentBody(question), { userId }, {
        authorType: "user",
        ...(clientRequestId ? { clientRequestId } : {}),
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          identifier: issue.identifier,
          source: DECISIONS_CLARITY_SOURCE,
          cardId,
          agentId,
          question,
        },
      });

      let woken = false;
      try {
        await wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId: issue.id, commentId: comment.id, mutation: "comment", clarityRequest: true },
          idempotencyKey: `decisions-clarity:${comment.id}`,
          requestedByActorType: "user",
          requestedByActorId: userId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            source: "decisions.clarity",
            wakeReason: "issue_commented",
          },
        });
        woken = true;
      } catch (error) {
        // The question is saved and shows on the card as unanswered, and the
        // response says the agent was not woken, so the board can ask again.
        logger.warn({ err: error, issueId: issue.id, agentId }, "decisions clarity wake failed");
      }

      const body: DecisionClarityResponse = { cardId, issueId: issue.id, commentId: comment.id, agentId, woken };
      res.status(201).json(body);
    },
  );

  return router;
}
