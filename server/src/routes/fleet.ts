import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { fleetInstanceCodeSchema, fleetRegisterRequestSchema, fleetSignedRequestSchema } from "@greatstone/shared/fleet";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { FleetMessageError, fleetHubEnabled, fleetService } from "../services/fleet.js";
import { assertInstanceAdmin } from "./authz.js";

// Fleet hub (GRE-1082). Two routers:
// - fleetHubRoutes: the hub's instance admins create, list and revoke
//   instances and read their check-ins. Clients never log in to the hub.
// - fleetSpokeRoutes: what a client instance calls. No session; the signed
//   message is the whole authorization. It answers only with the caller's own
//   registration result, never with another instance's facts.
// Both answer 404 unless GSAM_FLEET_HUB=true. No route sends a command to a spoke.

const createInstanceSchema = z.object({ code: fleetInstanceCodeSchema }).strict();

export function fleetHubRoutes(db: Db) {
  const router = Router();
  const fleet = fleetService(db);

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

export function fleetSpokeRoutes(db: Db) {
  const router = Router();
  const fleet = fleetService(db);

  router.use("/api/fleet/spoke", (_req, res, next) => {
    if (!fleetHubEnabled()) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.set("Cache-Control", "no-store");
    next();
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

  const signed = (handle: (message: string) => Promise<unknown>) => async (req: Request, res: Response) => {
    const body = fleetSignedRequestSchema.safeParse(req.body);
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

  return router;
}
