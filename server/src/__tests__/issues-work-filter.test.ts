import request from "supertest";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, goals, issues } from "@greatstone/db";
import type { GoalKind } from "@greatstone/shared";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// GRE-1144: issues linked to an objective or initiative are strategic work; everything else is day-to-day.
describeEmbeddedPostgres("issues list: work=strategic|day_to_day", () => {
  const ctx = useEmbeddedPostgres("gsam-issues-work-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(issues);
      await db.update(goals).set({ parentId: null });
      await db.delete(goals);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedGoal(companyId: string, kind: GoalKind | null) {
    const [goal] = await ctx.db
      .insert(goals)
      .values({ companyId, title: `Goal ${kind ?? "plain"}`, level: "team", status: "active", kind })
      .returning();
    return goal;
  }

  async function seedIssue(companyId: string, title: string, goalId: string | null, status = "todo") {
    const [issue] = await ctx.db.insert(issues).values({ companyId, title, status, goalId }).returning();
    return issue;
  }

  async function seed() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Work filter co");
    const { companyId } = company;
    const objective = await seedGoal(companyId, "objective");
    const initiative = await seedGoal(companyId, "initiative");
    const kpi = await seedGoal(companyId, "kpi");
    const plain = await seedGoal(companyId, null);
    await seedIssue(companyId, "Win the region", objective.id);
    await seedIssue(companyId, "Launch the partner plan", initiative.id);
    await seedIssue(companyId, "Track the KPI", kpi.id);
    await seedIssue(companyId, "Old goal task", plain.id);
    await seedIssue(companyId, "Fix the printer", null);
    const app = routeApp(ctx.db, company.actor, issueRoutes);
    return { ...company, app };
  }

  const titles = (body: Array<{ title: string }>) => body.map((issue) => issue.title).sort();

  it("returns only strategic or only day-to-day issues, with the goal kind on each row", async () => {
    const { companyId, app } = await seed();

    const all = await request(app).get(`/api/companies/${companyId}/issues`);
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(5);
    const kindByTitle = new Map(all.body.map((issue: { title: string; goalKind: string | null }) => [issue.title, issue.goalKind]));
    expect(kindByTitle.get("Win the region")).toBe("objective");
    expect(kindByTitle.get("Fix the printer")).toBeNull();

    const strategic = await request(app).get(`/api/companies/${companyId}/issues?work=strategic`);
    expect(strategic.status).toBe(200);
    expect(titles(strategic.body)).toEqual(["Launch the partner plan", "Win the region"]);

    const dayToDay = await request(app).get(`/api/companies/${companyId}/issues?work=day_to_day`);
    expect(dayToDay.status).toBe(200);
    expect(titles(dayToDay.body)).toEqual(["Fix the printer", "Old goal task", "Track the KPI"]);
  });

  it("applies the filter to the compact view and to search", async () => {
    const { companyId, app } = await seed();

    const compact = await request(app).get(`/api/companies/${companyId}/issues?view=compact&work=strategic`);
    expect(compact.status).toBe(200);
    expect(compact.body.map((issue: { goalKind: string }) => issue.goalKind).sort()).toEqual(["initiative", "objective"]);

    // A different filter is a different request, not a cached copy of the first one.
    const compactDayToDay = await request(app).get(`/api/companies/${companyId}/issues?view=compact&work=day_to_day`);
    expect(compactDayToDay.status).toBe(200);
    expect(compactDayToDay.body).toHaveLength(3);

    const searched = await request(app).get(`/api/companies/${companyId}/issues?q=the&work=day_to_day`);
    expect(searched.status).toBe(200);
    expect(titles(searched.body)).toEqual(["Fix the printer", "Track the KPI"]);
  });

  it("filters the blocked count the same way", async () => {
    const { companyId, app } = await seed();
    const [objective] = await ctx.db.select().from(goals).where(eq(goals.kind, "objective"));
    await seedIssue(companyId, "Blocked strategic", objective!.id, "blocked");
    await seedIssue(companyId, "Blocked chore", null, "blocked");

    const strategic = await request(app).get(`/api/companies/${companyId}/issues/count?attention=blocked&work=strategic`);
    const dayToDay = await request(app).get(`/api/companies/${companyId}/issues/count?attention=blocked&work=day_to_day`);
    const all = await request(app).get(`/api/companies/${companyId}/issues/count?attention=blocked`);
    expect([strategic.status, dayToDay.status, all.status]).toEqual([200, 200, 200]);
    expect(strategic.body.count + dayToDay.body.count).toBe(all.body.count);
  });

  it("rejects an unknown work value", async () => {
    const { companyId, app } = await seed();
    const res = await request(app).get(`/api/companies/${companyId}/issues?work=urgent`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/work must be one of: strategic, day_to_day/);
    const count = await request(app).get(`/api/companies/${companyId}/issues/count?attention=blocked&work=urgent`);
    expect(count.status).toBe(400);
  });
});
