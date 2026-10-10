import { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import {
  answerGoalWhyRequestSchema,
  createGoalWhyRequestSchema,
  createStrategyBoardPackSchema,
  setStrategyBoardMembersSchema,
  type StrategyBoardViewerRights,
} from "@greatstone/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { goalService, logActivity } from "../services/index.js";
import { requireEntitlement } from "../services/entitlements.js";
import { boardViewerRights, strategyBoardService } from "../services/strategy-board.js";
import {
  assertCompanyAccess,
  getAccessibleResource,
  getActorInfo,
  hasCompanyAccess,
  hasCompanyBoardRole,
  hasCompanyOwnerOrAdminRole,
} from "./authz.js";

/** Path prefixes owned by this router; all are refused while enableStrategyBoard is off. */
export const STRATEGY_BOARD_ROUTE_PREFIXES = [
  "/companies/:companyId/strategy-board",
  "/strategy-board",
  "/goals/:id/why-requests",
  "/why-requests",
];

export const BOARD_ACTION_REQUIRED_MESSAGE = "Only board members, company owners and admins may do this on the board";

/**
 * Board control panel API (GRE-1135).
 *
 * Reading the board is like reading goals: any member of the company. The
 * board actions ("Why?" and board packs) are writes a board member may make
 * even though board members are viewers, so these routes check company access
 * without the viewer write rule and then check the board right. Choosing the
 * board is for company owners.
 */
export function strategyBoardRoutes(db: Db) {
  const router = Router();
  const svc = strategyBoardService(db);
  const goals = goalService(db);

  router.use(STRATEGY_BOARD_ROUTE_PREFIXES, requireEntitlement(db, "enableStrategyBoard"));

  async function viewerRights(req: Request, companyId: string): Promise<StrategyBoardViewerRights> {
    if (req.actor.type !== "board") {
      return { isBoardMember: false, isChair: false, mayAskWhy: false, mayMakeBoardPack: false, mayManageMembers: false };
    }
    const userId = req.actor.userId ?? null;
    const standing = userId
      ? await svc.getStanding(companyId, userId)
      : { role: null, isBoardMember: false, isChair: false };
    return boardViewerRights(standing, {
      isOwnerOrAdmin: hasCompanyOwnerOrAdminRole(req, companyId),
      isCompanyOwner: hasCompanyBoardRole(req, companyId),
    });
  }

  /** 404 for another company's resource, 403 without the board right. Returns the acting user id. */
  async function assertBoardAction(req: Request, res: Response, companyId: string, right: "mayAskWhy" | "mayMakeBoardPack") {
    if (!hasCompanyAccess(req, companyId)) {
      res.status(404).json({ error: "Not found" });
      return null;
    }
    const rights = await viewerRights(req, companyId);
    if (!rights[right]) throw forbidden(BOARD_ACTION_REQUIRED_MESSAGE, { code: "board_action_required" });
    return getActorInfo(req);
  }

  router.get("/companies/:companyId/strategy-board", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.summary(companyId, await viewerRights(req, companyId)));
  });

  router.get("/companies/:companyId/strategy-board/alerts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listAlerts(companyId));
  });

  router.get("/companies/:companyId/strategy-board/members", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!hasCompanyBoardRole(req, companyId)) throw forbidden("Only company owners may choose the board", { code: "board_layer_required" });
    res.json(await svc.listMembers(companyId));
  });

  router.put("/companies/:companyId/strategy-board/members", validate(setStrategyBoardMembersSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!hasCompanyBoardRole(req, companyId)) throw forbidden("Only company owners may choose the board", { code: "board_layer_required" });
    const actor = getActorInfo(req);
    const members = await svc.setMembers(companyId, req.body, actor.actorType === "user" ? actor.actorId : null);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "strategy_board.members_set",
      entityType: "company",
      entityId: companyId,
      details: {
        boardMemberUserIds: members.filter((m) => m.isBoardMember).map((m) => m.userId),
        chairUserId: members.find((m) => m.isChair)?.userId ?? null,
      },
    });
    res.json(members);
  });

  router.get("/companies/:companyId/strategy-board/packs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listPacks(companyId));
  });

  router.post("/companies/:companyId/strategy-board/packs", validate(createStrategyBoardPackSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = await assertBoardAction(req, res, companyId, "mayMakeBoardPack");
    if (!actor) return;
    const pack = await svc.createPack(companyId, req.body, actor.actorType === "user" ? actor.actorId : null);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "strategy_board.pack_created",
      entityType: "company",
      entityId: companyId,
      details: { packId: pack.id, periodStart: pack.periodStart, periodEnd: pack.periodEnd },
    });
    res.status(201).json(pack);
  });

  router.get("/strategy-board/packs/:id", async (req, res) => {
    const pack = await getAccessibleResource(req, res, svc.getPack(req.params.id as string), "Board pack not found");
    if (!pack) return;
    res.json(pack);
  });

  router.get("/goals/:id/why-requests", async (req, res) => {
    const goal = await getAccessibleResource(req, res, goals.getById(req.params.id as string), "Goal not found");
    if (!goal) return;
    res.json(await svc.listWhyRequests(goal.id));
  });

  router.post("/goals/:id/why-requests", validate(createGoalWhyRequestSchema), async (req, res) => {
    const goal = await goals.getById(req.params.id as string);
    if (!goal || !hasCompanyAccess(req, goal.companyId)) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = await assertBoardAction(req, res, goal.companyId, "mayAskWhy");
    if (!actor) return;
    const request = await svc.createWhyRequest(goal, req.body.question, actor.actorId);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.why_requested",
      entityType: "goal",
      entityId: goal.id,
      details: { whyRequestId: request.id, ownerIssueId: request.ownerIssueId },
    });
    res.status(201).json(request);
  });

  /**
   * The owner answers: the person or agent that owned the KPI when asked, the
   * KPI's owner now, the lead agent, or a company owner or admin. Viewers
   * (board members) cannot answer.
   */
  router.post("/why-requests/:id/answer", validate(answerGoalWhyRequestSchema), async (req, res) => {
    const request = await getAccessibleResource(req, res, svc.getWhyRequest(req.params.id as string), "Why request not found");
    if (!request) return;
    const goal = await goals.getById(request.goalId);
    if (!goal) throw notFound("Goal not found");
    const actor = getActorInfo(req);
    let allowed = false;
    if (actor.actorType === "agent") {
      allowed = actor.agentId != null && (
        actor.agentId === request.ownerAgentId
        || actor.agentId === goal.ownerAgentId
        || actor.agentId === (await goals.getCompanyLeadAgentId(goal.companyId))
      );
    } else {
      allowed = actor.actorId === request.ownerUserId
        || actor.actorId === goal.ownerUserId
        || hasCompanyOwnerOrAdminRole(req, goal.companyId);
    }
    if (!allowed) throw forbidden("Only the KPI owner may answer this request", { code: "why_request_not_owner" });
    const answered = await svc.answerWhyRequest(request, req.body.answer, {
      userId: actor.actorType === "user" ? actor.actorId : null,
      agentId: actor.agentId,
    });
    if (!answered) {
      res.status(409).json({ error: "This request has been answered already" });
      return;
    }
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.why_answered",
      entityType: "goal",
      entityId: goal.id,
      details: { whyRequestId: answered.id },
    });
    res.json(answered);
  });

  return router;
}
