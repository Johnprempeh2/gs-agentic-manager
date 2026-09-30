import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
  issueThreadInteractions,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { attentionService } from "../services/attention.ts";
import { issueService } from "../services/issues.ts";
import {
  bringBackTabledIssue,
  issueTablingService,
  returnDueTabledIssues,
} from "../services/issue-tabling.ts";
import { issueTablingRoutes } from "../routes/issue-tabling.ts";

// GRE-262 "Not now": a tabled task gets no wakes of any kind, its cards leave
// the Decisions feed, and it returns to its previous status on its return date
// or when a board user brings it back.

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Tabling test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue tabling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BOARD_USER = "board-user";

describeEmbeddedPostgres("issue tabling (Not now)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-tabling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    // Routes own their heartbeat instance, so wait on the table, not on one
    // instance's in-memory drain.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const active = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      if (active.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: { status?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Greatstone",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: BOARD_USER,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Put this off",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: BOARD_USER,
    });
    return { companyId, agentId, issueId };
  }

  function boardApp(companyId: string, actor: Record<string, unknown> = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: BOARD_USER,
        companyIds: [companyId],
        isInstanceAdmin: false,
        ...actor,
      };
      next();
    });
    app.use("/api", issueTablingRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function readIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  it("tables through the route: parks in backlog, records who and when, logs it, and lists it", async () => {
    const { companyId, issueId } = await seed();
    const app = boardApp(companyId);
    const returnAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    const res = await request(app).post(`/api/issues/${issueId}/table`).send({ returnAt }).expect(200);
    expect(res.body).toMatchObject({
      status: "backlog",
      tabledFromStatus: "in_progress",
      tabledByUserId: BOARD_USER,
    });
    expect(new Date(res.body.tabledUntil).toISOString()).toBe(returnAt);
    expect(res.body.tabledAt).toBeTruthy();

    const list = await request(app).get(`/api/companies/${companyId}/tabled-issues`).expect(200);
    expect(list.body.map((row: { id: string }) => row.id)).toEqual([issueId]);

    const logged = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.tabled")));
    expect(logged).toHaveLength(1);
    expect(logged[0]?.details).toMatchObject({ tabledFromStatus: "in_progress", retabled: false });

    // Tabling again only moves the date; the status to restore stays put.
    const again = await request(app).post(`/api/issues/${issueId}/table`).send({ returnAt: null }).expect(200);
    expect(again.body).toMatchObject({ status: "backlog", tabledFromStatus: "in_progress", tabledUntil: null });
  });

  it("rejects past return dates, finished tasks, and non-board actors", async () => {
    const { companyId, issueId } = await seed();
    const app = boardApp(companyId);
    await request(app).post(`/api/issues/${issueId}/table`)
      .send({ returnAt: new Date(Date.now() - 60_000).toISOString() }).expect(422);

    const done = await seed({ status: "done" });
    await request(boardApp(done.companyId)).post(`/api/issues/${done.issueId}/table`).send({}).expect(422);

    const agentApp = boardApp(companyId, { type: "agent", agentId: randomUUID(), companyId, userId: undefined });
    await request(agentApp).post(`/api/issues/${issueId}/table`).send({}).expect(403);
    expect((await readIssue(issueId)).tabledAt).toBeNull();
  });

  it("a tabled task gets no wakes of any kind", async () => {
    const { companyId, agentId, issueId } = await seed({ status: "todo" });
    await issueTablingService(db).table(issueId, { until: null, userId: BOARD_USER });

    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: BOARD_USER,
      body: "Any update?",
    });

    const wakes: Array<Parameters<typeof heartbeat.wakeup>[1]> = [
      // assignment
      { source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: { issueId } },
      // comment from the board, and a mention
      {
        source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId, commentId }, requestedByActorType: "user", requestedByActorId: BOARD_USER,
        contextSnapshot: { issueId, commentId, wakeCommentId: commentId, wakeReason: "issue_commented", source: "issue.comment" },
      },
      {
        source: "automation", triggerDetail: "system", reason: "issue_comment_mentioned",
        payload: { issueId, commentId }, requestedByActorType: "user", requestedByActorId: BOARD_USER,
        contextSnapshot: { issueId, commentId, wakeCommentId: commentId, source: "comment.mention" },
      },
      // routine dispatch
      { source: "assignment", triggerDetail: "system", reason: "routine_execution", payload: { issueId }, contextSnapshot: { issueId, source: "routine.dispatch" } },
      // heartbeat timer carrying the task
      { source: "timer", triggerDetail: "system", reason: "heartbeat_timer", payload: { issueId }, contextSnapshot: { issueId } },
      // recovery and liveness
      { source: "automation", triggerDetail: "system", reason: "issue_recovery_action_restored", payload: { issueId } },
      { source: "automation", triggerDetail: "system", reason: "stranded_assigned_issue", payload: { issueId } },
      { source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved", payload: { issueId } },
      { source: "automation", triggerDetail: "system", reason: "issue_children_completed", payload: { issueId } },
      // interaction continuation and a manual board wake
      { source: "automation", triggerDetail: "system", reason: "issue_interaction_resolved", payload: { issueId } },
      { source: "on_demand", triggerDetail: "manual", reason: "manual", payload: { issueId }, requestedByActorType: "user", requestedByActorId: BOARD_USER },
    ];
    for (const opts of wakes) {
      const run = await heartbeat.wakeup(agentId, opts);
      expect(run, `wake ${opts?.reason} should be dropped`).toBeNull();
    }

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    const skipped = await db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(skipped).toHaveLength(wakes.length);
    expect(skipped.every((row) => row.status === "skipped" && row.reason === "issue_tabled")).toBe(true);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("cancels runs queued outside the wake path (retries, recovery inserts) before they start", async () => {
    const { companyId, agentId, issueId } = await seed({ status: "todo" });
    await issueTablingService(db).table(issueId, { until: null, userId: BOARD_USER });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId, wakeReason: "transient_failure_retry" },
    });

    await heartbeat.resumeQueuedRuns();

    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
    expect(run.status).toBe("cancelled");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const logged = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, runId), eq(activityLog.action, "issue.tabled_run_cancelled")));
    expect(logged).toHaveLength(1);
  });

  it("tabling stops a run that is already queued on the task", async () => {
    const { companyId, agentId, issueId } = await seed({ status: "todo" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    const res = await request(boardApp(companyId)).post(`/api/issues/${issueId}/table`).send({}).expect(200);
    expect(res.body.status).toBe("backlog");
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
    expect(run.status).toBe("cancelled");
  });

  it("removes every card of a tabled task from the Decisions feed and its counts, and restores them on return", async () => {
    const { companyId, issueId } = await seed({ status: "in_review" });
    const other = randomUUID();
    await db.insert(issues).values({ id: other, companyId, title: "Still live", status: "todo", priority: "low" });
    const approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, companyId, type: "hire_agent", status: "pending", payload: { title: "Hire" } });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });
    await db.insert(issueThreadInteractions).values([
      {
        id: randomUUID(), companyId, issueId, kind: "ask_user_questions", status: "pending",
        continuationPolicy: "wake_assignee", title: "Pick a date", payload: { version: 1, questions: [] },
      },
      {
        id: randomUUID(), companyId, issueId: other, kind: "ask_user_questions", status: "pending",
        continuationPolicy: "wake_assignee", title: "Other question", payload: { version: 1, questions: [] },
      },
    ]);

    const feedIssueIds = (feed: Awaited<ReturnType<ReturnType<typeof attentionService>["list"]>>) =>
      feed.items.map((item) => item.relatedIssue?.id ?? (item.subject.metadata?.issueId as string | undefined) ?? null);

    const before = await attentionService(db).list(companyId, { userId: BOARD_USER });
    expect(feedIssueIds(before)).toContain(issueId);
    const beforeCount = before.totalCount;

    await issueTablingService(db).table(issueId, { until: null, userId: BOARD_USER });
    const during = await attentionService(db).list(companyId, { userId: BOARD_USER });
    expect(feedIssueIds(during)).not.toContain(issueId);
    expect(feedIssueIds(during)).toContain(other);
    expect(during.totalCount).toBe(during.items.length);
    expect(during.totalCount).toBeLessThan(beforeCount);
    expect(during.countsBySourceKind.approval).toBe(0);

    await issueTablingService(db).bringBack(issueId);
    const after = await attentionService(db).list(companyId, { userId: BOARD_USER });
    expect(after.totalCount).toBe(beforeCount);
  });

  it("returns on its return date (time-mocked), restores the previous status, logs it, and wakes the assignee once", async () => {
    const { issueId, agentId } = await seed({ status: "in_progress" });
    const t0 = new Date("2026-10-01T09:00:00.000Z");
    const returnAt = new Date("2026-10-03T09:00:00.000Z");
    await issueTablingService(db, { now: () => t0 }).table(issueId, { until: returnAt, userId: BOARD_USER });
    const wakeup = vi.fn(async () => null);

    const early = await returnDueTabledIssues(db, { heartbeat: { wakeup }, now: () => new Date("2026-10-02T09:00:00.000Z") });
    expect(early.returned).toBe(0);
    expect((await readIssue(issueId)).status).toBe("backlog");

    const due = await returnDueTabledIssues(db, { heartbeat: { wakeup }, now: () => new Date("2026-10-03T09:00:01.000Z") });
    expect(due.returned).toBe(1);
    const back = await readIssue(issueId);
    expect(back).toMatchObject({
      status: "in_progress",
      tabledAt: null,
      tabledUntil: null,
      tabledByUserId: null,
      tabledFromStatus: null,
    });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_untabled",
      payload: expect.objectContaining({ issueId }),
    }));
    const logged = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.untabled")));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actorType: "system" });
    expect(logged[0]?.details).toMatchObject({ reason: "return_date", restoredStatus: "in_progress" });

    // Idempotent: a second sweep does nothing.
    const again = await returnDueTabledIssues(db, { heartbeat: { wakeup }, now: () => new Date("2026-10-04T09:00:00.000Z") });
    expect(again).toEqual({ due: 0, returned: 0 });
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("comes back at once on bring back, restores the previous status, and logs it", async () => {
    const { companyId, issueId, agentId } = await seed({ status: "todo" });
    const app = boardApp(companyId);
    await request(app).post(`/api/issues/${issueId}/table`)
      .send({ returnAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(200);

    const res = await request(app).post(`/api/issues/${issueId}/bring-back`).send({}).expect(200);
    expect(res.body).toMatchObject({ status: "todo", tabledAt: null, tabledFromStatus: null });

    const logged = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.untabled")));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actorType: "user", actorId: BOARD_USER });
    expect(logged[0]?.details).toMatchObject({ reason: "manual", restoredStatus: "todo" });

    // The assignee gets one fresh wake now that the task is live again.
    const untabledWake = await db.select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`));
    expect(untabledWake.map((row) => row.reason)).toContain("issue_untabled");

    await request(app).post(`/api/issues/${issueId}/bring-back`).send({}).expect(409);
    const list = await request(app).get(`/api/companies/${companyId}/tabled-issues`).expect(200);
    expect(list.body).toEqual([]);
  });

  it("bring back and the return-date sweep racing restore the task exactly once", async () => {
    const { issueId } = await seed({ status: "blocked" });
    const t0 = new Date("2026-10-01T09:00:00.000Z");
    await issueTablingService(db, { now: () => t0 }).table(issueId, { until: new Date("2026-10-01T10:00:00.000Z"), userId: BOARD_USER });
    const wakeup = vi.fn(async () => null);
    const later = () => new Date("2026-10-01T11:00:00.000Z");
    const results = await Promise.all([
      bringBackTabledIssue(db, { heartbeat: { wakeup }, now: later }, issueId, { reason: "manual", actorType: "user", actorId: BOARD_USER }),
      returnDueTabledIssues(db, { heartbeat: { wakeup }, now: later }),
    ]);
    const restoredCount = (results[0] ? 1 : 0) + results[1].returned;
    expect(restoredCount).toBe(1);
    expect((await readIssue(issueId)).status).toBe("blocked");
    // Blocked work waits on its blockers; no assignee wake on return.
    expect(wakeup).not.toHaveBeenCalled();
    const logged = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.untabled")));
    expect(logged).toHaveLength(1);
  });

  it("moving a tabled task to another status by hand clears the tabled state", async () => {
    const { issueId } = await seed({ status: "in_progress" });
    await issueTablingService(db).table(issueId, { until: null, userId: BOARD_USER });
    await issueService(db).update(issueId, { status: "todo" });
    expect(await readIssue(issueId)).toMatchObject({ status: "todo", tabledAt: null, tabledFromStatus: null });
  });
});
