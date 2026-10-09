import { Router, type NextFunction, type Request, type Response } from "express";
import type { ZodType } from "zod";
import type { Db } from "@greatstone/db";
import {
  confirmMemoryLinkLeadSchema,
  contributeMemorySchema,
  createMemoryRelationshipSchema,
  dismissMemoryLinkLeadSchema,
  MEMORY_LINK_LEAD_STATES,
  createMemoryScopeSchema,
  deleteMemoryRecordSchema,
  MEMORY_DETECTION_NOTE,
  memoryActivityCountsQuerySchema,
  memoryActivityQuerySchema,
  memoryGraphQuerySchema,
  recallMemorySchema,
  resolveMemoryConflictSchema,
  reviewMemoryRecordSchema,
  runMemoryRetentionSchema,
  supersedeMemoryRecordSchema,
  updateMemorySettingsSchema,
  type MemoryCallerApp,
} from "@greatstone/shared";
import { isMemoryOnlyActor } from "../middleware/memory-only-key-guard.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import type { EngineCallSlots, MemoryEngine } from "../services/memory-gateway/engine.js";
import { getDailyPlanUsage } from "../services/memory-gateway/ingest-outbox.js";
import { createDbMemoryIngestStore } from "../services/memory-gateway/ingest-outbox-db.js";
import {
  MEMORY_SENSITIVE_CONTENT_CODE,
  MemorySensitiveContentError,
} from "../services/memory-gateway/sensitive-content.js";
import { memoryGraphService } from "../services/memory-gateway/graph.js";
import { memoryGrantService } from "../services/memory-gateway/grants.js";
import { memoryLinkService } from "../services/memory-gateway/link-check.js";
import { memoryReviewService } from "../services/memory-gateway/review.js";
import { memoryGatewayService, type MemoryCaller } from "../services/memory-gateway/service.js";
import { assertCompanyAccess, getActorInfo, hasCompanyOwnerOrAdminRole } from "./authz.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds the gateway caller from the authenticated actor. Identity never comes
 * from the request body, so a caller cannot speak for another agent or company.
 */
export function memoryCallerFromRequest(req: Request, companyId: string): MemoryCaller {
  assertCompanyAccess(req, companyId);
  const actor = getActorInfo(req);
  const runId = actor.runId && UUID_RE.test(actor.runId) ? actor.runId : null;
  return {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    userId: actor.actorType === "user" ? actor.actorId : null,
    runId,
    isBoardAdmin: hasCompanyOwnerOrAdminRole(req, companyId),
    ...memoryCallerApp(req.actor, runId),
  };
}

/**
 * The app and session a memory call came through (GRE-1079), from the
 * authenticated actor only. The person stays the agent or user id; this is
 * the provenance label beside it (deck v7 slide 17).
 */
export function memoryCallerApp(
  actor: Request["actor"],
  runId: string | null,
): { app: MemoryCallerApp | null; sessionId: string | null } {
  switch (actor.source) {
    case "session":
      return { app: "gsam_web", sessionId: actor.sessionId ?? null };
    case "local_implicit":
      return { app: "gsam_local", sessionId: null };
    case "board_key":
      return { app: "gsam_board_key", sessionId: actor.keyId ?? null };
    case "cloud_tenant":
      return { app: "gsam_cloud", sessionId: actor.sessionId ?? null };
    case "agent_jwt":
      return { app: "gsam_agent_run", sessionId: runId };
    case "agent_key":
      return { app: isMemoryOnlyActor(actor) ? "memory_key" : "gsam_agent_key", sessionId: actor.keyId ?? null };
    default:
      return { app: null, sessionId: null };
  }
}

