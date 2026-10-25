import { Router, type Request } from "express";
import type { Db } from "@greatstone/db";
import {
  addDeepDiveSessionQuestionSchema,
  answerToDeepDiveFindingSchema,
  planDeepDiveSessionSchema,
  updateDeepDiveSessionQuestionSchema,
  updateDeepDiveSessionSchema,
  type AddDeepDiveSessionQuestion,
  type AnswerToDeepDiveFinding,
  type PlanDeepDiveSession,
  type UpdateDeepDiveSession,
  type UpdateDeepDiveSessionQuestion,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { deepDiveSessionsService, type DeepDiveSessionActor } from "../services/deep-dive-sessions.js";
import { assertEntitled } from "../services/entitlements.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// Deep Dive sessions (GRE-2368): Screen 2 of the GRE-2327 plan. Anyone with
// access to the company may plan, run and close a session and answer its
// questions; only a person shares one. Each question comes back with what is
// already known about its GIF cell.

function sessionActor(req: Request): DeepDiveSessionActor {
  const actor = getActorInfo(req);
  return actor.actorType === "user" ? { type: "user", userId: actor.actorId } : { type: "agent", agentId: actor.agentId };
}

export function deepDiveSessionsRoutes(db: Db) {
  const router = Router();
  const sessions = deepDiveSessionsService(db);
  const settings = instanceSettingsService(db);

  async function assertEnabled() {
    await assertEntitled(settings, "enableCases");
    await assertEntitled(settings, "enableDeepDive");
  }

  async function sessionInScope(req: Request) {
    await assertEnabled();
    const companyId = await sessions.companyOfSession(req.params.sessionId as string);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  async function questionInScope(req: Request) {
    await assertEnabled();
    const companyId = await sessions.companyOfQuestion(req.params.questionId as string);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  async function log(req: Request, companyId: string, action: string, sessionId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "deep_dive_session",
      entityId: sessionId,
      details,
    });
  }

  router.get("/companies/:companyId/deep-dive/sessions", async (req, res) => {
    await assertEnabled();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ sessions: await sessions.list(companyId) });
  });

  router.post("/companies/:companyId/deep-dive/sessions", validate(planDeepDiveSessionSchema), async (req, res) => {
    await assertEnabled();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const session = await sessions.plan(companyId, req.body as PlanDeepDiveSession, sessionActor(req));
    await log(req, companyId, "deep_dive_session.planned", session.id, { questionCount: session.questionCount });
    res.status(201).json(session);
  });

  router.get("/deep-dive/sessions/:sessionId", async (req, res) => {
    await sessionInScope(req);
    res.json(await sessions.get(req.params.sessionId as string));
  });

  router.patch("/deep-dive/sessions/:sessionId", validate(updateDeepDiveSessionSchema), async (req, res) => {
    const companyId = await sessionInScope(req);
    const input = req.body as UpdateDeepDiveSession;
    const session = await sessions.update(req.params.sessionId as string, input, sessionActor(req));
    await log(req, companyId, "deep_dive_session.updated", session.id, { changed: Object.keys(input) });
    res.json(session);
  });

  router.post("/deep-dive/sessions/:sessionId/start", async (req, res) => {
    const companyId = await sessionInScope(req);
    const session = await sessions.start(req.params.sessionId as string);
    await log(req, companyId, "deep_dive_session.started", session.id, {});
    res.json(session);
  });

  router.post("/deep-dive/sessions/:sessionId/close", async (req, res) => {
    const companyId = await sessionInScope(req);
    const session = await sessions.close(req.params.sessionId as string);
    await log(req, companyId, "deep_dive_session.closed", session.id, {
      questionCount: session.questionCount,
      answeredCount: session.answeredCount,
    });
    res.json(session);
  });

  router.post(
    "/deep-dive/sessions/:sessionId/questions",
    validate(addDeepDiveSessionQuestionSchema),
    async (req, res) => {
      const companyId = await sessionInScope(req);
      const input = req.body as AddDeepDiveSessionQuestion;
      const session = await sessions.addQuestion(req.params.sessionId as string, input);
      await log(req, companyId, "deep_dive_session.question_added", session.id, {
        streamCaseId: input.streamCaseId,
        gifKey: input.gifKey,
      });
      res.status(201).json(session);
    },
  );

  router.patch(
    "/deep-dive/session-questions/:questionId",
    validate(updateDeepDiveSessionQuestionSchema),
    async (req, res) => {
      const companyId = await questionInScope(req);
      const input = req.body as UpdateDeepDiveSessionQuestion;
      const session = await sessions.updateQuestion(req.params.questionId as string, input, sessionActor(req));
      await log(req, companyId, input.answer !== undefined ? "deep_dive_session.answered" : "deep_dive_session.question_changed", session.id, {
        questionId: req.params.questionId,
      });
      res.json(session);
    },
  );

  router.delete("/deep-dive/session-questions/:questionId", async (req, res) => {
    const companyId = await questionInScope(req);
    const session = await sessions.removeQuestion(req.params.questionId as string);
    await log(req, companyId, "deep_dive_session.question_removed", session.id, { questionId: req.params.questionId });
    res.json(session);
  });

  router.post(
    "/deep-dive/session-questions/:questionId/finding",
    validate(answerToDeepDiveFindingSchema),
    async (req, res) => {
      const companyId = await questionInScope(req);
      const result = await sessions.answerToFinding(
        req.params.questionId as string,
        req.body as AnswerToDeepDiveFinding,
        sessionActor(req),
      );
      await log(req, companyId, "deep_dive_session.answer_to_finding", result.session.id, {
        questionId: req.params.questionId,
        findingId: result.finding.id,
      });
      res.status(201).json(result);
    },
  );

  return router;
}
