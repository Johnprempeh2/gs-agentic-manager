import { Router } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { badRequest } from "../errors.js";
import { CALENDAR_MAX_DAYS, calendarService } from "../services/calendar.js";
import { assertCompanyAccess } from "./authz.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));

const calendarQuerySchema = z.object({ from: isoDate, to: isoDate });

/** Company calendar: task due dates, scheduled routine runs and goal target dates in a window. */
export function calendarRoutes(db: Db) {
  const router = Router();
  const svc = calendarService(db);

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
