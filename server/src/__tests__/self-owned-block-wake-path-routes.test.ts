import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  issueThreadInteractions,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// GRE-6360: Flint set GRE-6132 to `blocked` with an unblock descriptor that
// named Flint itself, while the action said it waited on Keystone and John.
// Nothing else woke anyone, and the tree sat stranded for 40 hours. A block
// owned by its own assignee now needs a wake path; a block owned by someone
// else wakes them; and old self-owned blocks show in the block check.

vi.setConfig({ testTimeout: 30000 });

const mockWakeup = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: mockWakeup,
    }),
  };
});

const { errorHandler } = await import("../middleware/index.js");
const { issueRoutes } = await import("../routes/issues.js");
const { blockCheckRoutes } = await import("../routes/block-check.js");
const { attentionService } = await import("../services/attention.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres self-owned block tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

const SELF_OWNED = /^The unblock owner is the task's own assignee/;

describeEmbeddedPostgres("GRE-6360: a self-owned block needs a wake path", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-owned-block-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(() => {
    mockWakeup.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const nonce = randomUUID().slice(0, 8);
    const prefix = `SO${nonce.slice(0, 4).toUpperCase()}`;
    const [company] = await db.insert(companies).values({
      name: `Self-owned blocks ${nonce}`,
      issuePrefix: prefix,
      defaultResponsibleUserId: "board-user",
    }).returning();
    const companyId = company!.id;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "owner",
    });
    const [flint, keystone] = await db.insert(agents).values([
      { companyId, name: "Flint", role: "qa", status: "idle", adapterType: "codex_local" },
      { companyId, name: "Keystone", role: "engineer", status: "idle", adapterType: "codex_local" },
    ]).returning();
    let n = 0;
    const seedIssue = async (title: string, values: Partial<typeof issues.$inferInsert> = {}) => {
      n += 1;
      const [issue] = await db.insert(issues).values({
        companyId,
        identifier: `${prefix}-${n}`,
        issueNumber: n,
        title,
        status: "todo",
        priority: "medium",
        responsibleUserId: "board-user",
        ...values,
      }).returning();
      return issue!;
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "operator", status: "active" }],
        isInstanceAdmin: true,
        source: "local_implicit",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use("/api", blockCheckRoutes(db));
    app.use(errorHandler);
    return {
      companyId,
      flint: flint!,
      keystone: keystone!,
      seedIssue,
      patch: (issueId: string, body: Record<string, unknown>) =>
        request(app).patch(`/api/issues/${issueId}`).send(body),
      create: (body: Record<string, unknown>) =>
        request(app).post(`/api/companies/${companyId}/issues`).send(body),
      blockCheck: () => request(app).get(`/api/companies/${companyId}/block-check`),
    };
  }

  const statusOf = async (issueId: string) =>
    db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!.status);

  const unblockWakesFor = (agentId: string) =>
    mockWakeup.mock.calls.filter(
      (call) => (call as unknown[])[0] === agentId &&
        ((call as unknown[])[1] as { reason?: string } | undefined)?.reason === "issue_unblock_requested",
    );

  describe("the assignee names itself as the unblock owner", () => {
    it("refuses the block when nothing will wake it (the GRE-6132 shape)", async () => {
      const f = await seedFixture();
      const task = await f.seedIssue("Release the build", { assigneeAgentId: f.flint.id });
      const res = await f.patch(task.id, {
        status: "blocked",
        unblockDescriptor: {
          owner: { agentId: f.flint.id },
          action: "Waiting on Keystone to confirm with John before release.",
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.code).toBe("issue_blocked_self_owned_without_wake");
      expect(res.body.error).toMatch(SELF_OWNED);
      expect(res.body.error).toContain("blockedByIssueIds");
      expect(await statusOf(task.id)).toBe("todo");
    });

    it("refuses a new task created blocked on its own assignee", async () => {
      const f = await seedFixture();
      const res = await f.create({
        title: "Release the build",
        status: "blocked",
        assigneeAgentId: f.flint.id,
        unblockDescriptor: { owner: { agentId: f.flint.id }, action: "Wait for Keystone." },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(
        (res.body.details ?? []).some((detail: { message: string }) => SELF_OWNED.test(detail.message)),
      ).toBe(true);
    });

    it("allows the block with a first-class blocker", async () => {
      const f = await seedFixture();
      const blocker = await f.seedIssue("Keystone confirms with John", { assigneeAgentId: f.keystone.id });
      const task = await f.seedIssue("Release the build", { assigneeAgentId: f.flint.id });
      const res = await f.patch(task.id, {
        status: "blocked",
        blockedByIssueIds: [blocker.id],
        unblockDescriptor: { owner: { agentId: f.flint.id }, action: "Release once Keystone confirms." },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(task.id)).toBe("blocked");
    });

    it("allows the block with a pending card", async () => {
      const f = await seedFixture();
      const task = await f.seedIssue("Release the build", { assigneeAgentId: f.flint.id });
      await db.insert(issueThreadInteractions).values({
        companyId: f.companyId,
        issueId: task.id,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "May I release?",
        payload: { version: 1, prompt: "May I release?" },
      });
      const res = await f.patch(task.id, {
        status: "blocked",
        unblockDescriptor: { owner: { agentId: f.flint.id }, action: "Release once John answers." },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(task.id)).toBe("blocked");
    });

    it("allows the block with a day to check again", async () => {
      const f = await seedFixture();
      const task = await f.seedIssue("Release the build", { assigneeAgentId: f.flint.id });
      const res = await f.patch(task.id, {
        status: "blocked",
        unblockDescriptor: {
          owner: { agentId: f.flint.id },
          action: "Chase the client for the logo.",
          waitingOn: "client",
          expectedBy: "2099-01-01",
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(task.id)).toBe("blocked");
    });
  });

  describe("someone else is the unblock owner", () => {
    it("wakes the owner agent when the task is blocked", async () => {
      const f = await seedFixture();
      const task = await f.seedIssue("Release the build", { assigneeAgentId: f.flint.id });
      const res = await f.patch(task.id, {
        status: "blocked",
        unblockDescriptor: { owner: { agentId: f.keystone.id }, action: "Confirm the release with John." },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusOf(task.id)).toBe("blocked");
      const wakes = unblockWakesFor(f.keystone.id);
      expect(wakes).toHaveLength(1);
      expect((wakes[0] as unknown[])[1]).toMatchObject({
        payload: { issueId: task.id, action: "Confirm the release with John." },
      });
      expect(unblockWakesFor(f.flint.id)).toHaveLength(0);
    });

    it("puts the task in the owner user's inbox when the task is blocked", async () => {
      const f = await seedFixture();
      const task = await f.seedIssue("Release the build", { assigneeAgentId: f.flint.id });
      const res = await f.patch(task.id, {
        status: "blocked",
        unblockDescriptor: { owner: { userId: "board-user" }, action: "Approve the release." },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const feed = await attentionService(db).list(f.companyId, { userId: "board-user" });
      const item = feed.items.find(
        (candidate) => candidate.sourceKind === "blocker_attention" && candidate.subject.id === task.id,
      );
      expect(item, JSON.stringify(feed.items.map((candidate) => candidate.dedupKey))).toMatchObject({
        whyNow: "Approve the release.",
      });
    });
  });

  describe("blocks set before the guard", () => {
    it("shows a self-owned block with no wake path in the block check", async () => {
      const f = await seedFixture();
      const stranded = await f.seedIssue("Release the build", {
        assigneeAgentId: f.flint.id,
        status: "blocked",
        blockedTransitionAt: new Date("2026-11-25T06:20:00.000Z"),
        unblockDescriptor: {
          owner: { agentId: f.flint.id },
          action: "Waiting on Keystone to confirm with John.",
        },
      });
      const dated = await f.seedIssue("Chase the client", {
        assigneeAgentId: f.flint.id,
        status: "blocked",
        unblockDescriptor: {
          owner: { agentId: f.flint.id },
          action: "Chase the client.",
          expectedBy: "2099-01-01",
        },
      });
      const res = await f.blockCheck();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const items = (res.body.projects as { items: { kind: string; detail: string; issue: { id: string } }[] }[])
        .flatMap((project) => project.items);
      expect(items.find((item) => item.issue.id === stranded.id)).toMatchObject({
        kind: "unexplained",
        detail: "Blocked on its own assignee, and nothing will wake it: Waiting on Keystone to confirm with John.",
      });
      expect(items.some((item) => item.issue.id === dated.id)).toBe(false);
    });
  });
});
