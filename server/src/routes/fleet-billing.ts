import { Router } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { fleetBillingItemInputSchema, fleetBillingLinkSchema } from "@greatstone/shared/fleet";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { BILLING_EVENTS_SECRET_ENV, fleetBillingService, fleetCatalogueService, verifyBillingSignature, type StripeClient } from "../services/fleet-billing.js";
import { fleetHubEnabled, fleetService } from "../services/fleet.js";
import { readHubSigningKey } from "../services/fleet-entitlements.js";
import { logFleetActivity } from "../services/fleet-orders.js";
import { assertInstanceAdmin } from "./authz.js";

// GSAM for Mac (P3): payments and modules. Both routers answer 404 unless GSAM_FLEET_HUB=true.
// - fleetBillingHubRoutes: hub instance admins keep the catalogue and link installs to Stripe customers.
// - fleetBillingEventRoutes: Stripe events, forwarded by the website (or sent by Stripe) and signed
//   with GSAM_BILLING_EVENTS_SECRET in Stripe's signature format. No session.

const stripeEventSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  created: z.number().int().nonnegative(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

/** Tests pass a fake Stripe; the server reads GSAM_STRIPE_SECRET_KEY. */
type BillingRouteDeps = { stripe?: () => StripeClient | null };

export function fleetBillingHubRoutes(db: Db, deps: BillingRouteDeps = {}) {
  const router = Router();
  const catalogue = fleetCatalogueService(db, deps);

  router.use("/fleet", (req, _res, next) => {
    if (!fleetHubEnabled()) throw notFound();
    assertInstanceAdmin(req);
    next();
  });

  router.get("/fleet/catalogue", async (_req, res) => {
    res.json(await catalogue.list());
  });

  router.post("/fleet/catalogue", validate(fleetBillingItemInputSchema), async (req, res) => {
    const item = await catalogue.create(req.body);
    logger.info({ itemId: item.id, kind: item.kind }, "Fleet catalogue item created");
    res.status(201).json(item);
  });

  router.put("/fleet/catalogue/:id", validate(fleetBillingItemInputSchema), async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("Catalogue item not found");
    res.json(await catalogue.update(req.params.id as string, req.body));
  });

  router.delete("/fleet/catalogue/:id", async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound("Catalogue item not found");
    res.json(await catalogue.archive(req.params.id as string));
  });

  router.put("/fleet/instances/:id/billing", validate(fleetBillingLinkSchema), async (req, res) => {
    if (!(await fleetService(db).get(req.params.id as string))) throw notFound("Fleet instance not found");
    const row = await catalogue.link(req.params.id as string, req.body.stripeCustomerId);
    res.json({ stripeCustomerId: row.stripeCustomerId, stripeSubscriptionId: null, subscriptionStatus: null, cancelAtPeriodEnd: false });
  });

  return router;
}

export function fleetBillingEventRoutes(db: Db, deps: BillingRouteDeps = {}) {
  const router = Router();
  const billing = fleetBillingService(db, { ...deps, signingKey: () => readHubSigningKey() });

  router.post("/api/fleet/billing/events", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fleetHubEnabled()) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const secret = process.env[BILLING_EVENTS_SECRET_ENV]?.trim();
    if (!secret) {
      res.status(503).json({ error: "fleet_billing_not_configured" });
      return;
    }
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!raw || !verifyBillingSignature(raw, req.get("stripe-signature"), secret)) {
      logger.warn("Refused a billing event: bad or old signature");
      res.status(401).json({ error: "fleet_billing_bad_signature" });
      return;
    }
    const event = stripeEventSchema.safeParse(req.body);
    if (!event.success) {
      res.status(400).json({ error: "fleet_billing_bad_event" });
      return;
    }
    const result = await billing.handleEvent(event.data);
    logger.info({ eventType: event.data.type, outcome: result.outcome, fleetInstanceId: result.instanceId ?? null }, "Billing event");
    if (result.outcome === "processed" && result.instanceId) {
      await logFleetActivity(db, {
        actorUserId: null,
        action: "fleet.billing.event",
        instanceId: result.instanceId,
        details: { type: event.data.type, eventId: event.data.id, validUntil: result.validUntil ?? null, licenceCreated: Boolean(result.licenceKey) },
      }).catch((err: unknown) => logger.warn({ err: (err as Error).message }, "Billing event: activity log failed"));
    }
    res.json(result);
  });

  return router;
}
