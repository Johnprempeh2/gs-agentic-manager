import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Wakes are recorded, never executed: no adapter process starts in this test.
const wakeup = vi.hoisted(() => vi.fn(async () => ({ id: "wake-1" })));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup,
    }),
  };
});

const { errorHandler } = await import("../middleware/index.js");
const { issueRoutes } = await import("../routes/issues.js");
const { projectTreeRoutes } = await import("../routes/project-tree.js");
const { projectTreeService, PROJECT_TASK_PLACEMENT_REASON, PROJECT_TIDY_ORIGIN_KIND } = await import(
  "../services/project-tree.js"
);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project tree tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const USER_ID = "ben";

describeEmbeddedPostgres("project tree", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-tree-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    wakeup.mockClear();
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(activityLog);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function boardActor(companyId: string) {
    return {
      type: "board",
      source: "session",
      userId: USER_ID,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "owner" }],
      isInstanceAdmin: false,
    };
  }

  function app(
    companyId: string,
    options: { actor?: Record<string, unknown>; limits?: { maxNodes: number; maxDepth: number } } = {},
  ) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = options.actor ?? boardActor(companyId);
      next();
    });
    testApp.use(
      "/api",
      projectTreeRoutes(db, {
        service: projectTreeService(db, { heartbeat: { wakeup }, limits: options.limits }),
      }),
    );
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function company(prefix = "GRE") {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: prefix, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({
      companyId: id, principalType: "user", principalId: USER_ID, status: "active", membershipRole: "owner",
    });
    return id;
  }

  async function agent(companyId: string, name: string, role = "engineer") {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role,
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function project(companyId: string, values: Partial<typeof projects.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(projects).values({ id, companyId, name: values.name ?? "Platform", ...values });
    return id;
  }

  async function task(companyId: string, values: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    // Next free number, so tasks the service itself creates never clash.
    const issueNumber = (await db.select({ n: issues.issueNumber }).from(issues))
      .reduce((max, row) => Math.max(max, row.n ?? 0), 0) + 1;
    await db.insert(issues).values({
      id,
      companyId,
      title: values.title ?? `Task ${issueNumber}`,
      status: "todo",
      issueNumber,
      identifier: `GRE-${issueNumber}`,
      ...values,
    });
    return id;
  }

  /** Everest (the company lead), a project lead and a project with two key tasks. */
  async function seedPlatform() {
    const companyId = await company();
    const everest = await agent(companyId, "Everest", "ceo");
    const lead = await agent(companyId, "Flint");
    const projectId = await project(companyId, { leadAgentId: lead });
    const keyAt = new Date();
    const k1 = await task(companyId, { projectId, title: "Ship billing", status: "in_progress", keyTaskAt: keyAt });
    const c1 = await task(companyId, { projectId, parentId: k1, status: "done" });
    const c2 = await task(companyId, { projectId, parentId: k1, status: "todo" });
    const c2a = await task(companyId, { projectId, parentId: c2, status: "blocked" });
    const c3 = await task(companyId, { projectId, parentId: k1, status: "done" });
    const c3a = await task(companyId, { projectId, parentId: c3, status: "done" });
    const k2 = await task(companyId, { projectId, title: "Launch site", status: "done", keyTaskAt: keyAt });
    const d1 = await task(companyId, { projectId, parentId: k2, status: "done" });
    const u1 = await task(companyId, { projectId, title: "Loose idea", status: "todo" });
    const u2 = await task(companyId, { projectId, title: "Old loose work", status: "done" });
    const elsewhere = await task(companyId, { title: "Not in the project", status: "todo" });
    await db.insert(issueRelations).values({ companyId, issueId: u1, relatedIssueId: c2a, type: "blocks" });
    return { companyId, everest, lead, projectId, k1, c1, c2, c2a, c3, c3a, k2, d1, u1, u2, elsewhere };
  }

  describe("GET /projects/:id/tree", () => {
    it("sends key tasks with their open work and the unsorted work, and counts finished work", async () => {
      const s = await seedPlatform();
      const res = await request(app(s.companyId)).get(`/api/projects/${s.projectId}/tree`).expect(200);
      const tree = res.body;

      expect(tree.project).toMatchObject({ id: s.projectId, name: "Platform", lead: { agentId: s.lead, covering: false } });
      expect([...tree.keyTaskIds].sort()).toEqual([s.k1, s.k2].sort());
      expect(tree.unsortedIds).toEqual([s.u1]);
      const byId = new Map(tree.nodes.map((node: { id: string }) => [node.id, node]));
      // Finished work is counted, not sent.
      expect([...byId.keys()].sort()).toEqual([s.k1, s.c2, s.c2a, s.k2, s.u1].sort());
      expect(byId.get(s.k1)).toMatchObject({ parentId: null, isKeyTask: true, childCount: 3, doneChildCount: 2 });
      expect(byId.get(s.c2)).toMatchObject({ parentId: s.k1, isKeyTask: false });
      expect(byId.get(s.c2a)).toMatchObject({ parentId: s.c2, blockedByIds: [s.u1] });
      expect(byId.get(s.u1)).toMatchObject({ parentId: null });
      expect(tree.hiddenDoneByParent).toEqual({ [s.k1]: 3, [s.k2]: 1 });
      expect(tree.keyTaskProgress).toEqual({
        [s.k1]: { done: 3, total: 5 },
        [s.k2]: { done: 1, total: 1 },
      });
      expect(tree.counts).toEqual({ done: 5, active: 1, blocked: 1, waiting: 1 });
      expect(tree.openTidyTaskId).toBeNull();
      expect(tree.truncated).toBe(false);
    });

    it("sends finished work when asked", async () => {
      const s = await seedPlatform();
      const res = await request(app(s.companyId)).get(`/api/projects/${s.projectId}/tree?finished=1`).expect(200);
      const ids = res.body.nodes.map((node: { id: string }) => node.id).sort();
      expect(ids).toEqual([s.k1, s.c1, s.c2, s.c2a, s.c3, s.c3a, s.k2, s.d1, s.u1, s.u2].sort());
      expect(res.body.hiddenDoneByParent).toEqual({});
      expect([...res.body.unsortedIds].sort()).toEqual([s.u1, s.u2].sort());
    });

    it("caps a big project and says so, open work first", async () => {
      const s = await seedPlatform();
      const res = await request(app(s.companyId, { limits: { maxNodes: 3, maxDepth: 12 } }))
        .get(`/api/projects/${s.projectId}/tree`)
        .expect(200);
      expect(res.body.truncated).toBe(true);
      expect(res.body.nodes).toHaveLength(3);
      expect(res.body.limits).toEqual({ maxNodes: 3, maxDepth: 12 });
      // Counts still tell the truth about the whole project.
      expect(res.body.counts.done).toBe(5);
    });

    it("lets the company lead cover a project with no lead", async () => {
      const companyId = await company();
      const everest = await agent(companyId, "Everest", "ceo");
      const projectId = await project(companyId);
      const res = await request(app(companyId)).get(`/api/projects/${projectId}/tree`).expect(200);
      expect(res.body.project.lead).toEqual({ agentId: everest, covering: true });
      expect(res.body.nodes).toEqual([]);
    });

    it("stays inside the company", async () => {
      const companyA = await company("AAA");
      const companyB = await company("BBB");
      const projectB = await project(companyB);
      await request(app(companyA, { actor: boardActor(companyA) })).get(`/api/projects/${projectB}/tree`).expect(404);
    });
  });

  describe("placement", () => {
    it("wakes the assignee agent once for a person's new top-level task", async () => {
      const s = await seedPlatform();
      const worker = await agent(s.companyId, "Mason");
      const res = await request(app(s.companyId))
        .post(`/api/companies/${s.companyId}/issues`)
        .send({ title: "New idea", status: "todo", projectId: s.projectId, assigneeAgentId: worker })
        .expect(201);

      const placementWakes = wakeup.mock.calls.filter(
        (call) => (call as unknown[])[1] && ((call as unknown[])[1] as { reason?: string }).reason === PROJECT_TASK_PLACEMENT_REASON,
      );
      expect(placementWakes).toHaveLength(1);
      expect(placementWakes[0]![0]).toBe(worker);
      // The wake is on a placement task that carries the instruction, not on the new task itself.
      const [placement] = await db.select().from(issues).where(eq(issues.originId, res.body.id));
      expect(placement).toMatchObject({ originKind: PROJECT_TASK_PLACEMENT_REASON, assigneeAgentId: worker, projectId: null });
      expect(placement!.description).toContain("Do not start that task here");
      expect(placementWakes[0]![1]).toMatchObject({ contextSnapshot: { issueId: placement!.id } });
      const logged = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityId, res.body.id), eq(activityLog.action, "issue.placement_requested")));
      expect(logged).toHaveLength(1);
      expect(logged[0]!.details).toMatchObject({ via: "assignee", requestedByUserId: USER_ID });

      // Once per task.
      const again = await projectTreeService(db, { heartbeat: { wakeup } }).requestPlacement(
        { ...res.body, keyTaskAt: null },
        USER_ID,
      );
      expect(again).toBeNull();
      expect(wakeup.mock.calls.filter((call) => ((call as unknown[])[1] as { reason?: string }).reason === PROJECT_TASK_PLACEMENT_REASON)).toHaveLength(1);
    });

    it("closes the placement job once the task is placed or marked key", async () => {
      const s = await seedPlatform();
      const res = await request(app(s.companyId))
        .post(`/api/companies/${s.companyId}/issues`)
        .send({ title: "Write the welcome email", status: "todo", projectId: s.projectId });
      expect(res.body.id, JSON.stringify(res.body).slice(0, 300)).toBeTruthy();
      const job = async () => (await db.select().from(issues).where(eq(issues.originId, res.body.id)))[0]!;
      expect((await job()).status).toBe("todo");
      await request(app(s.companyId)).patch(`/api/issues/${res.body.id}`).send({ parentId: s.k1 }).expect(200);
      expect((await job()).status).toBe("done");
    });

    it("falls back to the project lead, then the company lead", async () => {
      const s = await seedPlatform();
      const service = projectTreeService(db, { heartbeat: { wakeup } });
      const unassigned = await task(s.companyId, { projectId: s.projectId });
      const row = (await db.select().from(issues).where(eq(issues.id, unassigned)))[0]!;
      expect(await service.requestPlacement(row, USER_ID)).toEqual({ agentId: s.lead, via: "project_lead" });

      const leaderless = await project(s.companyId, { name: "Side project" });
      const other = await task(s.companyId, { projectId: leaderless });
      const otherRow = (await db.select().from(issues).where(eq(issues.id, other)))[0]!;
      expect(await service.requestPlacement(otherRow, USER_ID)).toEqual({ agentId: s.everest, via: "company_lead" });
    });

    it("does not place agent-created tasks, sub-tasks or tasks outside a project", async () => {
      const s = await seedPlatform();
      const worker = await agent(s.companyId, "Mason");
      await request(app(s.companyId, { actor: { type: "agent", source: "agent_key", companyId: s.companyId, agentId: worker } }))
        .post(`/api/companies/${s.companyId}/issues`)
        .send({ title: "Agent's own task", status: "todo", projectId: s.projectId })
        .expect(201);
      await request(app(s.companyId))
        .post(`/api/companies/${s.companyId}/issues`)
        .send({ title: "Sub-task", status: "todo", projectId: s.projectId, parentId: s.k1 })
        .expect(201);
      await request(app(s.companyId))
        .post(`/api/companies/${s.companyId}/issues`)
        .send({ title: "No project", status: "todo" })
        .expect(201);
      expect(wakeup.mock.calls.filter((call) => ((call as unknown[])[1] as { reason?: string }).reason === PROJECT_TASK_PLACEMENT_REASON)).toHaveLength(0);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.placement_requested"))).toHaveLength(0);
    });
  });

  describe("key tasks", () => {
    it("are marked and cleared through the normal update, with an activity entry", async () => {
      const s = await seedPlatform();
      await request(app(s.companyId))
        .patch(`/api/issues/${s.u1}`)
        .send({ keyTask: true, comment: "This drives the launch." })
        .expect(200);
      const marked = (await db.select().from(issues).where(eq(issues.id, s.u1)))[0]!;
      expect(marked.keyTaskAt).toBeInstanceOf(Date);
      const markLog = await db.select().from(activityLog).where(eq(activityLog.action, "issue.key_task_marked"));
      expect(markLog).toHaveLength(1);
      expect(markLog[0]).toMatchObject({ actorId: USER_ID, entityId: s.u1 });
      expect(markLog[0]!.details).toMatchObject({ reason: "This drives the launch." });

      const tree = await request(app(s.companyId)).get(`/api/projects/${s.projectId}/tree`).expect(200);
      expect(tree.body.keyTaskIds).toContain(s.u1);
      expect(tree.body.unsortedIds).toEqual([]);

      await request(app(s.companyId)).patch(`/api/issues/${s.u1}`).send({ keyTask: false }).expect(200);
      expect((await db.select().from(issues).where(eq(issues.id, s.u1)))[0]!.keyTaskAt).toBeNull();
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.key_task_cleared"))).toHaveLength(1);
    });
  });

  describe("POST /projects/:id/tidy", () => {
    it("gives the lead one task listing the unsorted work, and refuses a second while it is open", async () => {
      const s = await seedPlatform();
      const first = await request(app(s.companyId)).post(`/api/projects/${s.projectId}/tidy`).expect(201);
      expect(first.body).toMatchObject({ status: "created", agentId: s.lead });
      const tidy = (await db.select().from(issues).where(eq(issues.id, first.body.taskId)))[0]!;
      expect(tidy).toMatchObject({ assigneeAgentId: s.lead, originKind: PROJECT_TIDY_ORIGIN_KIND, originId: s.projectId });
      expect(tidy.description).toContain("Loose idea");
      expect(tidy.description).not.toContain("Old loose work");
      expect(wakeup).toHaveBeenCalledWith(s.lead, expect.objectContaining({ reason: "project_tidy" }));

      const second = await request(app(s.companyId)).post(`/api/projects/${s.projectId}/tidy`).expect(409);
      expect(second.body.taskId).toBe(first.body.taskId);
      const tree = await request(app(s.companyId)).get(`/api/projects/${s.projectId}/tree`).expect(200);
      expect(tree.body.openTidyTaskId).toBe(first.body.taskId);

      // Once it is closed, a new tidy may start.
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.body.taskId));
      await request(app(s.companyId)).post(`/api/projects/${s.projectId}/tidy`).expect(201);
    });

    it("refuses when nothing is unsorted", async () => {
      const companyId = await company();
      await agent(companyId, "Everest", "ceo");
      const projectId = await project(companyId);
      await task(companyId, { projectId, keyTaskAt: new Date() });
      await request(app(companyId)).post(`/api/projects/${projectId}/tidy`).expect(409);
    });
  });

  describe("projects with no lead", () => {
    it("gives the company lead one task, once, to propose leads", async () => {
      const companyId = await company();
      const everest = await agent(companyId, "Everest", "ceo");
      const lead = await agent(companyId, "Flint");
      await project(companyId, { name: "Billing" });
      await project(companyId, { name: "Website" });
      await project(companyId, { name: "Led", leadAgentId: lead });
      const service = projectTreeService(db, { heartbeat: { wakeup } });

      const created = await service.ensureLeadProposalTask(companyId);
      expect(created).toMatchObject({ assigneeAgentId: everest, title: "Propose a lead for 2 projects" });
      expect(created!.description).toContain("Billing");
      expect(created!.description).not.toContain("- Led");

      // Not again, even once that task is closed.
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, created!.id));
      expect(await service.ensureLeadProposalTask(companyId)).toBeNull();
      expect(await service.ensureLeadProposalTasks()).toBe(0);
    });
  });
});
