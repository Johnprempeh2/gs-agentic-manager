import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  activityLog,
  agents,
  documentRevisions,
  documents,
  goalCheckIns,
  goalKpiReadings,
  goals,
  issueDocuments,
  issues,
} from "@greatstone/db";
import type { GoalDetail } from "@greatstone/shared";
import { goalRoutes } from "../routes/goals.js";
import { documentService } from "../services/documents.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/** Made-up company. Slide 5 holds the reference points; slide 1 does not. */
const PRE_READ = [
  "# Pre-read",
  "",
  "## Slide 1. Strengths",
  "",
  "- **S1** Revenue was USD 78m, actual. [F2]",
  "",
  "## Slide 5. Benchmarks, limits and workshop questions",
  "",
  "- **B1** Gross margin: client baseline 18.5% (FY2025); peer median 24% (listed millers, FY2025). [F2] [P1]",
  "- **B2** Days sales outstanding: baseline 41 days; peer 30 days. [P2]",
].join("\n");

const B1 = {
  bulletId: "B1",
  title: "Gross margin",
  baselineValue: 18.5,
  baselineDate: "2025-12-31",
  unit: "%",
  benchmarkNote: "B1: peer median 24% (listed millers, FY2025). Sources: P1, page 12",
};
const B2 = { bulletId: "B2", title: "Days sales outstanding", baselineValue: 41, baselineDate: "2025-12-31", unit: "days", kpiDirection: "down" };

