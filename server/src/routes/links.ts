import { Router, type Request } from "express";
import type { Db } from "@greatstone/db";
import {
  createLinkSchema,
  importLinksSchema,
  linksQuerySchema,
  updateLinkSchema,
  type CreateLink,
  type ImportLinks,
  type UpdateLink,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { linkService, type LinkActor } from "../services/links.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

/**
 * The links register (GRE-4252). Board users and the company's agents may
 * read and write, as for deliverables. Archive, never delete: a link may
 * already have been sent to a client.
 */
export function linkRoutes(db: Db) {
  const router = Router();
  const svc = linkService(db);

  function actorOf(req: Request): LinkActor {
    const actor = getActorInfo(req);
    return {
      agentId: actor.agentId ?? null,
      userId: actor.actorType === "user" ? actor.actorId : null,
    };
  }

  async function activity(req: Request, companyId: string, action: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "link",
      entityId,
      details,
    });
  }

  router.get("/companies/:companyId/links", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = linksQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid links query", parsed.error.issues);
    res.json(await svc.list(companyId, parsed.data));
  });

  router.get("/companies/:companyId/links/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const link = await svc.get(companyId, req.params.id as string);
    if (!link) throw notFound("Link not found");
    res.json(link);
  });

  /** Add a link. The same URL again updates the stored row (200 instead of 201). */
  router.post("/companies/:companyId/links", validate(createLinkSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { link, created } = await svc.upsert(companyId, req.body as CreateLink, actorOf(req));
    await activity(req, companyId, created ? "link.created" : "link.updated", link.id, { url: link.url, title: link.title });
    res.status(created ? 201 : 200).json(link);
  });

  router.patch("/companies/:companyId/links/:id", validate(updateLinkSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = req.body as UpdateLink;
    const link = await svc.update(companyId, req.params.id as string, body);
    await activity(req, companyId, "link.updated", link.id, { fields: Object.keys(body) });
    res.json(link);
  });

  router.post("/companies/:companyId/links/:id/archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const link = await svc.archive(companyId, req.params.id as string);
    await activity(req, companyId, "link.archived", link.id, { url: link.url });
    res.json(link);
  });

  /** Load a CSV export of the Notion "Netlify Link Register". */
  router.post("/companies/:companyId/links/import", validate(importLinksSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.importCsv(companyId, (req.body as ImportLinks).csv, actorOf(req));
    await activity(req, companyId, "link.imported", companyId, {
      created: result.created,
      updated: result.updated,
      skipped: result.skipped.length,
    });
    res.json(result);
  });

  /** One-off fill from the deliverables and previews GSAM already holds. Safe to run again. */
  router.post("/companies/:companyId/links/backfill", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.backfill(companyId, actorOf(req));
    await activity(req, companyId, "link.backfilled", companyId, { ...result });
    res.json(result);
  });

  return router;
}
