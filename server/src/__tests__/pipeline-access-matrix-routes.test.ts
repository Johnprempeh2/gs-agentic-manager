import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  principalPermissionGrants,
} from "@greatstone/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping pipeline access matrix route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Actor = Express.Request["actor"];

describeEmbeddedPostgres("pipeline access matrix and per-pipeline grants (GRE-1073)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const noopHeartbeat = { wakeup: async () => null };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-access-matrix-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(activityLog);
    await db.delete(pipelines);
    await db.delete(heartbeatRuns);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Actor) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", pipelineRoutes(db, { heartbeat: noopHeartbeat }));
    instance.use(errorHandler);
    return instance;
  }

  const STAGES = [
    { key: "intake", name: "Intake", kind: "open", position: 100 },
    { key: "working", name: "Working", kind: "working", position: 200 },
    { key: "done", name: "Done", kind: "done", position: 900 },
    { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
  ];

  const localBoard: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };

  async function seedCompany() {
    const [company] = await db.insert(companies).values({
      name: `Matrix Co ${randomUUID().slice(0, 6)}`,
      issuePrefix: `M${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  async function seedBoardUser(companyId: string, role: "owner" | "operator", grants: string[], name = "Board User") {
    const userId = `user-${randomUUID().slice(0, 8)}`;
    await db.insert(authUsers).values({
      id: userId,
      name,
      email: `${userId}@example.test`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
    });
    for (const permissionKey of grants) {
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "user",
        principalId: userId,
        permissionKey,
        scope: null,
      });
    }
    const actor: Actor = {
      type: "board",
      userId,
      source: "session",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
      isInstanceAdmin: false,
    };
    return { userId, actor };
  }

  async function seedAgent(companyId: string, name: string, role = "engineer") {
    const [agent] = await db.insert(agents).values({
      companyId,
      name,
      role,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agent!.id,
      status: "active",
      membershipRole: "member",
    });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    const actor: Actor = { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" };
    return { agent: agent!, actor };
  }

  async function seedPipeline(companyId: string, key: string) {
    const created = await request(app(localBoard))
      .post(`/api/companies/${companyId}/pipelines`)
      .send({ key, name: `Pipeline ${key}`, stages: STAGES })
      .expect(201);
    return created.body as { id: string };
  }

  async function agentPipelineGrants(agentId: string) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(and(eq(principalPermissionGrants.principalType, "agent"), eq(principalPermissionGrants.principalId, agentId)));
  }

  it("grants and removes each level per pipeline; the matrix, authorization and activity log agree", async () => {
    const company = await seedCompany();
    const owner = await seedBoardUser(company.id, "owner", ["users:manage_permissions"], "Grace Owner");
    const sales = await seedPipeline(company.id, "sales");
    const support = await seedPipeline(company.id, "support");
    const harbor = await seedAgent(company.id, "Harbor");
    const http = request(app(owner.actor));
    const put = (body: Record<string, unknown>) =>
      http.put(`/api/companies/${company.id}/pipeline-access/agents/${harbor.agent.id}`).send(body).expect(200);

    await put({ pipelineId: sales.id, level: "administer" });
    const matrix = (await put({ pipelineId: support.id, level: "work_cases" })).body;
    const row = matrix.agents.find((agent: { agentId: string }) => agent.agentId === harbor.agent.id);
    expect(row.levels).toEqual({ [sales.id]: "administer", [support.id]: "work_cases" });
    expect(row.allPipelinesLevel).toBeNull();
    expect(row.lastChange).toMatchObject({ actorId: owner.userId, actorName: "Grace Owner" });
    expect(matrix.canManage).toBe(true);

    // The grants are the ones authorization reads: Administer on sales lets
    // Harbor rename it; Work cases on support does not.
    await request(app(harbor.actor)).patch(`/api/pipelines/${sales.id}`).send({ name: "Sales renamed" }).expect(200);
    await request(app(harbor.actor)).patch(`/api/pipelines/${support.id}`).send({ name: "Nope" }).expect(403);

    await put({ pipelineId: sales.id, level: "view" });
    const cleared = (await put({ pipelineId: support.id, level: "view" })).body;
    expect(cleared.agents.find((agent: { agentId: string }) => agent.agentId === harbor.agent.id).levels).toEqual({
      [sales.id]: "view",
      [support.id]: "view",
    });
    expect(await agentPipelineGrants(harbor.agent.id)).toEqual([]);

    const log = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, harbor.agent.id), eq(activityLog.action, "agent.pipeline_access_updated")));
    expect(log).toHaveLength(4);
    expect(log.map((entry) => entry.details)).toContainEqual({ pipelineId: sales.id, before: "administer", after: "view" });
    expect(log.every((entry) => entry.actorId === owner.userId)).toBe(true);
  });

  it("keeps other pipelines when one pipeline drops out of an all-pipelines grant", async () => {
    const company = await seedCompany();
    const a = await seedPipeline(company.id, "a");
    const b = await seedPipeline(company.id, "b");
    const target = await seedAgent(company.id, "Target");
    const http = request(app(localBoard));

    const all = (await http
      .put(`/api/companies/${company.id}/pipeline-access/agents/${target.agent.id}`)
      .send({ level: "administer" })
      .expect(200)).body;
    expect(all.agents[0].allPipelinesLevel).toBe("administer");

    const after = (await http
      .put(`/api/companies/${company.id}/pipeline-access/agents/${target.agent.id}`)
      .send({ pipelineId: b.id, level: "work_cases" })
      .expect(200)).body;
    expect(after.agents[0].levels).toEqual({ [a.id]: "administer", [b.id]: "work_cases" });
  });

  it("refuses changes from users without users:manage_permissions and from agents, and hides edit rights", async () => {
    const company = await seedCompany();
    const pipeline = await seedPipeline(company.id, "sales");
    const operator = await seedBoardUser(company.id, "operator", ["agents:create"]);
    const target = await seedAgent(company.id, "Target");
    const ceo = await seedAgent(company.id, "Chief", "ceo");
    const body = { pipelineId: pipeline.id, level: "administer" };
    const path = `/api/companies/${company.id}/pipeline-access/agents/${target.agent.id}`;

    await request(app(operator.actor)).put(path).send(body).expect(403);
    await request(app(ceo.actor)).put(path).send(body).expect(403);
    await request(app(operator.actor)).put(path).send({ level: "administer" }).expect(403);
    expect(await agentPipelineGrants(target.agent.id)).toEqual([]);

    const read = await request(app(operator.actor)).get(`/api/companies/${company.id}/pipeline-access`).expect(200);
    expect(read.body.canManage).toBe(false);
  });

  it("keeps companies apart", async () => {
    const company = await seedCompany();
    const other = await seedCompany();
    const owner = await seedBoardUser(company.id, "owner", ["users:manage_permissions"]);
    const ours = await seedPipeline(company.id, "ours");
    const theirs = await seedPipeline(other.id, "theirs");
    const ourAgent = await seedAgent(company.id, "Ours");
    const theirAgent = await seedAgent(other.id, "Theirs");
    const http = request(app(owner.actor));

    await http.get(`/api/companies/${other.id}/pipeline-access`).expect(403);
    await http
      .put(`/api/companies/${company.id}/pipeline-access/agents/${theirAgent.agent.id}`)
      .send({ pipelineId: ours.id, level: "administer" })
      .expect(404);
    await http
      .put(`/api/companies/${company.id}/pipeline-access/agents/${ourAgent.agent.id}`)
      .send({ pipelineId: theirs.id, level: "administer" })
      .expect(422);
    const matrix = (await http.get(`/api/companies/${company.id}/pipeline-access`).expect(200)).body;
    expect(matrix.pipelines.map((row: { id: string }) => row.id)).toEqual([ours.id]);
    expect(matrix.agents.map((row: { agentId: string }) => row.agentId)).toEqual([ourAgent.agent.id]);
  });
});
