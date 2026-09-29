// Releases page API (GRE-121; the page is GRE-122). Releasing stays John's
// decision: every action is board only, and agents get 403. Two exceptions:
// the release manager agent (Keystone) may edit the next version's title, and
// an agent may flag its own running run "finish before update".
//
// Every action goes through liveReleaseService, the same service the
// "Update live?" card uses; nothing here repeats release logic.
//
// Release, rollback and promote also ask for the password again in login mode
// (GRE-133, wired by GRE-136): the company and board checks run first, then
// the shared `assertReleaseReauth`.
import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import { isUuidLike } from "@greatstone/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { logActivity } from "../services/index.js";
import { liveReleaseService } from "../services/live-release.js";
import { assertReleaseReauth, releaseReauth, type ReleaseReauth } from "../services/release-reauth.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

type ActionResult =
  | { ok: true; progress: unknown }
  | { ok: false; status: 403 | 409 | 422; error: string };

export function releaseRoutes(db: Db, reauth: ReleaseReauth = releaseReauth(db)) {
  const router = Router();
  const svc = liveReleaseService(db);

  function assertBoardFor(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
  }

  async function log(req: Request, companyId: string, action: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action,
      entityType: "release",
      entityId: typeof details.tag === "string" ? details.tag : "live",
      ...(actor.agentId ? { agentId: actor.agentId } : {}),
      ...(actor.runId ? { runId: actor.runId } : {}),
      details,
    });
  }

  function send(res: Response, result: ActionResult, okStatus: number) {
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(okStatus).json({ progress: result.progress });
  }

  const userActor = (req: Request) => ({ actorType: "user", actorId: getActorInfo(req).actorId });

  router.get("/companies/:companyId/releases", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardFor(req, companyId);
    res.json(await svc.overview(companyId));
  });

  router.post("/companies/:companyId/releases/release", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardFor(req, companyId);
    assertReleaseReauth(req, "release", reauth);
    const tag = typeof req.body?.tag === "string" && req.body.tag.trim() ? req.body.tag.trim() : null;
    const title = typeof req.body?.title === "string" ? req.body.title : null;
    const result = await svc.start({ kind: "release", tag, title, actor: userActor(req) });
    if (result.ok) await log(req, companyId, "release.started", { tag: result.job.tag, fromMain: tag === null });
    send(res, result.ok ? { ok: true, progress: result.progress } : result, 202);
  });

  router.post("/companies/:companyId/releases/rollback", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardFor(req, companyId);
    assertReleaseReauth(req, "rollback", reauth);
    const tag = typeof req.body?.tag === "string" ? req.body.tag.trim() : null;
    const result = await svc.start({ kind: "rollback", tag, actor: userActor(req) });
    if (result.ok) await log(req, companyId, "release.rollback_started", { tag: result.job.tag });
    send(res, result.ok ? { ok: true, progress: result.progress } : result, 202);
  });

  // "Promote to Stable" (GRE-127): a stable-* tag on a live-* release, with
  // the client notes as its message.
  router.post("/companies/:companyId/releases/promote", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardFor(req, companyId);
    assertReleaseReauth(req, "promote", reauth);
    const result = await svc.promote({ liveTag: req.body?.liveTag, notes: req.body?.notes });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    await log(req, companyId, "release.promoted_to_stable", { tag: result.stable.tag, liveTag: result.stable.liveTag });
    res.status(201).json({ stable: result.stable });
  });

  router.post("/companies/:companyId/releases/cancel", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardFor(req, companyId);
    const result = await svc.cancel(userActor(req));
    if (result.ok) await log(req, companyId, "release.cancelled", { tag: result.job.tag });
    send(res, result.ok ? { ok: true, progress: result.progress } : result, 200);
  });

  router.post("/companies/:companyId/releases/override", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardFor(req, companyId);
    const result = await svc.override(userActor(req));
    if (result.ok) await log(req, companyId, "release.override", { tag: result.job.tag });
    send(res, result.ok ? { ok: true, progress: result.progress } : result, 200);
  });

  // Board or the release manager agent; only the title.
  router.patch("/companies/:companyId/releases/next", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      const agentId = req.actor.type === "agent" ? req.actor.agentId : null;
      if (!agentId || !(await svc.isReleaseManagerAgent(companyId, agentId))) {
        throw forbidden("Only the board or the release manager can edit the next title");
      }
    }
    const extra = Object.keys(req.body ?? {}).filter((key) => key !== "title");
    if (extra.length > 0) {
      res.status(422).json({ error: `only the title can be edited (not ${extra.join(", ")})` });
      return;
    }
    const actor = getActorInfo(req);
    const result = await svc.setNextTitle({ title: req.body?.title, editedBy: `${actor.actorType}:${actor.actorId}` });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    await log(req, companyId, "release.next_title_edited", { title: (req.body.title as string).trim() });
    res.json({ next: result.next });
  });

  // An agent on its own running run, or the board on any run of its company.
  router.post("/heartbeat-runs/:runId/finish-before-update", async (req, res) => {
    const runId = req.params.runId as string;
    if (!isUuidLike(runId)) throw badRequest("runId must be a UUID");
    const run = await svc.findRun(runId);
    if (!run) throw notFound("Run not found");
    assertCompanyAccess(req, run.companyId);
    if (req.actor.type === "agent") {
      if (req.actor.agentId !== run.agentId || req.actor.runId !== runId) {
        throw forbidden("An agent can flag only its own current run");
      }
    } else {
      assertBoard(req);
    }
    if (typeof req.body?.enabled !== "boolean") {
      res.status(422).json({ error: "enabled must be true or false" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await svc.setRunFlag({
      runId,
      companyId: run.companyId,
      agentId: run.agentId,
      enabled: req.body.enabled,
      reason: typeof req.body.reason === "string" ? req.body.reason : null,
      by: `${actor.actorType}:${actor.actorId}`,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ runId, finishBeforeUpdate: req.body.enabled, flag: result.flag });
  });

  return router;
}
