import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { CALENDAR_MAX_DAYS, calendarService } from "../services/calendar.js";
import { calendarFeedService } from "../services/calendar-feed.js";
import { runtimeCanonicalOrigin } from "../services/cloud-runtime-identity.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));

const calendarQuerySchema = z.object({ from: isoDate, to: isoDate });

/** Company calendar: task due dates, scheduled routine runs and goal target dates in a window. */
export function calendarRoutes(db: Db) {
  const router = Router();
  const svc = calendarService(db);
  const feeds = calendarFeedService(db);

  /** Turning the feed on publishes deadlines at a secret URL, so it needs the same right as other connections. */
  async function assertManager(req: Request, companyId: string) {
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

  async function audit(req: Request, companyId: string, action: string) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "company",
      entityId: companyId,
    });
  }

  router.get("/companies/:companyId/calendar-feed", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await feeds.status(companyId));
  });

  router.post("/companies/:companyId/calendar-feed", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertManager(req, companyId);
    const feed = await feeds.enable(companyId, req.actor.userId ?? null);
    await audit(req, companyId, "calendar_feed.enabled");
    res.status(201).json(feed);
  });

  router.delete("/companies/:companyId/calendar-feed", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertManager(req, companyId);
    await feeds.disable(companyId);
    await audit(req, companyId, "calendar_feed.disabled");
    res.json({ ok: true });
  });

  // Calendar apps cannot send headers, so the secret is the URL itself.
  router.get("/calendar-feeds/:file", async (req, res) => {
    const match = /^(gsam_cal_[a-f0-9]{48})\.ics$/.exec(req.params.file as string);
    if (!match) throw notFound("Calendar feed not found");
    const origin = runtimeCanonicalOrigin() ?? `${req.protocol}://${req.get("host")}`;
    const ics = await feeds.render(match[1]!, origin);
    if (!ics) throw notFound("Calendar feed not found");
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(ics);
  });

  router.get("/companies/:companyId/calendar", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = calendarQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("`from` and `to` must be dates in YYYY-MM-DD form");
    const { from, to } = parsed.data;
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (days < 0) throw badRequest("`to` must be on or after `from`");
    if (days >= CALENDAR_MAX_DAYS) throw badRequest(`The calendar shows at most ${CALENDAR_MAX_DAYS} days at a time`);
    res.json(await svc.build(companyId, from, to));
  });

  return router;
}