// GRE-1161: draft KPIs pre-filled from a research pack's slide 5.
describeEmbeddedPostgres("goals API: draft KPIs from a research pack (GRE-1161)", () => {
  const ctx = useEmbeddedPostgres("gsam-goals-kpi-drafts-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(goalKpiReadings);
      await db.delete(goalCheckIns);
      await db.update(goals).set({ parentId: null });
      await db.delete(goals);
      await db.delete(issueDocuments);
      await db.delete(documentRevisions);
      await db.delete(documents);
      await db.delete(issues);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seed(name = "Drafts") {
    const company = await seedCompanyWithBoardAccess(ctx.db, name);
    const [packIssue] = await ctx.db
      .insert(issues)
      .values({ companyId: company.companyId, title: "Test pack: Synthesis", status: "done" })
      .returning();
    await documentService(ctx.db).upsertIssueDocument({
      issueId: packIssue.id,
      key: "pre-read",
      title: "Pre-read",
      format: "markdown",
      body: PRE_READ,
      createdByUserId: company.userId,
    });
    const [csf] = await ctx.db
      .insert(goals)
      .values({ companyId: company.companyId, title: "Grow margin", kind: "csf", level: "company", status: "active" })
      .returning();
    const [objective] = await ctx.db
      .insert(goals)
      .values({ companyId: company.companyId, title: "Lift margin", kind: "objective", level: "team", status: "active", parentId: csf.id })
      .returning();
    return { ...company, packIssue, csf, objective, app: routeApp(ctx.db, company.actor, goalRoutes) };
  }

  async function seedAgent(companyId: string) {
    const [agent] = await ctx.db
      .insert(agents)
      .values({
        companyId,
        name: "Researcher",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return agent;
  }

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", agentId, companyId, runId: null, source: "agent_key" } as never;
  }

  it("creates drafts with baseline, unit, date, benchmark note and source link, and no target or status", async () => {
    const { app, packIssue, objective, userId, companyId } = await seed();

    const res = await request(app)
      .post(`/api/goals/${objective.id}/kpi-drafts`)
      .send({ sourceIssueId: packIssue.id, rows: [B1, B2] });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      title: "Gross margin",
      kind: "kpi",
      status: "draft",
      parentId: objective.id,
      baselineValue: 18.5,
      baselineDate: "2025-12-31",
      currentValue: 18.5,
      unit: "%",
      benchmarkNote: B1.benchmarkNote,
      targetValue: null,
      targetDate: null,
      sourceIssueId: packIssue.id,
      sourceDocumentKey: "pre-read",
      sourceBulletId: "B1",
    });
    expect(res.body[1]).toMatchObject({ sourceBulletId: "B2", kpiDirection: "down", benchmarkNote: null });

    // A person ran it: the first reading is the baseline, owner_reported, never agent_verified.
    const readings = await ctx.db.select().from(goalKpiReadings).where(eq(goalKpiReadings.goalId, res.body[0].id));
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ value: 18.5, readingDate: "2025-12-31", source: "owner_reported", recordedByUserId: userId });

    // No RAG status on the draft, and it does not count in its objective's roll-up.
    const detail = await request(app).get(`/api/goals/${objective.id}`);
    const sub = (detail.body as GoalDetail).subGoals.find((goal) => goal.id === res.body[0].id);
    expect(sub?.kpiStatus).toMatchObject({ status: null, reason: "draft" });
    expect((detail.body as GoalDetail).ragRollup).toEqual({ status: null, red: 0, amber: 0, green: 0, noStatus: 0 });

    const [logged] = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "goal.kpi_drafts_created"));
    expect(logged).toMatchObject({ companyId, entityId: objective.id });
    expect(logged.details).toMatchObject({ bulletIds: ["B1", "B2"], documentKey: "pre-read" });
  });

  it("records the first reading as system when an agent runs the pre-fill", async () => {
    const { packIssue, objective, companyId } = await seed();
    const agent = await seedAgent(companyId);
    const res = await request(routeApp(ctx.db, agentActor(companyId, agent.id), goalRoutes))
      .post(`/api/goals/${objective.id}/kpi-drafts`)
      .send({ sourceIssueId: packIssue.id, rows: [B1] });
    expect(res.status).toBe(201);
    const [reading] = await ctx.db.select().from(goalKpiReadings).where(eq(goalKpiReadings.goalId, res.body[0].id));
    expect(reading).toMatchObject({ source: "system", recordedByAgentId: agent.id });
  });

  it("leaves nothing behind when one row fails inside the transaction", async () => {
    const { app, packIssue, objective } = await seed();
    // Passes the date pattern but Postgres rejects it, after the first row is written.
    const res = await request(app)
      .post(`/api/goals/${objective.id}/kpi-drafts`)
      .send({ sourceIssueId: packIssue.id, rows: [B1, { ...B2, baselineDate: "2025-02-30" }] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await ctx.db.select().from(goals).where(eq(goals.kind, "kpi"))).toHaveLength(0);
    expect(await ctx.db.select().from(goalKpiReadings)).toHaveLength(0);
  });

  it("refuses bullets that are not slide-5 reference points, a wrong parent and another company's pack", async () => {
    const { app, packIssue, objective, csf } = await seed();

    const notSlideFive = await request(app)
      .post(`/api/goals/${objective.id}/kpi-drafts`)
      .send({ sourceIssueId: packIssue.id, rows: [B1, { ...B2, bulletId: "S1" }] });
    expect(notSlideFive.status).toBe(422);
    expect(notSlideFive.body.error).toContain("S1");

    const [initiative] = await ctx.db
      .insert(goals)
      .values({ companyId: objective.companyId, title: "Run pricing", kind: "initiative", status: "active", parentId: objective.id })
      .returning();
    const wrongParent = await request(app)
      .post(`/api/goals/${initiative.id}/kpi-drafts`)
      .send({ sourceIssueId: packIssue.id, rows: [B1] });
    expect(wrongParent.status).toBe(422);

    const other = await seed("Other company");
    const crossCompany = await request(app)
      .post(`/api/goals/${csf.id}/kpi-drafts`)
      .send({ sourceIssueId: other.packIssue.id, rows: [B1] });
    expect(crossCompany.status).toBe(404);

    const missingDoc = await request(app)
      .post(`/api/goals/${csf.id}/kpi-drafts`)
      .send({ sourceIssueId: packIssue.id, documentKey: "benchmarks", rows: [B1] });
    expect(missingDoc.status).toBe(404);

    expect(await ctx.db.select().from(goals).where(eq(goals.kind, "kpi"))).toHaveLength(0);
  });

  it("only a person accepts a draft, and only once the target is set", async () => {
    const { app, packIssue, objective, companyId } = await seed();
    const created = await request(app)
      .post(`/api/goals/${objective.id}/kpi-drafts`)
      .send({ sourceIssueId: packIssue.id, rows: [B1] });
    const draftId = created.body[0].id as string;

    const noTarget = await request(app).patch(`/api/goals/${draftId}`).send({ status: "active" });
    expect(noTarget.status).toBe(422);
    expect(noTarget.body.error).toContain("target");

    const agent = await seedAgent(companyId);
    const byAgent = await request(routeApp(ctx.db, agentActor(companyId, agent.id), goalRoutes))
      .patch(`/api/goals/${draftId}`)
      .send({ status: "active", targetValue: 22, targetDate: "2027-12-31" });
    expect(byAgent.status).toBe(403);

    // A person sets the target while it is still a draft: still no status.
    const target = await request(app).patch(`/api/goals/${draftId}`).send({ targetValue: 22, targetDate: "2027-12-31" });
    expect(target.status).toBe(200);
    expect((await request(app).get(`/api/goals/${draftId}`)).body.kpiStatus).toMatchObject({ status: null, reason: "draft" });

    const accepted = await request(app).patch(`/api/goals/${draftId}`).send({ status: "active" });
    expect(accepted.status).toBe(200);
    expect((await request(app).get(`/api/goals/${draftId}`)).body.kpiStatus.status).not.toBeNull();
  });
});
