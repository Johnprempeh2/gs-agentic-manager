import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, createDb, projects } from "@greatstone/db";
import { registerAgentProjectAccessRoutes } from "../routes/agent-project-access.js";
import { errorHandler } from "../middleware/error-handler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("agent project access repair", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-project-access-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Project access", issuePrefix: `A${companyId.slice(0, 6)}` });
    const projectRows = await db.insert(projects).values(["Existing", "Needed"].map(name => ({ companyId, name }))).returning();
    const permissions = { canCreateAgents: false, canCreateSkills: false, trustPreset: "low_trust_review",
      authorizationPolicy: { customPolicy: { preserve: true }, trustBoundary: { mode: "low_trust_review", companyId,
        projectIds: [projectRows[0]!.id], allowedSecretBindingIds: [] } } };
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", adapterType: "process", status: "idle", permissions });
    return { companyId, agentId, projectRows, permissions };
  }

  function app(actor: express.Request["actor"]) {
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = actor; next(); });
    registerAgentProjectAccessRoutes(app, db); app.use(errorHandler); return app;
  }
  const board = { type: "board" as const, source: "local_implicit" as const };

  it("adds a same-company project without replacing the boundary or creating duplicate activity", async () => {
    const fixture = await seed();
    const api = app(board);
    const projectId = fixture.projectRows[1]!.id;
    const first = await request(api).post(`/agents/${fixture.agentId}/project-access`).send({ projectIds: [projectId] });
    expect(first.status).toBe(200);
    expect(first.body.projectIds).toEqual([fixture.projectRows[0]!.id, projectId]);
    const [saved] = await db.select().from(agents).where(eq(agents.id, fixture.agentId));
    expect(saved!.permissions).toEqual({ ...fixture.permissions, authorizationPolicy: {
      ...fixture.permissions.authorizationPolicy, trustBoundary: {
        ...fixture.permissions.authorizationPolicy.trustBoundary, projectIds: [fixture.projectRows[0]!.id, projectId],
      },
    } });
    expect((await request(api).post(`/agents/${fixture.agentId}/project-access`).send({ projectIds: [projectId] })).status).toBe(200);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, fixture.companyId), eq(activityLog.action, "agent.project_access_added")))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toHaveLength(0);
  });

  it("rejects a foreign project, agent key, and pending approval", async () => {
    const own = await seed(), foreign = await seed(), api = app(board);
    expect((await request(api).post(`/agents/${own.agentId}/project-access`).send({ projectIds: [foreign.projectRows[0]!.id] })).status).toBe(404);
    const scopedBoard = app({ type: "board", source: "session", userId: randomUUID(), companyIds: [own.companyId], memberships: [] });
    expect((await request(scopedBoard).get(`/agents/${foreign.agentId}/project-access`)).status).toBe(404);
    const agentActor = { type: "agent" as const, source: "agent_key" as const, agentId: own.agentId, companyId: own.companyId };
    expect((await request(app(agentActor)).post(`/agents/${own.agentId}/project-access`).send({ projectIds: [own.projectRows[1]!.id] })).status).toBe(403);
    await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, own.agentId));
    expect((await request(api).post(`/agents/${own.agentId}/project-access`).send({ projectIds: [own.projectRows[1]!.id] })).status).toBe(409);
  });

  it("keeps both projects when two operators add access at the same time", async () => {
    const fixture = await seed();
    const [third] = await db.insert(projects).values({ companyId: fixture.companyId, name: "Third" }).returning();
    const api = app(board);
    const [first, second] = await Promise.all([
      request(api).post(`/agents/${fixture.agentId}/project-access`).send({ projectIds: [fixture.projectRows[1]!.id] }),
      request(api).post(`/agents/${fixture.agentId}/project-access`).send({ projectIds: [third!.id] }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const [saved] = await db.select().from(agents).where(eq(agents.id, fixture.agentId));
    const ids = (saved!.permissions.authorizationPolicy as { trustBoundary: { projectIds: string[] } }).trustBoundary.projectIds;
    expect(ids).toEqual(expect.arrayContaining([fixture.projectRows[0]!.id, fixture.projectRows[1]!.id, third!.id]));
    expect(ids).toHaveLength(3);
  });
});
