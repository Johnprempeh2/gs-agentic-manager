import { and, desc, eq, gte, inArray, isNotNull, ne, notInArray } from "drizzle-orm";
import {
  agents,
  authUsers,
  goalCheckIns,
  goalWhyRequests,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
  type Db,
} from "@greatstone/db";
import type { GoalWhyRequestStatus, StrategyBoardAgent, StrategyBoardBrief } from "@greatstone/shared";
import { renderStrategyBoardBrief } from "@greatstone/shared";
import { unprocessable } from "../errors.js";
import { BOARD_MEMBER_PERMISSION, boardAgentIdsFromScope, strategyBoardService } from "./strategy-board.js";

/**
 * Board agent chat (GRE-1186): a board member asks the agents set for them
 * about the plan. The chat is an ordinary agent conversation in Ask mode,
 * marked with this origin kind. It is questions only: the board member may
 * only send messages, and the agent's run may only reply (see
 * `boardQuestionRunGuard`).
 */
export const BOARD_QUESTION_ORIGIN_KIND = "strategy_board_question";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRIEF_ACTION_LIMIT = 60;
const BRIEF_CHECK_IN_LIMIT = 30;
const BRIEF_WHY_LIMIT = 30;
const BRIEF_WHY_DAYS = 120;

export function isBoardQuestionChat(issue: { originKind?: string | null; conversationAgentId?: string | null } | null | undefined) {
  return Boolean(issue?.conversationAgentId && issue.originKind === BOARD_QUESTION_ORIGIN_KIND);
}

/** Replaces the generic chat directive for a board question chat. */
export function boardQuestionDirective(input: { issuePrefix: string | null; brief: string }) {
  const board = input.issuePrefix ? `/${input.issuePrefix}/strategy-board` : "/strategy-board";
  return `You are answering a board member's questions about how the plan is going. The board member is a non-executive: they read the plan and ask questions; they do not run the company.

Questions only. Do not create, assign, update or close tasks; do not change goals, KPIs, readings or check-ins; do not wake, invoke or configure agents; do not create documents, approvals or interactions. GS Agentic Manager refuses every write from this run except your reply on this chat, so do not try. If the board member asks for an action, say who owns it and offer a "Why?" request instead.

Answer only from the plan below and from read-only GET calls to the API. For every number, cite the KPI or task it comes from by name (and task id), and say how far it can be trusted: its source (owner-reported, agent-checked or system) and how old the reading is. An owner-reported or old reading is weak evidence; say so plainly. If the plan does not hold the answer, say that, and do not guess.

To have the owner explain a KPI, offer a "Why?" request as a link the board member opens and confirms. Do not send it yourself. Write the link as [Send a "Why?" request](${board}?askWhy=<KPI id>&question=<URL-encoded question>), using the KPI id from the plan. The board member confirms it before anything is sent, and it is logged.

Keep answers short and plain. Use short sentences and lists.

${input.brief}`;
}

