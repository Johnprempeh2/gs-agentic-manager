import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { onboardingQuestService } from "../services/onboarding-quest.js";
import type { QuestFeatures } from "@greatstone/shared";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "./authz.js";

const visitSchema = z.object({ step: z.string().regex(/^[a-z0-9-]{1,64}$/) }).strict();
const skipSchema = z.object({ chapter: z.string().regex(/^[a-z0-9-]{1,64}$/), skipped: z.boolean() }).strict();

/**
 * Getting started: the person's own quest (`/me`, any active member, viewers
 * included, because it writes nothing but their own progress), and an owner's
 * read of a member's progress. People only; agents never play it.
 */
export function onboardingQuestRoutes(db: Db, opts: { features?: () => QuestFeatures } = {}) {
  const router = Router();
  const quest = onboardingQuestService(db, opts);
  const access = accessService(db);

  function me(req: Request) {
    assertAuthenticated(req);
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const userId = req.actor.userId;
    if (!userId) throw forbidden("Board user context required");
    const member = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin || (req.actor.companyIds ?? []).includes(companyId);
    if (!member) throw forbidden("User does not have access to this company");
    return { companyId, userId };
  }

  router.use("/companies/:companyId/onboarding", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.get("/companies/:companyId/onboarding/me", async (req, res) => {
    const { companyId, userId } = me(req);
    res.json(await quest.state(companyId, userId));
  });

  router.post("/companies/:companyId/onboarding/me/start", async (req, res) => {
    const { companyId, userId } = me(req);
    res.json(await quest.start(companyId, userId));
  });

  router.post("/companies/:companyId/onboarding/me/visits", validate(visitSchema), async (req, res) => {
    const { companyId, userId } = me(req);
    res.json(await quest.markVisit(companyId, userId, req.body.step));
  });

  router.post("/companies/:companyId/onboarding/me/chapters", validate(skipSchema), async (req, res) => {
    const { companyId, userId } = me(req);
    res.json(await quest.setChapterSkipped(companyId, userId, req.body.chapter, req.body.skipped));
  });

  router.post("/companies/:companyId/onboarding/me/practice/clear", async (req, res) => {
    const { companyId, userId } = me(req);
    res.json(await quest.clearPractice(companyId, userId));
  });

  router.post("/companies/:companyId/onboarding/me/replay", async (req, res) => {
    const { companyId, userId } = me(req);
    res.json(await quest.replay(companyId, userId));
  });

  // The owner's view on the member page: read only, never starts anything for the member.
  router.get("/companies/:companyId/members/:memberId/onboarding", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (req.actor.source !== "local_implicit" && !(await access.canUser(companyId, req.actor.userId, "users:manage_permissions"))) {
      throw forbidden("Permission denied");
    }
    const member = await access.getMemberById(companyId, req.params.memberId as string);
    if (!member || member.principalType !== "user") throw notFound("Member not found");
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await quest.state(companyId, member.principalId));
  });

  return router;
}
