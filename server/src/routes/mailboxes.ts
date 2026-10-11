import { Router, type Request } from "express";
import {
  isUuidLike,
  mailboxAgentsSchema,
  mailboxConnectSchema,
  mailboxReadSchema,
  mailboxSaveSchema,
  mailboxSearchSchema,
} from "@greatstone/shared";
import type { Db } from "@greatstone/db";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { accessService } from "../services/access.js";
import { badRequest, forbidden } from "../errors.js";
import type { StorageService } from "../storage/types.js";
import {
  mailboxService,
  type MailboxBoardActor,
  type MailboxReader,
} from "../services/mailboxes.js";
import type { MailboxClientFactory } from "../services/mailbox-imap.js";

// Read-only mailboxes (GRE-1343). Board users with tools:manage_connections add
// and remove them; agents reach only the mailboxes installed for them.
export function mailboxRoutes(
  db: Db,
  storage: StorageService,
  options: { clientFactory?: MailboxClientFactory } = {},
) {
  const router = Router();
  const service = mailboxService(db, { storage, clientFactory: options.clientFactory });

  router.param("companyId", (_req, _res, next, id) => {
    if (!isUuidLike(id)) throw badRequest("Invalid company");
    next();
  });
  router.param("mailboxId", (_req, _res, next, id) => {
    if (!isUuidLike(id)) throw badRequest("Invalid mailbox");
    next();
  });

  async function manager(req: Request, companyId: string): Promise<MailboxBoardActor> {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const actor = {
      userId: req.actor.userId ?? "board",
      localImplicit: req.actor.source === "local_implicit",
    };
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return actor;
    if (
      !req.actor.userId ||
      !(await accessService(db).hasPermission(
        companyId,
        "user",
        req.actor.userId,
        "tools:manage_connections",
      ))
    )
      throw forbidden("Missing permission: tools:manage_connections");
    return actor;
  }

  async function reader(req: Request, companyId: string): Promise<MailboxReader> {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      return { kind: "agent", agentId: req.actor.agentId, runId: req.actor.runId ?? undefined };
    }
    const actor = await manager(req, companyId);
    return { kind: "board", userId: actor.userId };
  }

  router.get("/companies/:companyId/mailboxes", async (req, res) => {
    const companyId = String(req.params.companyId);
    const who = await reader(req, companyId);
    res.set("Cache-Control", "no-store").json(
      who.kind === "agent"
        ? await service.assigned(companyId, who.agentId)
        : await service.list(companyId),
    );
  });

  router.post(
    "/companies/:companyId/mailboxes",
    validate(mailboxConnectSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const actor = await manager(req, companyId);
      res.status(201).json(await service.connect(companyId, req.body, actor));
    },
  );

  router.put(
    "/companies/:companyId/mailboxes/:mailboxId/agents",
    validate(mailboxAgentsSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const actor = await manager(req, companyId);
      res.json(
        await service.setAgents(companyId, String(req.params.mailboxId), req.body, actor),
      );
    },
  );

  router.delete("/companies/:companyId/mailboxes/:mailboxId", async (req, res) => {
    const companyId = String(req.params.companyId);
    const actor = await manager(req, companyId);
    res.json(await service.remove(companyId, String(req.params.mailboxId), actor));
  });

  router.post("/companies/:companyId/mailboxes/:mailboxId/test", async (req, res) => {
    const companyId = String(req.params.companyId);
    await manager(req, companyId);
    res.json(await service.test(companyId, String(req.params.mailboxId)));
  });

  router.get("/companies/:companyId/mailboxes/:mailboxId/folders", async (req, res) => {
    const companyId = String(req.params.companyId);
    const who = await reader(req, companyId);
    res
      .set("Cache-Control", "no-store")
      .json(await service.folders(companyId, String(req.params.mailboxId), who));
  });

  router.post(
    "/companies/:companyId/mailboxes/:mailboxId/search",
    validate(mailboxSearchSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const who = await reader(req, companyId);
      res
        .set("Cache-Control", "no-store")
        .json(await service.search(companyId, String(req.params.mailboxId), req.body, who));
    },
  );

  router.post(
    "/companies/:companyId/mailboxes/:mailboxId/read",
    validate(mailboxReadSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const who = await reader(req, companyId);
      res
        .set("Cache-Control", "no-store")
        .json(await service.read(companyId, String(req.params.mailboxId), req.body, who));
    },
  );

  router.post(
    "/companies/:companyId/mailboxes/:mailboxId/save",
    validate(mailboxSaveSchema),
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const who = await reader(req, companyId);
      res
        .status(201)
        .json(await service.save(companyId, String(req.params.mailboxId), req.body, who));
    },
  );

  return router;
}
