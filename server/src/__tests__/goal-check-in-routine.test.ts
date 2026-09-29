import request from "supertest";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companyOnboardingSeeds,
  goalCheckIns,
  goals,
  heartbeatRuns,
  issues,
  projects,
  routineRuns,
  routineTriggers,
  routines,
} from "@greatstone/db";
import { goalRoutes } from "../routes/goals.js";
import { onboardingSeedRoutes } from "../routes/onboarding-seed.js";
import {
  GOAL_CHECK_IN_ROUTINE_ORIGIN_KIND,
  GOAL_CHECK_IN_ROUTINE_TEMPLATE,
  ensureGoalCheckInRoutine,
} from "../services/goal-check-in-routine.js";
import { routineService } from "../services/routines.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describe("goal check-in routine template", () => {
  it("runs daily and tells the lead to post check-ins and ask goal owners", () => {
    expect(GOAL_CHECK_IN_ROUTINE_TEMPLATE.cronExpression).toBe("0 9 * * *");
    expect(GOAL_CHECK_IN_ROUTINE_TEMPLATE.description).toContain("POST /api/goals/{goalId}/check-ins");
    expect(GOAL_CHECK_IN_ROUTINE_TEMPLATE.description).toContain("progress");
    expect(GOAL_CHECK_IN_ROUTINE_TEMPLATE.description).toContain("blockers");
    expect(GOAL_CHECK_IN_ROUTINE_TEMPLATE.description).toContain("owned by another agent");
  });
});

describeEmbeddedPostgres("goal check-in routine", () => {
  const ctx = useEmbeddedPostgres("gsam-goal-check-in-routine-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(goalCheckIns);
      await db.delete(companyOnboardingSeeds);
      await db.delete(routineRuns);
      await db.delete(heartbeatRuns);
      await db.delete(issues);
      await db.delete(routineTriggers);
      await db.delete(routines);
      await db.delete(projects);
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
        role: reportsTo ? "engineer" : "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        reportsTo,
      })
      .returning();
    return agent!;
  }

  it("creates one active daily routine for the lead agent and is safe to repeat", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Check-in");
    const lead = await seedAgent(companyId, "Lead");

    const first = await ensureGoalCheckInRoutine(ctx.db, companyId, lead.id);
    const second = await ensureGoalCheckInRoutine(ctx.db, companyId, lead.id);

    expect(first.status).toBe("created");
    expect(second).toEqual({ status: "exists", routineId: (first as { routineId: string }).routineId });
    const rows = await ctx.db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Goal check-in",
      assigneeAgentId: lead.id,
      status: "active",
      originKind: GOAL_CHECK_IN_ROUTINE_ORIGIN_KIND,
    });
    expect(rows[0]!.description).toContain(`/api/companies/${companyId}/goals`);
    const triggers = await ctx.db.select().from(routineTriggers).where(eq(routineTriggers.routineId, rows[0]!.id));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC", enabled: true });
    expect(triggers[0]!.nextRunAt).toBeInstanceOf(Date);
  });

  it("skips agents that are not the lead", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Check-in");
    const lead = await seedAgent(companyId, "Lead");
    const report = await seedAgent(companyId, "Report", lead.id);

    expect(await ensureGoalCheckInRoutine(ctx.db, companyId, report.id)).toEqual({
      status: "skipped",
      reason: "not_lead_agent",
    });
    expect(await ctx.db.select().from(routines).where(eq(routines.companyId, companyId))).toHaveLength(0);
  });

  it("company setup creates the routine with the lead agent", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Check-in");
    const app = routeApp(ctx.db, seeded.actor, onboardingSeedRoutes);

    const response = await request(app)
      .post(`/api/companies/${seeded.companyId}/onboarding-seed`)
      .send({ revision: "b".repeat(32), mission: "Ship the product", agent: { name: "Ada", role: "Chief of Staff" } });

    expect(response.status).toBe(200);
    const rows = await ctx.db.select().from(routines).where(eq(routines.companyId, seeded.companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assigneeAgentId).toBe(response.body.agentId);
    expect(rows[0]!.originKind).toBe(GOAL_CHECK_IN_ROUTINE_ORIGIN_KIND);
  });

  it("one run wakes the lead with an issue, and the lead posts one check-in per open goal", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Check-in");
    const lead = await seedAgent(companyId, "Lead");
    const openGoals = await ctx.db
      .insert(goals)
      .values([
        { companyId, title: "Revenue", level: "company", status: "active", ownerAgentId: lead.id },
        { companyId, title: "Hiring", level: "team", status: "planned", ownerAgentId: lead.id },
      ])
      .returning();
    const created = await ensureGoalCheckInRoutine(ctx.db, companyId, lead.id);
    const routineId = (created as { routineId: string }).routineId;

    const wokenAgentIds: string[] = [];
    const svc = routineService(ctx.db, {
      heartbeat: {
        wakeup: async (agentId) => {
          wokenAgentIds.push(agentId);
          return null;
        },
      },
    });
    const run = await svc.runRoutine(routineId, { source: "manual" });
    expect(run.linkedIssueId).toBeTruthy();
    expect(wokenAgentIds).toEqual([lead.id]);
    const [wakeIssue] = await ctx.db.select().from(issues).where(eq(issues.id, run.linkedIssueId!));
    expect(wakeIssue).toMatchObject({ assigneeAgentId: lead.id, title: "Goal check-in" });

    // The lead follows the routine: read goals, post one check-in each.
    const agentApp = routeApp(
      ctx.db,
      { type: "agent", agentId: lead.id, companyId, source: "agent_key" } as never,
      goalRoutes,
    );
    const listed = await request(agentApp).get(`/api/companies/${companyId}/goals`);
    expect(listed.status).toBe(200);
    for (const goal of listed.body as Array<{ id: string; status: string }>) {
      const posted = await request(agentApp)
        .post(`/api/goals/${goal.id}/check-ins`)
        .send({ body: "Recap: on track.", progressPercent: 10, blockers: [] });
      expect(posted.status).toBe(201);
    }

    const checkIns = await ctx.db.select().from(goalCheckIns).where(eq(goalCheckIns.companyId, companyId));
    expect(checkIns.map((row) => row.goalId).sort()).toEqual(openGoals.map((goal) => goal.id).sort());
    expect(checkIns.every((row) => row.authorAgentId === lead.id)).toBe(true);
  });
});
