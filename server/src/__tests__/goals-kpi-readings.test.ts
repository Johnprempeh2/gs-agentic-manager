import request from "supertest";
import { eq } from "drizzle-orm";
import { activityLog, agents, goalCheckIns, goalKpiReadings, goals, issues } from "@greatstone/db";
import type { GoalDetail, GoalKpiReading, GoalWithProgress } from "@greatstone/shared";
import { expect, it } from "vitest";
import { goalRoutes } from "../routes/goals.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/** "YYYY-MM-DD" `days` from today (UTC). */
function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
const TODAY = dayOffset(0);

describeEmbeddedPostgres("goals API: KPI readings, status and budget (GRE-1133)", () => {
  const ctx = useEmbeddedPostgres("gsam-goals-kpi-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(goalKpiReadings);
      await db.delete(goalCheckIns);
      await db.delete(issues);
      await db.update(goals).set({ parentId: null });
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

  /** Revenue 100 → 200 over 200 days, today is the midpoint: plan today is 150. */
  function kpiPlan(values: Partial<typeof goals.$inferInsert> = {}) {
    return {
      kind: "kpi",
      baselineValue: 100,
      baselineDate: dayOffset(-100),
      targetValue: 200,
      targetDate: dayOffset(100),
      ...values,
    } satisfies Partial<typeof goals.$inferInsert>;
  }

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", agentId, companyId, runId: null, source: "agent_key" } as never;
  }

  it("records readings with source and author, lists them newest first, and moves the current value", async () => {
    const { companyId, actor, userId } = await seedCompanyWithBoardAccess(ctx.db, "Readings");
    const lead = await seedAgent(companyId, "Lead");
    const owner = await seedAgent(companyId, "Owner", lead.id);
    const checker = await seedAgent(companyId, "Checker", lead.id);
    const csf = await seedGoal(companyId, { kind: "csf", title: "Grow revenue" });
    const kpi = await seedGoal(companyId, { ...kpiPlan(), title: "Revenue", parentId: csf.id, ownerAgentId: owner.id });

    const byOwner = await request(routeApp(ctx.db, agentActor(companyId, owner.id), goalRoutes))
      .post(`/api/goals/${kpi.id}/readings`)
      .send({ value: 152, readingDate: dayOffset(-1), note: "From my sheet" });
    expect(byOwner.status).toBe(201);
    expect(byOwner.body).toMatchObject({
      value: 152,
      source: "owner_reported",
      recordedByAgentId: owner.id,
      recordedByUserId: null,
      note: "From my sheet",
    });

    const verified = await request(routeApp(ctx.db, agentActor(companyId, checker.id), goalRoutes))
      .post(`/api/goals/${kpi.id}/readings`)
      .send({ value: 128, readingDate: TODAY, source: "agent_verified", note: "Ledger says 128" });
    expect(verified.status).toBe(201);
    expect(verified.body).toMatchObject({ source: "agent_verified", recordedByAgentId: checker.id });

    // An older reading posted later does not move the current value.
    const byBoard = await request(routeApp(ctx.db, actor, goalRoutes))
      .post(`/api/goals/${kpi.id}/readings`)
      .send({ value: 110, readingDate: dayOffset(-50) });
    expect(byBoard.status).toBe(201);
    expect(byBoard.body).toMatchObject({ source: "owner_reported", recordedByUserId: userId, recordedByAgentId: null });

    const list = await request(routeApp(ctx.db, actor, goalRoutes)).get(`/api/goals/${kpi.id}/readings`);
    expect(list.status).toBe(200);
    expect((list.body as GoalKpiReading[]).map((r) => [r.value, r.source])).toEqual([
      [128, "agent_verified"],
      [152, "owner_reported"],
      [110, "owner_reported"],
    ]);

    const [row] = await ctx.db.select().from(goals).where(eq(goals.id, kpi.id));
    expect(row.currentValue).toBe(128);

    // The verified 128 against a plan of 150 is 22% of the planned change behind: red.
    const detail = await request(routeApp(ctx.db, actor, goalRoutes)).get(`/api/goals/${kpi.id}`);
    expect((detail.body as GoalDetail).kpiStatus).toMatchObject({
      status: "red",
      reason: "behind_plan",
      plannedValue: 150,
      gapPercent: 22,
      latestValue: 128,
    });
    expect((detail.body as GoalDetail).latestReading).toMatchObject({ value: 128, source: "agent_verified" });

    const activity = await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, kpi.id));
    expect(activity.filter((a) => a.action === "goal.kpi_reading_recorded")).toHaveLength(3);
  });

  it("enforces who may post which source", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Sources");
    const lead = await seedAgent(companyId, "Lead");
    const owner = await seedAgent(companyId, "Owner", lead.id);
    const other = await seedAgent(companyId, "Other", lead.id);
    const csf = await seedGoal(companyId, { kind: "csf" });
    const kpi = await seedGoal(companyId, { ...kpiPlan(), parentId: csf.id, ownerAgentId: owner.id });
    const post = (who: never, body: object) =>
      request(routeApp(ctx.db, who, goalRoutes)).post(`/api/goals/${kpi.id}/readings`).send(body);

    // The owner cannot mark its own number as checked.
    const selfVerify = await post(agentActor(companyId, owner.id), { value: 1, readingDate: TODAY, source: "agent_verified" });
    expect(selfVerify.status).toBe(403);
    expect(selfVerify.body.details).toMatchObject({ code: "kpi_reading_self_verify" });
    const selfSystem = await post(agentActor(companyId, owner.id), { value: 1, readingDate: TODAY, source: "system" });
    expect(selfSystem.status).toBe(403);

    // A person cannot post a verified or system reading.
    const userVerify = await post(actor as never, { value: 1, readingDate: TODAY, source: "agent_verified" });
    expect(userVerify.status).toBe(403);
    expect(userVerify.body.details).toMatchObject({ code: "kpi_reading_agent_only" });

    // Another agent may not report for the owner, but may verify or import.
    const otherOwnerReported = await post(agentActor(companyId, other.id), { value: 1, readingDate: TODAY });
    expect(otherOwnerReported.status).toBe(403);
    expect((await post(agentActor(companyId, other.id), { value: 1, readingDate: TODAY, source: "system" })).status).toBe(201);
    expect((await post(agentActor(companyId, lead.id), { value: 1, readingDate: TODAY })).status).toBe(201);

    // Bad input and non-KPI goals.
    expect((await post(actor as never, { value: 1, readingDate: "yesterday" })).status).toBe(400);
    expect((await post(actor as never, { value: 1, readingDate: TODAY, source: "guess" })).status).toBe(400);
    const objective = await seedGoal(companyId, { kind: "objective", parentId: csf.id });
    const notKpi = await request(routeApp(ctx.db, actor, goalRoutes))
      .post(`/api/goals/${objective.id}/readings`)
      .send({ value: 1, readingDate: TODAY });
    expect(notKpi.status).toBe(422);
  });

  it("keeps readings inside the company", async () => {
    const a = await seedCompanyWithBoardAccess(ctx.db, "Company A");
    const b = await seedCompanyWithBoardAccess(ctx.db, "Company B");
    const csf = await seedGoal(a.companyId, { kind: "csf" });
    const kpi = await seedGoal(a.companyId, { ...kpiPlan(), parentId: csf.id });
    await request(routeApp(ctx.db, a.actor, goalRoutes))
      .post(`/api/goals/${kpi.id}/readings`)
      .send({ value: 150, readingDate: TODAY });

    const appB = routeApp(ctx.db, b.actor, goalRoutes);
    // Another company sees no such goal.
    expect((await request(appB).get(`/api/goals/${kpi.id}/readings`)).status).toBe(404);
    expect((await request(appB).post(`/api/goals/${kpi.id}/readings`).send({ value: 1, readingDate: TODAY })).status).toBe(404);
  });

  it("rolls status up pillar → objective → KPI: worst child wins", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Rollup");
    const csf = await seedGoal(companyId, { kind: "csf", title: "CSF" });
    const pillar = await seedGoal(companyId, { kind: "pillar", title: "Employer of choice", parentId: csf.id });
    const objA = await seedGoal(companyId, { kind: "objective", title: "Retain talent", parentId: pillar.id });
    const objB = await seedGoal(companyId, { kind: "objective", title: "Hire well", parentId: pillar.id });
    const green = await seedGoal(companyId, { ...kpiPlan(), title: "On plan", parentId: objA.id });
    const amber = await seedGoal(companyId, { ...kpiPlan(), title: "Slipping", parentId: objA.id });
    const unread = await seedGoal(companyId, { ...kpiPlan(), title: "No reading", parentId: objB.id });
    // Churn, down is good: 20 → 10, plan today is 15; 17 is 20% behind.
    const red = await seedGoal(companyId, {
      ...kpiPlan({ baselineValue: 20, targetValue: 10, kpiDirection: "down" }),
      title: "Churn",
      parentId: objB.id,
    });
    const app = routeApp(ctx.db, actor, goalRoutes);
    for (const [goal, value] of [[green, 151], [amber, 138], [red, 17]] as const) {
      const res = await request(app).post(`/api/goals/${goal.id}/readings`).send({ value, readingDate: TODAY });
      expect(res.status).toBe(201);
    }

    const list = await request(app).get(`/api/companies/${companyId}/goals`);
    const byId = new Map((list.body as GoalWithProgress[]).map((goal) => [goal.id, goal]));
    expect(byId.get(green.id)?.kpiStatus?.status).toBe("green");
    expect(byId.get(amber.id)?.kpiStatus).toMatchObject({ status: "amber", gapPercent: 12 });
    expect(byId.get(red.id)?.kpiStatus).toMatchObject({ status: "red", gapPercent: 20 });
    expect(byId.get(unread.id)?.kpiStatus).toMatchObject({ status: null, reason: "no_reading" });
    expect(byId.get(objA.id)?.kpiStatus).toBeNull();
    expect(byId.get(objA.id)?.ragRollup).toEqual({ status: "amber", red: 0, amber: 1, green: 1, noStatus: 0 });
    expect(byId.get(objB.id)?.ragRollup).toEqual({ status: "red", red: 1, amber: 0, green: 0, noStatus: 1 });
    expect(byId.get(pillar.id)?.ragRollup).toEqual({ status: "red", red: 1, amber: 1, green: 1, noStatus: 1 });
    expect(byId.get(csf.id)?.ragRollup.status).toBe("red");

    // The detail view carries the same roll-up on the goal and its sub-goals.
    const detail = (await request(app).get(`/api/goals/${pillar.id}`)).body as GoalDetail;
    expect(detail.ragRollup.status).toBe("red");
    expect(new Map(detail.subGoals.map((g) => [g.id, g.ragRollup.status]))).toEqual(
      new Map([[objA.id, "amber"], [objB.id, "red"]]),
    );
  });

  it("past the deadline a KPI short of target is red", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Late");
    const csf = await seedGoal(companyId, { kind: "csf" });
    const kpi = await seedGoal(companyId, {
      ...kpiPlan({ baselineDate: dayOffset(-300), targetDate: dayOffset(-10) }),
      parentId: csf.id,
    });
    const app = routeApp(ctx.db, actor, goalRoutes);
    await request(app).post(`/api/goals/${kpi.id}/readings`).send({ value: 195, readingDate: TODAY });
    const detail = (await request(app).get(`/api/goals/${kpi.id}`)).body as GoalDetail;
    expect(detail.kpiStatus).toMatchObject({ status: "red", reason: "deadline_missed" });
  });

  it("saves KPI plan fields and initiative budget, and checks the thresholds", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Fields");
    const app = routeApp(ctx.db, actor, goalRoutes);
    const csf = await seedGoal(companyId, { kind: "csf" });
    const objective = await seedGoal(companyId, { kind: "objective", parentId: csf.id });

    const kpi = await request(app).post(`/api/companies/${companyId}/goals`).send({
      title: "Incidents",
      kind: "kpi",
      parentId: csf.id,
      baselineValue: 12,
      baselineDate: dayOffset(-30),
      targetValue: 0,
      targetDate: dayOffset(300),
      kpiDirection: "down",
      amberThresholdPct: 5,
      redThresholdPct: 15,
    });
    expect(kpi.status).toBe(201);
    expect(kpi.body).toMatchObject({ targetValue: 0, kpiDirection: "down", amberThresholdPct: 5, redThresholdPct: 15 });

    const badLines = await request(app).patch(`/api/goals/${kpi.body.id}`).send({ redThresholdPct: 3 });
    expect(badLines.status).toBe(422);
    expect(badLines.body.error).toMatch(/red line/);

    const initiative = await request(app).post(`/api/companies/${companyId}/goals`).send({
      title: "New payroll system",
      kind: "initiative",
      parentId: objective.id,
      budgetPlannedCents: 5_000_000_00,
      budgetSpentCents: 1_250_000_00,
      budgetCurrency: "ngn",
    });
    expect(initiative.status).toBe(201);
    expect(initiative.body).toMatchObject({
      budgetPlannedCents: 5_000_000_00,
      budgetSpentCents: 1_250_000_00,
      budgetCurrency: "NGN",
    });
    const badCurrency = await request(app).patch(`/api/goals/${initiative.body.id}`).send({ budgetCurrency: "naira" });
    expect(badCurrency.status).toBe(400);
  });
});
