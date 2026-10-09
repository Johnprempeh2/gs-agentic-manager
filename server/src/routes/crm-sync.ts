// CRM sync routes (GRE-1100). Contract: doc/CRM-SYNC-CONTRACT.md.
// Company-scoped; board users of the company write, agents read. Every write
// goes to the activity log.
import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import {
  createCrmSyncBindingSchema,
  dismissCrmSyncConflictSchema,
  listCrmSyncConflictsQuerySchema,
  listCrmSyncEventsQuerySchema,
  replaceCrmSyncFieldMapSchema,
  resolveCrmSyncConflictSchema,
  runCrmSyncBindingSchema,
  updateCrmSyncBindingSchema,
  type CreateCrmSyncBinding,
  type DismissCrmSyncConflict,
  type ReplaceCrmSyncFieldMap,
  type ResolveCrmSyncConflict,
  type RunCrmSyncBinding,
  type UpdateCrmSyncBinding,
} from "@greatstone/shared";
import { badRequest, HttpError, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import {
  crmSyncService,
  loadCaseCompanyId,
  loadCrmSyncBinding,
  loadCrmSyncConflict,
} from "../services/crm-sync.js";
import { requireEntitlement } from "../services/entitlements.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/** Bindings target pipelines, so CRM sync is off while enablePipelines is off. */
export const CRM_SYNC_ROUTE_PREFIXES = [
  "/companies/:companyId/crm-sync",
  "/crm-sync",
  "/cases/:caseId/crm-sync",
];

const idSchema = z.string().guid();

// Another company's binding answers 404, not 403, so ids do not leak.
function assertSyncCompanyAccess(req: Request, companyId: string, what: string) {
  try {
    assertCompanyAccess(req, companyId);
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.status === 403 &&
      (error.message.includes("another company") || error.message.includes("does not have access"))
    ) {
      throw notFound(`${what} not found`);
    }
    throw error;
  }
}

/** Writes need a board user who can write in the company. Returns the user id for the audit trail. */
function assertBoardWriter(req: Request, companyId: string) {
  assertSyncCompanyAccess(req, companyId, "Resource");
  assertBoard(req);
  return { userId: req.actor.type === "board" ? req.actor.userId ?? "board" : "board" };
}

function parseId(value: unknown, what: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw notFound(`${what} not found`);
  return parsed.data;
}

function parseQuery<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) throw badRequest("Invalid query", parsed.error.flatten());
  return parsed.data;
}

