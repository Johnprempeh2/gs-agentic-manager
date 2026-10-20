import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { teamScorecardService } from "../services/team-scorecard.ts";
import { teamScorecardRoutes } from "../routes/team-scorecard.ts";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres team scorecard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-10-15T12:00:00.000Z");
const YESTERDAY = new Date("2026-10-14T12:00:00.000Z");
const LAST_MONTH = new Date("2026-09-20T12:00:00.000Z");

describeEmbeddedPostgres("team scorecard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-team-scorecard-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const everest = randomUUID();
    const ridge = randomUUID();
    const gone = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Scorecard", issuePrefix: `S${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values([
      { id: everest, companyId, name: "Everest", role: "ceo", title: "Chief executive", status: "idle", adapterType: "codex_local" },
      { id: ridge, companyId, name: "Ridge", role: "engineer", status: "idle", adapterType: "codex_local" },
      { id: gone, companyId, name: "Gone", role: "engineer", status: "terminated", adapterType: "codex_local" },
    ]);
    await db.insert(issues).values([
      { companyId, title: "Proposal sent", identifier: "S-1", status: "done", assigneeAgentId: everest, completedAt: YESTERDAY },
      { companyId, title: "Old win", identifier: "S-2", status: "done", assigneeAgentId: everest, completedAt: LAST_MONTH },
      { companyId, title: "Watchdog", identifier: "S-3", status: "done", assigneeAgentId: everest, completedAt: YESTERDAY, originKind: "task_watchdog" },
      { companyId, title: "Hidden", identifier: "S-4", status: "done", assigneeAgentId: everest, completedAt: YESTERDAY, hiddenAt: YESTERDAY },
      { companyId, title: "Board pack", identifier: "S-5", status: "in_progress", assigneeAgentId: everest, dueDate: "2026-10-10" },
      { companyId, title: "Booking page", identifier: "S-6", status: "blocked", assigneeAgentId: ridge },
      { companyId, title: "Website copy", identifier: "S-7", status: "in_review", assigneeAgentId: ridge },
      { companyId, title: "Backlog idea", identifier: "S-8", status: "backlog", assigneeAgentId: ridge },
    ]);
    return { companyId };
  }

  it("counts finished work in the window and what each agent holds now", async () => {
    const { companyId } = await seedCompany();
    const week = await teamScorecardService(db).build(companyId, { days: 7, now: NOW });

    expect(week.agents.map((agent) => agent.name)).toEqual(["Ridge", "Everest"]);
    const everest = week.agents.find((agent) => agent.name === "Everest")!;
    expect(everest).toMatchObject({ finished: 1, underWay: 1, inReview: 0, stuck: 0, overdue: 1, title: "Chief executive" });
    expect(everest.recentlyFinished.map((task) => task.identifier)).toEqual(["S-1"]);
    const ridge = week.agents.find((agent) => agent.name === "Ridge")!;
    expect(ridge).toMatchObject({ finished: 0, underWay: 0, inReview: 1, stuck: 1 });
    expect(ridge.stuckTasks.map((task) => task.title)).toEqual(["Booking page"]);
    expect(week.totals).toEqual({ finished: 1, underWay: 1, inReview: 1, stuck: 1, overdue: 1 });

    const month = await teamScorecardService(db).build(companyId, { days: 30, now: NOW });
    expect(month.agents.find((agent) => agent.name === "Everest")!.finished).toBe(2);
  });

  it("gives each agent the median time from start to finish", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pace", issuePrefix: `P${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Mason", role: "engineer", status: "idle", adapterType: "codex_local" });
    const hour = 3_600_000;
    await db.insert(issues).values([
      { companyId, title: "Quick", status: "done", assigneeAgentId: agentId, startedAt: new Date(YESTERDAY.getTime() - 2 * hour), completedAt: YESTERDAY },
      { companyId, title: "Medium", status: "done", assigneeAgentId: agentId, startedAt: new Date(YESTERDAY.getTime() - 4 * hour), completedAt: YESTERDAY },
      { companyId, title: "Long", status: "done", assigneeAgentId: agentId, startedAt: new Date(YESTERDAY.getTime() - 30 * hour), completedAt: YESTERDAY },
    ]);
    const week = await teamScorecardService(db).build(companyId, { days: 7, now: NOW });
    expect(week.agents[0]!.medianFinishMs).toBe(4 * hour);
  });

  it("serves the scorecard over HTTP and checks the window", async () => {
    const { companyId } = await seedCompany();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: [companyId] } as never;
      next();
    });
    app.use("/api", teamScorecardRoutes(db));
    app.use(errorHandler);

    const ok = await request(app).get(`/api/companies/${companyId}/team-scorecard`);
    expect(ok.status).toBe(200);
    expect(ok.body.days).toBe(7);
    const month = await request(app).get(`/api/companies/${companyId}/team-scorecard`).query({ days: "30" });
    expect(month.body.days).toBe(30);
    const bad = await request(app).get(`/api/companies/${companyId}/team-scorecard`).query({ days: "3" });
    expect(bad.status).toBe(400);
    const otherCompany = await request(app).get(`/api/companies/${randomUUID()}/team-scorecard`);
    expect(otherCompany.status).toBe(403);
  });
});
