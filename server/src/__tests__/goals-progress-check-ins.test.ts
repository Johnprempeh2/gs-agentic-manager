import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { activityLog, agents, goalCheckIns, goals, issues } from "@greatstone/db";
import type { GoalDetail, GoalWithProgress } from "@greatstone/shared";
import { goalRoutes } from "../routes/goals.js";
import { agentService } from "../services/agents.js";
import { goalService } from "../services/goals.js";
import { computeGoalProgress, goalSubtreeIds, sortMilestones } from "../services/goal-progress.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describe("goal progress (pure)", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 0, n));

  it("skips cancelled sub-goal branches and survives a parent cycle", () => {
    const rows = [
      { id: "a", parentId: "c", status: "active", targetValue: null, currentValue: null, createdAt: at(1) },
      { id: "b", parentId: "a", status: "active", targetValue: null, currentValue: null, createdAt: at(2) },
      { id: "c", parentId: "a", status: "cancelled", targetValue: null, currentValue: null, createdAt: at(3) },
    ];
    expect(goalSubtreeIds("a", rows).sort()).toEqual(["a", "b"]);
  });

  it("clamps number-target progress to 0-100", () => {
    const progress = computeGoalProgress({ targetValue: 3, currentValue: 5 }, [], new Map());
    expect(progress).toMatchObject({ source: "number", percent: 100 });
  });

  it("orders milestones by status then created date and drops cancelled", () => {
    const sorted = sortMilestones([
      { id: "1", status: "todo", createdAt: at(1) },
      { id: "2", status: "done", createdAt: at(5) },
      { id: "3", status: "cancelled", createdAt: at(1) },
      { id: "4", status: "done", createdAt: at(2) },
      { id: "5", status: "in_progress", createdAt: at(1) },
    ]);
    expect(sorted.map((row) => row.id)).toEqual(["4", "2", "5", "1"]);
  });
});

