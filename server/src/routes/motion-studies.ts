import { Router } from "express";
import type { Db } from "@greatstone/db";
import {
  createMotionStudySchema,
  importMotionStudiesSchema,
  motionStudiesQuerySchema,
  resolveMotionStudyProposalSchema,
  updateMotionStudySchema,
  type ImportMotionStudies,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { MOTION_STUDY_CONTENT_TYPE, MOTION_STUDY_CSP, motionStudyService, toMotionStudy } from "../services/motion-studies.js";
import type { StorageService } from "../storage/types.js";
import { notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";

// GS Studio's Motion section (GRE-2212): the Animation Lab's studies, their
// catalogue fields and the decisions on them. People set Status and Decision;
// an agent's change to either is kept as a proposal until a person answers it.

export function motionStudyRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = motionStudyService(db, storage);

  router.get("/companies/:companyId/motion-studies", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ studies: await svc.list(companyId, motionStudiesQuerySchema.parse(req.query)) });
  });

  router.post("/companies/:companyId/motion-studies", validate(createMotionStudySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const row = await svc.create(companyId, req.body, actor);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "motion_study.created",
      entityType: "motion_study",
      entityId: row.id,
      details: { number: row.number, slug: row.slug, title: row.title, source: row.source },
    });
    res.status(201).json(toMotionStudy(row));
  });

  router.post("/companies/:companyId/motion-studies/import", validate(importMotionStudiesSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    let input = req.body as ImportMotionStudies;
    // Decisions belong to people: studies an agent imports arrive New and Undecided.
    if (actor.actorType === "agent") {
      input = { studies: input.studies.map((study) => ({ ...study, status: "new", decision: "undecided" })) };
    }
    const result = await svc.importStudies(companyId, input, actor);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "motion_study.imported",
      entityType: "company",
      entityId: companyId,
      details: { created: result.created, updated: result.updated, slugs: result.studies.map((study) => study.slug) },
    });
    res.json(result);
  });

  router.get("/motion-studies/:id", async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Study not found");
    if (!row) return;
    res.json(toMotionStudy(row));
  });

  // The study page, sandboxed: its own scripts run, nothing outside it is reachable.
  router.get("/motion-studies/:id/preview", async (req, res, next) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Study not found");
    if (!row) return;
    const file = await svc.readHtml(row);
    if (!file) throw notFound("This study has no page");
    res.setHeader("Content-Type", MOTION_STUDY_CONTENT_TYPE);
    res.setHeader("Content-Length", String(file.asset.byteSize));
    res.setHeader("Content-Security-Policy", MOTION_STUDY_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "private, max-age=60");
    file.stream.on("error", (err) => next(err));
    file.stream.pipe(res);
  });

  // The card's still frame. An image only; nothing in it runs.
  router.get("/motion-studies/:id/poster", async (req, res, next) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Study not found");
    if (!row) return;
    const file = await svc.readPoster(row);
    if (!file) throw notFound("This study has no poster");
    res.setHeader("Content-Type", file.asset.contentType);
    res.setHeader("Content-Length", String(file.asset.byteSize));
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "private, max-age=86400");
    file.stream.on("error", (err) => next(err));
    file.stream.pipe(res);
  });

  router.patch("/motion-studies/:id", validate(updateMotionStudySchema), async (req, res) => {
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Study not found");
    if (!row) return;
    // Write path: the oracle guard wants the read gate named before the write check.
    if (!hasCompanyAccess(req, row.companyId)) throw notFound("Study not found");
    assertCompanyAccess(req, row.companyId);
    const actor = getActorInfo(req);
    const { row: updated, proposed } = await svc.update(row, req.body, actor);
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: proposed ? "motion_study.proposed" : "motion_study.updated",
      entityType: "motion_study",
      entityId: row.id,
      details: {
        before: { status: row.status, decision: row.decision },
        after: { status: updated.status, decision: updated.decision },
        proposal: proposed ? { status: updated.proposedStatus, decision: updated.proposedDecision } : null,
      },
    });
    res.json(toMotionStudy(updated));
  });

  router.post("/motion-studies/:id/proposal", validate(resolveMotionStudyProposalSchema), async (req, res) => {
    assertBoard(req);
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Study not found");
    if (!row) return;
    if (!hasCompanyAccess(req, row.companyId)) throw notFound("Study not found");
    assertCompanyAccess(req, row.companyId);
    const updated = await svc.resolveProposal(row, req.body.accept);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: req.body.accept ? "motion_study.proposal_accepted" : "motion_study.proposal_declined",
      entityType: "motion_study",
      entityId: row.id,
      details: {
        proposal: { status: row.proposedStatus, decision: row.proposedDecision },
        proposedByAgentId: row.proposedByAgentId,
      },
    });
    res.json(toMotionStudy(updated));
  });

  router.delete("/motion-studies/:id", async (req, res) => {
    assertBoard(req);
    const row = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Study not found");
    if (!row) return;
    await svc.remove(row.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "motion_study.deleted",
      entityType: "motion_study",
      entityId: row.id,
      details: { number: row.number, slug: row.slug, assetId: row.assetId },
    });
    res.status(204).end();
  });

  return router;
}
