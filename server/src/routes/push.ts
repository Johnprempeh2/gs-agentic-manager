import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { companies } from "@greatstone/db";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { pushNotificationService } from "../services/push-notifications.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const base64url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/);

export const pushSubscriptionSchema = z.object({
  // Push services are HTTPS only; never let a caller point the server elsewhere.
  endpoint: z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Push endpoint must be HTTPS"),
  keys: z.object({ p256dh: base64url.max(200), auth: base64url.max(100) }),
});

const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2048) });

function boardUserId(req: Request, res: Response, companyId: string) {
  assertCompanyAccess(req, companyId);
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

/** Phone notifications for decisions (Web Push). Company-scoped, board users only. */
export function pushRoutes(db: Db, service = pushNotificationService(db)) {
  const router = Router();

  router.get("/companies/:companyId/push/config", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = boardUserId(req, res, companyId);
    if (!userId) return;
    const endpoint = typeof req.query.endpoint === "string" ? req.query.endpoint : null;
    res.json({
      publicKey: service.publicKey(),
      subscribed: endpoint ? await service.isSubscribed(companyId, userId, endpoint) : false,
    });
  });

  router.post("/companies/:companyId/push/subscriptions", validate(pushSubscriptionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = boardUserId(req, res, companyId);
    if (!userId) return;
    const body = req.body as z.infer<typeof pushSubscriptionSchema>;
    const row = await service.subscribe(companyId, userId, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: req.get("user-agent")?.slice(0, 300) ?? null,
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "push_subscription.saved",
      entityType: "push_subscription",
      entityId: row.id,
      // The endpoint is a capability URL; log only its push service host.
      details: { pushService: new URL(body.endpoint).host },
    });
    res.status(201).json({ ok: true });
  });

  router.delete("/companies/:companyId/push/subscriptions", validate(unsubscribeSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = boardUserId(req, res, companyId);
    if (!userId) return;
    const { endpoint } = req.body as z.infer<typeof unsubscribeSchema>;
    const removed = await service.unsubscribe(companyId, userId, endpoint);
    if (removed) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "push_subscription.removed",
        entityType: "push_subscription",
        entityId: companyId,
        details: { pushService: new URL(endpoint).host },
      });
    }
    res.json({ ok: true, removed });
  });

  router.post("/companies/:companyId/push/test", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = boardUserId(req, res, companyId);
    if (!userId) return;
    const [company] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
    res.json(await service.sendTest(companyId, userId, company?.prefix ?? ""));
  });

  return router;
}
