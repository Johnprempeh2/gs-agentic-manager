import { Router, type Request } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { pipelineCases } from "@greatstone/db";
import {
  acceptClientDeliverableSchema,
  createClientPublicationSchema,
  registerClientApproverSchema,
  rejectClientPublicationSchema,
  submitClientPublicationSchema,
  withdrawClientPublicationSchema,
  type AcceptClientDeliverable,
  type CreateClientPublicationLinkResponse,
} from "@greatstone/shared";
import { contentDispositionHeader, isInlineAttachmentContentType, SVG_CONTENT_TYPE } from "../attachment-types.js";
import { HttpError, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import { requireEntitlement } from "../services/entitlements.js";
import { clientPublicationService, type ClientPublicationActor } from "../services/client-publications.js";
import type { ClientReceiptSender } from "../services/client-receipts.js";
import { deliverableService } from "../services/deliverables.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// Clients > Deliverables publishing and the engagement timeline (GRE-2373).
//
// Who may do what:
// - Read the publications or the timeline: anyone with access to the client's company.
// - Start a draft or send it for approval: Work cases on the client's pipeline (a person, or an agent in a run).
// - Register or remove approvers, publish, make the client's link, withdraw, resend a receipt:
//   a person (board user) with Work cases. Agents never publish.
// - Approve or send back: only the person named as approver, who must still be registered for the client.
// A client in another company reads as not found, never as forbidden.

const CLIENT_PUBLICATION_ROUTE_PREFIXES = [
  "/cases/:caseId/publications",
  "/cases/:caseId/approvers",
  "/cases/:caseId/timeline",
  "/client-publications",
];

/** A publication row as the board sees it: never the link's token hash or the client's IP. */
function rowOut<T extends { acceptanceTokenHash?: unknown; acceptedIp?: unknown; acceptedUserAgent?: unknown }>(row: T) {
  const { acceptanceTokenHash: _hash, acceptedIp: _ip, acceptedUserAgent: _agent, ...rest } = row;
  return rest;
}

function parseId(value: unknown, what: string) {
  const parsed = z.string().guid().safeParse(value);
  if (!parsed.success) throw notFound(`${what} not found`);
  return parsed.data;
}

export function clientPublicationRoutes(
  db: Db,
  options: { publicBaseUrl?: string; receipts?: ClientReceiptSender; now?: () => Date } = {},
) {
  const router = Router();
  const svc = clientPublicationService(db, { receipts: options.receipts, now: options.now });
  const access = accessService(db);

  router.use(CLIENT_PUBLICATION_ROUTE_PREFIXES, requireEntitlement(db, "enablePipelines"));

  function assertInCompany(req: Request, companyId: string) {
    try {
      assertCompanyAccess(req, companyId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) throw notFound("Pipeline case not found");
      throw error;
    }
  }

  async function caseScope(req: Request, caseId: string) {
    const row = await db
      .select({ companyId: pipelineCases.companyId, pipelineId: pipelineCases.pipelineId })
      .from(pipelineCases)
      .where(eq(pipelineCases.id, parseId(caseId, "Pipeline case")))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Pipeline case not found");
    assertInCompany(req, row.companyId);
    return { companyId: row.companyId, pipelineId: row.pipelineId, caseId };
  }

  async function assertWorkCases(req: Request, scope: { companyId: string; pipelineId: string }) {
    const decision = await access.decide({
      actor: req.actor,
      action: "pipelines:cases",
      resource: { type: "company", companyId: scope.companyId },
      scope: { pipelineId: scope.pipelineId },
    });
    if (!decision.allowed) {
      throw new HttpError(403, decision.explanation, { code: decision.code ?? "pipeline_cases_forbidden", reason: decision.reason });
    }
  }

  function actorOf(req: Request): ClientPublicationActor {
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw unauthorized();
      if (!req.actor.runId) throw unprocessable("Agent changes need a run id", { code: "run_id_required" });
      return { type: "agent", agentId: req.actor.agentId, runId: req.actor.runId };
    }
    if (req.actor.type === "board") return { type: "user", userId: req.actor.userId ?? "board" };
    throw unauthorized();
  }

  function personOf(req: Request, what: string): string {
    if (req.actor.type !== "board") throw forbidden(`Only a person can ${what}`);
    return req.actor.userId ?? "board";
  }

  async function publicationScope(req: Request) {
    const id = parseId(req.params.id, "Publication");
    const { caseId } = await svc.scopeOf(id).catch(() => {
      throw notFound("Publication not found");
    });
    return { id, ...(await caseScope(req, caseId)) };
  }

  async function log(req: Request, companyId: string, action: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "client_deliverable_publication",
      entityId,
      details,
    });
  }

  router.get("/cases/:caseId/publications", async (req, res) => {
    const scope = await caseScope(req, req.params.caseId as string);
    res.json(await svc.list(scope.companyId, scope.caseId));
  });

  // ?view=client returns what the client may see (for the website client view).
  router.get("/cases/:caseId/timeline", async (req, res) => {
    const scope = await caseScope(req, req.params.caseId as string);
    res.json(await svc.timeline(scope.companyId, scope.caseId, { clientSafe: req.query.view === "client" }));
  });

  router.post("/cases/:caseId/approvers", validate(registerClientApproverSchema), async (req, res) => {
    const scope = await caseScope(req, req.params.caseId as string);
    const by = personOf(req, "register an approver");
    await assertWorkCases(req, scope);
    const row = await svc.registerApprover(scope.companyId, scope.caseId, (req.body as { userId: string }).userId, by);
    await log(req, scope.companyId, "client_deliverable_approver.registered", row.id, { caseId: scope.caseId, userId: row.userId });
    res.status(201).json(row);
  });

  router.delete("/cases/:caseId/approvers/:approverId", async (req, res) => {
    const scope = await caseScope(req, req.params.caseId as string);
    const by = personOf(req, "remove an approver");
    await assertWorkCases(req, scope);
    const row = await svc.removeApprover(scope.companyId, scope.caseId, parseId(req.params.approverId, "Approver"), by);
    await log(req, scope.companyId, "client_deliverable_approver.removed", row.id, { caseId: scope.caseId, userId: row.userId });
    res.json(row);
  });

  router.post("/cases/:caseId/publications", validate(createClientPublicationSchema), async (req, res) => {
    const scope = await caseScope(req, req.params.caseId as string);
    await assertWorkCases(req, scope);
    const row = await svc.create(scope.companyId, scope.caseId, (req.body as { stageLinkId: string }).stageLinkId, actorOf(req));
    await log(req, scope.companyId, "client_deliverable_publication.created", row.id, { caseId: scope.caseId });
    res.status(201).json(rowOut(row));
  });

  router.post("/client-publications/:id/submit", validate(submitClientPublicationSchema), async (req, res) => {
    const scope = await publicationScope(req);
    await assertWorkCases(req, scope);
    const row = await svc.submit(scope.id, (req.body as { approverUserId: string }).approverUserId, actorOf(req));
    await log(req, scope.companyId, "client_deliverable_publication.submitted", row.id, { fingerprint: row.fingerprint, approverUserId: row.approverUserId });
    res.json(rowOut(row));
  });

  router.post("/client-publications/:id/approve", async (req, res) => {
    const scope = await publicationScope(req);
    const userId = personOf(req, "approve a deliverable");
    const row = await svc.approve(scope.id, userId);
    await log(req, scope.companyId, "client_deliverable_publication.approved", row.id, { fingerprint: row.approvedFingerprint });
    res.json(rowOut(row));
  });

  router.post("/client-publications/:id/reject", validate(rejectClientPublicationSchema), async (req, res) => {
    const scope = await publicationScope(req);
    const userId = personOf(req, "send a deliverable back");
    const row = await svc.reject(scope.id, userId, (req.body as { reason: string }).reason);
    await log(req, scope.companyId, "client_deliverable_publication.rejected", row.id, {});
    res.json(rowOut(row));
  });

  router.post("/client-publications/:id/publish", async (req, res) => {
    const scope = await publicationScope(req);
    const userId = personOf(req, "publish a deliverable");
    await assertWorkCases(req, scope);
    const row = await svc.publish(scope.id, userId);
    await log(req, scope.companyId, "client_deliverable_publication.published", row.id, { fingerprint: row.publishedFingerprint });
    res.json(rowOut(row));
  });

  router.post("/client-publications/:id/acceptance-link", async (req, res) => {
    const scope = await publicationScope(req);
    const userId = personOf(req, "share a deliverable with the client");
    await assertWorkCases(req, scope);
    const created = await svc.createLink(scope.id, userId);
    await log(req, scope.companyId, "client_deliverable_publication.link_created", scope.id, { expiresAt: created.expiresAt });
    const base = (options.publicBaseUrl?.trim() || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
    const body: CreateClientPublicationLinkResponse = { url: `${base}${created.path}`, path: created.path, expiresAt: created.expiresAt };
    res.status(201).json(body);
  });

  router.post("/client-publications/:id/withdraw", validate(withdrawClientPublicationSchema), async (req, res) => {
    const scope = await publicationScope(req);
    const userId = personOf(req, "withdraw a deliverable");
    await assertWorkCases(req, scope);
    const row = await svc.withdraw(scope.id, userId, (req.body as { reason: string }).reason);
    await log(req, scope.companyId, "client_deliverable_publication.withdrawn", row.id, {});
    res.json(rowOut(row));
  });

  router.post("/client-publications/:id/receipt", async (req, res) => {
    const scope = await publicationScope(req);
    personOf(req, "send a receipt");
    await assertWorkCases(req, scope);
    const outcome = await svc.resendReceipt(scope.id);
    await log(req, scope.companyId, "client_deliverable_publication.receipt_resent", scope.id, { status: outcome.status });
    res.json(outcome);
  });

  return router;
}

