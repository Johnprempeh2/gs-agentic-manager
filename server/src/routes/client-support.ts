import { Router } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import {
  FLEET_SUPPORT_ATTACHMENT_MAX_BYTES,
  FLEET_SUPPORT_CONTENT_TYPES,
  FLEET_SUPPORT_KINDS,
  FLEET_SUPPORT_PRIORITIES,
  FLEET_SUPPORT_SUMMARY_MAX,
  FLEET_SUPPORT_TITLE_MAX,
  clientSupportInboxSchema,
  fleetSupportFileNameSchema,
} from "@greatstone/shared/fleet-support";
import { badRequest, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { clientSupportService } from "../services/client-support.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";

// "Get help" in a client instance (GRE-1084). Two sets of routes:
// - company routes: the client's board member opens, edits and reads tickets
//   and picks files. Board users only: an agent never opens a ticket or an
//   upgrade request on the client's behalf.
// - instance routes: the operator log-in the host script uses to read the
//   outbox and write back the hub's answer.

const createSchema = z
  .object({
    kind: z.enum(FLEET_SUPPORT_KINDS).default("support"),
    title: z.string().trim().min(1).max(FLEET_SUPPORT_TITLE_MAX),
    summary: z.string().trim().max(FLEET_SUPPORT_SUMMARY_MAX).default(""),
    priority: z.enum(FLEET_SUPPORT_PRIORITIES).default("P3"),
    linkedIssueId: z.string().uuid().nullable().optional(),
  })
  .strict();

const editSchema = z
  .object({
    title: z.string().trim().min(1).max(FLEET_SUPPORT_TITLE_MAX).optional(),
    summary: z.string().trim().max(FLEET_SUPPORT_SUMMARY_MAX).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.summary !== undefined, "Give a title or a summary");

const attachSchema = z
  .object({
    name: fleetSupportFileNameSchema,
    contentType: z.enum(FLEET_SUPPORT_CONTENT_TYPES),
    contentBase64: z.string().min(1).max(Math.ceil(FLEET_SUPPORT_ATTACHMENT_MAX_BYTES / 3) * 4 + 4),
  })
  .strict();

export function clientSupportRoutes(db: Db, deps: { storage?: StorageService } = {}) {
  const router = Router();
  const svc = clientSupportService(db, { storage: deps.storage });

  const boardUser = (req: Parameters<typeof assertBoard>[0], companyId: string) => {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") throw badRequest("Board user required");
    return actor;
  };

  router.get("/companies/:companyId/client-support/tickets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.post("/companies/:companyId/client-support/tickets", validate(createSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = boardUser(req, companyId);
    res.status(201).json(await svc.create(companyId, req.body, actor));
  });

  router.patch("/companies/:companyId/client-support/tickets/:ticketId", validate(editSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = boardUser(req, companyId);
    res.json(await svc.edit(companyId, req.params.ticketId as string, req.body, actor));
  });

  router.post("/companies/:companyId/client-support/tickets/:ticketId/attachments", validate(attachSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = boardUser(req, companyId);
    const body = Buffer.from(req.body.contentBase64, "base64");
    if (body.length === 0 || body.length > FLEET_SUPPORT_ATTACHMENT_MAX_BYTES)
      throw unprocessable(`A file must be 1 byte to ${FLEET_SUPPORT_ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB`);
    res.status(201).json(await svc.attach(companyId, req.params.ticketId as string, { name: req.body.name, contentType: req.body.contentType, body }, actor));
  });

  router.get("/instance/client-support/outbox", async (req, res) => {
    assertInstanceAdmin(req);
    res.set("Cache-Control", "no-store");
    res.json(await svc.outbox());
  });

  router.get("/instance/client-support/attachments/:attachmentId/content", async (req, res) => {
    assertInstanceAdmin(req);
    res.set("Cache-Control", "no-store");
    res.json(await svc.attachmentContent(req.params.attachmentId as string));
  });

  router.post("/instance/client-support/inbox", validate(clientSupportInboxSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await svc.applyInbox(req.body));
  });

  return router;
}
