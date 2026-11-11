import { Router, type Request } from "express";
import type { Db } from "@greatstone/db";
import {
  DEEP_DIVE_DRAFT_STATUSES,
  decideDeepDiveDraftSchema,
  deepDiveInterviewCounts,
  logDeepDiveInterviewSchema,
  proposeDeepDiveRecordSchema,
  type DecideDeepDiveDraft,
  type DeepDiveDraftStatus,
  type LogDeepDiveInterview,
  type ProposeDeepDiveRecord,
} from "@greatstone/shared";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { deepDiveDraftsService, listDeepDiveRecords, listDeepDiveStartableClients, type DeepDiveDraftActor } from "../services/deep-dive-drafts.js";
import { resolveDeepDiveScope, type DeepDiveScope } from "../services/deep-dive-scope.js";
import { assertEntitled } from "../services/entitlements.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// Deep Dive tiles and agent drafts (GRE-4430). Every draft route names the
// company and the Deep Dive (?recordId=), so one client's drafts are never
// read or written through another's. Agents log and propose; only a person
// decides. Every write is in the activity log with the agent and run id.

function draftActor(req: Request): DeepDiveDraftActor {
  const actor = getActorInfo(req);
  return actor.actorType === "user"
    ? { type: "user", userId: actor.actorId }
    : { type: "agent", agentId: actor.agentId, runId: actor.runId };
}

export function deepDiveDraftsRoutes(db: Db) {
  const router = Router();
  const drafts = deepDiveDraftsService(db);
  const settings = instanceSettingsService(db);

  async function assertEnabled() {
    await assertEntitled(settings, "enableCases");
    await assertEntitled(settings, "enableDeepDive");
  }

  async function scopeOf(req: Request): Promise<DeepDiveScope> {
    await assertEnabled();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    return resolveDeepDiveScope(db, companyId, req.query.recordId);
  }

  async function log(req: Request, scope: DeepDiveScope, action: string, draftId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: scope.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "deep_dive_draft",
      entityId: draftId,
      details: { recordCaseId: scope.recordCaseId, ...details },
    });
  }

  router.get("/companies/:companyId/deep-dives", async (req, res) => {
    await assertEnabled();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const [deepDives, clients] = await Promise.all([listDeepDiveRecords(db, companyId), listDeepDiveStartableClients(db, companyId)]);
    res.json({ deepDives, clients });
  });

  router.get("/companies/:companyId/deep-dive/drafts", async (req, res) => {
    const scope = await scopeOf(req);
    const status = req.query.status;
    if (status !== undefined && !DEEP_DIVE_DRAFT_STATUSES.includes(status as DeepDiveDraftStatus)) {
      throw badRequest(`status is one of ${DEEP_DIVE_DRAFT_STATUSES.join(", ")}`);
    }
    res.json({ drafts: await drafts.list(scope, { status: status as DeepDiveDraftStatus | undefined }) });
  });

  router.get("/companies/:companyId/deep-dive/drafts/:draftId", async (req, res) => {
    const scope = await scopeOf(req);
    res.json(await drafts.get(scope, req.params.draftId as string));
  });

  router.post("/companies/:companyId/deep-dive/drafts/interview-log", validate(logDeepDiveInterviewSchema), async (req, res) => {
    const scope = await scopeOf(req);
    const { interview, draftId, expectedVersion } = req.body as LogDeepDiveInterview;
    const draft = await drafts.logInterview(scope, interview, { draftId, expectedVersion }, draftActor(req));
    await log(req, scope, draftId ? "deep_dive_draft.revised" : "deep_dive_draft.interview_logged", draft.id, {
      version: draft.version,
      counts: deepDiveInterviewCounts(interview),
    });
    res.status(draftId ? 200 : 201).json(draft);
  });

  router.post("/companies/:companyId/deep-dive/drafts/record-proposal", validate(proposeDeepDiveRecordSchema), async (req, res) => {
    const scope = await scopeOf(req);
    const { title, proposal, draftId, expectedVersion } = req.body as ProposeDeepDiveRecord;
    const draft = await drafts.proposeRecord(scope, title, proposal, { draftId, expectedVersion }, draftActor(req));
    await log(req, scope, draftId ? "deep_dive_draft.revised" : "deep_dive_draft.record_proposed", draft.id, {
      version: draft.version,
      register: proposal.register,
    });
    res.status(draftId ? 200 : 201).json(draft);
  });

  router.post("/companies/:companyId/deep-dive/drafts/:draftId/decision", validate(decideDeepDiveDraftSchema), async (req, res) => {
    const scope = await scopeOf(req);
    const input = req.body as DecideDeepDiveDraft;
    const draft = await drafts.decide(scope, req.params.draftId as string, input, draftActor(req));
    await log(req, scope, `deep_dive_draft.${input.decision}`, draft.id, { version: draft.version });
    res.json(draft);
  });

  return router;
}
