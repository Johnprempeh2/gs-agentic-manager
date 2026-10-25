import { Router, type Request } from "express";
import type { Db } from "@greatstone/db";
import {
  DEEP_DIVE_FINDING_NEVER_EDITED,
  decideDeepDiveFindingSchema,
  listDeepDiveFindingsQuerySchema,
  proposeDeepDiveFindingSchema,
  setDeepDiveFindingVisibilitySchema,
  type DecideDeepDiveFinding,
  type ProposeDeepDiveFinding,
} from "@greatstone/shared";
import { badRequest, conflict } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { deepDiveFindingsService, type DeepDiveFindingActor } from "../services/deep-dive-findings.js";
import { assertEntitled } from "../services/entitlements.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// Deep Dive findings (GRE-2367): Screen 4 of the GRE-2327 plan. Anyone with
// access to the company may read and propose; only a person validates,
// rejects or shares. There is no route that edits a finding.

function findingActor(req: Request): DeepDiveFindingActor {
  const actor = getActorInfo(req);
  return actor.actorType === "user" ? { type: "user", userId: actor.actorId } : { type: "agent", agentId: actor.agentId };
}

export function deepDiveFindingsRoutes(db: Db) {
  const router = Router();
  const findings = deepDiveFindingsService(db);
  const settings = instanceSettingsService(db);

  async function assertEnabled() {
    await assertEntitled(settings, "enableCases");
    await assertEntitled(settings, "enableDeepDive");
  }

  async function findingInScope(req: Request) {
    await assertEnabled();
    const companyId = await findings.companyOf(req.params.findingId as string);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  async function log(req: Request, companyId: string, action: string, findingId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "deep_dive_finding",
      entityId: findingId,
      details,
    });
  }

  router.get("/companies/:companyId/deep-dive/findings", async (req, res) => {
    await assertEnabled();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listDeepDiveFindingsQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid findings query", query.error.issues);
    res.json({ findings: await findings.list(companyId, query.data) });
  });

  router.post("/companies/:companyId/deep-dive/findings", validate(proposeDeepDiveFindingSchema), async (req, res) => {
    await assertEnabled();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const finding = await findings.propose(companyId, req.body as ProposeDeepDiveFinding, findingActor(req));
    await log(req, companyId, "deep_dive_finding.proposed", finding.id, {
      streamCaseId: finding.streamCaseId,
      gifKey: finding.gifKey,
      supersedesFindingId: finding.supersedesFindingId,
      evidenceCount: finding.evidence.length,
    });
    res.status(201).json(finding);
  });

  router.get("/deep-dive/findings/:findingId", async (req, res) => {
    await findingInScope(req);
    res.json(await findings.get(req.params.findingId as string));
  });

  router.post("/deep-dive/findings/:findingId/decision", validate(decideDeepDiveFindingSchema), async (req, res) => {
    const companyId = await findingInScope(req);
    const { decision } = req.body as DecideDeepDiveFinding;
    const finding = await findings.decide(req.params.findingId as string, decision, findingActor(req));
    await log(req, companyId, `deep_dive_finding.${decision}`, finding.id, {
      supersedesFindingId: finding.supersedesFindingId,
    });
    res.json(finding);
  });

  // Internal/Shared is the only change a decided finding takes. Anything else
  // in the body is an edit, and a finding is never edited.
  router.patch("/deep-dive/findings/:findingId", async (req, res) => {
    const companyId = await findingInScope(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== "visibility")) throw conflict(DEEP_DIVE_FINDING_NEVER_EDITED);
    const parsed = setDeepDiveFindingVisibilitySchema.safeParse(body);
    if (!parsed.success) throw badRequest("Invalid visibility", parsed.error.issues);
    const finding = await findings.setVisibility(req.params.findingId as string, parsed.data.visibility, findingActor(req));
    await log(req, companyId, "deep_dive_finding.visibility_changed", finding.id, { visibility: finding.visibility });
    res.json(finding);
  });

  return router;
}