describeEmbeddedPostgres("goals API: progress, blockers, check-ins, default owner", () => {
  const ctx = useEmbeddedPostgres("gsam-goals-progress-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(goalCheckIns);
      await db.delete(issues);
      await db.delete(goals);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedAgent(companyId: string, name: string, reportsTo: string | null = null) {
    const [agent] = await ctx.db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        reportsTo,
      })
      .returning();
    return agent;
  }

  async function seedGoal(companyId: string, values: Partial<typeof goals.$inferInsert> = {}) {
    const [goal] = await ctx.db
      .insert(goals)
      .values({ companyId, title: "Goal", level: "team", status: "active", ...values })
      .returning();
    return goal;
  }

  let issueCounter = 0;
  async function seedIssue(companyId: string, goalId: string, status: string, title = `Issue ${status}`) {
    issueCounter += 1;
    const [issue] = await ctx.db
      .insert(issues)
      .values({ companyId, goalId, status, title, identifier: `G-${issueCounter}`, issueNumber: issueCounter })
      .returning();
    return issue;
  }

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", agentId, companyId, runId: null, source: "agent_key" } as never;
  }

  it("rolls up linked issues from sub-goals and leaves cancelled issues out", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Rollup");
    const root = await seedGoal(companyId, { title: "Root" });
    const child = await seedGoal(companyId, { title: "Child", parentId: root.id });
    const cancelledChild = await seedGoal(companyId, { title: "Dropped", parentId: root.id, status: "cancelled" });
    await seedIssue(companyId, root.id, "done");
    await seedIssue(companyId, root.id, "cancelled");
    await seedIssue(companyId, child.id, "done");
    await seedIssue(companyId, child.id, "in_progress");
    await seedIssue(companyId, cancelledChild.id, "todo");
    const blocked = await seedIssue(companyId, child.id, "blocked", "Waiting on keys");

    const app = routeApp(ctx.db, actor, goalRoutes);
    const list = await request(app).get(`/api/companies/${companyId}/goals`);
    expect(list.status).toBe(200);
    const rootRow = (list.body as GoalWithProgress[]).find((g) => g.id === root.id)!;
    expect(rootRow.progress).toEqual({ percent: 50, source: "issues", done: 2, open: 1, blocked: 1, total: 4 });
    expect(rootRow.blockers).toEqual([
      { kind: "issue", issueId: blocked.id, identifier: blocked.identifier, title: "Waiting on keys", goalId: child.id },
    ]);
    const childRow = (list.body as GoalWithProgress[]).find((g) => g.id === child.id)!;
    expect(childRow.progress).toMatchObject({ percent: 33, done: 1, total: 3 });

    const detail = await request(app).get(`/api/goals/${root.id}`);
    expect(detail.status).toBe(200);
    const body = detail.body as GoalDetail;
    expect(body.subGoals.map((g) => g.id)).toEqual([child.id, cancelledChild.id]);
    expect(body.milestones.map((m) => m.status)).toEqual(["done", "done", "in_progress", "blocked"]);
  });

  it("uses the number target over issue counts when set", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Number");
    const goal = await seedGoal(companyId, { targetValue: 3, currentValue: 1, unit: "clients live" });
    await seedIssue(companyId, goal.id, "done");

    const res = await request(routeApp(ctx.db, actor, goalRoutes)).get(`/api/goals/${goal.id}`);
    expect(res.body.progress).toMatchObject({ percent: 33, source: "number", done: 1, total: 1 });
    expect(res.body).toMatchObject({ targetValue: 3, currentValue: 1, unit: "clients live" });
  });

  it("reports no percent for a goal with nothing to measure", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Empty");
    const goal = await seedGoal(companyId);
    const res = await request(routeApp(ctx.db, actor, goalRoutes)).get(`/api/goals/${goal.id}`);
    expect(res.body.progress).toEqual({ percent: null, source: "none", done: 0, open: 0, blocked: 0, total: 0 });
  });

  it("gives an unowned new goal to the lead agent and keeps an explicit owner", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Owner");
    const lead = await seedAgent(companyId, "Lead");
    const report = await seedAgent(companyId, "Report", lead.id);
    const app = routeApp(ctx.db, actor, goalRoutes);

    const defaulted = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Grow", targetDate: "2026-12-31", doneWhen: "Three clients live" });
    expect(defaulted.status).toBe(201);
    expect(defaulted.body).toMatchObject({ ownerAgentId: lead.id, targetDate: "2026-12-31", doneWhen: "Three clients live" });

    const explicit = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Ship", ownerAgentId: report.id });
    expect(explicit.body.ownerAgentId).toBe(report.id);
  });

  // Default ownership makes most goals point at an agent. Deleting that agent
  // used to fail on goals_owner_agent_id_agents_id_fk; it now clears the owner.
  it("clears goal ownership when the owning agent is deleted", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Delete owner");
    const lead = await seedAgent(companyId, "Lead");
    const goal = await goalService(ctx.db).create(companyId, { title: "Mission", level: "company" });
    expect(goal.ownerAgentId).toBe(lead.id);

    await agentService(ctx.db).remove(lead.id);
    expect((await goalService(ctx.db).getById(goal.id))?.ownerAgentId).toBeNull();
  });

  it("leaves the owner empty when the company has no agents", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "No agents");
    const goal = await goalService(ctx.db).create(companyId, { title: "Mission", level: "company" });
    expect(goal.ownerAgentId).toBeNull();
  });

  it("lets the owner and the lead check in, refuses other agents, lists newest first", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Check-ins");
    const lead = await seedAgent(companyId, "Lead");
    const owner = await seedAgent(companyId, "Owner", lead.id);
    const other = await seedAgent(companyId, "Other", lead.id);
    const goal = await seedGoal(companyId, { ownerAgentId: owner.id });
    await seedIssue(companyId, goal.id, "done");
    await seedIssue(companyId, goal.id, "todo");

    const refused = await request(routeApp(ctx.db, agentActor(companyId, other.id), goalRoutes))
      .post(`/api/goals/${goal.id}/check-ins`)
      .send({ body: "Not mine" });
    expect(refused.status).toBe(403);

    const byOwner = await request(routeApp(ctx.db, agentActor(companyId, owner.id), goalRoutes))
      .post(`/api/goals/${goal.id}/check-ins`)
      .send({ body: "Halfway", blockers: ["Waiting on legal"] });
    expect(byOwner.status).toBe(201);
    expect(byOwner.body).toMatchObject({ authorAgentId: owner.id, progressPercent: 50, blockers: ["Waiting on legal"] });

    const byLead = await request(routeApp(ctx.db, agentActor(companyId, lead.id), goalRoutes))
      .post(`/api/goals/${goal.id}/check-ins`)
      .send({ body: "Legal cleared", progressPercent: 60 });
    expect(byLead.status).toBe(201);

    const byBoard = await request(routeApp(ctx.db, actor, goalRoutes))
      .post(`/api/goals/${goal.id}/check-ins`)
      .send({ body: "Board note" });
    expect(byBoard.status).toBe(201);
    expect(byBoard.body).toMatchObject({ authorAgentId: null, authorUserId: actor.userId });

    const list = await request(routeApp(ctx.db, actor, goalRoutes)).get(`/api/goals/${goal.id}/check-ins`);
    expect(list.body.map((c: { body: string }) => c.body)).toEqual(["Board note", "Legal cleared", "Halfway"]);
  });

  it("adds blockers named in the latest check-in only", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Check-in blockers");
    const goal = await seedGoal(companyId);
    const svc = goalService(ctx.db);
    await svc.createCheckIn(goal, { body: "old", blockers: ["Stale blocker"] }, { agentId: null, userId: "u" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const latest = await svc.createCheckIn(goal, { body: "new", blockers: ["Need budget"] }, { agentId: null, userId: "u" });

    const res = await request(routeApp(ctx.db, actor, goalRoutes)).get(`/api/goals/${goal.id}`);
    expect(res.body.blockers).toEqual([{ kind: "check_in", text: "Need budget", checkInId: latest.id }]);
    expect(res.body.latestCheckIn.id).toBe(latest.id);
  });

  it("hides goals and check-ins from another company", async () => {
    const home = await seedCompanyWithBoardAccess(ctx.db, "Home");
    const away = await seedCompanyWithBoardAccess(ctx.db, "Away");
    const goal = await seedGoal(away.companyId);
    const app = routeApp(ctx.db, home.actor, goalRoutes);
    expect((await request(app).get(`/api/goals/${goal.id}/check-ins`)).status).toBe(404);
    expect((await request(app).post(`/api/goals/${goal.id}/check-ins`).send({ body: "x" })).status).toBe(404);
    expect((await request(app).get(`/api/goals/${randomUUID()}`)).status).toBe(404);
  });
});
