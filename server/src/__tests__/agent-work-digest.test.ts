import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyUserVisits,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentWorkDigestService } from "../services/agent-work-digest.ts";
import { agentWorkDigestRoutes } from "../routes/agent-work-digest.ts";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent work digest tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-10-02T08:00:00.000Z");
const LAST_NIGHT = new Date("2026-10-01T22:00:00.000Z");
const OVERNIGHT = new Date("2026-10-02T02:00:00.000Z");
const LAST_WEEK = new Date("2026-09-25T12:00:00.000Z");
const USER_ID = "user-1";

describeEmbeddedPostgres("agent work digest", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-work-digest-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(companyUserVisits);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const builder = randomUUID();
    const tester = randomUUID();
    const idle = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Digest", issuePrefix: `D${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values([
      { id: builder, companyId, name: "Builder", role: "engineer", status: "idle", adapterType: "codex_local" },
      { id: tester, companyId, name: "Tester", role: "qa", status: "idle", adapterType: "codex_local" },
      { id: idle, companyId, name: "Sleeper", role: "engineer", status: "idle", adapterType: "codex_local" },
    ]);

    const finished = randomUUID();
    const started = randomUUID();
    const oldDone = randomUUID();
    const watchdog = randomUUID();
    const hidden = randomUUID();
    await db.insert(issues).values([
      { id: finished, companyId, title: "Faster board", identifier: "GRE-1", status: "done", assigneeAgentId: builder, startedAt: LAST_WEEK, completedAt: OVERNIGHT },
      { id: started, companyId, title: "Fix login", identifier: "GRE-2", status: "in_progress", assigneeAgentId: tester, startedAt: OVERNIGHT },
      // Before `since`: must not appear.
      { id: oldDone, companyId, title: "Old work", identifier: "GRE-3", status: "done", assigneeAgentId: builder, startedAt: LAST_WEEK, completedAt: LAST_WEEK },
      // Housekeeping task opened by the platform: must not appear.
      { id: watchdog, companyId, title: "Watchdog check", identifier: "GRE-4", status: "done", originKind: "task_watchdog", assigneeAgentId: idle, startedAt: OVERNIGHT, completedAt: OVERNIGHT },
      // Hidden task: must not appear.
      { id: hidden, companyId, title: "Hidden", identifier: "GRE-5", status: "done", assigneeAgentId: idle, startedAt: OVERNIGHT, completedAt: OVERNIGHT, hiddenAt: OVERNIGHT },
    ]);

    const failedRun = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: failedRun, companyId, agentId: tester, status: "failed", finishedAt: OVERNIGHT, contextSnapshot: { issueId: started } },
      { companyId, agentId: builder, status: "succeeded", finishedAt: OVERNIGHT, contextSnapshot: { issueId: finished } },
      // Failure on a housekeeping task is housekeeping.
      { companyId, agentId: idle, status: "timed_out", finishedAt: OVERNIGHT, contextSnapshot: { issueId: watchdog } },
    ]);

    await db.insert(approvals).values({ companyId, type: "hire_agent", requestedByAgentId: builder, payload: {}, createdAt: OVERNIGHT });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: started,
      kind: "request_confirmation",
      createdByAgentId: tester,
      payload: {} as never,
      createdAt: OVERNIGHT,
    });

    // System housekeeping in the raw audit log: must never reach the digest.
    await db.insert(activityLog).values([
      { companyId, actorType: "system", actorId: "system", action: "environment.lease_acquired", entityType: "environment", entityId: randomUUID(), createdAt: OVERNIGHT },
      { companyId, actorType: "system", actorId: "system", action: "issue.updated", entityType: "issue", entityId: watchdog, agentId: idle, createdAt: OVERNIGHT },
    ]);

    return { companyId, builder, tester, idle, finished, started, failedRun };
  }

  it("groups agent work by agent, in plain language, without housekeeping", async () => {
    const seed = await seedCompany();
    const digest = await agentWorkDigestService(db).build(seed.companyId, { userId: USER_ID, since: LAST_NIGHT, now: NOW });

    expect(digest.sinceSource).toBe("query");
    expect(digest.since).toBe(LAST_NIGHT.toISOString());
    expect(digest.counts).toEqual({ tasksFinished: 1, tasksStarted: 1, decisionsRaised: 2, failures: 1 });
    expect(digest.agents.map((agent) => agent.agentName).sort()).toEqual(["Builder", "Tester"]);
    expect(digest.agents.some((agent) => agent.agentId === seed.idle)).toBe(false);

    const builder = digest.agents.find((agent) => agent.agentId === seed.builder)!;
    expect(builder.counts).toEqual({ tasksFinished: 1, tasksStarted: 0, decisionsRaised: 1, failures: 0 });
    expect(builder.items.map((item) => item.label).sort()).toEqual([
      "Asked for approval: Hire agent",
      "Finished GRE-1: Faster board",
    ]);

    const tester = digest.agents.find((agent) => agent.agentId === seed.tester)!;
    expect(tester.counts).toEqual({ tasksFinished: 0, tasksStarted: 1, decisionsRaised: 1, failures: 1 });
    expect(tester.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "task_started", label: "Started GRE-2: Fix login", issueId: seed.started }),
      expect.objectContaining({ kind: "run_failed", label: "Run failed on GRE-2: Fix login", runId: seed.failedRun }),
      expect.objectContaining({ kind: "decision_raised", label: "Asked you a question on GRE-2: Fix login" }),
    ]));

    const labels = digest.agents.flatMap((agent) => agent.items.map((item) => item.label)).join("\n");
    expect(labels).not.toMatch(/[a-z]+\.[a-z_]+/); // no event codes such as issue.updated
    expect(labels).not.toMatch(/Watchdog|Hidden|Old work/);
  });

  it("defaults `since` to the stored last visit, then to the last 24 hours", async () => {
    const seed = await seedCompany();
    const svc = agentWorkDigestService(db);

    const firstVisit = await svc.build(seed.companyId, { userId: USER_ID, now: NOW });
    expect(firstVisit.sinceSource).toBe("default_window");
    expect(firstVisit.since).toBe(new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString());
    expect(firstVisit.counts.tasksFinished).toBe(1);

    // Visit after the overnight work: nothing new since then.
    const afterWork = new Date("2026-10-02T03:00:00.000Z");
    await svc.recordVisit(seed.companyId, USER_ID, afterWork);
    const quiet = await svc.build(seed.companyId, { userId: USER_ID, now: NOW });
    expect(quiet.sinceSource).toBe("last_visit");
    expect(quiet.since).toBe(afterWork.toISOString());
    expect(quiet.agents).toEqual([]);

    // A stale tab reporting an older visit must not move the marker back.
    await svc.recordVisit(seed.companyId, USER_ID, LAST_WEEK);
    expect((await svc.getLastVisit(seed.companyId, USER_ID))?.toISOString()).toBe(afterWork.toISOString());

    // Visits are per user.
    const other = await svc.build(seed.companyId, { userId: "user-2", now: NOW });
    expect(other.sinceSource).toBe("default_window");
  });

  it("serves the digest and records the visit over HTTP", async () => {
    const seed = await seedCompany();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: USER_ID, source: "session", isInstanceAdmin: false, companyIds: [seed.companyId] } as never;
      next();
    });
    app.use("/api", agentWorkDigestRoutes(db));
    app.use(errorHandler);

    const byQuery = await request(app).get(`/api/companies/${seed.companyId}/agent-work-digest`).query({ since: LAST_NIGHT.toISOString() });
    expect(byQuery.status).toBe(200);
    expect(byQuery.body.sinceSource).toBe("query");
    expect(byQuery.body.counts.tasksFinished).toBe(1);

    const bad = await request(app).get(`/api/companies/${seed.companyId}/agent-work-digest`).query({ since: "not-a-date" });
    expect(bad.status).toBe(400);

    const visit = await request(app).post(`/api/companies/${seed.companyId}/agent-work-digest/visit`);
    expect(visit.status).toBe(200);
    const byDefault = await request(app).get(`/api/companies/${seed.companyId}/agent-work-digest`);
    expect(byDefault.status).toBe(200);
    expect(byDefault.body.sinceSource).toBe("last_visit");
    expect(byDefault.body.since).toBe(visit.body.lastVisitedAt);

    const otherCompany = await request(app).get(`/api/companies/${randomUUID()}/agent-work-digest`);
    expect(otherCompany.status).toBe(403);
  });
});
