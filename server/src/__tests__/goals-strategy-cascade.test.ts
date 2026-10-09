import request from "supertest";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companyMemberships, goalCheckIns, goals, issues } from "@greatstone/db";
import {
  STRATEGIC_PLAN_TEMPLATE,
  STRATEGIC_PLAN_TEMPLATE_NAME,
  goalKindParentError,
  type GoalWithProgress,
} from "@greatstone/shared";
import { goalRoutes } from "../routes/goals.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

describe("goal kind tree rules (pure)", () => {
  it("keeps vision, value and CSF at the top", () => {
    for (const kind of ["vision", "value", "csf"] as const) {
      expect(goalKindParentError(kind, false, null)).toBeNull();
      expect(goalKindParentError(kind, true, "vision")).toMatch(/top of the plan/);
    }
  });

  it("puts pillar under CSF or vision, objective under CSF or pillar, KPI under CSF, pillar or objective, initiative under objective", () => {
    expect(goalKindParentError("pillar", true, "csf")).toBeNull();
    expect(goalKindParentError("pillar", true, "vision")).toBeNull();
    expect(goalKindParentError("pillar", true, "value")).toMatch(/csf or vision/);
    expect(goalKindParentError("objective", true, "csf")).toBeNull();
    expect(goalKindParentError("objective", true, "pillar")).toBeNull();
    expect(goalKindParentError("objective", true, "vision")).toMatch(/csf or pillar/);
    expect(goalKindParentError("objective", false, null)).toMatch(/csf or pillar/);
    expect(goalKindParentError("kpi", true, "csf")).toBeNull();
    expect(goalKindParentError("kpi", true, "pillar")).toBeNull();
    expect(goalKindParentError("kpi", true, "objective")).toBeNull();
    expect(goalKindParentError("kpi", true, "vision")).toMatch(/csf or pillar or objective/);
    expect(goalKindParentError("kpi", true, null)).toMatch(/csf or pillar or objective/);
    expect(goalKindParentError("initiative", true, "objective")).toBeNull();
    expect(goalKindParentError("initiative", true, "csf")).toMatch(/objective/);
  });

  it("does not check plain goals", () => {
    expect(goalKindParentError(null, true, "vision")).toBeNull();
    expect(goalKindParentError(undefined, false, null)).toBeNull();
  });

  it("the one-page template has vision, values, a CSF with an objective and a KPI, and obeys the rules", () => {
    expect(STRATEGIC_PLAN_TEMPLATE_NAME).toBe("One-page strategic plan");
    expect(STRATEGIC_PLAN_TEMPLATE.map((node) => node.kind)).toEqual(["vision", "value", "csf", "objective", "kpi"]);
    const kindByKey = new Map(STRATEGIC_PLAN_TEMPLATE.map((node) => [node.key, node.kind]));
    for (const node of STRATEGIC_PLAN_TEMPLATE) {
      const parentKind = node.parentKey ? kindByKey.get(node.parentKey) ?? null : null;
      expect(goalKindParentError(node.kind, node.parentKey != null, parentKind)).toBeNull();
    }
  });
});

