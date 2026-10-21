import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueFollows,
  issueRecentViews,
  issueThreadInteractions,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueFollowRoutes } from "../routes/issue-follows.js";
import { RECENT_ISSUE_VIEWS_LIMIT } from "../services/issue-follows.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue follow tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue follows and recently opened", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-follows-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issueFollows);
    await db.delete(issueRecentViews);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(userId: string, companyIds: string[]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId,
        companyIds,
        memberships: companyIds.map((companyId) => ({ companyId, status: "active", membershipRole: "owner" })),
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueFollowRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function company(prefix: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: prefix, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values(
      ["ben", "naa"].map((principalId) => ({
        companyId: id, principalType: "user", principalId, status: "active", membershipRole: "member",
      })),
    );
    return id;
  }

  async function task(companyId: string, values: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: values.title ?? `Task ${id.slice(0, 4)}`, status: "todo", ...values });
    return id;
  }

  it("follows a task and rolls up its whole subtree", async () => {
    const companyId = await company("GRE");
    const parent = await task(companyId, { title: "Indago portal", status: "in_progress" });
    const done = await task(companyId, { parentId: parent, status: "done" });
    const mine = await task(companyId, { parentId: parent, status: "todo", assigneeUserId: "ben" });
    const asking = await task(companyId, { parentId: parent, status: "in_progress" });
    const grandchild = await task(companyId, { parentId: done, status: "blocked", title: "Waiting on DNS" });
    await task(companyId, { parentId: parent, status: "done", hiddenAt: new Date() });
    await db.insert(issueThreadInteractions).values({
      companyId, issueId: asking, kind: "request_confirmation", status: "pending",
      payload: { version: 1, prompt: "Ship it?" },
    });
    await db.insert(issueComments).values([
      { companyId, issueId: grandchild, body: "Old note", createdAt: new Date("2026-10-01T09:00:00Z") },
      { companyId, issueId: grandchild, body: "DNS is still pending at the registrar", createdAt: new Date("2026-10-03T09:00:00Z") },
    ]);
    await db.insert(activityLog).values({
      companyId, actorType: "agent", actorId: "agent-1", action: "issue.updated", entityType: "issue", entityId: done,
      details: { status: "done", _previous: { status: "in_progress" } }, createdAt: new Date("2026-10-02T09:00:00Z"),
    });

    const app = appFor("ben", [companyId]);
    await request(app).put(`/api/issues/${parent}/follow`).expect(200, { issueId: parent, following: true });
    // Following twice is harmless.
    await request(app).put(`/api/issues/${parent}/follow`).expect(200);
    await request(app).get(`/api/issues/${parent}/follow`).expect(200, { issueId: parent, following: true });

    const res = await request(app).get(`/api/companies/${companyId}/issue-follows`).expect(200);
    expect(res.body).toHaveLength(1);
    const [rollup] = res.body;
    expect(rollup.issue).toMatchObject({ id: parent, title: "Indago portal" });
    expect(rollup.counts).toEqual({ total: 5, done: 1, inProgress: 2, waitingOnYou: 2, blocked: 1 });
    expect(rollup.latestUpdates.map((update: { kind: string; summary: string }) => [update.kind, update.summary])).toEqual([
      ["comment", "DNS is still pending at the registrar"],
      ["status", "done"],
      ["comment", "Old note"],
    ]);
    expect(mine).toBeTruthy();

    await request(app).delete(`/api/issues/${parent}/follow`).expect(200, { issueId: parent, following: false });
    await request(app).get(`/api/companies/${companyId}/issue-follows`).expect(200, []);
  });

  it("keeps follows personal and inside the company", async () => {
    const companyA = await company("AAA");
    const companyB = await company("BBB");
    const taskA = await task(companyA);
    const taskB = await task(companyB);

    await request(appFor("ben", [companyA])).put(`/api/issues/${taskA}/follow`).expect(200);

    // Another user in the same company sees none of Ben's follows.
    await request(appFor("naa", [companyA])).get(`/api/companies/${companyA}/issue-follows`).expect(200, []);
    await request(appFor("naa", [companyA])).get(`/api/issues/${taskA}/follow`).expect(200, { issueId: taskA, following: false });

    // A task in a company the user cannot reach looks missing.
    await request(appFor("ben", [companyA])).put(`/api/issues/${taskB}/follow`).expect(404);
    await request(appFor("ben", [companyA])).get(`/api/companies/${companyB}/issue-follows`).expect(403);
    await request(appFor("ben", [companyA])).put(`/api/issues/not-a-uuid/follow`).expect(404);
  });

  it("accepts a task key (GRE-123) wherever it accepts a task id", async () => {
    const companyA = await company("GRE");
    const companyB = await company("BBB");
    const taskA = await task(companyA, { issueNumber: 123, identifier: "GRE-123" });
    await task(companyB, { issueNumber: 9, identifier: "BBB-9" });
    const ben = appFor("ben", [companyA]);

    await request(ben).put("/api/issues/GRE-123/follow").expect(200, { issueId: taskA, following: true });
    await request(ben).get("/api/issues/gre-123/follow").expect(200, { issueId: taskA, following: true });
    await request(ben).delete("/api/issues/GRE-123/follow").expect(200, { issueId: taskA, following: false });
    await request(ben).post("/api/issues/GRE-123/recent-view").expect(204);
    expect(await db.select().from(issueRecentViews)).toMatchObject([{ issueId: taskA }]);

    // A key from a company the user cannot reach, or no task at all, looks missing.
    await request(ben).put("/api/issues/BBB-9/follow").expect(404);
    await request(ben).put("/api/issues/GRE-999/follow").expect(404);
  });

  it("keeps the last ten opened tasks, newest first, per user", async () => {
    const companyId = await company("GRE");
    const ids: string[] = [];
    for (let index = 0; index < RECENT_ISSUE_VIEWS_LIMIT + 2; index += 1) ids.push(await task(companyId, { title: `T${index}` }));

    const ben = appFor("ben", [companyId]);
    for (const id of ids) await request(ben).post(`/api/issues/${id}/recent-view`).expect(204);
    // Opening an older one again moves it to the top.
    await request(ben).post(`/api/issues/${ids[5]}/recent-view`).expect(204);

    const res = await request(ben).get(`/api/companies/${companyId}/recent-issues`).expect(200);
    expect(res.body).toHaveLength(RECENT_ISSUE_VIEWS_LIMIT);
    expect(res.body[0].issue.title).toBe("T5");
    expect(res.body[1].issue.title).toBe("T11");
    expect(res.body.map((entry: { issue: { title: string } }) => entry.issue.title)).not.toContain("T0");

    const stored = await db.select().from(issueRecentViews);
    expect(stored).toHaveLength(RECENT_ISSUE_VIEWS_LIMIT);

    await request(appFor("naa", [companyId])).get(`/api/companies/${companyId}/recent-issues`).expect(200, []);
  });

  it("does not record opens for agents or tasks in another company", async () => {
    const companyA = await company("AAA");
    const companyB = await company("BBB");
    const taskB = await task(companyB);
    await request(appFor("ben", [companyA])).post(`/api/issues/${taskB}/recent-view`).expect(404);

    const agentApp = express();
    agentApp.use(express.json());
    agentApp.use((req, _res, next) => {
      (req as any).actor = { type: "agent", agentId: randomUUID(), companyId: companyB, runId: randomUUID() };
      next();
    });
    agentApp.use("/api", issueFollowRoutes(db));
    agentApp.use(errorHandler);
    await request(agentApp).post(`/api/issues/${taskB}/recent-view`).expect(403);
    expect(await db.select().from(issueRecentViews)).toHaveLength(0);
  });
});
