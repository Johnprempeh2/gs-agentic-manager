import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { heartbeatRuns, issueWorkProducts } from "@greatstone/db";
import {
  createDeliverableCommentSchema,
  createDeliverableSchema,
  deliverablesQuerySchema,
  HTML_ATTACHMENT_CSP,
  markDeliverableSchema,
  updateDeliverableCommentSchema,
  type CreateDeliverableComment,
  type DeliverableCommentsResponse,
  type MarkDeliverable,
  type SendDeliverableCommentsResponse,
  type UpdateDeliverableComment,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { accessService, issueService, logActivity } from "../services/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildDeliverableCommentsBody, deliverableCommentService } from "../services/deliverable-comments.js";
import { injectDeliverableReviewScript } from "../services/deliverable-review-script.js";
import { deliverableService } from "../services/deliverables.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

// Deliverables (GRE-388). Agents register a finished document on an issue they
// may change; board users list, preview and promote existing artifacts.

function titleFromFilename(filename: string | null) {
  const base = (filename ?? "").replace(/\.[a-z0-9]{1,8}$/i, "").replace(/[_-]+/g, " ").trim();
  return base || "Deliverable";
}

type Heartbeat = ReturnType<typeof heartbeatService>;

export function deliverableRoutes(
  db: Db,
  storage?: StorageService,
  opts: { heartbeat?: Pick<Heartbeat, "wakeup"> } = {},
) {
  const router = Router();
  const svc = deliverableService(db, storage);
  const comments = deliverableCommentService(db);
  let heartbeat = opts.heartbeat ?? null;
  const wakeup: Heartbeat["wakeup"] = (...args) => (heartbeat ??= heartbeatService(db)).wakeup(...args);
  const issuesSvc = issueService(db);
  const access = accessService(db);

  async function assertAgentMayChangeIssue(
    req: Request,
    issue: {
      id: string;
      companyId: string;
      projectId: string | null;
      parentId: string | null;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      status: string;
    },
  ) {
    if (req.actor.type !== "agent") return;
    const decision = await access.decide({
      actor: req.actor,
      action: "issue:mutate",
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
    if (!decision.allowed) throw forbidden("This agent cannot add deliverables to this issue");
  }

  async function logRegistered(
    req: Request,
    deliverable: { id: string; companyId: string; issue: { id: string }; key: string; version: number },
    action: "issue.deliverable_registered" | "issue.deliverable_marked",
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: deliverable.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "issue",
      entityId: deliverable.issue.id,
      details: { workProductId: deliverable.id, key: deliverable.key, version: deliverable.version },
    });
  }

  router.get("/companies/:companyId/deliverables", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId, deliverablesQuerySchema.parse(req.query)));
  });

  router.get("/companies/:companyId/deliverables/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const detail = await svc.getDetail(companyId, req.params.id as string);
    if (!detail) throw notFound("Deliverable not found");
    res.json(detail);
  });

  router.post("/companies/:companyId/deliverables/:id/opened", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await svc.markOpened(companyId, req.params.id as string))) throw notFound("Deliverable not found");
    res.json({ ok: true });
  });

  router.post("/issues/:id/deliverables", validate(createDeliverableSchema), async (req, res) => {
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;
    await assertAgentMayChangeIssue(req, issue);
    const { attachmentId, ...fields } = req.body as import("@greatstone/shared").CreateDeliverable;
    const attachment = await svc.getAttachment(issue.companyId, attachmentId);
    if (!attachment || attachment.issueId !== issue.id) {
      throw unprocessable("attachmentId must be an attachment on this issue. Upload it first with POST /api/companies/{companyId}/issues/{issueId}/attachments.");
    }
    const actor = getActorInfo(req);
    // Only an agent's own run counts as the creating run.
    const runId = actor.actorType === "agent" && actor.runId && actor.agentId
      ? await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.agentId, actor.agentId)))
        .then((rows) => rows[0]?.id ?? null)
      : null;
    const deliverable = await svc.register({
      issue,
      attachment,
      fields,
      createdByAgentId: actor.agentId,
      createdByRunId: runId,
    });
    await logRegistered(req, deliverable, "issue.deliverable_registered");
    res.status(201).json(deliverable);
  });

  router.post("/companies/:companyId/deliverables/mark", validate(markDeliverableSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = req.body as MarkDeliverable;
    const [source, sourceId] = body.artifactId.split(":") as ["attachment" | "work_product", string];
    let attachmentId = sourceId;
    let sourceTitle: string | null = null;
    let sourceSummary: string | null = null;
    if (source === "work_product") {
      const product = await db
        .select({ metadata: issueWorkProducts.metadata, title: issueWorkProducts.title, summary: issueWorkProducts.summary })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.id, sourceId),
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, "artifact"),
        ))
        .then((rows) => rows[0] ?? null);
      const productAttachmentId = product?.metadata?.attachmentId;
      if (!product || typeof productAttachmentId !== "string") {
        throw unprocessable("Only artifacts with a stored file can become deliverables");
      }
      attachmentId = productAttachmentId;
      sourceTitle = product.title;
      sourceSummary = product.summary ?? null;
    }
    const attachment = await svc.getAttachment(companyId, attachmentId);
    if (!attachment) throw notFound("Artifact not found");
    const issue = await issuesSvc.getById(attachment.issueId);
    if (!issue || issue.companyId !== companyId) throw notFound("Issue not found");
    // Marking the file a deliverable already shows is a no-op, not a new version.
    const existing = await svc.findLatestByAttachment(companyId, attachment.id);
    if (existing) {
      res.status(200).json(existing);
      return;
    }
    const { artifactId: _artifactId, ...fields } = body;
    const deliverable = await svc.register({
      issue,
      attachment,
      fields: {
        ...fields,
        title: fields.title
          ?? sourceTitle
          ?? (await svc.readHtmlTitle(attachment))
          ?? titleFromFilename(attachment.originalFilename),
        summary: fields.summary ?? sourceSummary ?? undefined,
      },
      createdByAgentId: null,
      createdByRunId: null,
    });
    await logRegistered(req, deliverable, "issue.deliverable_marked");
    res.status(201).json(deliverable);
  });

  // Deliverable comments (GRE-982). Anyone who may read the deliverable sees
  // its sent comments; only board users write, and each sees only their own
  // drafts. Comments belong to one version, so a new version starts clean.

  async function getDeliverableOr404(req: Request) {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const detail = await svc.getDetail(companyId, req.params.id as string);
    if (!detail) throw notFound("Deliverable not found");
    return detail;
  }

  function boardUserId(req: Request) {
    assertBoard(req);
    return getActorInfo(req).actorId;
  }

  router.get("/companies/:companyId/deliverables/:id/review-content", async (req, res) => {
    const detail = await getDeliverableOr404(req);
    const html = await svc.readDeliverableHtml(detail.companyId, detail.attachmentId);
    if (html === null) throw unprocessable("Only HTML deliverables up to 5 MB can take comments on the page");
    // The same sandbox as the file opened on its own (issues.ts attachment
    // content), so review mode gives the document no more power.
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", HTML_ATTACHMENT_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).send(injectDeliverableReviewScript(html));
  });

  router.get("/companies/:companyId/deliverables/:id/comments", async (req, res) => {
    const detail = await getDeliverableOr404(req);
    const viewerUserId = req.actor.type === "board" ? getActorInfo(req).actorId : null;
    const body: DeliverableCommentsResponse = {
      comments: await comments.list(detail.companyId, detail.id, viewerUserId),
    };
    res.json(body);
  });

  router.post(
    "/companies/:companyId/deliverables/:id/comments",
    validate(createDeliverableCommentSchema),
    async (req, res) => {
      const detail = await getDeliverableOr404(req);
      const userId = boardUserId(req);
      const created = await comments.create({
        companyId: detail.companyId,
        deliverable: { id: detail.id, issueId: detail.issue.id },
        userId,
        fields: req.body as CreateDeliverableComment,
      });
      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/deliverables/:id/comments/:commentId",
    validate(updateDeliverableCommentSchema),
    async (req, res) => {
      const detail = await getDeliverableOr404(req);
      const userId = boardUserId(req);
      const { body } = req.body as UpdateDeliverableComment;
      res.json(await comments.update(detail.companyId, detail.id, req.params.commentId as string, userId, body));
    },
  );

  router.delete("/companies/:companyId/deliverables/:id/comments/:commentId", async (req, res) => {
    const detail = await getDeliverableOr404(req);
    const userId = boardUserId(req);
    await comments.remove(detail.companyId, detail.id, req.params.commentId as string, userId);
    res.status(204).end();
  });

  router.post("/companies/:companyId/deliverables/:id/comments/send", async (req, res) => {
    const detail = await getDeliverableOr404(req);
    const userId = boardUserId(req);
    const issue = await issuesSvc.getById(detail.issue.id);
    if (!issue || issue.companyId !== detail.companyId) throw notFound("Issue not found");

    const claimed = await comments.claimDrafts(detail.companyId, detail.id, userId);
    const claimedIds = claimed.map((comment) => comment.id);
    let taskComment: Awaited<ReturnType<typeof issuesSvc.addComment>>;
    try {
      taskComment = await issuesSvc.addComment(
        issue.id,
        buildDeliverableCommentsBody({ deliverable: detail, comments: claimed }),
        { userId },
        { authorType: "user" },
      );
    } catch (error) {
      await comments.releaseClaim(claimedIds);
      throw error;
    }
    const sent = await comments.recordSentComment(claimedIds, taskComment.id);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId: taskComment.id,
        identifier: issue.identifier,
        source: "deliverable_comments",
        workProductId: detail.id,
        version: detail.version,
        noteCount: sent.length,
      },
    });

    const agentId = issue.assigneeAgentId ?? null;
    let woken = false;
    if (agentId) {
      // Like any board comment, notes on finished work reopen it so the agent
      // can revise (issues.ts implicit reopen).
      if (issue.status === "done" || issue.status === "cancelled") {
        const reopened = await issuesSvc.update(issue.id, { status: "todo" });
        if (reopened) {
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: "user",
            actorId: userId,
            action: "issue.updated",
            entityType: "issue",
            entityId: issue.id,
            details: { status: "todo", reopened: true, reopenedFrom: issue.status, source: "deliverable_comments" },
          });
        }
      }
      try {
        await wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId: issue.id, commentId: taskComment.id, mutation: "comment" },
          idempotencyKey: `deliverable-comments:${taskComment.id}`,
          requestedByActorType: "user",
          requestedByActorId: userId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            commentId: taskComment.id,
            wakeCommentId: taskComment.id,
            source: "deliverables.comments",
            wakeReason: "issue_commented",
          },
        });
        woken = true;
      } catch (error) {
        // The notes are posted on the task; the response says the agent was
        // not woken, so the board can nudge it from the task.
        logger.warn({ err: error, issueId: issue.id, agentId }, "deliverable comments wake failed");
      }
    }

    const body: SendDeliverableCommentsResponse = { sent, commentId: taskComment.id, agentId, woken };
    res.status(201).json(body);
  });

  return router;
}