// Organization memory gateway (GRE-672, ADR-0001). Every route is scoped to
// the company in the path; all but the settings routes answer 404 while the
// company setting is off.
export function memoryRoutes(
  db: Db,
  options: { engine?: MemoryEngine; engineTimeoutMs?: number; directRetainSlots?: EngineCallSlots } = {},
) {
  const router = Router();
  const svc = memoryGatewayService(db, options);
  const reviews = memoryReviewService(db, svc);
  const graphs = memoryGraphService(db, svc);
  const grants = memoryGrantService(db, svc);
  const links = memoryLinkService(db, svc);

  // Runs before body validation so a company with memory off learns nothing
  // from any memory route, not even which bodies are valid.
  /**
   * The caller for one memory call. An agent that names a run must name its
   * own running run (GRE-867); the refusal is audited under the real caller.
   */
  async function callerFor(req: Request, companyId: string, operation: string) {
    const caller = memoryCallerFromRequest(req, companyId);
    const claimedRunId = getActorInfo(req).runId;
    if (claimedRunId) await svc.assertLiveRun(caller, operation, claimedRunId);
    return caller;
  }

  // Like `validate`, but a rejected body (for example one naming another
  // identity) leaves a denied audit row for the real caller (GRE-651).
  async function validateContribute(req: Request, _res: Response, next: NextFunction) {
    const parsed = contributeMemorySchema.safeParse(req.body);
    if (parsed.success) {
      req.body = parsed.data;
      next();
      return;
    }
    try {
      const caller = await callerFor(req, req.params.companyId as string, "contribute");
      await svc.recordRejectedContribute(caller, {
        unrecognizedFields: parsed.error.issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys : [])),
        invalidFields: parsed.error.issues
          .filter((issue) => issue.code !== "unrecognized_keys")
          .map((issue) => issue.path.join(".")),
      });
      next(parsed.error);
    } catch (error) {
      next(error);
    }
  }

  async function requireEnabled(req: Request, _res: Response, next: NextFunction) {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await svc.assertEnabled(companyId);
      next();
    } catch (error) {
      next(error);
    }
  }

  router.get("/companies/:companyId/memory/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getSettings(companyId));
  });

  router.patch("/companies/:companyId/memory/settings", validate(updateMemorySettingsSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "settings_update");
    const settings = await svc.updateSettings(caller, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.settings_updated",
      entityType: "company",
      entityId: companyId,
      details: req.body,
    });
    res.json(settings);
  });

  // Memory rights (G3, GRE-933): John only. The body is checked inside the
  // service so a refused body still leaves an audit row for the real caller.
  router.get("/companies/:companyId/memory/grants", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json(await grants.list(await callerFor(req, companyId, "grants_list")));
  });

  router.put("/companies/:companyId/memory/grants", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const grant = await grants.set(await callerFor(req, companyId, "grant_set"), req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.grants_set",
      entityType: grant.principalType === "agent" ? "agent" : "user",
      entityId: grant.principalId,
      details: { permissions: grant.permissions },
    });
    res.json(grant);
  });

  // One right on or off (the agent Permissions toggles, GRE-988).
  router.patch("/companies/:companyId/memory/grants", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const grant = await grants.change(await callerFor(req, companyId, "grant_change"), req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.grants_set",
      entityType: grant.principalType === "agent" ? "agent" : "user",
      entityId: grant.principalId,
      details: { permissions: grant.permissions },
    });
    res.json(grant);
  });

  router.get("/companies/:companyId/memory/scopes", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json(await svc.listScopes(await callerFor(req, companyId, "scopes_list")));
  });

  router.post("/companies/:companyId/memory/scopes", requireEnabled, validate(createMemoryScopeSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.status(201).json(await svc.createScope(await callerFor(req, companyId, "scope_create"), req.body));
  });

  router.post("/companies/:companyId/memory/records", requireEnabled, validateContribute, async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "contribute");
    try {
      res.status(201).json(await svc.contribute(caller, req.body));
    } catch (error) {
      if (!(error instanceof MemorySensitiveContentError)) throw error;
      // Answered here so `detection` sits at the top level, where callers look for it (GRE-868).
      res.status(422).json({
        error: error.message,
        code: MEMORY_SENSITIVE_CONTENT_CODE,
        matchedTypes: error.matchedTypes,
        detection: MEMORY_DETECTION_NOTE,
      });
    }
  });

  router.get("/companies/:companyId/memory/records/:recordId", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const recordId = req.params.recordId as string;
    const caller = await callerFor(req, companyId, "get");
    if (!UUID_RE.test(recordId)) {
      res.status(404).json({ error: "Memory record not found" });
      return;
    }
    res.json(await svc.getRecord(caller, recordId));
  });

  router.post("/companies/:companyId/memory/recall", requireEnabled, validate(recallMemorySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json(await svc.recall(await callerFor(req, companyId, "recall"), req.body));
  });

  // Review workflow (GRE-886). The reviewer is always the authenticated
  // caller; ids that are not uuids get the same 404 as a record you cannot read.
  function recordIdOr404(req: Request, res: Response) {
    const recordId = req.params.recordId as string;
    if (UUID_RE.test(recordId)) return recordId;
    res.status(404).json({ error: "Memory record not found" });
    return null;
  }

  router.post("/companies/:companyId/memory/records/:recordId/review", requireEnabled, validate(reviewMemoryRecordSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, `review_${req.body.action}`);
    const recordId = recordIdOr404(req, res);
    if (recordId) res.json(await reviews.review(caller, recordId, req.body));
  });

  router.post("/companies/:companyId/memory/records/:recordId/supersede", requireEnabled, validate(supersedeMemoryRecordSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "supersede");
    const recordId = recordIdOr404(req, res);
    if (recordId) res.json(await reviews.supersede(caller, recordId, req.body));
  });

  router.post("/companies/:companyId/memory/records/:recordId/delete", requireEnabled, validate(deleteMemoryRecordSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "delete");
    const recordId = recordIdOr404(req, res);
    if (recordId) res.json(await reviews.deleteRecord(caller, recordId, req.body));
  });

  router.get("/companies/:companyId/memory/records/:recordId/history", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "history");
    const recordId = recordIdOr404(req, res);
    if (recordId) res.json(await reviews.history(caller, recordId));
  });

  router.get("/companies/:companyId/memory/records/:recordId/relationships", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "relationships_list");
    const recordId = recordIdOr404(req, res);
    if (recordId) res.json(await reviews.listRelationships(caller, recordId));
  });

  router.post("/companies/:companyId/memory/relationships", requireEnabled, validate(createMemoryRelationshipSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.status(201).json(await reviews.createRelationship(await callerFor(req, companyId, "relationship_create"), req.body));
  });

  // Conflict queue data, grouped by the approved position (GRE-886); the steward reads it (GRE-887).
  router.get("/companies/:companyId/memory/conflicts", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const requested = String(req.query.state ?? "open");
    const state = requested === "resolved" || requested === "all" ? requested : "open";
    res.json(await reviews.listConflicts(await callerFor(req, companyId, "conflicts_list"), state));
  });

  router.post("/companies/:companyId/memory/conflicts/:conflictId/resolve", requireEnabled, validate(resolveMemoryConflictSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "conflict_resolve");
    const conflictId = req.params.conflictId as string;
    if (!UUID_RE.test(conflictId)) {
      res.status(404).json({ error: "Memory conflict not found" });
      return;
    }
    res.json(await reviews.resolveConflict(caller, conflictId, req.body));
  });

  // Link check (memory linking, 6 Oct 2026). The scheduler runs it every few
  // hours; the owner can run it now. Its leads are reviewed here: the owner or
  // a memory reviewer for both entries confirms one (a stated link, with the
  // reviewer as author) or dismisses it.
  router.post("/companies/:companyId/memory/link-check", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json(await links.runNow(await callerFor(req, companyId, "link_check")));
  });

  router.get("/companies/:companyId/memory/link-leads", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const requested = String(req.query.state ?? "open");
    const state = requested === "all" || (MEMORY_LINK_LEAD_STATES as readonly string[]).includes(requested)
      ? (requested as (typeof MEMORY_LINK_LEAD_STATES)[number] | "all")
      : "open";
    res.json(await links.list(await callerFor(req, companyId, "link_leads_list"), state));
  });

  function leadIdOr404(req: Request, res: Response) {
    const leadId = req.params.leadId as string;
    if (UUID_RE.test(leadId)) return leadId;
    res.status(404).json({ error: "Memory link lead not found" });
    return null;
  }

  router.post("/companies/:companyId/memory/link-leads/:leadId/confirm", requireEnabled, validate(confirmMemoryLinkLeadSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "link_lead_confirm");
    const leadId = leadIdOr404(req, res);
    if (leadId) res.json(await links.confirm(caller, leadId, req.body));
  });

  router.post("/companies/:companyId/memory/link-leads/:leadId/dismiss", requireEnabled, validate(dismissMemoryLinkLeadSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "link_lead_dismiss");
    const leadId = leadIdOr404(req, res);
    if (leadId) res.json(await links.dismiss(caller, leadId, req.body));
  });

  // Retention (G1 decision 7). Dry run by default; `withinDays` lists what falls due soon.
  router.post("/companies/:companyId/memory/retention", requireEnabled, validate(runMemoryRetentionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    res.json(await reviews.runRetention(await callerFor(req, companyId, "retention"), req.body));
  });

  // Graph and contribution activity (GRE-864, plan section 8). Read only;
  // every node, edge, label and count is checked on the server.
  function parseQuery<T>(schema: ZodType<T>, req: Request) {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  }

  router.get("/companies/:companyId/memory/graph", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "graph");
    res.json(await graphs.graph(caller, parseQuery(memoryGraphQuerySchema, req)));
  });

  router.get("/companies/:companyId/memory/graph/nodes/:recordId", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "graph_node");
    res.json(await graphs.nodeDetail(caller, req.params.recordId as string));
  });

  router.get("/companies/:companyId/memory/graph/edges/:edgeId", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "graph_edge");
    res.json(await graphs.edgeDetail(caller, req.params.edgeId as string));
  });

  router.get("/companies/:companyId/memory/activity", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "activity");
    res.json(await graphs.activity(caller, parseQuery(memoryActivityQuerySchema, req)));
  });

  router.get("/companies/:companyId/memory/activity/counts", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const caller = await callerFor(req, companyId, "activity_counts");
    res.json(await graphs.activityCounts(caller, parseQuery(memoryActivityCountsQuerySchema, req)));
  });

  // Daily Claude plan use by memory extraction (GRE-673): engine deliveries and
  // the model tokens the engine reported, per Europe/London day. `days` is 1-90.
  router.get("/companies/:companyId/memory/plan-usage", requireEnabled, async (req, res) => {
    const companyId = req.params.companyId as string;
    const requested = Number.parseInt(String(req.query.days ?? "7"), 10);
    const days = Number.isFinite(requested) ? Math.min(90, Math.max(1, requested)) : 7;
    const usage = await getDailyPlanUsage({ store: createDbMemoryIngestStore(db), companyId, days });
    res.json({ companyId, days, usage });
  });

  return router;
}
