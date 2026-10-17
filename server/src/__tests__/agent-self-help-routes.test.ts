import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRelations, issues } from "@greatstone/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("agent self-help routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-self-help-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Self Help Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [agent, other] = await db
      .insert(agents)
      .values([
        { companyId, name: "Mason", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
        { companyId, name: "Ridge", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      ])
      .returning();
    return { companyId, agentId: agent!.id, otherId: other!.id };
  }

  it("lists the calling agent's failed runs with their errors, newest first", async () => {
    const { companyId, agentId, otherId } = await seed();
    await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "failed", error: "Old failure", createdAt: new Date("2026-10-01T00:00:00Z") },
      { companyId, agentId, status: "timed_out", error: "Took too long", errorCode: "timeout", createdAt: new Date("2026-10-02T00:00:00Z") },
      { companyId, agentId, status: "succeeded", createdAt: new Date("2026-10-03T00:00:00Z") },
      { companyId, agentId: otherId, status: "failed", error: "Not mine", createdAt: new Date("2026-10-04T00:00:00Z") },
    ]);
    const app = createApp(db, { type: "agent", agentId, companyId, source: "agent_jwt" });
    const res = await request(app).get("/api/agents/me/failed-runs");
    expect(res.status).toBe(200);
    expect(res.body.map((run: { error: string }) => run.error)).toEqual(["Took too long", "Old failure"]);
    expect(res.body[0].errorCode).toBe("timeout");

    const limited = await request(app).get("/api/agents/me/failed-runs?limit=1");
    expect(limited.body).toHaveLength(1);
  });

  it("lists the calling agent's tasks that other open tasks wait on", async () => {
    const { companyId, agentId, otherId } = await seed();
    const [mine, waitingA, waitingB, theirs, waitingC] = await db
      .insert(issues)
      .values([
        { companyId, title: "Write the brief", status: "in_progress", assigneeAgentId: agentId },
        { companyId, title: "Design", status: "blocked", assigneeAgentId: otherId },
        { companyId, title: "Build", status: "blocked", assigneeAgentId: otherId },
        { companyId, title: "Their task", status: "todo", assigneeAgentId: otherId },
        { companyId, title: "Review", status: "blocked", assigneeAgentId: agentId },
      ])
      .returning();
    await db.insert(issueRelations).values([
      { companyId, issueId: mine!.id, relatedIssueId: waitingA!.id, type: "blocks" },
      { companyId, issueId: waitingA!.id, relatedIssueId: waitingB!.id, type: "blocks" },
      { companyId, issueId: theirs!.id, relatedIssueId: waitingC!.id, type: "blocks" },
    ]);
    const app = createApp(db, { type: "agent", agentId, companyId, source: "agent_jwt" });
    const res = await request(app).get("/api/agents/me/waiting-on-me");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].issue.title).toBe("Write the brief");
    expect(res.body[0].waitingCount).toBe(2);
  });

  it("refuses a board user", async () => {
    const app = createApp(db, { type: "board", userId: "local-board", source: "local_implicit" });
    expect((await request(app).get("/api/agents/me/failed-runs")).status).toBe(401);
    expect((await request(app).get("/api/agents/me/waiting-on-me")).status).toBe(401);
  });
});
