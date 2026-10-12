import { Router, type Request } from "express";
import { z } from "zod";
import { memoryOperations, type Db } from "@greatstone/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { memoryGatewayService } from "../services/memory-gateway/service.js";
import {
  assertStewardGrant,
  getStewardDailyReport,
  runStewardReview,
  StewardAccessError,
} from "../services/memory-gateway/steward-review.js";
import {
  createDbStewardOwnerResolver,
  createDbStewardStore,
  createSandboxStewardGrant,
  createStewardGrant,
  getStewardGrant,
  revokeStewardGrant,
  STEWARD_GRANT_MAX_DAYS,
  StewardGrantRefusal,
} from "../services/memory-gateway/steward-review-db.js";
import { assertCompanyAccess, getActorInfo, hasCompanyOwnerOrAdminRole } from "./authz.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
export { STEWARD_GRANT_MAX_DAYS };

/**
 * Sandbox grants exist only where this is set (a sandbox instance on
 * synthetic data). The live grant has its own route (GRE-933).
 */
export const STEWARD_SANDBOX_GRANTS_ENV = "GSAM_MEMORY_STEWARD_SANDBOX_GRANTS";

const createStewardGrantSchema = z
  .object({
    agentId: z.string().uuid(),
    scopeIds: z.array(z.string().uuid()).min(1).max(50),
    expiresInDays: z.number().int().min(1).max(STEWARD_GRANT_MAX_DAYS),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * Sandbox controls for the review pass (GRE-897, exit test MT-19). Only where
 * sandbox grants are on. `now` is the pass clock (settle window, lease, run
 * day); `killAfterEntries` stops the pass after the page holding entry N, as
 * a crash would.
 */
const stewardReviewSandboxSchema = z
  .object({
    now: z.string().datetime({ offset: true }).optional(),
    killAfterEntries: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

const stewardReviewBodySchema = z.object({ sandbox: stewardReviewSandboxSchema.optional() });

// Memory steward daily review (GRE-887). The daily GSAM routine wakes the
// steward agent, which calls POST .../steward/review once. The steward reads
// records through its grant and writes only the decision queue.
export function memoryStewardRoutes(db: Db) {
  const router = Router();
  const gateway = memoryGatewayService(db);
  const store = createDbStewardStore(db);

  async function requireEnabled(req: Request) {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await gateway.assertEnabled(companyId);
    return companyId;
  }

  /** Board owner/admin, or an agent holding a live steward grant. */
  async function assertCanRead(req: Request, companyId: string) {
    if (hasCompanyOwnerOrAdminRole(req, companyId)) return;
    const actor = getActorInfo(req);
    if (actor.actorType === "agent" && actor.agentId) {
      const grant = await getStewardGrant(db, { companyId, agentId: actor.agentId });
      try {
        assertStewardGrant(grant, { companyId, agentId: actor.agentId, now: new Date() });
        return;
      } catch {
        // fall through
      }
    }
    throw forbidden("Only a company owner, an admin or the granted steward can read the steward queue");
  }

  async function assertGrantAdmin(req: Request, companyId: string, operation: string) {
    if (hasCompanyOwnerOrAdminRole(req, companyId)) return;
    const actor = getActorInfo(req);
    await db.insert(memoryOperations).values({
      companyId,
      operation,
      outcome: "denied",
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      detail: { reason: "not a company owner or admin" },
    });
    throw forbidden("Only a company owner or admin can change steward grants");
  }

  router.post("/companies/:companyId/memory/steward/review", async (req, res) => {
    const companyId = await requireEnabled(req);
    const actor = getActorInfo(req);
    if (actor.actorType !== "agent" || !actor.agentId) throw forbidden("Only the steward agent runs the review");
    const sandbox = stewardReviewBodySchema.parse(req.body ?? {}).sandbox;
    if (sandbox && process.env[STEWARD_SANDBOX_GRANTS_ENV] !== "true") {
      await db.insert(memoryOperations).values({
        companyId,
        operation: "steward_review",
        outcome: "denied",
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        detail: { reason: "sandbox controls are off on this instance", sandbox },
      });
      throw forbidden("Steward sandbox controls are off on this instance");
    }
    const grant = await getStewardGrant(db, { companyId, agentId: actor.agentId });
    const sandboxNow = sandbox?.now ? new Date(sandbox.now) : null;
    try {
      const result = await runStewardReview({
        store,
        companyId,
        agentId: actor.agentId,
        grant,
        resolveOwner: createDbStewardOwnerResolver(db),
        ...(sandbox
          ? {
              now: sandboxNow ? () => sandboxNow : undefined,
              grantNow: () => new Date(),
              killAfterEntries: sandbox.killAfterEntries,
              auditDetail: { sandbox: { ...sandbox, wallClock: new Date().toISOString() } },
            }
          : {}),
      });
      res.status(result.outcome === "busy" ? 409 : 200).json(result);
    } catch (error) {
      // The refusal is already audited by runStewardReview.
      if (error instanceof StewardAccessError) throw forbidden(error.message);
      throw error;
    }
  });

  router.get("/companies/:companyId/memory/steward/queue", async (req, res) => {
    const companyId = await requireEnabled(req);
    await assertCanRead(req, companyId);
    res.json({ companyId, items: await store.listOpenItems(companyId) });
  });

  // Audit cost (review time, plan use) and queue age, per Europe/London day. `days` is 1-90.
  router.get("/companies/:companyId/memory/steward/report", async (req, res) => {
    const companyId = await requireEnabled(req);
    await assertCanRead(req, companyId);
    const requested = Number.parseInt(String(req.query.days ?? "7"), 10);
    const days = Number.isFinite(requested) ? Math.min(90, Math.max(1, requested)) : 7;
    res.json({ companyId, days, report: await getStewardDailyReport({ store, companyId, days }) });
  });

  router.post(
    "/companies/:companyId/memory/steward/grants",
    validate(createStewardGrantSchema),
    async (req, res) => {
      const companyId = await requireEnabled(req);
      await assertGrantAdmin(req, companyId, "steward_grant");
      if (process.env[STEWARD_SANDBOX_GRANTS_ENV] !== "true") {
        throw notFound("Steward grants are sandbox only until G4");
      }
      const actor = getActorInfo(req);
      const body = req.body as z.infer<typeof createStewardGrantSchema>;
      let grant;
      try {
        grant = await createSandboxStewardGrant(db, {
          companyId,
          agentId: body.agentId,
          scopeIds: body.scopeIds,
          grantedByUserId: actor.actorId,
          expiresAt: new Date(Date.now() + body.expiresInDays * DAY_MS),
          reason: body.reason,
        });
      } catch (error) {
        throw forbidden((error as Error).message);
      }
      await db.insert(memoryOperations).values({
        companyId,
        operation: "steward_grant",
        outcome: "allowed",
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: body.agentId,
        scopeIds: grant.scopeIds,
        detail: { grantId: grant.id, environment: grant.environment, expiresAt: grant.expiresAt.toISOString() },
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory.steward_grant_created",
        entityType: "agent",
        entityId: body.agentId,
        details: { grantId: grant.id, scopeIds: grant.scopeIds, expiresAt: grant.expiresAt.toISOString() },
      });
      res.status(201).json(grant);
    },
  );

  // John's live steward grant (G3, GRE-933): owner only, Greatstone scopes
  // only, at most 30 days, then renewed. Every refusal is audited.
  router.post("/companies/:companyId/memory/steward/grants/live", async (req, res) => {
    const companyId = await requireEnabled(req);
    const operation = "steward_grant_live";
    await assertGrantAdmin(req, companyId, operation);
    const actor = getActorInfo(req);
    const refuse = async (reason: string, detail: Record<string, unknown> = {}) =>
      db.insert(memoryOperations).values({
        companyId,
        operation,
        outcome: "denied",
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        detail: { reason, ...detail },
      });
    const parsed = createStewardGrantSchema.safeParse(req.body);
    if (!parsed.success) {
      await refuse("invalid_body", { invalidFields: parsed.error.issues.map((issue) => issue.path.join(".") || issue.code) });
      throw badRequest("Invalid steward grant", parsed.error.issues);
    }
    const body = parsed.data;
    let grant;
    try {
      grant = await createStewardGrant(db, {
        companyId,
        agentId: body.agentId,
        scopeIds: body.scopeIds,
        environment: "live",
        grantedByUserId: actor.actorId,
        expiresAt: new Date(Date.now() + body.expiresInDays * DAY_MS),
        reason: body.reason,
      });
    } catch (error) {
      if (!(error instanceof StewardGrantRefusal)) throw error;
      await refuse(error.reason, { stewardAgentId: body.agentId, scopeIds: body.scopeIds });
      throw forbidden(error.message);
    }
    await db.insert(memoryOperations).values({
      companyId,
      operation,
      outcome: "allowed",
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: body.agentId,
      scopeIds: grant.scopeIds,
      detail: { grantId: grant.id, environment: grant.environment, expiresAt: grant.expiresAt.toISOString(), reason: body.reason },
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.steward_grant_created",
      entityType: "agent",
      entityId: body.agentId,
      details: { grantId: grant.id, environment: grant.environment, scopeIds: grant.scopeIds, expiresAt: grant.expiresAt.toISOString() },
    });
    res.status(201).json(grant);
  });

  router.post("/companies/:companyId/memory/steward/grants/:grantId/revoke", async (req, res) => {
    const companyId = await requireEnabled(req);
    await assertGrantAdmin(req, companyId, "steward_grant_revoke");
    const grantId = req.params.grantId as string;
    if (!UUID_RE.test(grantId)) throw notFound("No live steward grant with that id");
    if (!(await revokeStewardGrant(db, { companyId, grantId }))) throw notFound("No live steward grant with that id");
    const actor = getActorInfo(req);
    await db.insert(memoryOperations).values({
      companyId,
      operation: "steward_grant_revoke",
      outcome: "allowed",
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      detail: { grantId },
    });
    res.json({ grantId, revoked: true });
  });

  return router;
}
