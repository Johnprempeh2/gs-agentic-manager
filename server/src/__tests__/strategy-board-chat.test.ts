import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companyMemberships,
  goalCheckIns,
  goalKpiAlerts,
  goalKpiReadings,
  goals,
  goalWhyRequests,
  heartbeatRuns,
  issueComments,
  issues,
  principalPermissionGrants,
  strategyBoardPacks,
} from "@greatstone/db";
import type { Issue, StrategyBoardAgent, StrategyBoardMember } from "@greatstone/shared";
import { afterEach, beforeEach, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { boardQuestionRunGuard, isReplyOnChat } from "../middleware/board-question-run-guard.js";
import { agentRoutes } from "../routes/agents.js";
import { goalRoutes } from "../routes/goals.js";
import { issueRoutes } from "../routes/issues.js";
import { strategyBoardRoutes } from "../routes/strategy-board.js";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { BOARD_QUESTION_ORIGIN_KIND, strategyBoardChatService } from "../services/strategy-board-chat.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

type AgentActor = {
  type: "agent";
  agentId: string;
  companyId: string;
  runId: string;
  source: string;
  onBehalfOfUserId: string;
  onBehalfOfMemberships: Array<{ companyId: string; membershipRole: string; status: string }>;
};

describeEmbeddedPostgres("board agent chat (GRE-1186)", () => {
  const ctx = useEmbeddedPostgres("gsam-strategy-board-chat-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(strategyBoardPacks);
      await db.delete(goalKpiAlerts);
      await db.delete(goalWhyRequests);
      await db.delete(goalKpiReadings);
      await db.delete(goalCheckIns);
      await db.delete(issueComments);
      await db.delete(agentWakeupRequests);
      await db.delete(issues);
      await db.delete(heartbeatRuns);
      await db.update(goals).set({ parentId: null });
      await db.delete(goals);
      await db.delete(agents);
      await db.delete(principalPermissionGrants);
      await resetCompanyIssueFixtures(db);
    },
  });

  beforeEach(async () => {
    await instanceSettingsService(ctx.db).updateExperimental({ enableStrategyBoard: true, enableAgentChat: false });
  });
  afterEach(() => {
    delete process.env.GSAM_RESPONSIBLE_USER_AUTHZ_MODE;
  });

  async function setSwitch(on: boolean) {
    await instanceSettingsService(ctx.db).updateExperimental({ enableStrategyBoard: on });
  }

  async function addMember(companyId: string, role: "owner" | "operator" | "viewer", name = role) {
    const userId = `user-${name}-${Math.random().toString(36).slice(2, 8)}`;
    await ctx.db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
      updatedAt: new Date(),
    });
    const actor: BoardActor = {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
      isInstanceAdmin: false,
    };
    return { userId, actor };
  }

  async function seedAgent(companyId: string, name: string) {
    const [agent] = await ctx.db
      .insert(agents)
      .values({ companyId, name, role: "general", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    return agent;
  }

  /** A CSF, objective and KPI with one owner-reported reading 5 days old. */
  async function seedPlan(companyId: string, ownerAgentId: string) {
    const [csf] = await ctx.db.insert(goals).values({ companyId, title: "Grow revenue", kind: "csf", level: "company", status: "active" }).returning();
    const [objective] = await ctx.db
      .insert(goals)
      .values({ companyId, title: "Win new clients", kind: "objective", level: "team", status: "active", parentId: csf.id })
      .returning();
    const [kpi] = await ctx.db
      .insert(goals)
      .values({
        companyId,
        title: "Revenue",
        kind: "kpi",
        level: "task",
        status: "active",
        parentId: objective.id,
        unit: "k",
        baselineValue: 100,
        baselineDate: dayOffset(-100),
        targetValue: 200,
        targetDate: dayOffset(100),
        ownerAgentId,
      })
      .returning();
    await ctx.db.insert(goalKpiReadings).values({ companyId, goalId: kpi.id, value: 120, readingDate: dayOffset(-5), source: "owner_reported" });
    return { csf, objective, kpi };
  }

  function boardApp(actor: BoardActor) {
    return routeApp(ctx.db, actor, strategyBoardRoutes, issueRoutes, goalRoutes, agentRoutes);
  }

  /** The routes an agent run reaches, behind the real board question guard. */
  function agentApp(actor: AgentActor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    const api = express.Router();
    api.use(boardQuestionRunGuard(ctx.db));
    for (const factory of [issueRoutes, goalRoutes, agentRoutes, strategyBoardRoutes]) api.use(factory(ctx.db, {} as never));
    app.use("/api", api);
    app.use(errorHandler);
    return app;
  }

  /** A company with an owner, a board member and three agents; the member may ask the secretary and the evidence agent. */
  async function seedBoard(name: string) {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, name);
    const member = await addMember(companyId, "viewer", "member");
    const secretary = await seedAgent(companyId, "Board secretary");
    const evidence = await seedAgent(companyId, "Revenue evidence agent");
    const other = await seedAgent(companyId, "Engineer");
    expect((await request(boardApp(owner)).put(`/api/companies/${companyId}/strategy-board/members`).send({ members: [{ userId: member.userId }] })).status).toBe(200);
    const set = await request(boardApp(owner))
      .put(`/api/companies/${companyId}/strategy-board/members/${member.userId}/agents`)
      .send({ agentIds: [secretary.id, evidence.id] });
    expect(set.status).toBe(200);
    return { companyId, owner, member, secretary, evidence, other };
  }

  async function openChat(actor: BoardActor, companyId: string, agentId: string) {
    return request(boardApp(actor)).post(`/api/companies/${companyId}/strategy-board/chats/${agentId}`).send({});
  }

  function message(actor: BoardActor, issueId: string, body: string) {
    return request(boardApp(actor)).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
  }

  async function runFor(companyId: string, agentId: string, issueId: string) {
    const [run] = await ctx.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running", contextSnapshot: { issueId, taskKey: issueId, conversationMode: true, conversationSessionGeneration: 0 } })
      .returning();
    return run;
  }

  /** Comments record the responsible user, so they must exist as users. */
  async function ensureUser(userId: string) {
    await ctx.db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.local`, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  }

  function agentActor(companyId: string, agentId: string, runId: string, viewerUserId: string): AgentActor {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
      onBehalfOfUserId: viewerUserId,
      onBehalfOfMemberships: [{ companyId, membershipRole: "viewer", status: "active" }],
    };
  }

  // ---- Who may talk to which agent ----

  it("owners set each board member's agents; the list survives re-choosing the board and refuses other companies' agents", async () => {
    const { companyId, owner, member, secretary, evidence } = await seedBoard("SetAgents");
    let members = (await request(boardApp(owner)).get(`/api/companies/${companyId}/strategy-board/members`)).body as StrategyBoardMember[];
    expect(members.find((m) => m.userId === member.userId)?.agentIds).toEqual([secretary.id, evidence.id]);

    // Choosing the board again keeps the member's agents.
    await request(boardApp(owner)).put(`/api/companies/${companyId}/strategy-board/members`).send({ members: [{ userId: member.userId, chair: true }] });
    members = (await request(boardApp(owner)).get(`/api/companies/${companyId}/strategy-board/members`)).body as StrategyBoardMember[];
    expect(members.find((m) => m.userId === member.userId)?.agentIds).toEqual([secretary.id, evidence.id]);

    const elsewhere = await seedCompanyWithBoardAccess(ctx.db, "Elsewhere");
    const foreign = await seedAgent(elsewhere.companyId, "Foreign agent");
    const refused = await request(boardApp(owner))
      .put(`/api/companies/${companyId}/strategy-board/members/${member.userId}/agents`)
      .send({ agentIds: [foreign.id] });
    expect(refused.status).toBe(422);
    expect(refused.body.details?.code ?? refused.body.code).toBe("board_agent_not_found");

    const operator = await addMember(companyId, "operator", "operator");
    const notOnBoard = await request(boardApp(owner))
      .put(`/api/companies/${companyId}/strategy-board/members/${operator.userId}/agents`)
      .send({ agentIds: [secretary.id] });
    expect(notOnBoard.status).toBe(422);

    // Only owners choose; a board member cannot widen their own list.
    const self = await request(boardApp(member.actor))
      .put(`/api/companies/${companyId}/strategy-board/members/${member.userId}/agents`)
      .send({ agentIds: [secretary.id, evidence.id, foreign.id] });
    expect(self.status).toBe(403);

    const [logged] = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "strategy_board.member_agents_set"));
    expect(logged.details).toMatchObject({ boardMemberUserId: member.userId, agentIds: [secretary.id, evidence.id] });
  });

  it("a board member can chat only with their set agents and cannot reach other agents", async () => {
    const { companyId, owner, member, secretary, evidence, other } = await seedBoard("OnlyMine");
    const listed = (await request(boardApp(member.actor)).get(`/api/companies/${companyId}/strategy-board/agents`)).body as StrategyBoardAgent[];
    expect(listed.map((a) => a.name)).toEqual(["Board secretary", "Revenue evidence agent"]);
    // Owners and admins have the normal agent chat; they get no board agents.
    expect((await request(boardApp(owner)).get(`/api/companies/${companyId}/strategy-board/agents`)).body).toEqual([]);

    expect((await request(boardApp(member.actor)).get(`/api/companies/${companyId}/strategy-board/chats/${secretary.id}`)).body).toBeNull();
    const opened = await openChat(member.actor, companyId, secretary.id);
    expect(opened.status).toBe(201);
    const chat = opened.body as Issue;
    expect(chat).toMatchObject({
      conversationAgentId: secretary.id,
      conversationUserId: member.userId,
      workMode: "ask",
      originKind: BOARD_QUESTION_ORIGIN_KIND,
    });
    expect((await openChat(member.actor, companyId, secretary.id)).body.id).toBe(chat.id);
    expect((await openChat(member.actor, companyId, evidence.id)).status).toBe(201);

    // Not one of theirs: refused on the board route and on the normal chat route.
    const refused = await openChat(member.actor, companyId, other.id);
    expect(refused.status).toBe(403);
    expect((await request(boardApp(member.actor)).get(`/api/companies/${companyId}/strategy-board/chats/${other.id}`)).status).toBe(403);
    expect((await request(boardApp(member.actor)).post(`/api/companies/${companyId}/chats/${other.id}`).send({})).status).toBe(403);

    // They may send a message on their own board chat, and it wakes only that agent.
    const sent = await message(member.actor, chat.id, "How is revenue doing?");
    expect(sent.status).toBe(201);

    // Another person's board chat is not theirs to write in.
    const second = await addMember(companyId, "viewer", "second");
    await request(boardApp(owner)).put(`/api/companies/${companyId}/strategy-board/members`).send({ members: [{ userId: member.userId }, { userId: second.userId }] });
    expect((await message(second.actor, chat.id, "Me too")).status).toBe(403);

    // Taking the agent off their list closes the chat to new messages.
    await request(boardApp(owner)).put(`/api/companies/${companyId}/strategy-board/members/${member.userId}/agents`).send({ agentIds: [evidence.id] });
    expect((await message(member.actor, chat.id, "Still there?")).status).toBe(403);
    expect((await openChat(member.actor, companyId, secretary.id)).status).toBe(403);
  });

  it("from the board chat, a board member cannot create or change tasks, goals or agent settings", async () => {
    const { companyId, member, secretary, other } = await seedBoard("NoControl");
    const { kpi } = await seedPlan(companyId, other.id);
    const chat = (await openChat(member.actor, companyId, secretary.id)).body as Issue;
    const app = boardApp(member.actor);

    expect((await request(app).patch(`/api/issues/${chat.id}`).send({ workMode: "standard" })).status).toBe(403);
    expect((await request(app).patch(`/api/issues/${chat.id}`).send({ assigneeAgentId: other.id })).status).toBe(403);
    expect((await request(app).post(`/api/companies/${companyId}/issues`).send({ title: "Do this", assigneeAgentId: other.id })).status).toBe(403);
    expect((await request(app).patch(`/api/goals/${kpi.id}`).send({ title: "Changed" })).status).toBe(403);
    expect((await request(app).patch(`/api/agents/${secretary.id}`).send({ name: "Renamed" })).status).toBe(403);
    expect((await request(app).post(`/api/agents/${other.id}/wakeup`).send({})).status).toBe(403);

    const [stillAsk] = await ctx.db.select().from(issues).where(eq(issues.id, chat.id));
    expect(stillAsk).toMatchObject({ workMode: "ask", assigneeAgentId: secretary.id });
    const [goal] = await ctx.db.select().from(goals).where(eq(goals.id, kpi.id));
    expect(goal.title).toBe("Revenue");
    const created = await ctx.db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(created.map((issue) => issue.id)).toEqual([chat.id]);
  });

  it("the agent's run on a board chat may reply there and nothing else, even with responsible-user checks in shadow mode", async () => {
    const { companyId, member, secretary, other } = await seedBoard("RunGuard");
    const { kpi } = await seedPlan(companyId, other.id);
    const chat = (await openChat(member.actor, companyId, secretary.id)).body as Issue;
    const run = await runFor(companyId, secretary.id, chat.id);
    await ensureUser(member.userId);

    for (const shadow of [false, true]) {
      if (shadow) process.env.GSAM_RESPONSIBLE_USER_AUTHZ_MODE = "shadow";
      const app = agentApp(agentActor(companyId, secretary.id, run.id, member.userId));

      // Reading the plan is allowed.
      expect((await request(app).get(`/api/goals/${kpi.id}`)).status).toBe(200);

      const tries = [
        await request(app).post(`/api/companies/${companyId}/issues`).send({ title: "Chase revenue", assigneeAgentId: other.id }),
        await request(app).patch(`/api/issues/${chat.id}`).send({ workMode: "standard" }),
        await request(app).patch(`/api/goals/${kpi.id}`).send({ title: "Changed" }),
        await request(app).post(`/api/goals/${kpi.id}/readings`).send({ value: 199, readingDate: dayOffset(0) }),
        await request(app).patch(`/api/agents/${other.id}`).send({ name: "Renamed" }),
        await request(app).post(`/api/agents/${other.id}/wakeup`).send({}),
        await request(app).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "Why?" }),
      ];
      for (const res of tries) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("board_question_read_only");
      }

      const reply = await request(app).post(`/api/issues/${chat.id}/comments`).send({ body: `Revenue is 120 k (owner-reported, 5 days old). shadow=${shadow}` });
      expect(reply.status).toBe(201);
    }

    expect((await ctx.db.select().from(issues).where(eq(issues.companyId, companyId))).map((issue) => issue.id)).toEqual([chat.id]);
    const [goal] = await ctx.db.select().from(goals).where(eq(goals.id, kpi.id));
    expect(goal.title).toBe("Revenue");
    expect(await ctx.db.select().from(goalKpiReadings).where(eq(goalKpiReadings.value, 199))).toHaveLength(0);
    const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, other.id));
    expect(agent.name).toBe("Engineer");
  });

  it("the guard leaves runs on other work alone", async () => {
    const { companyId, owner, secretary } = await seedBoard("OtherWork");
    const task = await issueService(ctx.db).create(companyId, { title: "Normal task", status: "todo", assigneeAgentId: secretary.id });
    const run = await runFor(companyId, secretary.id, task.id);
    await ensureUser(owner.userId);
    const actor = { ...agentActor(companyId, secretary.id, run.id, owner.userId), onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }] };
    const res = await request(agentApp(actor)).post(`/api/issues/${task.id}/comments`).send({ body: "Working on it" });
    expect(res.status).toBe(201);
    expect(isReplyOnChat("POST", "/issues/TX-1/comments", { id: "x", identifier: "tx-1" })).toBe(true);
    expect(isReplyOnChat("PATCH", `/issues/x/comments`, { id: "x", identifier: null })).toBe(false);
    expect(isReplyOnChat("POST", `/issues/y/comments`, { id: "x", identifier: null })).toBe(false);
  });

  it("nothing shows and nothing works with the switch off", async () => {
    const { companyId, owner, member, secretary } = await seedBoard("SwitchOff");
    const chat = (await openChat(member.actor, companyId, secretary.id)).body as Issue;
    await setSwitch(false);
    for (const res of [
      await request(boardApp(member.actor)).get(`/api/companies/${companyId}/strategy-board/agents`),
      await request(boardApp(member.actor)).get(`/api/companies/${companyId}/strategy-board/chats/${secretary.id}`),
      await openChat(member.actor, companyId, secretary.id),
      await request(boardApp(owner)).put(`/api/companies/${companyId}/strategy-board/members/${member.userId}/agents`).send({ agentIds: [] }),
    ]) {
      expect(res.status).toBe(403);
    }
    expect((await message(member.actor, chat.id, "Hello?")).status).toBe(403);
    const comments = await ctx.db.select().from(issueComments).where(eq(issueComments.issueId, chat.id));
    expect(comments).toHaveLength(0);
  });

  // ---- What the agent answers from ----

  it("the agent's prompt for a board chat holds the questions-only directive and each KPI's source and age (fixture data)", async () => {
    const { companyId, other } = await seedBoard("Brief");
    const { kpi } = await seedPlan(companyId, other.id);
    await ctx.db.insert(issues).values({ companyId, title: "Call lapsed clients", status: "in_progress", goalId: kpi.id, assigneeAgentId: other.id, identifier: "BRF-7" });
    await ctx.db.insert(goalCheckIns).values({ companyId, goalId: kpi.id, authorAgentId: other.id, body: "Pipeline is thin this month.", progressPercent: 40 });

    const directive = await strategyBoardChatService(ctx.db).directiveFor(companyId);
    expect(directive).toContain("Questions only.");
    expect(directive).toContain(`KPI "Revenue" [id ${kpi.id}] under Grow revenue > Win new clients`);
    expect(directive).toContain(`latest 120 k on ${dayOffset(-5)} (source: owner-reported; age: 5 days old)`);
    expect(directive).toContain("owner Engineer");
    expect(directive).toContain('Task BRF-7 "Call lapsed clients": in_progress; assignee Engineer; for KPI "Revenue".');
    expect(directive).toContain("Pipeline is thin this month.");
    expect(directive).toMatch(/\/T[0-9A-F]{6}\/strategy-board\?askWhy=<KPI id>/);

    const markdown = buildPaperclipTaskMarkdown({
      issue: { id: "chat", identifier: "BRF-1", title: "Board questions", workMode: "ask", conversationAgentId: other.id },
      boardQuestionDirective: directive,
    } as Parameters<typeof buildPaperclipTaskMarkdown>[0]);
    expect(markdown).toContain("Board question directive:");
    expect(markdown).not.toContain("Chat mode directive:");
  });
});
