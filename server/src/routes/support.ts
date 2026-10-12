import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issues, supportQueues, supportTickets } from "@greatstone/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import type { heartbeatService } from "../services/heartbeat.js";
import { supportQueueService } from "../services/support-queue.js";
import { fleetSupportService } from "../services/fleet-support.js";
import { FLEET_SUPPORT_REPLY_MAX } from "@greatstone/shared/fleet-support";
import { SUPPORT_PRIORITIES } from "../services/support-hours.js";
import { assertBoard, assertCompanyAccess, assertCompanyOwnerOrAdmin, getActorInfo, hasCompanyAccess } from "./authz.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const queueSchema = z.object({
  clientCode: z.string().trim().min(2).max(12),
  projectId: z.string().uuid(),
  triageAgentId: z.string().uuid(),
  emailEndpointId: z.string().uuid().nullable().optional(),
  installAgentId: z.string().uuid().nullable().optional(),
  reliabilityAgentId: z.string().uuid().nullable().optional(),
  coverAgentId: z.string().uuid().nullable().optional(),
  p1UserId: z.string().trim().min(1).nullable().optional(),
  holidays: z.array(isoDate).max(60).optional(),
});

const intakeSchema = z.object({
  clientCode: z.string().trim().min(2).max(12),
  subject: z.string().trim().min(1).max(200),
  body: z.string().max(20000).default(""),
  from: z.string().trim().max(320).nullable().optional(),
  receivedAt: z.coerce.date().optional(),
  priority: z.enum(SUPPORT_PRIORITIES).optional(),
});

const triageSchema = z
  .object({
    priority: z.enum(SUPPORT_PRIORITIES).optional(),
    category: z.enum(["general", "install", "reliability"]).optional(),
    respondedAt: z.coerce.date().optional(),
  })
  .refine((v) => v.priority || v.category || v.respondedAt, "Give a priority, a category or respondedAt");

const clientReplySchema = z.object({ body: z.string().trim().min(1).max(FLEET_SUPPORT_REPLY_MAX) }).strict();

/** Client support queue (GRE-665): queue setup, manual intake, triage and the ticket list. */
export function supportRoutes(db: Db, opts: { heartbeat?: Pick<ReturnType<typeof heartbeatService>, "wakeup"> } = {}) {
  const router = Router();
  const svc = supportQueueService(db, { wakeup: opts.heartbeat?.wakeup });
  const fleetSupport = fleetSupportService(db, { wakeup: opts.heartbeat?.wakeup });

  /** The support ticket behind an issue, checked for the caller: board user, or the owner, triage or cover agent. */
  async function assertTicketActor(req: Parameters<typeof assertBoard>[0], issueId: string) {
    const [row] = await db
      .select({ issue: issues, queue: supportQueues })
      .from(supportTickets)
      .innerJoin(issues, eq(issues.id, supportTickets.issueId))
      .innerJoin(supportQueues, eq(supportQueues.id, supportTickets.queueId))
      .where(eq(supportTickets.issueId, issueId));
    if (!row || !hasCompanyAccess(req, row.issue.companyId)) throw notFound("This issue is not a support ticket");
    assertCompanyAccess(req, row.issue.companyId);
    if (req.actor.type === "agent") {
      const allowed = [row.issue.assigneeAgentId, row.queue.triageAgentId, row.queue.coverAgentId];
      if (!req.actor.agentId || !allowed.includes(req.actor.agentId))
        throw forbidden("Only the ticket owner or the queue's triage or cover agent can act on this ticket");
    } else {
      assertBoard(req);
    }
    return row;
  }

  router.get("/companies/:companyId/support-queues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listQueues(companyId));
  });

  router.put("/companies/:companyId/support-queues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyOwnerOrAdmin(req, companyId);
    const parsed = queueSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid support queue");
    res.json(await svc.configureQueue(companyId, parsed.data));
  });

  router.get("/companies/:companyId/support-tickets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listTickets(companyId));
  });

  // A board user logs a client email that reached us some other way (or a test ticket).
  router.post("/companies/:companyId/support-tickets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const parsed = intakeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid support ticket");
    const { clientCode, ...input } = parsed.data;
    const created = await svc.intake(companyId, clientCode, input);
    res.status(201).json(created);
  });

  // Triage (priority, kind of fault) or record a first response made outside email.
  router.post("/issues/:issueId/support-ticket", async (req, res) => {
    const issueId = req.params.issueId as string;
    await assertTicketActor(req, issueId);
    const parsed = triageSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid triage");
    res.json(await svc.triage(issueId, parsed.data));
  });

  // GRE-1084: a reply for the client of a ticket that came from their instance.
  // It goes back on the instance's next sync; internal comments never do.
  router.post("/issues/:issueId/support-ticket/client-reply", async (req, res) => {
    const issueId = req.params.issueId as string;
    await assertTicketActor(req, issueId);
    const parsed = clientReplySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid reply");
    res.status(201).json(await fleetSupport.reply(issueId, parsed.data.body, getActorInfo(req)));
  });

  return router;
}
