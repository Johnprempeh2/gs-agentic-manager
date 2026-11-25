import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import {
  fleetActivateRequestSchema,
  fleetEntitlementInputSchema,
  fleetInstanceCodeSchema,
  fleetLicenceCreateSchema,
  fleetRegisterRequestSchema,
  fleetSignedRequestSchema,
} from "@greatstone/shared/fleet";
import { badRequest, conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { FLEET_SUPPORT_MESSAGE_MAX_CHARS, fleetSupportAttachmentRequestSchema } from "@greatstone/shared/fleet-support";
import { FleetMessageError, fleetHubEnabled, fleetService } from "../services/fleet.js";
import { readHubSigningKey } from "../services/fleet-entitlements.js";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";
import { inviteRateLimitMiddleware } from "../middleware/invite-rate-limit.js";
import { fleetSupportService } from "../services/fleet-support.js";
import type { heartbeatService } from "../services/heartbeat.js";
import type { StorageService } from "../storage/types.js";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";

// Fleet hub (GRE-1082). Two routers:
// - fleetHubRoutes: the hub's instance admins create, list, revoke and remove
//   instances and read their check-ins. Clients never log in to the hub.
// - fleetSpokeRoutes: what a client instance calls. No session; the signed
//   message is the whole authorization. It answers only with the caller's own
//   registration result, never with another instance's facts.
// Both answer 404 unless GSAM_FLEET_HUB=true. No route sends a command to a spoke.

const createInstanceSchema = z.object({ code: fleetInstanceCodeSchema }).strict();
const supportQueueLinkSchema = z.object({ supportQueueId: z.string().uuid().nullable() }).strict();
const supportSyncRequestSchema = z.object({ message: z.string().min(1).max(FLEET_SUPPORT_MESSAGE_MAX_CHARS) }).strict();

/** The hub's signing key, or a clear refusal: licences and documents need it. */
function hubSigningKey() {
  const key = readHubSigningKey();
  if (!key) throw conflict("The hub has no entitlement signing key (GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY)");
  return key;
}

function issuedByLabel(req: Request) {
  return req.actor.type === "board" ? (req.actor.userEmail ?? req.actor.userId ?? "hub") : "hub";
}

/** A document must end after it is issued, or every install refuses it. */
function assertFutureValidUntil(validUntil: string) {
  if (Date.parse(validUntil) <= Date.now()) throw badRequest("validUntil must be in the future");
}

type FleetRouteDeps = { storage?: StorageService; heartbeat?: Pick<ReturnType<typeof heartbeatService>, "wakeup"> };

export function fleetHubRoutes(db: Db) {
  const router = Router();
  const fleet = fleetService(db);
  const support = fleetSupportService(db);

  router.use("/fleet", (req, _res, next) => {
    if (!fleetHubEnabled()) throw notFound();
    assertInstanceAdmin(req);
    next();
  });

  router.get("/fleet/instances", async (_req, res) => {
    res.json(await fleet.list());
  });

  router.post("/fleet/instances", validate(createInstanceSchema), async (req, res) => {
    const userId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
    const created = await fleet.create(req.body.code, userId);
    if (!created) throw conflict("An instance with this code exists");
    logger.info({ fleetInstanceId: created.instance.id, userId }, "Fleet instance created");
    res.set("Cache-Control", "no-store");
    res.status(201).json(created);
  });

  // GSAM for Mac (P1): a licence key, shown once, for a new pending instance with its first signed document.
  router.post("/fleet/licences", validate(fleetLicenceCreateSchema), async (req, res) => {
    assertFutureValidUntil(req.body.validUntil);
    const key = hubSigningKey();
    const userId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
    const created = await fleet.createLicence(req.body, { userId, label: issuedByLabel(req) }, key);
    if (!created) throw conflict("An instance with this code exists");
    logger.info({ fleetInstanceId: created.instance.id, userId }, "Fleet licence created");
    res.set("Cache-Control", "no-store");
    res.status(201).json(created);
  });

  // A newer signed document; the install gets it with its next check-in answer.
  router.put("/fleet/instances/:id/entitlement", validate(fleetEntitlementInputSchema), async (req, res) => {
    assertFutureValidUntil(req.body.validUntil);
    const updated = await fleet.issueEntitlement(req.params.id as string, req.body, issuedByLabel(req), hubSigningKey());
    if (!updated) throw notFound("Fleet instance not found");
    logger.info({ fleetInstanceId: updated.id, entitlementVersion: updated.entitlementVersion }, "Fleet entitlement document issued");
    res.json(updated);
  });

  // The Greatstone operator log-in of a licensed install, for remote help. Never logged.
  router.get("/fleet/instances/:id/operator-login", async (req, res) => {
    const login = await fleet.operatorLogin(req.params.id as string);
    if (!login) throw notFound("No operator log-in for this instance");
    logger.info({ fleetInstanceId: req.params.id }, "Fleet operator log-in read");
    res.set("Cache-Control", "no-store");
    res.json(login);
  });

  router.post("/fleet/instances/:id/registration-code", async (req, res) => {
    const reissued = await fleet.reissueCode(req.params.id as string);
    if (!reissued) {
      if (!(await fleet.get(req.params.id as string))) throw notFound("Fleet instance not found");
      throw conflict("The instance is registered; revoke it first");
    }
    res.set("Cache-Control", "no-store");
    res.status(201).json(reissued);
  });

  router.post("/fleet/instances/:id/revoke", async (req, res) => {
    if (!(await fleet.get(req.params.id as string))) throw notFound("Fleet instance not found");
    const revoked = await fleet.revokeFromHub(req.params.id as string);
    logger.info({ fleetInstanceId: revoked?.id }, "Fleet instance revoked by the hub");
    res.json(revoked);
  });

  router.delete("/fleet/instances/:id", async (req, res) => {
    const removed = await fleet.remove(req.params.id as string);
    if (!removed) throw notFound("Fleet instance not found");
    logger.info({ fleetInstanceId: removed.id }, "Fleet instance removed by the hub");
    res.json({ id: removed.id, removed: true });
  });

  // GRE-1084: the support queue this instance's "Get help" tickets land in. Null stops intake.
  router.put("/fleet/instances/:id/support-queue", validate(supportQueueLinkSchema), async (req, res) => {
    const actor = getActorInfo(req);
    const linked = await support.setSupportQueue(req.params.id as string, req.body.supportQueueId, actor);
    logger.info({ fleetInstanceId: linked.id, supportQueueId: linked.supportQueueId }, "Fleet instance support queue set");
    res.json(linked);
  });

  router.get("/fleet/instances/:id/check-ins", async (req, res) => {
    if (!(await fleet.get(req.params.id as string))) throw notFound("Fleet instance not found");
    const limit = Math.max(1, Math.min(288, Number.parseInt(String(req.query.limit ?? "12"), 10) || 12));
    res.json(await fleet.checkIns(req.params.id as string, limit));
  });

  return router;
}

function sendRejection(res: Response, error: unknown) {
  if (error instanceof FleetMessageError) {
    logger.warn({ code: error.code }, "Rejected fleet message");
    res.status(error.status).json({ error: error.code });
    return;
  }
  throw error;
}

export function fleetSpokeRoutes(db: Db, deps: FleetRouteDeps = {}) {
  const router = Router();
  const fleet = fleetService(db);
  const support = fleetSupportService(db, { storage: deps.storage, wakeup: deps.heartbeat?.wakeup });

  router.use("/api/fleet/spoke", (_req, res, next) => {
    if (!fleetHubEnabled()) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.set("Cache-Control", "no-store");
    next();
  });

  // GSAM for Mac (P1): licence activation. Public, so rate limited per address on top of the one-use key.
  const activationLimiter = createInviteRateLimiter({ windowMs: 10 * 60_000, maxRequests: 10 });
  router.post("/api/fleet/spoke/activate", inviteRateLimitMiddleware(activationLimiter), async (req, res) => {
    const body = fleetActivateRequestSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "fleet_bad_message" });
      return;
    }
    const key = readHubSigningKey();
    if (!key) {
      res.status(503).json({ error: "fleet_hub_not_signing" });
      return;
    }
    try {
      const result = await fleet.activate(body.data, key);
      logger.info({ fleetInstanceId: result.instanceId, os: body.data.facts.os, arch: body.data.facts.arch }, "Fleet licence activated");
      res.status(201).json(result);
    } catch (error) {
      sendRejection(res, error);
    }
  });

  router.post("/api/fleet/spoke/register", async (req, res) => {
    const body = fleetRegisterRequestSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "fleet_bad_message" });
      return;
    }
    try {
      const result = await fleet.register(body.data);
      logger.info({ fleetInstanceId: result.instanceId }, "Fleet instance registered");
      res.status(201).json(result);
    } catch (error) {
      sendRejection(res, error);
    }
  });

  const signed = (handle: (message: string) => Promise<unknown>, schema: z.ZodType<{ message: string }> = fleetSignedRequestSchema) => async (req: Request, res: Response) => {
    const body = schema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "fleet_bad_message" });
      return;
    }
    try {
      res.json(await handle(body.data.message));
    } catch (error) {
      sendRejection(res, error);
    }
  };

  router.post("/api/fleet/spoke/check-in", signed((message) => fleet.checkIn(message)));
  router.post("/api/fleet/spoke/revoke", signed((message) => fleet.revokeFromSpoke(message)));
  router.post("/api/fleet/spoke/delete", signed(async (message) => {
    const result = await fleet.deleteFromSpoke(message);
    logger.info("Fleet instance removed by the spoke");
    return result;
  }));
  // GRE-1084: the spoke's support tickets in, their status and our replies out. Only the caller's own tickets.
  router.post("/api/fleet/spoke/support-sync", signed(async (message) => {
    const answer = await support.sync(message);
    logger.info({ tickets: answer.tickets.length, refused: answer.refused.length }, "Fleet support sync");
    return answer;
  }, supportSyncRequestSchema));
  router.post("/api/fleet/spoke/support-attachment", async (req, res) => {
    const body = fleetSupportAttachmentRequestSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "fleet_bad_message" });
      return;
    }
    try {
      const result = await support.attachment(body.data.message, body.data.content);
      logger.info({ duplicate: result.duplicate }, "Fleet support attachment");
      res.json(result);
    } catch (error) {
      sendRejection(res, error);
    }
  });

  return router;
}