export function crmSyncRoutes(db: Db) {
  const router = Router();
  const svc = crmSyncService(db);

  router.use(CRM_SYNC_ROUTE_PREFIXES, requireEntitlement(db, "enablePipelines"));

  async function bindingFor(req: Request) {
    const binding = await loadCrmSyncBinding(db, parseId(req.params.bindingId, "Binding"));
    assertSyncCompanyAccess(req, binding.companyId, "Binding");
    return binding;
  }

  async function conflictFor(req: Request) {
    const row = await loadCrmSyncConflict(db, parseId(req.params.conflictId, "Conflict"));
    assertSyncCompanyAccess(req, row.companyId, "Conflict");
    return row;
  }

  function audit(companyId: string, userId: string, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
    return logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action,
      entityType,
      entityId,
      details,
    });
  }

  router.get("/companies/:companyId/crm-sync/bindings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertSyncCompanyAccess(req, companyId, "Company");
    res.json(await svc.listBindings(companyId));
  });

  router.post("/companies/:companyId/crm-sync/bindings", validate(createCrmSyncBindingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = assertBoardWriter(req, companyId);
    const input = req.body as CreateCrmSyncBinding;
    const binding = await svc.createBinding(companyId, input, actor);
    await audit(companyId, actor.userId, "crm_sync.binding_created", "crm_sync_binding", binding.id, {
      connectionId: binding.connectionId,
      providerKey: binding.providerKey,
      externalContainerId: binding.externalContainerId,
      pipelineId: binding.pipelineId,
      direction: binding.direction,
      fieldCount: input.fieldMap.length,
    });
    res.status(201).json(binding);
  });

  router.get("/crm-sync/bindings/:bindingId", async (req, res) => {
    res.json(await svc.getBinding(await bindingFor(req)));
  });

  router.patch("/crm-sync/bindings/:bindingId", validate(updateCrmSyncBindingSchema), async (req, res) => {
    const binding = await bindingFor(req);
    const actor = assertBoardWriter(req, binding.companyId);
    const patch = req.body as UpdateCrmSyncBinding;
    const updated = await svc.updateBinding(binding, patch);
    await audit(binding.companyId, actor.userId, "crm_sync.binding_updated", "crm_sync_binding", binding.id, {
      changed: Object.keys(patch),
      before: { direction: binding.direction, status: binding.status },
      after: { direction: updated.direction, status: updated.status },
    });
    res.json(updated);
  });

  router.delete("/crm-sync/bindings/:bindingId", async (req, res) => {
    const binding = await bindingFor(req);
    const actor = assertBoardWriter(req, binding.companyId);
    const result = await svc.deleteBinding(binding, actor);
    await audit(binding.companyId, actor.userId, "crm_sync.binding_deleted", "crm_sync_binding", binding.id, {
      externalContainerId: binding.externalContainerId,
      pipelineId: binding.pipelineId,
      dismissedConflictCount: result.dismissedConflictCount,
    });
    res.status(204).end();
  });

  router.get("/crm-sync/bindings/:bindingId/field-map", async (req, res) => {
    res.json(await svc.getFieldMap(await bindingFor(req)));
  });

  router.put("/crm-sync/bindings/:bindingId/field-map", validate(replaceCrmSyncFieldMapSchema), async (req, res) => {
    const binding = await bindingFor(req);
    const actor = assertBoardWriter(req, binding.companyId);
    const { fields } = req.body as ReplaceCrmSyncFieldMap;
    const map = await svc.replaceFieldMap(binding, fields);
    await audit(binding.companyId, actor.userId, "crm_sync.field_map_replaced", "crm_sync_binding", binding.id, {
      fields: fields.map((entry) => ({ externalField: entry.externalField, gsamField: entry.gsamField, owner: entry.owner })),
    });
    res.json(map);
  });

  router.post("/crm-sync/bindings/:bindingId/sync", validate(runCrmSyncBindingSchema), async (req, res) => {
    const binding = await bindingFor(req);
    const actor = assertBoardWriter(req, binding.companyId);
    const { direction } = req.body as RunCrmSyncBinding;
    const queued = await svc.queueRun(binding, direction);
    await audit(binding.companyId, actor.userId, "crm_sync.run_queued", "crm_sync_binding", binding.id, {
      direction,
      nextSyncAt: queued.nextSyncAt,
    });
    res.status(202).json(queued);
  });

  router.get("/crm-sync/bindings/:bindingId/events", async (req, res) => {
    const binding = await bindingFor(req);
    res.json(await svc.listEvents(binding, parseQuery(listCrmSyncEventsQuerySchema, req)));
  });

  router.get("/companies/:companyId/crm-sync/conflicts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertSyncCompanyAccess(req, companyId, "Company");
    res.json(await svc.listConflicts(companyId, parseQuery(listCrmSyncConflictsQuerySchema, req)));
  });

  router.post("/crm-sync/conflicts/:conflictId/resolve", validate(resolveCrmSyncConflictSchema), async (req, res) => {
    const row = await conflictFor(req);
    const actor = assertBoardWriter(req, row.companyId);
    const input = req.body as ResolveCrmSyncConflict;
    const resolved = await svc.resolveConflict(row, input, actor);
    await audit(row.companyId, actor.userId, "crm_sync.conflict_resolved", "crm_sync_conflict", row.id, {
      bindingId: row.bindingId,
      gsamField: row.gsamField,
      resolution: input.resolution,
    });
    res.json(resolved);
  });

  router.post("/crm-sync/conflicts/:conflictId/dismiss", validate(dismissCrmSyncConflictSchema), async (req, res) => {
    const row = await conflictFor(req);
    const actor = assertBoardWriter(req, row.companyId);
    const input = req.body as DismissCrmSyncConflict;
    const dismissed = await svc.dismissConflict(row, input.reason, actor);
    await audit(row.companyId, actor.userId, "crm_sync.conflict_dismissed", "crm_sync_conflict", row.id, {
      bindingId: row.bindingId,
      gsamField: row.gsamField,
    });
    res.json(dismissed);
  });

  router.get("/cases/:caseId/crm-sync/links", async (req, res) => {
    const caseId = parseId(req.params.caseId, "Case");
    const companyId = await loadCaseCompanyId(db, caseId);
    assertSyncCompanyAccess(req, companyId, "Case");
    res.json(await svc.listCaseLinks(companyId, caseId));
  });

  router.get("/cases/:caseId/crm-sync/status", async (req, res) => {
    const caseId = parseId(req.params.caseId, "Case");
    const companyId = await loadCaseCompanyId(db, caseId);
    assertSyncCompanyAccess(req, companyId, "Case");
    res.json(await svc.getCaseStatus(companyId, caseId));
  });

  return router;
}