describeEmbeddedPostgres("goals API: strategy cascade (GRE-1132)", () => {
  const ctx = useEmbeddedPostgres("gsam-goals-cascade-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(goalCheckIns);
      await db.delete(issues);
      await db.update(goals).set({ parentId: null });
      await db.delete(goals);
      await db.delete(agents);
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

  /** A second member of the company with the given role, and an actor for them. */
  async function seedMember(companyId: string, role: "admin" | "operator"): Promise<BoardActor & { userId: string }> {
    const userId = `user-${role}-${companyId}`;
    await ctx.db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
      updatedAt: new Date(),
    });
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
      isInstanceAdmin: false,
    };
  }

  it("loads an old goal (no kind, agent owner) unchanged", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Legacy");
    const parent = await seedGoal(companyId, { title: "Old company goal", level: "company" });
    const child = await seedGoal(companyId, { title: "Old team goal", parentId: parent.id });

    const app = routeApp(ctx.db, actor, goalRoutes);
    const list = await request(app).get(`/api/companies/${companyId}/goals`);
    expect(list.status).toBe(200);
    const byId = new Map((list.body as GoalWithProgress[]).map((goal) => [goal.id, goal]));
    expect(byId.get(parent.id)).toMatchObject({ title: "Old company goal", level: "company", kind: null, ownerUserId: null });
    expect(byId.get(child.id)).toMatchObject({ parentId: parent.id, kind: null });

    // A plain goal may still be edited and re-parented with no kind rules.
    const patched = await request(app).patch(`/api/goals/${child.id}`).send({ title: "Renamed", parentId: null });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ title: "Renamed", kind: null, level: "team" });
  });

  it("rejects a wrong parent kind on create and on update", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Tree");
    const app = routeApp(ctx.db, actor, goalRoutes);
    const vision = await seedGoal(companyId, { kind: "vision", title: "Vision" });
    const value = await seedGoal(companyId, { kind: "value", title: "Value" });

    const badKpi = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "KPI under vision", kind: "kpi", parentId: vision.id });
    expect(badKpi.status).toBe(422);
    expect(badKpi.body.error).toMatch(/must sit under a goal of kind csf or pillar or objective/);

    const badPillar = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Pillar under value", kind: "pillar", parentId: value.id });
    expect(badPillar.status).toBe(422);

    const pillar = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Pillar", kind: "pillar", parentId: vision.id });
    expect(pillar.status).toBe(201);
    expect(pillar.body).toMatchObject({ kind: "pillar", level: "company", parentId: vision.id });

    const moved = await request(app).patch(`/api/goals/${pillar.body.id}`).send({ parentId: value.id });
    expect(moved.status).toBe(422);

    // Changing a kind may not strand its sub-goals.
    const objective = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Objective", kind: "objective", parentId: pillar.body.id });
    expect(objective.status).toBe(201);
    const recast = await request(app).patch(`/api/goals/${pillar.body.id}`).send({ kind: "value", parentId: null });
    expect(recast.status).toBe(422);
    expect(recast.body.error).toMatch(/Objective/);
  });

  it("takes objectives and KPIs straight under a CSF, as on a one-page plan", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "OnePage");
    const app = routeApp(ctx.db, actor, goalRoutes);
    const csf = await seedGoal(companyId, { kind: "csf", title: "People" });

    const objective = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Grow skills", kind: "objective", parentId: csf.id });
    expect(objective.status).toBe(201);
    const kpi = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Staff turnover", kind: "kpi", parentId: csf.id });
    expect(kpi.status).toBe(201);
    const initiative = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Training plan", kind: "initiative", parentId: csf.id });
    expect(initiative.status).toBe(422);
  });

  it("rejects a parent from another company", async () => {
    const first = await seedCompanyWithBoardAccess(ctx.db, "First");
    const second = await seedCompanyWithBoardAccess(ctx.db, "Second");
    const foreignVision = await seedGoal(second.companyId, { kind: "vision" });
    const res = await request(routeApp(ctx.db, first.actor, goalRoutes))
      .post(`/api/companies/${first.companyId}/goals`)
      .send({ title: "Pillar", kind: "pillar", parentId: foreignVision.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not found in this company/);
  });

  it("lets only the board edit vision, values and CSFs; Exco edits pillars and below", async () => {
    const { companyId, actor: boardActor } = await seedCompanyWithBoardAccess(ctx.db, "Layers");
    const exco = await seedMember(companyId, "admin");
    const vision = await seedGoal(companyId, { kind: "vision", title: "Vision" });
    const excoApp = routeApp(ctx.db, exco, goalRoutes);

    const editVision = await request(excoApp).patch(`/api/goals/${vision.id}`).send({ title: "Exco vision" });
    expect(editVision.status).toBe(403);
    expect(editVision.body.error).toMatch(/Only board members/);
    const createCsf = await request(excoApp).post(`/api/companies/${companyId}/goals`).send({ title: "CSF", kind: "csf" });
    expect(createCsf.status).toBe(403);
    const deleteVision = await request(excoApp).delete(`/api/goals/${vision.id}`);
    expect(deleteVision.status).toBe(403);
    const template = await request(excoApp).post(`/api/companies/${companyId}/goals/strategic-plan`);
    expect(template.status).toBe(403);

    const pillar = await request(excoApp)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Pillar", kind: "pillar", parentId: vision.id });
    expect(pillar.status).toBe(201);
    // Exco cannot lift a pillar into a board layer either.
    const promote = await request(excoApp).patch(`/api/goals/${pillar.body.id}`).send({ kind: "csf", parentId: null });
    expect(promote.status).toBe(403);

    const boardEdit = await request(routeApp(ctx.db, boardActor, goalRoutes))
      .patch(`/api/goals/${vision.id}`)
      .send({ title: "Board vision" });
    expect(boardEdit.status).toBe(200);
    expect(boardEdit.body.title).toBe("Board vision");
  });

  it("refuses agents on board layers", async () => {
    const { companyId } = await seedCompanyWithBoardAccess(ctx.db, "Agents");
    const [agent] = await ctx.db
      .insert(agents)
      .values({ companyId, name: "Lead", role: "ceo", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    const vision = await seedGoal(companyId, { kind: "vision" });
    const agentActor = { type: "agent", agentId: agent.id, companyId, runId: null, source: "agent_key" } as never;
    const res = await request(routeApp(ctx.db, agentActor, goalRoutes)).patch(`/api/goals/${vision.id}`).send({ title: "x" });
    expect(res.status).toBe(403);
  });

  it("creates the full strategic plan in one call", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Template");
    const res = await request(routeApp(ctx.db, actor, goalRoutes)).post(`/api/companies/${companyId}/goals/strategic-plan`);
    expect(res.status).toBe(201);

    const rows = await ctx.db.select().from(goals).where(eq(goals.companyId, companyId));
    expect(rows).toHaveLength(STRATEGIC_PLAN_TEMPLATE.length);
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    expect([...byKind.keys()].sort()).toEqual(["csf", "kpi", "objective", "value", "vision"]);
    expect(byKind.get("vision")!.parentId).toBeNull();
    expect(byKind.get("value")!.parentId).toBeNull();
    expect(byKind.get("csf")!.parentId).toBeNull();
    expect(byKind.get("objective")!.parentId).toBe(byKind.get("csf")!.id);
    expect(byKind.get("kpi")!.parentId).toBe(byKind.get("csf")!.id);
    expect(byKind.get("value")!.description).toMatch(/behaviour/);
    expect(rows.every((row) => row.status === "planned")).toBe(true);
  });

  it("takes a person or an agent as owner, not both, and only from this company", async () => {
    const { companyId, userId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Owners");
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other");
    const app = routeApp(ctx.db, actor, goalRoutes);
    const [agent] = await ctx.db
      .insert(agents)
      .values({ companyId, name: "Owner agent", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();

    const personOwned = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Person owned", ownerUserId: userId });
    expect(personOwned.status).toBe(201);
    // A person owner means no default lead agent.
    expect(personOwned.body).toMatchObject({ ownerUserId: userId, ownerAgentId: null });

    const both = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Both", ownerUserId: userId, ownerAgentId: agent.id });
    expect(both.status).toBe(400);

    const outsider = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: "Outsider", ownerUserId: other.userId });
    expect(outsider.status).toBe(422);

    // Switching to an agent owner clears the person.
    const switched = await request(app).patch(`/api/goals/${personOwned.body.id}`).send({ ownerAgentId: agent.id });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({ ownerAgentId: agent.id, ownerUserId: null });
  });
});
