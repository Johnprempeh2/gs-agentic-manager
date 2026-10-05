import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import {
  contributeMemorySchema,
  createMemoryScopeSchema,
  MEMORY_DETECTION_NOTE,
  recallMemorySchema,
  updateMemorySettingsSchema,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import type { MemoryEngine } from "../services/memory-gateway/engine.js";
import { getDailyPlanUsage } from "../services/memory-gateway/ingest-outbox.js";
import { createDbMemoryIngestStore } from "../services/memory-gateway/ingest-outbox-db.js";
import {
  MEMORY_SENSITIVE_CONTENT_CODE,
  MemorySensitiveContentError,
} from "../services/memory-gateway/sensitive-content.js";
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
  return {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    userId: actor.actorType === "user" ? actor.actorId : null,
    runId: actor.runId && UUID_RE.test(actor.runId) ? actor.runId : null,
    isBoardAdmin: hasCompanyOwnerOrAdminRole(req, companyId),
  };
}

// Organization memory gateway (GRE-672, ADR-0001). Every route is scoped to
// the company in the path; all but the settings routes answer 404 while the
// company setting is off.
export function memoryRoutes(db: Db, options: { engine?: MemoryEngine; engineTimeoutMs?: number } = {}) {
  const router = Router();
  const svc = memoryGatewayService(db, options);

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
    res.status(201).json(await svc.contribute(await callerFor(req, companyId, "contribute"), req.body));
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
