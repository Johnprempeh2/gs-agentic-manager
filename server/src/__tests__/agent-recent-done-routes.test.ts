import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@greatstone/db";
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

describeEmbeddedPostgres("GET /agents/me/recent-done", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-recent-done-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
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
      name: "Recent Done Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [agent, other] = await db
      .insert(agents)
      .values([
        { companyId, name: "Mason", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
        { companyId, name: "Ridge", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      ])
      .returning();
    await db.insert(issues).values([
      { companyId, title: "Older", status: "done", assigneeAgentId: agent!.id, completedAt: new Date("2026-10-01T00:00:00Z") },
      { companyId, title: "Newer", status: "done", assigneeAgentId: agent!.id, completedAt: new Date("2026-10-05T00:00:00Z") },
      { companyId, title: "Hidden", status: "done", assigneeAgentId: agent!.id, completedAt: new Date("2026-10-06T00:00:00Z"), hiddenAt: new Date() },
      { companyId, title: "Open", status: "todo", assigneeAgentId: agent!.id },
      { companyId, title: "Someone else", status: "done", assigneeAgentId: other!.id, completedAt: new Date("2026-10-07T00:00:00Z") },
    ]);
    return { companyId, agentId: agent!.id };
  }

  it("lists only the calling agent's finished, visible tasks, newest first", async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(db, { type: "agent", agentId, companyId, source: "agent_jwt" });
    const res = await request(app).get("/api/agents/me/recent-done");
    expect(res.status).toBe(200);
    expect(res.body.map((row: { title: string }) => row.title)).toEqual(["Newer", "Older"]);

    const limited = await request(app).get("/api/agents/me/recent-done?limit=1");
    expect(limited.body.map((row: { title: string }) => row.title)).toEqual(["Newer"]);
  });

  it("inbox-lite carries each open task's due date", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(issues).values({ companyId, title: "Due soon", status: "todo", assigneeAgentId: agentId, dueDate: "2026-10-20" });
    const app = createApp(db, { type: "agent", agentId, companyId, source: "agent_jwt" });
    const res = await request(app).get("/api/agents/me/inbox-lite");
    expect(res.status).toBe(200);
    const byTitle = new Map(res.body.map((row: { title: string; dueDate: string | null }) => [row.title, row.dueDate]));
    expect(byTitle.get("Due soon")).toBe("2026-10-20");
    expect(byTitle.get("Open")).toBeNull();
  });

  it("refuses a board user", async () => {
    const res = await request(createApp(db, { type: "board", userId: "local-board", source: "local_implicit" })).get(
      "/api/agents/me/recent-done",
    );
    expect(res.status).toBe(401);
  });
});