// The client's side: no sign-in. The 256-bit token in the path is the only
// key, and it reaches one published deliverable and nothing else.
export function clientDeliverablePublicRoutes(
  db: Db,
  storage?: StorageService,
  options: { receipts?: ClientReceiptSender; now?: () => Date } = {},
) {
  const router = Router();
  const svc = clientPublicationService(db, options);
  const deliverables = deliverableService(db, storage);

  const noStore = (res: { setHeader: (name: string, value: string) => void }) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
  };

  router.get("/client-deliverable/:token", async (req, res) => {
    noStore(res);
    res.json(await svc.view(req.params.token as string));
  });

  router.get("/client-deliverable/:token/content", async (req, res, next) => {
    noStore(res);
    const { companyId, attachmentId } = await svc.content(req.params.token as string);
    if (!storage) throw new HttpError(503, "File storage is not available");
    const attachment = await deliverables.getAttachment(companyId, attachmentId);
    if (!attachment) throw notFound("This deliverable is not available");
    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    const contentType = attachment.contentType || object.contentType || "application/octet-stream";
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const inlineSafe = mediaType !== SVG_CONTENT_TYPE && isInlineAttachmentContentType(mediaType);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Deliverables are often HTML: show them, but sandboxed so they cannot run as this site.
    res.setHeader("Content-Security-Policy", inlineSafe ? "sandbox" : "sandbox; default-src 'none'");
    res.setHeader(
      "Content-Disposition",
      contentDispositionHeader(inlineSafe && req.query.download !== "1" ? "inline" : "attachment", attachment.originalFilename ?? "deliverable"),
    );
    object.stream.on("error", (err) => next(err));
    object.stream.pipe(res);
  });

  router.post("/client-deliverable/:token/accept", validate(acceptClientDeliverableSchema), async (req, res) => {
    noStore(res);
    const token = req.params.token as string;
    await svc.accept(token, req.body as AcceptClientDeliverable, {
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.json(await svc.view(token));
  });

  return router;
}

