import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueRelations,
  issues,
  issueThreadInteractions,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

// GRE-2329: POST /issues with status "blocked" and a misspelt `blockedByIds`
// saved a blocked task with no blocker, and agents worked on it anyway. A
// PATCH with the same field returned 200 with no changes. Both are refused now.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mystery-block tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;

function createApp(db: Db, company: CompanyRow) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

const SAY_WHAT_BLOCKS = /^Say what is blocking it/;
const BLOCKED_BY_IDS_HINT = 'Unknown issue field: "blockedByIds" (did you mean blockedByIssueIds?)';

describeEmbeddedPostgres("GRE-2329: the issues API refuses mystery blocks", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mystery-blocks-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const nonce = randomUUID().slice(0, 8);
    const prefix = `MB${nonce.slice(0, 4).toUpperCase()}`;
    const [company] = await db.insert(companies).values({
      name: `Mystery blocks ${nonce}`,
      issuePrefix: prefix,
      defaultResponsibleUserId: "board-user",
    }).returning();
    let n = 0;
    const seedIssue = async (title: string, status = "todo") => {
      n += 1;
      const [issue] = await db.insert(issues).values({
        companyId: company!.id,
        identifier: `${prefix}-${n}`,
        issueNumber: n,
        title,
        status,
        priority: "medium",
        responsibleUserId: "board-user",
      }).returning();
      return issue!;
    };
    const app = createApp(db, company!);
    const create = (body: Record<string, unknown>) =>
      request(app).post(`/api/companies/${company!.id}/issues`).send(body);
    const patch = (issueId: string, body: Record<string, unknown>) =>
      request(app).patch(`/api/issues/${issueId}`).send(body);
    return { company: company!, seedIssue, create, patch };
  }

  const statusOf = async (issueId: string) =>
    db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!.status);

  const messagesOf = (body: { error?: string; details?: { message: string }[] }) =>
    (body.details ?? []).map((detail) => detail.message);

  it("refuses an unknown field on create and names the field it meant", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue("Release");
    const res = await f.create({ title: "Wait on the release", status: "blocked", blockedByIds: [blocker.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(messagesOf(res.body)).toContain(BLOCKED_BY_IDS_HINT);
    const created = await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.company.id));
    expect(created).toHaveLength(1);
  });

  it("refuses an unknown field on PATCH instead of answering 200 with no changes", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue("Release");
    const task = await f.seedIssue("Wait on the release");
    const res = await f.patch(task.id, { status: "blocked", blockedByIds: [blocker.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(messagesOf(res.body)).toContain(BLOCKED_BY_IDS_HINT);
    expect(await statusOf(task.id)).toBe("todo");
  });

  it("refuses to create a blocked task with nothing blocking it", async () => {
    const f = await seedFixture();
    const res = await f.create({ title: "Mystery", status: "blocked" });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(messagesOf(res.body).some((message) => SAY_WHAT_BLOCKS.test(message))).toBe(true);
  });

  it("refuses to move a task to blocked with nothing blocking it", async () => {
    const f = await seedFixture();
    const task = await f.seedIssue("Mystery");
    const res = await f.patch(task.id, { status: "blocked", comment: "Blocked." });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(SAY_WHAT_BLOCKS);
    expect(res.body.code).toBe("issue_blocked_without_reason");
    expect(await statusOf(task.id)).toBe("todo");
  });

  it("creates a blocked task that names the task it waits on", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue("Release");
    const res = await f.create({ title: "Wait on the release", status: "blocked", blockedByIssueIds: [blocker.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("blocked");
  });

  it("creates a blocked task that says who must act", async () => {
    const f = await seedFixture();
    const res = await f.create({
      title: "Wait on the board",
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Approve the budget" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("blocked");
  });

  it("moves a task to blocked when it names the task it waits on", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue("Release");
    const task = await f.seedIssue("Wait on the release");
    const res = await f.patch(task.id, { status: "blocked", blockedByIssueIds: [blocker.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(task.id)).toBe("blocked");
  });

  it("moves a task to blocked when an existing blocker is still open", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue("Release");
    const task = await f.seedIssue("Wait on the release");
    await db.insert(issueRelations).values({
      companyId: f.company.id,
      issueId: blocker.id,
      relatedIssueId: task.id,
      type: "blocks",
    });
    const res = await f.patch(task.id, { status: "blocked" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(task.id)).toBe("blocked");
  });

  it("moves a task to blocked when it says who must act", async () => {
    const f = await seedFixture();
    const task = await f.seedIssue("Wait on the board");
    const res = await f.patch(task.id, {
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "Approve the budget" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(task.id)).toBe("blocked");
  });

  it("moves a task to blocked while a card on it waits for an answer", async () => {
    const f = await seedFixture();
    const task = await f.seedIssue("Wait on the card");
    await db.insert(issueThreadInteractions).values({
      companyId: f.company.id,
      issueId: task.id,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "none",
      title: "May I deploy?",
      payload: { version: 1, prompt: "May I deploy?" },
    });
    const res = await f.patch(task.id, { status: "blocked" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(task.id)).toBe("blocked");
  });
});
