import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@greatstone/db";
import type { NeedsMe } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const { errorHandler } = await import("../middleware/index.js");
const { decisionsFeedRoutes } = await import("../routes/decisions-feed.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres needs-me tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const USER_ID = "board-user";
const OTHER_USER_ID = "other-user";

describeEmbeddedPostgres("one needs-me list for the board user (GRE-355)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-needs-me-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let issueNumber = 0;
  let companyNumber = 0;

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    companyNumber += 1;
    await db.insert(companies).values({ id: companyId, name: "GRE Co", issuePrefix: `GR${companyNumber}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: USER_ID, status: "active", membershipRole: "owner",
    });
    return { companyId, agentId };
  }

  async function task(companyId: string, values: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    issueNumber += 1;
    await db.insert(issues).values({
      id,
      companyId,
      identifier: `GRE-${issueNumber}`,
      issueNumber,
      title: `Task ${issueNumber}`,
      status: "todo",
      priority: "medium",
      ...values,
    });
    return id;
  }

  async function question(companyId: string, issueId: string, agentId: string, values: Partial<typeof issueThreadInteractions.$inferInsert> = {}) {
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      title: "Which month?",
      createdByAgentId: agentId,
      payload: { version: 1, questions: [{ id: "month", prompt: "Which month?", selectionMode: "single", options: [{ id: "sep", label: "September" }] }] },
      ...values,
    });
  }

  function app(companyId: string, actor?: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor ?? {
        type: "board",
        source: "session",
        userId: USER_ID,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "owner" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", decisionsFeedRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  async function needsMe(companyId: string): Promise<NeedsMe> {
    const res = await request(app(companyId)).get(`/api/companies/${companyId}/needs-me`).expect(200);
    return res.body as NeedsMe;
  }

  function taskIds(body: NeedsMe) {
    return body.assignedTasks.map((t) => t.id).sort();
  }

  it("includes tasks assigned to the user in every open status", async () => {
    const { companyId } = await seedCompany();
    const open = [];
    for (const status of ["backlog", "todo", "in_progress", "blocked"]) {
      open.push(await task(companyId, { status, assigneeUserId: USER_ID }));
    }

    const body = await needsMe(companyId);

    expect(taskIds(body)).toEqual([...open].sort());
    expect(body.assignedTaskCount).toBe(4);
    expect(body.count).toBe(body.decisionCount + body.assignedTaskCount);
  });

  it("excludes assigned tasks that are done or cancelled", async () => {
    const { companyId } = await seedCompany();
    await task(companyId, { status: "done", assigneeUserId: USER_ID });
    await task(companyId, { status: "cancelled", assigneeUserId: USER_ID });

    const body = await needsMe(companyId);

    expect(body.assignedTasks).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("excludes tasks the user only created or commented on", async () => {
    const { companyId, agentId } = await seedCompany();
    await task(companyId, { createdByUserId: USER_ID, assigneeAgentId: agentId });
    const commented = await task(companyId, { assigneeAgentId: agentId });
    await db.insert(issueComments).values({
      companyId, issueId: commented, authorUserId: USER_ID, authorType: "user", body: "Looks good.",
    });

    const body = await needsMe(companyId);

    expect(body.assignedTasks).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("excludes tasks assigned to another user, hidden tasks, and other companies", async () => {
    const { companyId } = await seedCompany();
    const other = await seedCompany();
    await task(companyId, { assigneeUserId: OTHER_USER_ID });
    await task(companyId, { assigneeUserId: USER_ID, hiddenAt: new Date() });
    await task(other.companyId, { assigneeUserId: USER_ID });

    const body = await needsMe(companyId);

    expect(body.assignedTasks).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("includes open questions waiting on the user and drops answered ones", async () => {
    const { companyId, agentId } = await seedCompany();
    const asked = await task(companyId, { status: "blocked", assigneeAgentId: agentId });
    const answered = await task(companyId, { status: "in_progress", assigneeAgentId: agentId });
    await question(companyId, asked, agentId);
    await question(companyId, answered, agentId, { status: "answered", resolvedByUserId: USER_ID, resolvedAt: new Date() });

    const body = await needsMe(companyId);

    expect(body.decisions.map((card) => card.task?.id)).toEqual([asked]);
    expect(body.decisionCount).toBe(1);
    expect(body.count).toBe(1);
  });

  it("excludes questions addressed to another user", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await task(companyId, { status: "blocked", assigneeAgentId: agentId });
    await question(companyId, issueId, agentId, { addresseeUserId: OTHER_USER_ID });

    const body = await needsMe(companyId);

    expect(body.decisions).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("counts an assigned task with an open question once, as the decision", async () => {
    const { companyId, agentId } = await seedCompany();
    const both = await task(companyId, { status: "blocked", assigneeUserId: USER_ID });
    const plain = await task(companyId, { status: "todo", assigneeUserId: USER_ID });
    await question(companyId, both, agentId);

    const body = await needsMe(companyId);

    expect(body.decisions.map((card) => card.task?.id)).toEqual([both]);
    expect(taskIds(body)).toEqual([plain]);
    expect(body).toMatchObject({ count: 2, decisionCount: 1, assignedTaskCount: 1 });
  });

  it("refuses agents", async () => {
    const { companyId, agentId } = await seedCompany();
    await request(app(companyId, { type: "agent", agentId, companyId, source: "agent_key" }))
      .get(`/api/companies/${companyId}/needs-me`)
      .expect(403);
  });
});
