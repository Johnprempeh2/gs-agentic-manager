// CRM sync routes (GRE-1100, GRE-1076). Contract: doc/CRM-SYNC-CONTRACT.md.
// Company-scoped; board users of the company configure sync, agents read.
// Conflict decisions need a person with Administer on the pipeline; agents and
// people with Work cases may propose a resolution or suggest a change to a
// CRM-owned field. Every write goes to the activity log.
import { Router, type Request } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { crmSyncBindings, pipelineCases, type Db } from "@greatstone/db";
import {
  acceptCrmSyncConflictProposalSchema,
  createCrmSyncBindingSchema,
  createCrmSyncSuggestionSchema,
  dismissCrmSyncConflictSchema,
  listCrmSyncConflictsQuerySchema,
  listCrmSyncEventsQuerySchema,
  proposeCrmSyncConflictResolutionSchema,
  replaceCrmSyncFieldMapSchema,
  resolveCrmSyncConflictSchema,
  runCrmSyncBindingSchema,
  updateCrmSyncBindingSchema,
  type CreateCrmSyncBinding,
  type CreateCrmSyncSuggestion,
  type CrmSyncChangeAuthor,
  type DismissCrmSyncConflict,
  type ProposeCrmSyncConflictResolution,
  type ReplaceCrmSyncFieldMap,
  type ResolveCrmSyncConflict,
  type RunCrmSyncBinding,
  type UpdateCrmSyncBinding,
} from "@greatstone/shared";
import { badRequest, HttpError, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
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

  const access = accessService(db);

  router.use(CRM_SYNC_ROUTE_PREFIXES, requireEntitlement(db, "enablePipelines"));

  /** Pipeline access level check (GRE-1072): Administer is pipelines:write, Work cases is pipelines:cases. */
  async function assertPipelineAccess(
    req: Request,
    companyId: string,
    pipelineId: string,
    action: "pipelines:write" | "pipelines:cases",
  ) {
    const decision = await access.decide({
      actor: req.actor,
      action,
      resource: { type: "company", companyId },
      scope: { pipelineId },
    });
    if (!decision.allowed) {
      throw new HttpError(403, decision.explanation, {
        code: action === "pipelines:write" ? "pipeline_write_forbidden" : "pipeline_cases_forbidden",
        reason: decision.reason,
        pipelineId,
      });
    }
  }

  /** The binding a conflict belongs to, even if the binding was deleted since. */
  async function conflictPipelineId(bindingId: string) {
    const row = await db
      .select({ pipelineId: crmSyncBindings.pipelineId })
      .from(crmSyncBindings)
      .where(eq(crmSyncBindings.id, bindingId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Conflict not found");
    return row.pipelineId;
  }

  /** Conflict decisions: a person (not an agent) with Administer on the bound pipeline. */
  async function assertConflictDecider(req: Request, row: { companyId: string; bindingId: string }) {
    const actor = assertBoardWriter(req, row.companyId);
    await assertPipelineAccess(req, row.companyId, await conflictPipelineId(row.bindingId), "pipelines:write");
    return actor;
  }

  /** Who is acting, for the audit trail and for "who changed it". */
  function changeAuthor(req: Request): CrmSyncChangeAuthor {
    if (req.actor.type === "agent" && req.actor.agentId) return { actorType: "agent", agentId: req.actor.agentId };
    if (req.actor.type === "board") return { actorType: "user", userId: req.actor.userId ?? "board" };
    throw new HttpError(403, "Only people and agents can do this", { code: "actor_not_allowed" });
  }

  function auditAs(req: Request, companyId: string, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
    const author = changeAuthor(req);
    return logActivity(db, author.actorType === "agent"
      ? {
        companyId,
        actorType: "agent",
        actorId: author.agentId,
        agentId: author.agentId,
        runId: req.actor.type === "agent" ? req.actor.runId ?? null : null,
        action,
        entityType,
        entityId,
        details,
      }
      : { companyId, actorType: "user", actorId: author.userId, action, entityType, entityId, details });
  }

  /** Before and after values for the audit trail of a conflict decision. */
  function decisionDetails(row: Awaited<ReturnType<typeof conflictFor>>) {
    return {
      bindingId: row.bindingId,
      kind: row.kind,
      caseId: row.entityId,
      gsamField: row.gsamField,
      externalField: row.externalField,
      before: {
        lastSynced: row.lastSyncedValue?.value ?? null,
        crm: row.crmValue.value,
        gsam: row.gsamValue.value,
      },
      gsamChangedBy: row.gsamChangedBy,
    };
  }

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
    const actor = await assertConflictDecider(req, row);
    const input = req.body as ResolveCrmSyncConflict;
    const resolved = await svc.resolveConflict(row, input, actor);
    await audit(row.companyId, actor.userId, "crm_sync.conflict_resolved", "crm_sync_conflict", row.id, {
      ...decisionDetails(row),
      resolution: input.resolution,
      after: resolved.resolvedValue ?? null,
      reason: input.reason ?? null,
    });
    res.json(resolved);
  });

  router.post("/crm-sync/conflicts/:conflictId/accept-proposal", validate(acceptCrmSyncConflictProposalSchema), async (req, res) => {
    const row = await conflictFor(req);
    const actor = await assertConflictDecider(req, row);
    const resolved = await svc.acceptProposal(row, actor);
    await audit(row.companyId, actor.userId, "crm_sync.conflict_resolved", "crm_sync_conflict", row.id, {
      ...decisionDetails(row),
      resolution: resolved.resolution,
      after: resolved.resolvedValue ?? null,
      reason: row.proposalReason,
      acceptedProposal: {
        proposedByAgentId: row.proposedByAgentId,
        proposedByUserId: row.proposedByUserId,
        proposedAt: row.proposedAt?.toISOString() ?? null,
      },
    });
    res.json(resolved);
  });

  // An agent with Work cases proposes; a person accepts. Proposing changes nothing on either side.
  router.post("/crm-sync/conflicts/:conflictId/propose", validate(proposeCrmSyncConflictResolutionSchema), async (req, res) => {
    const row = await conflictFor(req);
    const author = changeAuthor(req);
    await assertPipelineAccess(req, row.companyId, await conflictPipelineId(row.bindingId), "pipelines:cases");
    const input = req.body as ProposeCrmSyncConflictResolution;
    const proposed = await svc.proposeResolution(row, input, {
      agentId: author.actorType === "agent" ? author.agentId : null,
      userId: author.actorType === "user" ? author.userId : null,
    });
    await auditAs(req, row.companyId, "crm_sync.conflict_proposed", "crm_sync_conflict", row.id, {
      ...decisionDetails(row),
      resolution: input.resolution,
      proposedValue: input.resolution === "custom" ? input.value : null,
      reason: input.reason,
    });
    res.json(proposed);
  });

  router.post("/crm-sync/conflicts/:conflictId/dismiss", validate(dismissCrmSyncConflictSchema), async (req, res) => {
    const row = await conflictFor(req);
    const input = req.body as DismissCrmSyncConflict;
    // A suggester may withdraw their own suggestion without Administer.
    const ownSuggestion = row.kind === "suggestion" && req.actor.type === "board" &&
      row.gsamChangedBy.some((author) => author.actorType === "user" && author.userId === (req.actor.userId ?? "board"));
    const actor = ownSuggestion ? assertBoardWriter(req, row.companyId) : await assertConflictDecider(req, row);
    const dismissed = await svc.dismissConflict(row, input.reason, actor);
    await audit(row.companyId, actor.userId, "crm_sync.conflict_dismissed", "crm_sync_conflict", row.id, {
      ...decisionDetails(row),
      reason: input.reason ?? null,
    });
    res.json(dismissed);
  });

  // Suggested change to a CRM-owned field (Work cases). It waits for a person before write-back.
  router.post("/cases/:caseId/crm-sync/suggestions", validate(createCrmSyncSuggestionSchema), async (req, res) => {
    const caseId = parseId(req.params.caseId, "Case");
    const caseRow = await db
      .select({ id: pipelineCases.id, companyId: pipelineCases.companyId, pipelineId: pipelineCases.pipelineId })
      .from(pipelineCases)
      .where(and(eq(pipelineCases.id, caseId)))
      .then((rows) => rows[0] ?? null);
    if (!caseRow) throw notFound("Case not found");
    assertSyncCompanyAccess(req, caseRow.companyId, "Case");
    const author = changeAuthor(req);
    await assertPipelineAccess(req, caseRow.companyId, caseRow.pipelineId, "pipelines:cases");
    const input = req.body as CreateCrmSyncSuggestion;
    const suggestion = await svc.createSuggestion(caseRow, input, author);
    await auditAs(req, caseRow.companyId, "crm_sync.change_suggested", "crm_sync_conflict", suggestion.id, {
      bindingId: suggestion.bindingId,
      caseId,
      gsamField: suggestion.gsamField,
      externalField: suggestion.externalField,
      before: suggestion.crmValue,
      after: suggestion.gsamValue,
      reason: input.reason,
    });
    res.status(201).json(suggestion);
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
