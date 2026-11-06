import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { activityLog, agents, goals } from "@greatstone/db";
import { updateGoalSchema } from "@greatstone/shared";
import { goalService } from "../services/goals.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Upstream 833d06874 (#19203): a goal write cannot move a goal to another company.
describeEmbeddedPostgres("goals: company boundary on update (upstream 833d06874)", () => {
  const ctx = useEmbeddedPostgres("gsam-goal-company-boundary-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.update(goals).set({ parentId: null });
      await db.delete(goals);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedGoal() {
    const own = await seedCompanyWithBoardAccess(ctx.db, "Own");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    const [goal] = await ctx.db
      .insert(goals)
      .values({ companyId: own.companyId, title: "Ship it", level: "task", status: "planned" })
      .returning();
    return { own, other, goal };
  }

  it("refuses a patch that changes the goal company", async () => {
    const { own, other, goal } = await seedGoal();
    await expect(
      goalService(ctx.db).update(goal.id, { companyId: other.companyId, title: "Moved" }),
    ).rejects.toMatchObject({ status: 422 });
    const [row] = await ctx.db.select().from(goals).where(eq(goals.id, goal.id));
    expect(row.companyId).toBe(own.companyId);
    expect(row.title).toBe("Ship it");
  });

  it("refuses a patch that changes the goal id", async () => {
    const { goal } = await seedGoal();
    await expect(
      goalService(ctx.db).update(goal.id, { id: "00000000-0000-4000-8000-000000000001" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("still applies a normal edit, and accepts the same company id", async () => {
    const { own, goal } = await seedGoal();
    const updated = await goalService(ctx.db).update(goal.id, { companyId: own.companyId, title: "Renamed" });
    expect(updated?.title).toBe("Renamed");
    expect(updated?.companyId).toBe(own.companyId);
  });

  it("the plugin patch contract drops id and companyId", () => {
    const parsed = updateGoalSchema.parse({ title: "x", companyId: "c", id: "i" });
    expect(parsed).toEqual({ title: "x" });
  });
});
