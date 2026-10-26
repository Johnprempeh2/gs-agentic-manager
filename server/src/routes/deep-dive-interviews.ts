import { Router, type Request } from "express";
import type { Db } from "@greatstone/db";
import {
  createDeepDiveInterviewRoundSchema,
  draftDeepDiveInterviewSetSchema,
  inviteDeepDiveInterviewPeopleSchema,
  openDeepDiveInterviewRoundSchema,
  sendDeepDiveInterviewInvitesSchema,
  updateDeepDiveInterviewRoundSchema,
  updateDeepDiveInterviewSetSchema,
  type CreateDeepDiveInterviewRound,
  type DraftDeepDiveInterviewSet,
  type InviteDeepDiveInterviewPeople,
  type OpenDeepDiveInterviewRound,
  type SendDeepDiveInterviewInvites,
  type UpdateDeepDiveInterviewRound,
  type UpdateDeepDiveInterviewSet,
} from "@greatstone/shared";
import { validate } from "../middleware/validate.js";
import { deepDiveInterviewInvitesService } from "../services/deep-dive-interview-invites.js";
import { deepDiveInterviewsService, type DeepDiveInterviewActor } from "../services/deep-dive-interviews.js";
import type { WebsiteBridgeActor } from "../services/website/data-bridge-client.js";
import { interviewBridgeFromEnv, type InterviewBridge } from "../services/website/interview-bridge.js";
import { assertEntitled } from "../services/entitlements.js";
import { logActivity } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// Parallel Interview rounds (GRE-2611): the Deep Dive's first step. Anyone with
// access to the company may set up the round and draft or edit question sets;
// only a person approves a set. Every write answers with the whole round view.
// Invites (GRE-2665): only a person opens the round on the website and sends
// invites or reminders; anyone with access reads the live progress. Activity
// rows carry counts only, never a name or an email.

function interviewActor(req: Request): DeepDiveInterviewActor {
  const actor = getActorInfo(req);
  return actor.actorType === "user" ? { type: "user", userId: actor.actorId } : { type: "agent", agentId: actor.agentId };
}

function bridgeActor(req: Request): WebsiteBridgeActor {
  const actor = getActorInfo(req);
  return { type: actor.actorType === "user" ? "user" : "agent", id: actor.actorId, runId: actor.runId };
}

