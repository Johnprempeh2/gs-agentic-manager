import { Router, type Request } from "express";
import type { Db } from "@greatstone/db";
import {
  createInboundTaskHookSchema,
  inboundTaskSchema,
  updateInboundTaskHookSchema,
} from "@greatstone/shared";
import { badRequest, forbidden, unsupportedMediaType } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { inboundTaskHookService, tokenFromHeaders, type InboundTaskHookDeps } from "../services/inbound-task-hooks.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Inbound task webhooks: board routes to make and manage them, and the public
 * URL outside tools post to. Managing needs tools:manage_connections, like
 * other connections; the public URL checks the hook's own token.
 */
export function inboundTaskHookRoutes(db: Db, deps: InboundTaskHookDeps = {}) {
  const router = Router();
  const service = inboundTaskHookService(db, deps);

  async function manager(req: Request, companyId: string) {
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

  async function audit(req: Request, companyId: string, action: string, hookId: string, details: Record<string, unknown> = {}) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "inbound_task_hook",
      entityId: hookId,
      details,
    });
  }

  router.get("/companies/:companyId/inbound-task-hooks", async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    res.json(await service.list(companyId));
  });

  router.post("/companies/:companyId/inbound-task-hooks", validate(createInboundTaskHookSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    const hook = await service.create(companyId, req.body, req.actor.userId ?? null);
    await audit(req, companyId, "inbound_task_hook.created", hook.id, { name: hook.name, assigneeAgentId: hook.assigneeAgentId });
    res.status(201).json(hook);
  });

  router.patch("/companies/:companyId/inbound-task-hooks/:hookId", validate(updateInboundTaskHookSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    const hook = await service.update(companyId, req.params.hookId as string, req.body);
    await audit(req, companyId, "inbound_task_hook.updated", hook.id, req.body);
    res.json(hook);
  });

  router.post("/companies/:companyId/inbound-task-hooks/:hookId/rotate", async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    const hook = await service.rotate(companyId, req.params.hookId as string);
    await audit(req, companyId, "inbound_task_hook.token_rotated", hook.id);
    res.json(hook);
  });

  router.delete("/companies/:companyId/inbound-task-hooks/:hookId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    const hook = await service.revoke(companyId, req.params.hookId as string);
    await audit(req, companyId, "inbound_task_hook.deleted", hook.id, { name: hook.name });
    res.json({ ok: true });
  });

  router.post("/inbound/tasks/:publicId", async (req, res) => {
    if (!req.is("application/json")) {
      throw unsupportedMediaType("Send the task with Content-Type: application/json");
    }
    const parsed = inboundTaskSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid task", parsed.error.issues);
    const { result } = await service.receive(
      req.params.publicId as string,
      tokenFromHeaders(req.header("authorization"), req.header("x-gsam-token")),
      parsed.data,
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  return router;
}