export function strategyBoardChatService(db: Db) {
  const board = strategyBoardService(db);

  async function memberGrant(companyId: string, userId: string) {
    return db
      .select({ id: principalPermissionGrants.id, scope: principalPermissionGrants.scope })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, userId),
          eq(principalPermissionGrants.permissionKey, BOARD_MEMBER_PERMISSION),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  /** The agents a board member may ask. Empty for anyone who is not a board member. */
  async function listAgents(companyId: string, userId: string): Promise<StrategyBoardAgent[]> {
    const standing = await board.getStanding(companyId, userId);
    if (!standing.isBoardMember) return [];
    const ids = boardAgentIdsFromScope((await memberGrant(companyId, userId))?.scope);
    if (ids.length === 0) return [];
    const rows = await db
      .select({ id: agents.id, name: agents.name, title: agents.title, icon: agents.icon })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, ids), ne(agents.status, "terminated")));
    const order = new Map(ids.map((id, index) => [id, index]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  async function mayChat(companyId: string, userId: string, agentId: string) {
    return (await listAgents(companyId, userId)).some((agent) => agent.id === agentId);
  }

  /** Owners choose which agents one board member may ask. */
  async function setMemberAgents(companyId: string, userId: string, agentIds: string[]) {
    const standing = await board.getStanding(companyId, userId);
    const grant = await memberGrant(companyId, userId);
    if (!standing.isBoardMember || !grant) {
      throw unprocessable("Only board members are given board agents. Add this person to the board first.", { code: "board_member_required", userId });
    }
    if (agentIds.length) {
      const found = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds), ne(agents.status, "terminated")));
      const known = new Set(found.map((row) => row.id));
      const missing = agentIds.filter((id) => !known.has(id));
      if (missing.length) throw unprocessable("Choose agents of this company", { code: "board_agent_not_found", agentIds: missing });
    }
    await db
      .update(principalPermissionGrants)
      .set({ scope: agentIds.length ? { agentIds } : null, updatedAt: new Date() })
      .where(eq(principalPermissionGrants.id, grant.id));
    return agentIds;
  }

  /** The plan as the board sees it today, with actions, check-ins and "why" answers. */
  async function brief(companyId: string): Promise<StrategyBoardBrief> {
    const [built, company] = await Promise.all([board.buildBoard(companyId), board.companyLink(companyId)]);
    const goalIds = built.kpis.map((kpi) => kpi.goalId);
    const objectiveIds = [...new Set(built.kpis.map((kpi) => kpi.objectiveId).filter((id): id is string => !!id))];
    const planGoalIds = [...goalIds, ...objectiveIds];
    const whySince = new Date(Date.now() - BRIEF_WHY_DAYS * 86_400_000);
    const [actionRows, checkInRows, whyRows] = planGoalIds.length
      ? await Promise.all([
          db
            .select({
              identifier: issues.identifier,
              title: issues.title,
              status: issues.status,
              goalId: issues.goalId,
              assigneeName: agents.name,
            })
            .from(issues)
            .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
            .where(
              and(
                eq(issues.companyId, companyId),
                inArray(issues.goalId, planGoalIds),
                notInArray(issues.status, ["done", "cancelled"]),
                isNotNull(issues.goalId),
              ),
            )
            .orderBy(desc(issues.updatedAt))
            .limit(BRIEF_ACTION_LIMIT),
          db
            .select({
              goalId: goalCheckIns.goalId,
              body: goalCheckIns.body,
              progressPercent: goalCheckIns.progressPercent,
              createdAt: goalCheckIns.createdAt,
              agentName: agents.name,
              userName: authUsers.name,
            })
            .from(goalCheckIns)
            .leftJoin(agents, eq(agents.id, goalCheckIns.authorAgentId))
            .leftJoin(authUsers, eq(authUsers.id, goalCheckIns.authorUserId))
            .where(and(eq(goalCheckIns.companyId, companyId), inArray(goalCheckIns.goalId, planGoalIds)))
            .orderBy(desc(goalCheckIns.createdAt))
            .limit(BRIEF_CHECK_IN_LIMIT),
          db
            .select()
            .from(goalWhyRequests)
            .where(and(eq(goalWhyRequests.companyId, companyId), gte(goalWhyRequests.createdAt, whySince)))
            .orderBy(desc(goalWhyRequests.createdAt))
            .limit(BRIEF_WHY_LIMIT),
        ])
      : [[], [], []];
    return {
      companyName: company.name,
      issuePrefix: company.prefix ?? "",
      asOf: new Date().toISOString().slice(0, 10),
      kpis: built.kpis,
      actions: actionRows.map((row) => ({
        identifier: row.identifier,
        title: row.title,
        status: row.status,
        goalId: row.goalId!,
        assigneeName: row.assigneeName ?? null,
      })),
      checkIns: checkInRows.map((row) => ({
        goalId: row.goalId,
        body: row.body,
        progressPercent: row.progressPercent,
        date: row.createdAt.toISOString().slice(0, 10),
        authorName: row.agentName ?? row.userName ?? null,
      })),
      whyRequests: whyRows.map((row) => ({
        goalId: row.goalId,
        question: row.question,
        status: row.status as GoalWhyRequestStatus,
        answer: row.answer,
        askedAt: row.createdAt.toISOString().slice(0, 10),
      })),
    };
  }

  /** The directive and plan brief for an agent turn on a board chat. */
  async function directiveFor(companyId: string) {
    const planBrief = await brief(companyId);
    return boardQuestionDirective({ issuePrefix: planBrief.issuePrefix || null, brief: renderStrategyBoardBrief(planBrief) });
  }

  /**
   * The board chat a run is serving, or null. A run serves the issue in its
   * context snapshot; only board question chats count.
   */
  async function boardChatForRun(companyId: string, agentId: string, runId: string) {
    const [run] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    const issueId = run?.contextSnapshot?.issueId;
    if (typeof issueId !== "string" || !UUID_RE.test(issueId)) return null;
    const [issue] = await db
      .select({ id: issues.id, identifier: issues.identifier, originKind: issues.originKind, conversationAgentId: issues.conversationAgentId })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    return issue && isBoardQuestionChat(issue) ? { id: issue.id, identifier: issue.identifier } : null;
  }

  return { listAgents, mayChat, setMemberAgents, brief, directiveFor, boardChatForRun };
}