export function deepDiveInterviewsRoutes(db: Db, options: { interviewBridge?: InterviewBridge } = {}) {
  const router = Router();
  const interviews = deepDiveInterviewsService(db);
  const invites = deepDiveInterviewInvitesService(db, options.interviewBridge ?? interviewBridgeFromEnv(db));
  const settings = instanceSettingsService(db);

  async function assertEnabled() {
    await assertEntitled(settings, "enableCases");
    await assertEntitled(settings, "enableDeepDive");
  }

  async function companyInScope(req: Request) {
    await assertEnabled();
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  async function roundInScope(req: Request) {
    await assertEnabled();
    const companyId = await interviews.companyOfRound(req.params.roundId as string);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  async function setInScope(req: Request) {
    await assertEnabled();
    const companyId = await interviews.companyOfSet(req.params.setId as string);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  async function log(req: Request, companyId: string, action: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "deep_dive_interview_round",
      entityId,
      details,
    });
  }

  router.get("/companies/:companyId/deep-dive/interview-round", async (req, res) => {
    const companyId = await companyInScope(req);
    res.json(await interviews.view(companyId));
  });

  router.post(
    "/companies/:companyId/deep-dive/interview-round",
    validate(createDeepDiveInterviewRoundSchema),
    async (req, res) => {
      const companyId = await companyInScope(req);
      const input = req.body as CreateDeepDiveInterviewRound;
      const view = await interviews.create(companyId, input, interviewActor(req));
      await log(req, companyId, "deep_dive_interview.round_created", view.round!.id, { mode: input.mode });
      res.status(201).json(view);
    },
  );

  router.patch(
    "/deep-dive/interview-rounds/:roundId",
    validate(updateDeepDiveInterviewRoundSchema),
    async (req, res) => {
      const companyId = await roundInScope(req);
      const input = req.body as UpdateDeepDiveInterviewRound;
      const view = await interviews.update(req.params.roundId as string, input);
      await log(req, companyId, "deep_dive_interview.round_updated", req.params.roundId as string, { changed: Object.keys(input) });
      res.json(view);
    },
  );

  router.post(
    "/deep-dive/interview-rounds/:roundId/sets",
    validate(draftDeepDiveInterviewSetSchema),
    async (req, res) => {
      const companyId = await roundInScope(req);
      const result = await interviews.draftSet(req.params.roundId as string, req.body as DraftDeepDiveInterviewSet, interviewActor(req));
      await log(req, companyId, "deep_dive_interview.set_drafted", req.params.roundId as string, {
        setId: result.set.id,
        questionCount: (result.set.questions as unknown[]).length,
        leftOut: result.set.leftOut,
      });
      res.status(201).json(result.view);
    },
  );

  router.patch(
    "/deep-dive/interview-sets/:setId",
    validate(updateDeepDiveInterviewSetSchema),
    async (req, res) => {
      const companyId = await setInScope(req);
      const input = req.body as UpdateDeepDiveInterviewSet;
      const view = await interviews.updateSet(req.params.setId as string, input);
      await log(req, companyId, "deep_dive_interview.set_changed", view.round!.id, {
        setId: req.params.setId,
        questionCount: input.questions.length,
      });
      res.json(view);
    },
  );

  router.post("/deep-dive/interview-sets/:setId/redraft", async (req, res) => {
    const companyId = await setInScope(req);
    const view = await interviews.redraftSet(req.params.setId as string, interviewActor(req));
    await log(req, companyId, "deep_dive_interview.set_redrafted", view.round!.id, { setId: req.params.setId });
    res.json(view);
  });

  router.post("/deep-dive/interview-sets/:setId/approve", async (req, res) => {
    const companyId = await setInScope(req);
    const view = await interviews.approveSet(req.params.setId as string, interviewActor(req));
    await log(req, companyId, "deep_dive_interview.set_approved", view.round!.id, { setId: req.params.setId });
    res.json(view);
  });

  router.delete("/deep-dive/interview-sets/:setId", async (req, res) => {
    const companyId = await setInScope(req);
    const view = await interviews.removeSet(req.params.setId as string);
    await log(req, companyId, "deep_dive_interview.set_removed", view.round!.id, { setId: req.params.setId });
    res.json(view);
  });

  router.get("/companies/:companyId/deep-dive/interview-round/progress", async (req, res) => {
    const companyId = await companyInScope(req);
    res.json(await invites.progress(companyId, bridgeActor(req)));
  });

  router.post(
    "/deep-dive/interview-rounds/:roundId/open",
    validate(openDeepDiveInterviewRoundSchema),
    async (req, res) => {
      const companyId = await roundInScope(req);
      const input = req.body as OpenDeepDiveInterviewRound;
      const progress = await invites.open(req.params.roundId as string, input, interviewActor(req), bridgeActor(req));
      await log(req, companyId, "deep_dive_interview.round_opened", req.params.roundId as string, {
        allowedEmailDomains: input.allowedEmailDomains.length,
        seatTotal: input.seatTotal,
      });
      res.json(progress);
    },
  );

  router.post(
    "/deep-dive/interview-rounds/:roundId/invites",
    validate(inviteDeepDiveInterviewPeopleSchema),
    async (req, res) => {
      const companyId = await roundInScope(req);
      const result = await invites.invite(req.params.roundId as string, req.body as InviteDeepDiveInterviewPeople, interviewActor(req), bridgeActor(req));
      await log(req, companyId, "deep_dive_interview.people_invited", req.params.roundId as string, {
        invited: result.invited,
        created: result.created,
        emailed: result.emailed,
      });
      res.json(result);
    },
  );

  router.post(
    "/deep-dive/interview-rounds/:roundId/invites/send",
    validate(sendDeepDiveInterviewInvitesSchema),
    async (req, res) => {
      const companyId = await roundInScope(req);
      const input = req.body as SendDeepDiveInterviewInvites;
      const result = await invites.send(req.params.roundId as string, input, interviewActor(req), bridgeActor(req));
      await log(req, companyId, `deep_dive_interview.invites_${input.kind === "resend" ? "resent" : "reminded"}`, req.params.roundId as string, {
        people: input.websiteEmployeeIds.length,
        emailed: result.emailed,
        skipped: result.skipped,
      });
      res.json(result);
    },
  );

  return router;
}
