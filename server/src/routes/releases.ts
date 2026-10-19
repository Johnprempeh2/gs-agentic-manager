// Releases page API (GRE-121; the page is GRE-122). Releasing stays John's
// decision: every action is board only, and agents get 403. Two exceptions:
// the release manager agent (Keystone) may edit the next version's title, and
// an agent may flag its own running run "finish before update".
//
// Release, rollback, promote, cancel, override and the next title are for
// company owners and admins only (and instance admins, and the implicit local
// board): an operator or viewer gets 403 "Owner or admin role required". The
// overview (GET) stays open to every member of the company, since it only
// reads.
//
// A release request (Release now, POST /release, the "Update live?" card) goes
// to the release queue; rollback, cancel and override go through
// liveReleaseService. Nothing here repeats release logic.
//
// Release, rollback and promote also ask for the password again in login mode
// (GRE-133, wired by GRE-136): the company, board and role checks run first,
// then the shared `assertReleaseReauth`.
import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import { isUuidLike } from "@greatstone/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { logActivity } from "../services/index.js";
import { liveReleaseService } from "../services/live-release.js";
import { QUEUE_ITEM_ID_RE, QUEUE_REF_RE, releaseQueueService } from "../services/release-queue.js";
import { assertReleaseReauth, releaseReauth, type ReleaseReauth } from "../services/release-reauth.js";
import { assertBoard, assertCompanyAccess, assertCompanyOwnerOrAdmin, getActorInfo, hasCompanyAccess } from "./authz.js";

type ActionResult =
  | { ok: true; progress: unknown }
  | { ok: false; status: 403 | 409 | 422; error: string };

export function releaseRoutes(db: Db, reauth: ReleaseReauth = releaseReauth(db)) {
  const router = Router();
  const svc = liveReleaseService(db);
  const queue = releaseQueueService();

  /** Read only: any board member of the company. */
  function assertBoardFor(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
  }

  /** Changes live or a release in progress: owner or admin only. */
  function assertReleaserFor(req: Request, companyId: string) {
    assertCompanyOwnerOrAdmin(req, companyId);
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

  // Kept for older callers: it no longer releases from the server (that path
  // skipped the preview). Like Release now, it adds the tag, or main when there
  // is none, to the release queue and answers with the queue item.
  router.post("/companies/:companyId/releases/release", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertReleaserFor(req, companyId);
    assertReleaseReauth(req, "release", reauth);
    const tag = typeof req.body?.tag === "string" && req.body.tag.trim() ? req.body.tag.trim() : null;
    const title = typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim() : null;
    if (tag !== null && !/^rc-\d{4}-\d{2}-\d{2}\.\d+$/.test(tag)) {
      res.status(422).json({ error: "a release needs an rc-YYYY-MM-DD.N tag, or no tag for main" });
      return;
    }
    const repo = queueTarget(res);
    if (!repo) return;
    const result = await queue.enqueue(repo, { ref: tag ?? "main", title, by: `user:${getActorInfo(req).actorId}` });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    await log(req, companyId, "release.queued", { tag: result.item.ref, queueId: result.item.id });
    res.status(202).json({ item: result.item, queue: queue.view() });
  });

  router.post("/companies/:companyId/releases/rollback", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertReleaserFor(req, companyId);
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
    assertReleaserFor(req, companyId);
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
    assertReleaserFor(req, companyId);
    const result = await svc.cancel(userActor(req));
    if (result.ok) await log(req, companyId, "release.cancelled", { tag: result.job.tag });
    send(res, result.ok ? { ok: true, progress: result.progress } : result, 200);
  });

  router.post("/companies/:companyId/releases/override", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertReleaserFor(req, companyId);
    const result = await svc.override(userActor(req));
    if (result.ok) await log(req, companyId, "release.override", { tag: result.job.tag });
    send(res, result.ok ? { ok: true, progress: result.progress } : result, 200);
  });

  // An owner or admin, or the release manager agent; only the title.
  router.patch("/companies/:companyId/releases/next", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      assertReleaserFor(req, companyId);
    } else {
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

  // The release queue (scripts/greatstone-release-queue.mjs): the board and
  // the release manager agent read it and add to it; only an owner or admin
  // cancels. A request goes through the full test gate, the preview and the
  // release script on the PC; nothing here releases.
  async function assertBoardOrReleaseManager(req: Request, companyId: string) {
    if (req.actor.type !== "none" && !hasCompanyAccess(req, companyId)) throw notFound("Company not found");
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    const agentId = req.actor.type === "agent" ? req.actor.agentId : null;
    if (!agentId || !(await svc.isReleaseManagerAgent(companyId, agentId))) {
      throw forbidden("Only the board or the release manager can use the release queue");
    }
  }

  function queueTarget(res: Response): string | null {
    const off = svc.releaseOffReason();
    const repo = off ? null : svc.releaseRepo();
    if (!repo) {
      res.status(409).json({ error: off ?? "release is off on this server: no release repo (GSAM_RELEASE_REPO or ~/GSAM/release.conf)" });
      return null;
    }
    return repo;
  }

  router.get("/companies/:companyId/releases/queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardOrReleaseManager(req, companyId);
    res.json(queue.view());
  });

  router.post("/companies/:companyId/releases/queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardOrReleaseManager(req, companyId);
    if (req.actor.type === "board") {
      assertReleaserFor(req, companyId);
      assertReleaseReauth(req, "release", reauth);
    }
    const extra = Object.keys(req.body ?? {}).filter((key) => key !== "ref" && key !== "title");
    const ref = req.body?.ref ?? "main";
    const title = req.body?.title ?? null;
    if (extra.length > 0 || typeof ref !== "string" || !QUEUE_REF_RE.test(ref) || (title !== null && typeof title !== "string")) {
      res.status(422).json({ error: "send { ref?: \"main\" | rc-YYYY-MM-DD.N | commit sha, title?: string }" });
      return;
    }
    const repo = queueTarget(res);
    if (!repo) return;
    const actor = getActorInfo(req);
    const result = await queue.enqueue(repo, { ref, title: title?.trim() || null, by: `${actor.actorType}:${actor.actorId}` });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    await log(req, companyId, "release.queued", { tag: result.item.ref, queueId: result.item.id });
    res.status(202).json({ item: result.item, queue: queue.view() });
  });

  router.post("/companies/:companyId/releases/queue/:itemId/cancel", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (req.actor.type !== "none" && !hasCompanyAccess(req, companyId)) throw notFound("Company not found");
    assertReleaserFor(req, companyId);
    const itemId = req.params.itemId as string;
    if (!QUEUE_ITEM_ID_RE.test(itemId)) throw notFound("No such request in the release queue");
    const repo = queueTarget(res);
    if (!repo) return;
    const actor = getActorInfo(req);
    const result = await queue.cancel(repo, { id: itemId, by: `${actor.actorType}:${actor.actorId}` });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    await log(req, companyId, "release.queue_cancelled", { tag: result.item.ref, queueId: itemId });
    res.json({ item: result.item, queue: queue.view() });
  });

  // An agent on its own running run, or the board on any run of its company.
  router.post("/heartbeat-runs/:runId/finish-before-update", async (req, res) => {
    const runId = req.params.runId as string;
    if (!isUuidLike(runId)) throw badRequest("runId must be a UUID");
    const run = await svc.findRun(runId);
    if (!run || !hasCompanyAccess(req, run.companyId)) throw notFound("Run not found");
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
