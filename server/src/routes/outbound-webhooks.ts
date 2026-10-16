import { Router, type Request } from "express";
import type { Db } from "@greatstone/db";
import { createOutboundWebhookSchema, updateOutboundWebhookSchema } from "@greatstone/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { outboundWebhookService, type OutboundWebhookDeps } from "../services/outbound-webhooks.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Outbound webhooks: board routes to add, change, test and remove the URLs
 * GSAM posts events to, and to read each one's delivery log. Managing needs
 * tools:manage_connections, like other connections.
 */
export function outboundWebhookRoutes(db: Db, deps: OutboundWebhookDeps = {}) {
  const router = Router();
  const service = outboundWebhookService(db, deps);

  async function manager(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    if (
      !req.actor.userId ||
      !(await accessService(db).hasPermission(companyId, "user", req.actor.userId, "tools:manage_connections"))
    ) {
      throw forbidden("Missing permission: tools:manage_connections");
    }
  }

  async function audit(req: Request, companyId: string, action: string, webhookId: string, details: Record<string, unknown> = {}) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "outbound_webhook",
      entityId: webhookId,
      details,
    });
  }

  router.get("/companies/:companyId/outbound-webhooks", async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    res.json(await service.list(companyId));
  });

  router.post("/companies/:companyId/outbound-webhooks", validate(createOutboundWebhookSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    const webhook = await service.create(companyId, req.body, req.actor.userId ?? null);
    await audit(req, companyId, "outbound_webhook.created", webhook.id, { name: webhook.name, events: webhook.events });
    res.status(201).json(webhook);
  });

  router.patch("/companies/:companyId/outbound-webhooks/:webhookId", validate(updateOutboundWebhookSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    const webhook = await service.update(companyId, req.params.webhookId as string, req.body);
    const { url: _url, ...rest } = req.body as Record<string, unknown>;
    await audit(req, companyId, "outbound_webhook.updated", webhook.id, { ...rest, urlChanged: _url !== undefined });
    res.json(webhook);
  });

  router.post("/companies/:companyId/outbound-webhooks/:webhookId/test", async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    const delivery = await service.sendTest(companyId, req.params.webhookId as string);
    await audit(req, companyId, "outbound_webhook.tested", req.params.webhookId as string, { ok: delivery.ok, httpStatus: delivery.httpStatus });
    res.json(delivery);
  });

  router.get("/companies/:companyId/outbound-webhooks/:webhookId/deliveries", async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    res.json(await service.deliveries(companyId, req.params.webhookId as string));
  });

  router.delete("/companies/:companyId/outbound-webhooks/:webhookId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    const webhook = await service.remove(companyId, req.params.webhookId as string);
    await audit(req, companyId, "outbound_webhook.deleted", webhook.id, { name: webhook.name });
    res.json({ ok: true });
  });

  return router;
}
