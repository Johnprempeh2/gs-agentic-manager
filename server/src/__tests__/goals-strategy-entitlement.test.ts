import request from "supertest";
import { activityLog, goalKpiReadings, goalCheckIns, goals, instanceSettings, issues } from "@greatstone/db";
import { expect, it } from "vitest";
import { goalRoutes } from "../routes/goals.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// GRE-1382 (D2 rule 2 on GRE-1354): plain goals are Foundation and stay open;
// the KPI cascade and KPI readings are the Strategy module (enableStrategy).

describeEmbeddedPostgres("goals API: Strategy entitlement (GRE-1382)", () => {
  const ctx = useEmbeddedPostgres("gsam-goals-strategy-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(goalKpiReadings);
      await db.delete(goalCheckIns);
      await db.delete(issues);
      await db.update(goals).set({ parentId: null });
      await db.delete(goals);
      await db.delete(instanceSettings);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedGoal(companyId: string, values: Partial<typeof goals.$inferInsert> = {}) {
    const [goal] = await ctx.db
      .insert(goals)
      .values({ companyId, title: "Goal", level: "team", status: "active", ...values })
      .returning();
    return goal;
  }

  it("is on by default on a self-hosted instance, so the plan keeps working", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Default");
    const res = await request(routeApp(ctx.db, actor, goalRoutes)).post(`/api/companies/${companyId}/goals/strategic-plan`);
    expect(res.status).toBe(201);
  });

  it("with Strategy off, refuses KPI cascade and readings routes but keeps plain goals working", async () => {
    await instanceSettingsService(ctx.db).updateExperimental({ enableStrategy: false });
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Foundation");
    const app = routeApp(ctx.db, actor, goalRoutes);
    const csf = await seedGoal(companyId, { kind: "csf", title: "Grow revenue" });
    const kpi = await seedGoal(companyId, { kind: "kpi", title: "Revenue", parentId: csf.id, targetValue: 200 });

    const refused = [
      await request(app).get(`/api/goals/${kpi.id}/readings`),
      await request(app).post(`/api/goals/${kpi.id}/readings`).send({ value: 150, readingDate: "2026-10-01" }),
      await request(app).post(`/api/companies/${companyId}/goals/strategic-plan`),
      await request(app).post(`/api/companies/${companyId}/goals`).send({ title: "Win", kind: "objective", parentId: csf.id }),
      await request(app).patch(`/api/goals/${kpi.id}`).send({ title: "Revenue (net)" }),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "not_entitled", feature: "enableStrategy" });
    }

    // Plain goals: create, list, read, edit, check in.
    const created = await request(app).post(`/api/companies/${companyId}/goals`).send({ title: "Ship the website" });
    expect(created.status).toBe(201);
    expect(created.body.kind ?? null).toBeNull();
    const plainId = created.body.id as string;

    const list = await request(app).get(`/api/companies/${companyId}/goals`);
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).map((goal) => goal.id)).toContain(plainId);

    expect((await request(app).get(`/api/goals/${plainId}`)).status).toBe(200);
    expect((await request(app).patch(`/api/goals/${plainId}`).send({ title: "Ship the new website" })).status).toBe(200);
    expect(
      (await request(app).post(`/api/goals/${plainId}/check-ins`).send({ body: "Half done", progressPercent: 50 })).status,
    ).toBe(201);

    // A plain goal cannot be turned into a strategy goal while Strategy is off.
    const promote = await request(app).patch(`/api/goals/${plainId}`).send({ kind: "objective", parentId: csf.id });
    expect(promote.status).toBe(403);
    expect(promote.body).toMatchObject({ code: "not_entitled", feature: "enableStrategy" });

    // Stored strategy goals stay readable and can be made plain; nothing is deleted.
    expect((await request(app).get(`/api/goals/${kpi.id}`)).status).toBe(200);
  });
});
