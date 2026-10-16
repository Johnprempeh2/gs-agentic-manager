import { Router } from "express";
import type { Db } from "@greatstone/db";
import { badRequest } from "../errors.js";
import {
  AGENT_DAILY_DIGEST_MAX_RANGE_DAYS,
  agentDailyDigestService,
  previousUtcDay,
  utcDayWindow,
} from "../services/agent-daily-digest.js";
import { assertCompanyAccess } from "./authz.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function readDate(value: unknown, name: string): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !DATE.test(value)) throw badRequest(`${name} must be a date like 2026-10-15`);
  try {
    utcDayWindow(value);
  } catch {
    throw badRequest(`${name} must be a real calendar date`);
  }
  return value;
}

/** The nightly digests of what each agent did, for the board and the company's own agents. */
export function agentDailyDigestRoutes(db: Db, service = agentDailyDigestService(db)) {
  const router = Router();

  router.get("/companies/:companyId/agent-daily-digests", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const to = readDate(req.query.to, "to") ?? previousUtcDay(new Date(Date.now() + DAY_MS));
    const from = readDate(req.query.from, "from") ?? new Date(utcDayWindow(to).start.getTime() - 6 * DAY_MS).toISOString().slice(0, 10);
    if (from > to) throw badRequest("from must not be after to");
    const days = (utcDayWindow(to).start.getTime() - utcDayWindow(from).start.getTime()) / DAY_MS + 1;
    if (days > AGENT_DAILY_DIGEST_MAX_RANGE_DAYS) {
      throw badRequest(`Ask for at most ${AGENT_DAILY_DIGEST_MAX_RANGE_DAYS} days at a time`);
    }
    res.json({ from, to, digests: await service.list(companyId, from, to) });
  });

  return router;
}
