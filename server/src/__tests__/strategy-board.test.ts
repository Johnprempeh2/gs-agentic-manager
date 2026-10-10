import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companyMemberships,
  goalCheckIns,
  goalKpiAlerts,
  goalKpiReadings,
  goals,
  goalWhyRequests,
  issueComments,
  issues,
  principalPermissionGrants,
  strategyBoardPacks,
} from "@greatstone/db";
import type { GoalWhyRequest, StrategyBoardMember, StrategyBoardPack, StrategyBoardSummary } from "@greatstone/shared";
import { beforeEach, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { companyRoutes } from "../routes/companies.js";
import { goalRoutes } from "../routes/goals.js";
import { issueRoutes } from "../routes/issues.js";
import { strategyBoardRoutes } from "../routes/strategy-board.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { runScheduledStrategyBoardAlerts } from "../services/strategy-board.js";
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
const TODAY = dayOffset(0);

describeEmbeddedPostgres("board control panel (GRE-1135)", () => {
  const ctx = useEmbeddedPostgres("gsam-strategy-board-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(strategyBoardPacks);
      await db.delete(goalKpiAlerts);
      await db.delete(goalWhyRequests);
      await db.delete(goalKpiReadings);
      await db.delete(goalCheckIns);
      await db.delete(issueComments);
      await db.delete(issues);
      await db.update(goals).set({ parentId: null });
      await db.delete(goals);
      await db.delete(agents);
      await db.delete(principalPermissionGrants);
      await resetCompanyIssueFixtures(db);
    },
  });

  // resetEach runs after each test; the switch must be on before each one.
  beforeEach(async () => {
    await instanceSettingsService(ctx.db).updateExperimental({ enableStrategyBoard: true });
  });

  async function setSwitch(on: boolean) {
    await instanceSettingsService(ctx.db).updateExperimental({ enableStrategyBoard: on });
  }

  async function addMember(companyId: string, role: "owner" | "admin" | "operator" | "viewer", name = role) {
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
      .values({ companyId, name, role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    return agent;
  }

  /** A CSF with an objective and a KPI: revenue 100 → 200 over 200 days, so the plan today is 150. */
  async function seedPlan(companyId: string, owner: { ownerUserId?: string; ownerAgentId?: string } = {}) {
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
        ...owner,
      })
      .returning();
    return { csf, objective, kpi };
  }

  function app(actor: BoardActor) {
    return routeApp(ctx.db, actor, goalRoutes, strategyBoardRoutes, issueRoutes);
  }

  async function postReading(actor: BoardActor, goalId: string, value: number, readingDate = TODAY) {
    const res = await request(app(actor)).post(`/api/goals/${goalId}/readings`).send({ value, readingDate });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function setBoard(owner: BoardActor, companyId: string, members: Array<{ userId: string; chair?: boolean }>) {
    return request(app(owner)).put(`/api/companies/${companyId}/strategy-board/members`).send({ members });
  }

  async function alertIssues(companyId: string) {
    return ctx.db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "strategy_board_kpi_alert")));
  }

  // ---- Slippage alerts: who gets them, and when ----

  it("alerts the chair once when a KPI turns red, not again while it stays red, and again after it recovers", async () => {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, "Alerts");
    const chair = await addMember(companyId, "viewer", "chair");
    const member = await addMember(companyId, "viewer", "member");
    expect((await setBoard(owner, companyId, [{ userId: chair.userId, chair: true }, { userId: member.userId }])).status).toBe(200);
    const { kpi } = await seedPlan(companyId);

    // Amber (15% behind): no alert.
    await postReading(owner, kpi.id, 135);
    expect(await alertIssues(companyId)).toHaveLength(0);

    // Red (30% behind): one alert task, assigned to the chair only.
    const red = await postReading(owner, kpi.id, 120);
    let tasks = await alertIssues(companyId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ assigneeUserId: chair.userId, assigneeAgentId: null, status: "todo", goalId: kpi.id });
    expect(tasks[0].title).toBe("KPI turned red: Revenue");
    const [spell] = await ctx.db.select().from(goalKpiAlerts).where(eq(goalKpiAlerts.goalId, kpi.id));
    expect(spell).toMatchObject({ recipientUserId: chair.userId, readingId: red.id, clearedAt: null, alertIssueId: tasks[0].id });

    // Still red, a new reading and a plan edit: no repeat alert.
    await postReading(owner, kpi.id, 110);
    expect((await request(app(owner)).patch(`/api/goals/${kpi.id}`).send({ redThresholdPct: 25 })).status).toBe(200);
    await runScheduledStrategyBoardAlerts(ctx.db, Date.now() + 10 * 3_600_000);
    expect(await alertIssues(companyId)).toHaveLength(1);

    // Back on plan: the spell closes and the alert task is done.
    await postReading(owner, kpi.id, 150);
    tasks = await alertIssues(companyId);
    expect(tasks[0].status).toBe("done");
    const [closed] = await ctx.db.select().from(goalKpiAlerts).where(eq(goalKpiAlerts.goalId, kpi.id));
    expect(closed.clearedAt).not.toBeNull();

    // Red again later: a new spell, a new alert.
    await postReading(owner, kpi.id, 100);
    tasks = await alertIssues(companyId);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.assigneeUserId === chair.userId)).toBe(true);
  });

  it("records the red spell but sends nothing when the board has no chair, and the board view says so", async () => {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, "NoChair");
    const member = await addMember(companyId, "viewer", "member");
    await setBoard(owner, companyId, [{ userId: member.userId }]);
    const { kpi } = await seedPlan(companyId);
    await postReading(owner, kpi.id, 100);
    expect(await alertIssues(companyId)).toHaveLength(0);
    const spells = await ctx.db.select().from(goalKpiAlerts).where(eq(goalKpiAlerts.goalId, kpi.id));
    expect(spells).toEqual([expect.objectContaining({ recipientUserId: null, alertIssueId: null })]);
    const summary = await request(app(member.actor)).get(`/api/companies/${companyId}/strategy-board`);
    expect((summary.body as StrategyBoardSummary).unsentAlerts).toBe(1);
    expect((summary.body as StrategyBoardSummary).hasChair).toBe(false);
  });

  it("sends no alert with the switch off", async () => {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, "SwitchOffAlert");
    const chair = await addMember(companyId, "viewer", "chair");
    await setBoard(owner, companyId, [{ userId: chair.userId, chair: true }]);
    const { kpi } = await seedPlan(companyId);
    await setSwitch(false);
    await postReading(owner, kpi.id, 100);
    await runScheduledStrategyBoardAlerts(ctx.db, Date.now() + 20 * 3_600_000);
    expect(await alertIssues(companyId)).toHaveLength(0);
    expect(await ctx.db.select().from(goalKpiAlerts)).toHaveLength(0);
  });

  it("the hourly sweep alerts a KPI that turned red because its deadline passed", async () => {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, "Deadline");
    await setBoard(owner, companyId, [{ userId: (await addMember(companyId, "viewer", "chair")).userId, chair: true }]);
    const { kpi } = await seedPlan(companyId);
    await postReading(owner, kpi.id, 150, dayOffset(-1));
    expect(await alertIssues(companyId)).toHaveLength(0);
    // The deadline passes with no new reading.
    await ctx.db.update(goals).set({ targetDate: dayOffset(-1), baselineDate: dayOffset(-200) }).where(eq(goals.id, kpi.id));
    await runScheduledStrategyBoardAlerts(ctx.db, Date.now() + 30 * 3_600_000);
    expect(await alertIssues(companyId)).toHaveLength(1);
  });

  // ---- Board member right ----

  it("a board member reads the board, asks why and makes a pack, but cannot edit goals, change settings or run agents", async () => {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, "Rights");
    const board = await addMember(companyId, "viewer", "board");
    await setBoard(owner, companyId, [{ userId: board.userId }]);
    const agent = await seedAgent(companyId, "Owner agent");
    const { csf, kpi } = await seedPlan(companyId, { ownerAgentId: agent.id });

    const summary = await request(app(board.actor)).get(`/api/companies/${companyId}/strategy-board`);
    expect(summary.status).toBe(200);
    expect((summary.body as StrategyBoardSummary).viewer).toEqual({
      isBoardMember: true, isChair: false, mayAskWhy: true, mayMakeBoardPack: true, mayManageMembers: false,
    });
    expect((await request(app(board.actor)).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "Why?" })).status).toBe(201);
    expect((await request(app(board.actor)).post(`/api/companies/${companyId}/strategy-board/packs`).send({ periodStart: dayOffset(-90), periodEnd: TODAY })).status).toBe(201);

    // Goals: no edit at any layer, no new goals, no readings, no delete.
    expect((await request(app(board.actor)).patch(`/api/goals/${kpi.id}`).send({ title: "Changed" })).status).toBe(403);
    expect((await request(app(board.actor)).patch(`/api/goals/${csf.id}`).send({ title: "Changed" })).status).toBe(403);
    expect((await request(app(board.actor)).post(`/api/companies/${companyId}/goals`).send({ title: "New", kind: "objective", parentId: csf.id })).status).toBe(403);
    expect((await request(app(board.actor)).post(`/api/goals/${kpi.id}/readings`).send({ value: 1, readingDate: TODAY })).status).toBe(403);
    expect((await request(app(board.actor)).delete(`/api/goals/${kpi.id}`)).status).toBe(403);
    expect((await request(app(board.actor)).post(`/api/why-requests/00000000-0000-4000-8000-000000000001/answer`).send({ answer: "x" })).status).toBe(404);
    // Board: cannot choose the board.
    expect((await setBoard(board.actor, companyId, [])).status).toBe(403);

    // Settings: the company settings route refuses.
    const settingsApp = express();
    settingsApp.use(express.json());
    settingsApp.use((req, _res, next) => { (req as any).actor = board.actor; next(); });
    settingsApp.use("/api/companies", companyRoutes(ctx.db));
    settingsApp.use(errorHandler);
    expect((await request(settingsApp).patch(`/api/companies/${companyId}`).send({ name: "Renamed" })).status).toBe(403);

    // Agents: cannot wake an agent.
    const agentsApp = routeApp(ctx.db, board.actor, (db) => agentRoutes(db, {}));
    expect((await request(agentsApp).post(`/api/agents/${agent.id}/wakeup`).send({ source: "on_demand" })).status).toBe(403);

    const [row] = await ctx.db.select().from(goals).where(eq(goals.id, kpi.id));
    expect(row.title).toBe("Revenue");
  });

  it("a plain viewer or an operator without the board right cannot ask why or make a pack", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "NoRight");
    const viewer = await addMember(companyId, "viewer", "viewer");
    const operator = await addMember(companyId, "operator", "operator");
    const { kpi } = await seedPlan(companyId, { ownerUserId: operator.userId });
    for (const actor of [viewer.actor, operator.actor]) {
      const why = await request(app(actor)).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "Why?" });
      expect(why.status).toBe(403);
      expect(why.body.details?.code ?? why.body.code).toBe("board_action_required");
      expect((await request(app(actor)).post(`/api/companies/${companyId}/strategy-board/packs`).send({ periodStart: TODAY, periodEnd: TODAY })).status).toBe(403);
    }
  });

  it("only viewers can be board members; an owner may be named chair; only owners choose the board", async () => {
    const { companyId, actor: owner, userId: ownerId } = await seedCompanyWithBoardAccess(ctx.db, "Members");
    const operator = await addMember(companyId, "operator", "operator");
    const admin = await addMember(companyId, "admin", "admin");
    const viewer = await addMember(companyId, "viewer", "viewer");

    const bad = await setBoard(owner, companyId, [{ userId: operator.userId }]);
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain("board_member_must_be_viewer");
    expect((await setBoard(owner, companyId, [{ userId: ownerId }])).status).toBe(422);
    expect((await setBoard(owner, companyId, [{ userId: viewer.userId, chair: true }, { userId: ownerId, chair: true }])).status).toBe(400);
    expect((await setBoard(admin.actor, companyId, [{ userId: viewer.userId }])).status).toBe(403);

    const ok = await setBoard(owner, companyId, [{ userId: viewer.userId }, { userId: ownerId, chair: true }]);
    expect(ok.status).toBe(200);
    const members = ok.body as StrategyBoardMember[];
    expect(members.find((m) => m.userId === viewer.userId)).toMatchObject({ isBoardMember: true, isChair: false });
    expect(members.find((m) => m.userId === ownerId)).toMatchObject({ isBoardMember: false, isChair: true });
    expect(members.find((m) => m.userId === operator.userId)).toMatchObject({ isBoardMember: false, isChair: false });

    // Another company's owner cannot see or set this board.
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    expect((await setBoard(other.actor, companyId, [])).status).toBe(403);
  });

  // ---- "Why?" requests ----

  it("a why request goes to the owner as a task; the owner's answer is logged on the KPI and closes the task", async () => {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, "Why");
    const board = await addMember(companyId, "viewer", "board");
    await setBoard(owner, companyId, [{ userId: board.userId }]);
    const kpiOwner = await addMember(companyId, "operator", "coo");
    const stranger = await addMember(companyId, "operator", "other");
    const { kpi } = await seedPlan(companyId, { ownerUserId: kpiOwner.userId });

    const asked = await request(app(board.actor)).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "Why is revenue behind?" });
    expect(asked.status).toBe(201);
    const why = asked.body as GoalWhyRequest;
    expect(why).toMatchObject({ status: "open", askedByUserId: board.userId, ownerUserId: kpiOwner.userId });
    const [task] = await ctx.db.select().from(issues).where(eq(issues.id, why.ownerIssueId!));
    expect(task).toMatchObject({ assigneeUserId: kpiOwner.userId, originKind: "strategy_board_why_request", originId: why.id, status: "todo" });

    const summary = (await request(app(board.actor)).get(`/api/companies/${companyId}/strategy-board`)).body as StrategyBoardSummary;
    expect(summary.kpis[0].openWhyRequests).toBe(1);

    expect((await request(app(stranger.actor)).post(`/api/why-requests/${why.id}/answer`).send({ answer: "Not mine" })).status).toBe(403);
    const answered = await request(app(kpiOwner.actor)).post(`/api/why-requests/${why.id}/answer`).send({ answer: "Two deals moved to next quarter." });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ status: "answered", answer: "Two deals moved to next quarter.", answeredByUserId: kpiOwner.userId });
    expect((await request(app(kpiOwner.actor)).post(`/api/why-requests/${why.id}/answer`).send({ answer: "Again" })).status).toBe(409);

    const [doneTask] = await ctx.db.select().from(issues).where(eq(issues.id, why.ownerIssueId!));
    expect(doneTask.status).toBe("done");
    const list = await request(app(board.actor)).get(`/api/goals/${kpi.id}/why-requests`);
    expect((list.body as GoalWhyRequest[]).map((r) => [r.status, r.answer])).toEqual([["answered", "Two deals moved to next quarter."]]);
  });

  it("a why request on an agent-owned KPI goes to the agent, who may answer", async () => {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, "WhyAgent");
    const agent = await seedAgent(companyId, "Sales agent");
    const { kpi } = await seedPlan(companyId, { ownerAgentId: agent.id });
    const asked = await request(app(owner)).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "Why?" });
    expect(asked.status).toBe(201);
    const [task] = await ctx.db.select().from(issues).where(eq(issues.id, asked.body.ownerIssueId));
    expect(task).toMatchObject({ assigneeAgentId: agent.id, assigneeUserId: null });
    const agentActor = { type: "agent", agentId: agent.id, companyId, runId: null, source: "agent_key" } as never;
    const answered = await request(app(agentActor)).post(`/api/why-requests/${asked.body.id}/answer`).send({ answer: "Pipeline is thin." });
    expect(answered.status).toBe(200);
    expect(answered.body.answeredByAgentId).toBe(agent.id);
  });

  // ---- Board view and board pack ----

  it("the board view ranks slippages and the pack freezes status, readings and explanations; changes compare with the last pack", async () => {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, "Pack");
    const kpiOwner = await addMember(companyId, "operator", "coo");
    const { csf, kpi } = await seedPlan(companyId, { ownerUserId: kpiOwner.userId });
    const [second] = await ctx.db
      .insert(goals)
      .values({ companyId, title: "Margin", kind: "kpi", level: "task", status: "active", parentId: csf.id, baselineValue: 10, baselineDate: dayOffset(-100), targetValue: 20, targetDate: dayOffset(100) })
      .returning();
    await postReading(owner, kpi.id, 120, dayOffset(-2)); // 30% behind: red
    await postReading(owner, second.id, 14); // 10% behind: amber

    const why = await request(app(owner)).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "Why so low?" });
    await request(app(kpiOwner.actor)).post(`/api/why-requests/${why.body.id}/answer`).send({ answer: "A large client left." });

    const before = (await request(app(owner)).get(`/api/companies/${companyId}/strategy-board`)).body as StrategyBoardSummary;
    expect(before.attention.map((k) => [k.title, k.status])).toEqual([["Revenue", "red"], ["Margin", "amber"]]);
    expect(before.attention[0]).toMatchObject({ areaTitle: "Grow revenue", objectiveTitle: "Win new clients", latestReadingSource: "owner_reported", readingAgeDays: 2 });
    expect(before.areas).toEqual([expect.objectContaining({ title: "Grow revenue", rollup: expect.objectContaining({ status: "red", red: 1, amber: 1 }) })]);
    expect(before.lastSnapshot).toBeNull();
    expect(before.changes).toEqual([]);

    const created = await request(app(owner))
      .post(`/api/companies/${companyId}/strategy-board/packs`)
      .send({ periodStart: dayOffset(-30), periodEnd: TODAY, title: "Q4 board pack" });
    expect(created.status).toBe(201);
    const pack = created.body as StrategyBoardPack;
    expect(pack.snapshot.counts).toEqual({ red: 1, amber: 1, green: 0, noStatus: 0 });
    expect(pack.snapshot.readings).toHaveLength(2);
    expect(pack.body).toContain("# Q4 board pack");
    // Reading two days old: the plan on its date is 149, so 29% behind.
    expect(pack.body).toContain("| Revenue | Red | 29% | 120 k | 149 k | Owner reported (2 days old) |");
    expect(pack.body).toContain("> A large client left.");
    expect(pack.body).toContain("2 readings: 0 checked by an agent or taken from a system, 2 reported by the owner.");

    // The pack is frozen: a later reading changes the board, not the pack.
    await postReading(owner, kpi.id, 150);
    const fetched = (await request(app(owner)).get(`/api/strategy-board/packs/${pack.id}`)).body as StrategyBoardPack;
    expect(fetched.body).toBe(pack.body);
    const after = (await request(app(owner)).get(`/api/companies/${companyId}/strategy-board`)).body as StrategyBoardSummary;
    expect(after.lastSnapshot).toMatchObject({ packId: pack.id, title: "Q4 board pack" });
    expect(after.changes.map((k) => [k.title, k.previousStatus, k.status])).toEqual([["Revenue", "red", "green"]]);

    // Another company cannot read it.
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    expect((await request(app(other.actor)).get(`/api/strategy-board/packs/${pack.id}`)).status).toBe(404);
    expect((await request(app(other.actor)).get(`/api/companies/${companyId}/strategy-board`)).status).toBe(403);
    expect((await request(app(other.actor)).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "?" })).status).toBe(404);
  });

  // ---- Due dates on plan actions (GRE-1188) ----

  it("a task under a plan objective takes a due date; overdue ones show on the board and in the pack; off-plan tasks do not change", async () => {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, "DueDates");
    const doer = await addMember(companyId, "operator", "doer");
    const { csf, objective } = await seedPlan(companyId);
    const [initiative] = await ctx.db
      .insert(goals)
      .values({ companyId, title: "Open two branches", kind: "initiative", level: "team", status: "active", parentId: objective.id })
      .returning();
    const createTask = (body: Record<string, unknown>) =>
      request(app(owner)).post(`/api/companies/${companyId}/issues`).send({ status: "backlog", ...body });

    // Set a due date on a task under the objective (through an initiative), then change it.
    const created = await createTask({ title: "Sign the lease", goalId: initiative.id, assigneeUserId: doer.userId, dueDate: dayOffset(-2) });
    expect(created.status).toBe(201);
    expect(created.body.dueDate).toBe(dayOffset(-2));
    const changed = await request(app(owner)).patch(`/api/issues/${created.body.id}`).send({ dueDate: dayOffset(-5) });
    expect(changed.status).toBe(200);
    expect(changed.body.dueDate).toBe(dayOffset(-5));
    expect((await request(app(owner)).get(`/api/issues/${created.body.id}`)).body.dueDate).toBe(dayOffset(-5));

    // Not overdue: due later, or done.
    expect((await createTask({ title: "Hire branch staff", goalId: objective.id, dueDate: dayOffset(7) })).status).toBe(201);
    const done = await createTask({ title: "Pick the towns", goalId: objective.id, dueDate: dayOffset(-9) });
    expect((await request(app(owner)).patch(`/api/issues/${done.body.id}`).send({ status: "done" })).status).toBe(200);

    // A task not on the plan cannot take a due date, and stays as it was.
    const offPlan = await createTask({ title: "Fix the printer" });
    expect(offPlan.status).toBe(201);
    expect(offPlan.body.dueDate ?? null).toBeNull();
    const refused = await request(app(owner)).patch(`/api/issues/${offPlan.body.id}`).send({ dueDate: dayOffset(-1) });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain("due_date_needs_plan_objective");
    expect((await createTask({ title: "Area only", goalId: csf.id, dueDate: dayOffset(-1) })).status).toBe(422);
    const [offPlanRow] = await ctx.db.select().from(issues).where(eq(issues.id, offPlan.body.id));
    expect(offPlanRow.dueDate).toBeNull();

    // The board lists the overdue action under its objective and owner.
    const board = (await request(app(owner)).get(`/api/companies/${companyId}/strategy-board`)).body as StrategyBoardSummary;
    expect(board.overdueActions).toEqual([
      expect.objectContaining({
        issueId: created.body.id,
        title: "Sign the lease",
        dueDate: dayOffset(-5),
        daysOverdue: 5,
        objectiveId: objective.id,
        objectiveTitle: "Win new clients",
        areaTitle: "Grow revenue",
        owner: { type: "user", id: doer.userId, name: null },
      }),
    ]);

    // The board pack records it.
    const pack = (await request(app(owner))
      .post(`/api/companies/${companyId}/strategy-board/packs`)
      .send({ periodStart: dayOffset(-30), periodEnd: TODAY })).body as StrategyBoardPack;
    expect(pack.snapshot.overdueActions).toHaveLength(1);
    expect(pack.body).toContain("## Overdue actions");
    expect(pack.body).toContain(`| Win new clients | A person | ${created.body.identifier} Sign the lease | ${dayOffset(-5)} | 5 |`);
    expect(pack.body).not.toContain("Fix the printer");

    // Moving the task off the plan clears its due date; null clears it too.
    const moved = await request(app(owner)).patch(`/api/issues/${created.body.id}`).send({ goalId: csf.id });
    expect(moved.status).toBe(200);
    expect(moved.body.dueDate).toBeNull();
    const later = await createTask({ title: "Agree rent", goalId: objective.id, dueDate: dayOffset(3) });
    const cleared = await request(app(owner)).patch(`/api/issues/${later.body.id}`).send({ dueDate: null });
    expect(cleared.body.dueDate).toBeNull();
    const empty = (await request(app(owner)).get(`/api/companies/${companyId}/strategy-board`)).body as StrategyBoardSummary;
    expect(empty.overdueActions).toEqual([]);
  });

  // ---- Switch off ----

  it("with the switch off, nothing of the board answers", async () => {
    const { companyId, actor: owner } = await seedCompanyWithBoardAccess(ctx.db, "Off");
    const { kpi } = await seedPlan(companyId);
    await setSwitch(false);
    const calls = [
      request(app(owner)).get(`/api/companies/${companyId}/strategy-board`),
      request(app(owner)).get(`/api/companies/${companyId}/strategy-board/packs`),
      request(app(owner)).post(`/api/companies/${companyId}/strategy-board/packs`).send({ periodStart: TODAY, periodEnd: TODAY }),
      request(app(owner)).put(`/api/companies/${companyId}/strategy-board/members`).send({ members: [] }),
      request(app(owner)).get(`/api/goals/${kpi.id}/why-requests`),
      request(app(owner)).post(`/api/goals/${kpi.id}/why-requests`).send({ question: "Why?" }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toContain("not_entitled");
    }
    // Goals themselves keep working.
    expect((await request(app(owner)).get(`/api/goals/${kpi.id}`)).status).toBe(200);
  });
});
