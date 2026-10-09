import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
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
import { agentRoutes } from "../routes/agents.js";
import { pipelineRoutes } from "../routes/pipelines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping pipeline access route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Actor = Express.Request["actor"];

describeEmbeddedPostgres("pipeline access levels (GRE-1072)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const noopHeartbeat = { wakeup: async () => null };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-access-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

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
    instance.use("/api", agentRoutes(db));
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
      name: `Access Co ${randomUUID().slice(0, 6)}`,
      issuePrefix: `A${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  async function seedBoardUser(companyId: string, role: "owner" | "operator", grants: string[]) {
    const userId = `user-${randomUUID().slice(0, 8)}`;
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

  async function seedAgent(companyId: string, name: string, options: { onBehalfOf?: { userId: string; role: string } } = {}) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
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
    const actor: Actor = {
      type: "agent",
      agentId: agent!.id,
      companyId,
      runId: run!.id,
      source: "agent_key",
      ...(options.onBehalfOf
        ? {
            onBehalfOfUserId: options.onBehalfOf.userId,
            onBehalfOfMemberships: [{ companyId, membershipRole: options.onBehalfOf.role, status: "active" }],
          }
        : {}),
    };
    return { agent: agent!, runId: run!.id, actor };
  }

  async function grant(companyId: string, agentId: string, permissionKey: string, scope: Record<string, unknown> | null = null) {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey,
      scope,
    });
  }

  async function seedPipeline(companyId: string, key: string) {
    const created = await request(app(localBoard))
      .post(`/api/companies/${companyId}/pipelines`)
      .send({ key, name: `Pipeline ${key}`, stages: STAGES })
      .expect(201);
    return created.body as { id: string };
  }

  async function seedCase(pipelineId: string, caseKey: string) {
    const created = await request(app(localBoard))
      .post(`/api/pipelines/${pipelineId}/cases`)
      .send({ caseKey, title: `Case ${caseKey}` })
      .expect(201);
    return created.body.case as { id: string; version: number };
  }

  // Runs create, edit, move and claim as the given actor and returns the status codes.
  async function caseActionStatuses(actor: Actor, pipelineId: string) {
    const http = request(app(actor));
    const tag = randomUUID().slice(0, 6);
    const edit = await seedCase(pipelineId, `edit-${tag}`);
    const move = await seedCase(pipelineId, `move-${tag}`);
    const claim = await seedCase(pipelineId, `claim-${tag}`);
    const create = await http.post(`/api/pipelines/${pipelineId}/cases`).send({ caseKey: `new-${tag}`, title: "New" });
    const patch = await http.patch(`/api/cases/${edit.id}`).send({ title: "Edited" });
    const transition = await http
      .post(`/api/cases/${move.id}/transition`)
      .send({ toStageKey: "working", expectedVersion: move.version });
    const claimed = await http.post(`/api/cases/${claim.id}/claim`).send({});
    return {
      create: create.status,
      edit: patch.status,
      move: transition.status,
      claim: claimed.status,
    };
  }

  it("lets a board user give Harbor Administer from the agent permissions API, then Harbor creates a pipeline", async () => {
    const company = await seedCompany();
    const owner = await seedBoardUser(company.id, "owner", ["users:manage_permissions", "agents:create"]);
    const harbor = await seedAgent(company.id, "Harbor", { onBehalfOf: { userId: owner.userId, role: "owner" } });
    const harborHttp = request(app(harbor.actor));

    const denied = await harborHttp
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "sales", name: "Sales" })
      .expect(403);
    expect(denied.body.error).toContain("pipelines:write");

    const updated = await request(app(owner.actor))
      .patch(`/api/agents/${harbor.agent.id}/permissions`)
      .send({
        canCreateAgents: false,
        canAssignTasks: false,
        pipelineAccess: { level: "administer", pipelineIds: null },
      })
      .expect(200);
    expect(updated.body.access.grants.map((row: { permissionKey: string }) => row.permissionKey)).toContain("pipelines:write");

    const created = await harborHttp
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "sales", name: "Sales", stages: STAGES })
      .expect(201);
    expect(created.body.key).toBe("sales");

    const statuses = await caseActionStatuses(harbor.actor, created.body.id);
    expect(statuses).toEqual({ create: 201, edit: 200, move: 200, claim: 200 });
  });

  it("refuses pipeline access changes from users without users:manage_permissions and from agents", async () => {
    const company = await seedCompany();
    const operator = await seedBoardUser(company.id, "operator", ["agents:create"]);
    const target = await seedAgent(company.id, "Target");
    const ceo = await seedAgent(company.id, "Chief");
    await db.update(agents).set({ role: "ceo" }).where(eq(agents.id, ceo.agent.id));

    const body = { canCreateAgents: false, canAssignTasks: false, pipelineAccess: { level: "administer", pipelineIds: null } };
    await request(app(operator.actor)).patch(`/api/agents/${target.agent.id}/permissions`).send(body).expect(403);
    await request(app(ceo.actor)).patch(`/api/agents/${target.agent.id}/permissions`).send(body).expect(403);

    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(and(eq(principalPermissionGrants.principalType, "agent"), eq(principalPermissionGrants.principalId, target.agent.id)));
    expect(grants.filter((row) => row.permissionKey.startsWith("pipelines:"))).toEqual([]);
  });

  it("rejects a picked pipeline from another company", async () => {
    const company = await seedCompany();
    const other = await seedCompany();
    const otherPipeline = await seedPipeline(other.id, "theirs");
    const target = await seedAgent(company.id, "Target");

    await request(app(localBoard))
      .patch(`/api/agents/${target.agent.id}/permissions`)
      .send({
        canCreateAgents: false,
        canAssignTasks: false,
        pipelineAccess: { level: "work_cases", pipelineIds: [otherPipeline.id] },
      })
      .expect(422);
  });

  it("gives View-only agents 403 on create, edit, move and claim; Work cases succeeds", async () => {
    const company = await seedCompany();
    const pipeline = await seedPipeline(company.id, "crm");
    const viewer = await seedAgent(company.id, "Viewer");
    const worker = await seedAgent(company.id, "Worker");
    await grant(company.id, worker.agent.id, "pipelines:cases");

    expect(await caseActionStatuses(viewer.actor, pipeline.id)).toEqual({ create: 403, edit: 403, move: 403, claim: 403 });
    expect(await caseActionStatuses(worker.actor, pipeline.id)).toEqual({ create: 201, edit: 200, move: 200, claim: 200 });

    // Work cases does not administer.
    await request(app(worker.actor)).patch(`/api/pipelines/${pipeline.id}`).send({ name: "Renamed" }).expect(403);
    await request(app(worker.actor)).post(`/api/companies/${company.id}/pipelines`).send({ key: "x", name: "X" }).expect(403);
  });

  it("respects per-pipeline scope for Work cases and Administer", async () => {
    const company = await seedCompany();
    const allowed = await seedPipeline(company.id, "allowed");
    const other = await seedPipeline(company.id, "other");
    const worker = await seedAgent(company.id, "Scoped worker");
    const admin = await seedAgent(company.id, "Scoped admin");

    await request(app(localBoard))
      .patch(`/api/agents/${worker.agent.id}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: false, pipelineAccess: { level: "work_cases", pipelineIds: [allowed.id] } })
      .expect(200);
    await request(app(localBoard))
      .patch(`/api/agents/${admin.agent.id}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: false, pipelineAccess: { level: "administer", pipelineIds: [allowed.id] } })
      .expect(200);

    expect(await caseActionStatuses(worker.actor, allowed.id)).toEqual({ create: 201, edit: 200, move: 200, claim: 200 });
    expect(await caseActionStatuses(worker.actor, other.id)).toEqual({ create: 403, edit: 403, move: 403, claim: 403 });

    await request(app(admin.actor)).patch(`/api/pipelines/${allowed.id}`).send({ name: "Renamed" }).expect(200);
    await request(app(admin.actor)).patch(`/api/pipelines/${other.id}`).send({ name: "Renamed" }).expect(403);
    expect(await caseActionStatuses(admin.actor, other.id)).toEqual({ create: 403, edit: 403, move: 403, claim: 403 });
    // A scoped admin cannot create new pipelines; that needs all pipelines.
    await request(app(admin.actor)).post(`/api/companies/${company.id}/pipelines`).send({ key: "new", name: "New" }).expect(403);
  });

  it("keeps every case and admin action for existing pipelines:write holders", async () => {
    const company = await seedCompany();
    const legacy = await seedAgent(company.id, "Legacy writer");
    await grant(company.id, legacy.agent.id, "pipelines:write");
    const http = request(app(legacy.actor));

    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "legacy", name: "Legacy", stages: STAGES.filter((stage) => stage.key !== "working") })
      .expect(201);
    await http.patch(`/api/pipelines/${pipeline.body.id}`).send({ name: "Legacy 2" }).expect(200);
    await http.post(`/api/pipelines/${pipeline.body.id}/stages`).send({ key: "working", name: "Working", kind: "working", position: 200 }).expect(201);
    await http
      .put(`/api/pipelines/${pipeline.body.id}/transitions`)
      .send({ transitions: [{ fromStageKey: "intake", toStageKey: "working" }] })
      .expect(200);

    expect(await caseActionStatuses(legacy.actor, pipeline.body.id)).toEqual({ create: 201, edit: 200, move: 200, claim: 200 });
  });

  it("writes grant and structure changes to the activity log with actor, run and before/after", async () => {
    const company = await seedCompany();
    const owner = await seedBoardUser(company.id, "owner", ["users:manage_permissions", "agents:create"]);
    const harbor = await seedAgent(company.id, "Harbor");

    await request(app(owner.actor))
      .patch(`/api/agents/${harbor.agent.id}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: false, pipelineAccess: { level: "administer", pipelineIds: null } })
      .expect(200);

    const http = request(app(harbor.actor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "audit", name: "Audit", stages: STAGES.filter((stage) => stage.key !== "working") })
      .expect(201);
    const pipelineId = pipeline.body.id as string;
    await http.patch(`/api/pipelines/${pipelineId}`).send({ name: "Audit 2" }).expect(200);
    const stage = await http
      .post(`/api/pipelines/${pipelineId}/stages`)
      .send({ key: "working", name: "Working", kind: "working", position: 200 })
      .expect(201);
    await http.patch(`/api/pipelines/${pipelineId}/stages/${stage.body.id}`).send({ name: "In progress" }).expect(200);
    await http
      .put(`/api/pipelines/${pipelineId}/transitions`)
      .send({ transitions: [{ fromStageKey: "intake", toStageKey: "working" }] })
      .expect(200);
    await http.delete(`/api/pipelines/${pipelineId}/stages/${stage.body.id}`).expect(200);

    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
    const byAction = (action: string) => rows.filter((row) => row.action === action);

    const grantRow = byAction("agent.pipeline_access_updated")[0];
    expect(grantRow).toMatchObject({
      actorType: "user",
      actorId: owner.userId,
      entityType: "agent",
      entityId: harbor.agent.id,
      details: {
        before: { level: "view", pipelineIds: null },
        after: { level: "administer", pipelineIds: null },
      },
    });

    const structureActions = [
      "pipeline.created",
      "pipeline.updated",
      "pipeline.stage_created",
      "pipeline.stage_updated",
      "pipeline.transitions_replaced",
      "pipeline.stage_deleted",
    ];
    for (const action of structureActions) {
      const [row] = byAction(action);
      expect(row, action).toMatchObject({
        actorType: "agent",
        actorId: harbor.agent.id,
        runId: harbor.runId,
        entityType: "pipeline",
        entityId: pipelineId,
      });
      expect(row!.details, action).toHaveProperty("before");
      expect(row!.details, action).toHaveProperty("after");
    }
    expect(byAction("pipeline.updated")[0]!.details).toMatchObject({
      before: { name: "Audit" },
      after: { name: "Audit 2" },
    });
    expect(byAction("pipeline.stage_updated")[0]!.details).toMatchObject({
      before: { name: "Working" },
      after: { name: "In progress" },
    });
    expect(byAction("pipeline.transitions_replaced")[0]!.details).toMatchObject({
      before: { transitions: [] },
      after: { transitions: [{ fromStageKey: "intake", toStageKey: "working", label: null }] },
    });
    expect(byAction("pipeline.stage_deleted")[0]!.details).toMatchObject({
      before: { key: "working", name: "In progress" },
      after: null,
    });
  });
});
