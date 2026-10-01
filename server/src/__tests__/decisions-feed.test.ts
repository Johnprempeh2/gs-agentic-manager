import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  toolApplications,
  toolConnections,
} from "@greatstone/db";
import type { DecisionCard, DecisionCardAction, DecisionsFeed } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Wakes are recorded, never executed: no adapter process starts in this test.
const wakeup = vi.hoisted(() => vi.fn(async () => ({ id: "wake-1" })));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup,
    }),
  };
});

const { errorHandler } = await import("../middleware/index.js");
const { issueRoutes } = await import("../routes/issues.js");
const { inboxDismissalRoutes } = await import("../routes/inbox-dismissals.js");
const { decisionsFeedRoutes } = await import("../routes/decisions-feed.js");
const { sidebarBadgeRoutes } = await import("../routes/sidebar-badges.js");
const { decisionsFeedService } = await import("../services/decisions-feed.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decisions feed tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const USER_ID = "board-user";
const HOUR = 60 * 60 * 1000;
const RECONNECT = "Reconnect the selected AI account or choose an available connection, then continue the task.";

describeEmbeddedPostgres("one Decisions feed (GRE-263)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decisions-feed-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    wakeup.mockClear();
    await db.delete(inboxDismissals);
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(activityLog);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * The live board on 29 Sep: the Anthropic login failed, the board
   * reconnected it, and the old cards stayed. GRE-138 is blocked with a
   * connection request and a recovery; GRE-241 only asked to connect.
   */
  async function seedLiveScenario(input: { withQuestion?: boolean } = {}) {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const peerId = randomUUID();
    const failedAt = new Date(Date.now() - 3 * HOUR);
    await db.insert(companies).values({ id: companyId, name: "GRE Co", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([workerId, peerId].map((id) => ({
      id,
      companyId,
      name: id === workerId ? "Worker" : "Peer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { aiConnection: { provider: "anthropic" } },
      permissions: {},
    })));
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: USER_ID, status: "active", membershipRole: "owner",
    });
    const gre138 = randomUUID();
    const gre241 = randomUUID();
    await db.insert(issues).values([
      { id: gre138, companyId, identifier: "GRE-138", issueNumber: 138, title: "Cost ledger", status: "blocked", priority: "high", assigneeAgentId: workerId },
      { id: gre241, companyId, identifier: "GRE-241", issueNumber: 241, title: "Fetch main", status: "in_progress", priority: "medium", assigneeAgentId: workerId },
    ]);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      invocationSource: "assignment",
      status: "failed",
      errorCode: "configuration_incomplete",
      error: "No usable AI connection for this agent.",
      resultJson: { configurationIncomplete: { reason: "ai_connection_unavailable" } },
      contextSnapshot: { issueId: gre138 },
      createdAt: failedAt,
      finishedAt: failedAt,
    });
    const recoveryId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: recoveryId,
      companyId,
      sourceIssueId: gre138,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "board",
      previousOwnerAgentId: workerId,
      returnOwnerAgentId: workerId,
      cause: "configuration_incomplete",
      fingerprint: `stranded:${gre138}:ai`,
      evidence: { latestRunId: runId, failureSummary: "The run stopped: no usable AI connection for this agent." },
      nextAction: RECONNECT,
      createdAt: failedAt,
      updatedAt: failedAt,
    });
    const intent = (issueId: string) => ({
      companyId,
      issueId,
      kind: "connection_intent",
      status: "pending",
      title: "Connect Anthropic",
      addresseeUserId: USER_ID,
      createdByAgentId: workerId,
      payload: {
        version: 1, purpose: "ai", serviceSlug: "anthropic", serviceName: "Anthropic",
        requestingAgentId: workerId, requestingAgentName: "Worker", phase: "requested",
      },
      createdAt: failedAt,
      updatedAt: failedAt,
    });
    await db.insert(issueThreadInteractions).values([intent(gre138), intent(gre241)]);
    if (input.withQuestion) {
      await db.insert(issueThreadInteractions).values({
        companyId,
        issueId: gre138,
        kind: "ask_user_questions",
        status: "pending",
        title: "Which month should the ledger export first?",
        createdByAgentId: workerId,
        payload: { version: 1, questions: [{ id: "month", prompt: "Which month?", selectionMode: "single", options: [{ id: "sep", label: "September" }] }] },
      });
    }
    const [app] = await db.insert(toolApplications).values({ companyId, name: "Claude", type: "mcp_http" }).returning();
    const connectionId = randomUUID();
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId: app!.id,
      name: "Company Claude",
      uid: `ai-${connectionId}`,
      connectionPurpose: "ai",
      transport: "runtime_auth",
      status: "active",
      enabled: true,
      healthStatus: "error",
      healthMessage: "The provider rejected this account's login during a run.",
      config: { ai: { provider: "anthropic", method: "subscription" }, aiCredential: { source: "imported_login", expiresAt: null, recordedAt: failedAt.toISOString() } },
      updatedAt: failedAt,
    });
    await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization" });
    return { companyId, workerId, peerId, gre138, gre241, runId, recoveryId, connectionId, failedAt };
  }

  async function reconnect(connectionId: string, at: Date) {
    await db.update(toolConnections).set({ healthStatus: "ok", healthMessage: null, updatedAt: at, healthCheckedAt: at })
      .where(eq(toolConnections.id, connectionId));
  }

  function build(companyId: string) {
    return decisionsFeedService(db).build(companyId, { userId: USER_ID });
  }

  function cardFor(feed: DecisionsFeed, issueId: string) {
    return feed.cards.find((card) => card.task?.id === issueId) ?? null;
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
    testApp.use("/api", inboxDismissalRoutes(db));
    testApp.use("/api", sidebarBadgeRoutes(db));
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  function action(card: DecisionCard | null, id: DecisionCardAction["id"]) {
    const found = card?.actions.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`card ${card?.id} has no ${id} action: ${card?.actions.map((a) => a.id).join(",")}`);
    return found;
  }

  async function run(testApp: express.Express, found: DecisionCardAction, value?: string) {
    const responses = [];
    for (const call of found.requests) {
      const body = found.input && value !== undefined ? { ...call.body, [found.input.field]: value } : call.body;
      const agent = request(testApp);
      const response = call.method === "PATCH" ? await agent.patch(call.path).send(body) : await agent.post(call.path).send(body);
      expect(response.status, `${call.method} ${call.path}: ${JSON.stringify(response.body)}`).toBeLessThan(300);
      responses.push(response);
    }
    return responses;
  }

  it("merges a task's question, connection request and recovery into one card, and counts cards once", async () => {
    const seeded = await seedLiveScenario({ withQuestion: true });

    const feed = await build(seeded.companyId);

    const gre138 = feed.cards.filter((card) => card.task?.id === seeded.gre138);
    expect(gre138).toHaveLength(1);
    expect(gre138[0]).toMatchObject({
      id: `task:${seeded.gre138}`,
      kind: "question",
      title: "GRE-138 Cost ledger",
      reason: "Which month should the ledger export first?",
      waiting: { id: seeded.workerId, name: "Worker" },
    });
    expect(gre138[0]!.kinds).toEqual(["question", "connection", "recovery"]);
    expect(gre138[0]!.items).toHaveLength(3);
    expect(cardFor(feed, seeded.gre241)).toMatchObject({ kind: "connection", title: "GRE-241 Fetch main" });
    // The broken connection itself is one company-level card.
    expect(feed.cards.filter((card) => card.task === null).map((card) => card.kind)).toEqual(["connection"]);

    // One count, from the same build, for the badge, the list header and Focus.
    expect(feed.count).toBe(3);
    expect(feed.count).toBe(feed.cards.length);
    const countResponse = await request(app(seeded.companyId)).get(`/api/companies/${seeded.companyId}/decisions-feed/count`).expect(200);
    const feedResponse = await request(app(seeded.companyId)).get(`/api/companies/${seeded.companyId}/decisions-feed`).expect(200);
    expect(countResponse.body.count).toBe(3);
    const badgeResponse = await request(app(seeded.companyId)).get(`/api/companies/${seeded.companyId}/sidebar-badges`).expect(200);
    expect(badgeResponse.body.decisions).toBe(3);
    expect(feedResponse.body.count).toBe(feedResponse.body.cards.length);
    expect(feed.countsByKind).toMatchObject({ question: 1, connection: 2 });
  });

  it("clears connection cards once the connection is healthy, and keeps one retry card for the task it left blocked", async () => {
    const seeded = await seedLiveScenario();
    const before = await build(seeded.companyId);
    // GRE-138, GRE-241 and the company-level alert: three connection-led cards.
    expect(before.cards.map((card) => card.kind)).toEqual(["connection", "connection", "connection"]);
    expect(before.count).toBe(3);
    expect(cardFor(before, seeded.gre138)!.kinds).toEqual(["connection", "recovery"]);

    await reconnect(seeded.connectionId, new Date(seeded.failedAt.getTime() + HOUR));
    const after = await build(seeded.companyId);

    // GRE-241 only asked to connect and is still running: its card is gone.
    expect(cardFor(after, seeded.gre241)).toBeNull();
    // No company-level connection alert is left.
    expect(after.cards.filter((card) => card.task === null)).toEqual([]);
    // GRE-138 is still blocked, so it keeps exactly one card that says so and offers a retry.
    expect(after.cards).toHaveLength(1);
    expect(after.count).toBe(1);
    const card = cardFor(after, seeded.gre138)!;
    expect(card).toMatchObject({ kind: "recovery", kinds: ["recovery"], items: [] });
    expect(card.reason).toContain("The AI connection works again");
    expect(card.reason).not.toContain("Reconnect");
    expect(action(card, "retry").requests).toEqual([{
      method: "POST",
      path: `/api/issues/${seeded.gre138}/recovery-actions/resolve`,
      body: expect.objectContaining({ actionId: seeded.recoveryId, outcome: "restored", sourceIssueStatus: "todo" }),
    }]);
    // Two connection requests and the recovery (cause fixed), plus GRE-138's
    // blocker row, which blocks no other task.
    expect(after.staleCleared).toBe(4);
  });

  it("keeps the cards when the connection was saved before the failure", async () => {
    const seeded = await seedLiveScenario();
    await reconnect(seeded.connectionId, new Date(seeded.failedAt.getTime() - HOUR));

    const feed = await build(seeded.companyId);

    expect(cardFor(feed, seeded.gre138)!.kinds).toEqual(["connection", "recovery"]);
    expect(cardFor(feed, seeded.gre241)).not.toBeNull();
  });

  it("drops the recovery and connection rows of a task that is done", async () => {
    const seeded = await seedLiveScenario();
    await reconnect(seeded.connectionId, new Date(seeded.failedAt.getTime() - HOUR));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.gre138));

    const feed = await build(seeded.companyId);

    expect(cardFor(feed, seeded.gre138)).toBeNull();
  });

  it("gives a stalled blocker real actions: reassign, instruct, cancel", async () => {
    const seeded = await seedLiveScenario();
    await reconnect(seeded.connectionId, new Date(seeded.failedAt.getTime() + HOUR));
    const blocker = randomUUID();
    const blocked = randomUUID();
    await db.insert(issues).values([
      { id: blocker, companyId: seeded.companyId, identifier: "GRE-158", issueNumber: 158, title: "Pick a ledger owner", status: "todo", priority: "high" },
      { id: blocked, companyId: seeded.companyId, identifier: "GRE-159", issueNumber: 159, title: "Ledger export", status: "blocked", priority: "high", assigneeAgentId: seeded.workerId },
    ]);
    await db.insert(issueRelations).values({ companyId: seeded.companyId, issueId: blocker, relatedIssueId: blocked, type: "blocks" });

    const card = cardFor(await build(seeded.companyId), blocker)!;

    expect(card).toMatchObject({ kind: "blocked", title: "GRE-158 Pick a ledger owner", waiting: { name: "Worker" } });
    expect(card.reason).toContain("blocks 1 task");
    expect(card.nextStep).toContain("1 blocked task waits");
    expect(card.actions.map((candidate) => candidate.id)).toEqual(expect.arrayContaining(["reassign", "instruct", "cancel_task"]));
    expect(action(card, "cancel_task").description).toContain("The task waiting on it stops waiting");

    // Cancel works on a task that blocks another: the waiting task stops waiting on it.
    await run(app(seeded.companyId), action(card, "cancel_task"));
    const [cancelled] = await db.select().from(issues).where(eq(issues.id, blocker));
    expect(cancelled?.status).toBe("cancelled");
    const relations = await db.select().from(issueRelations).where(eq(issueRelations.issueId, blocker));
    expect(relations).toEqual([]);
    expect(cardFor(await build(seeded.companyId), blocker)).toBeNull();
  });

  it("keeps Retry on a merged card when the fixed connection left the task blocked", async () => {
    const seeded = await seedLiveScenario({ withQuestion: true });
    // GRE-139 waits on GRE-138, so GRE-138 also carries a blocked row.
    const waiting = randomUUID();
    await db.insert(issues).values({
      id: waiting, companyId: seeded.companyId, identifier: "GRE-139", issueNumber: 139, title: "Ledger export", status: "blocked", priority: "high", assigneeAgentId: seeded.peerId,
    });
    await db.insert(issueRelations).values({ companyId: seeded.companyId, issueId: seeded.gre138, relatedIssueId: waiting, type: "blocks" });
    await reconnect(seeded.connectionId, new Date(seeded.failedAt.getTime() + HOUR));

    const card = cardFor(await build(seeded.companyId), seeded.gre138)!;

    // The question and the blocker keep the card; the connection and recovery rows are gone.
    expect(card.kinds).toEqual(["question", "blocked"]);
    expect(action(card, "retry").requests).toEqual([{
      method: "POST",
      path: `/api/issues/${seeded.gre138}/recovery-actions/resolve`,
      body: expect.objectContaining({ actionId: seeded.recoveryId, outcome: "restored", sourceIssueStatus: "todo" }),
    }]);

    await run(app(seeded.companyId), action(card, "retry"));
    const [retried] = await db.select().from(issues).where(eq(issues.id, seeded.gre138));
    expect(retried?.status).toBe("todo");
  });

  it("runs each action against the real endpoints", async () => {
    const seeded = await seedLiveScenario();
    const testApp = app(seeded.companyId);
    const feed = await build(seeded.companyId);
    expect(feed.assignableAgents.map((agent) => agent.name)).toEqual(["Peer", "Worker"]);

    // Give an instruction: a comment on the task that wakes the owner.
    await run(testApp, action(cardFor(feed, seeded.gre241), "instruct"), "Use the main branch.");
    const [instruction] = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.gre241));
    expect(instruction?.body).toBe("Use the main branch.");

    // Reassign to a named agent.
    await run(testApp, action(cardFor(feed, seeded.gre241), "reassign"), seeded.peerId);
    const [reassigned] = await db.select().from(issues).where(eq(issues.id, seeded.gre241));
    expect(reassigned?.assigneeAgentId).toBe(seeded.peerId);

    // Retry: the recovery closes and the task goes back to its owner.
    await run(testApp, action(cardFor(feed, seeded.gre138), "retry"));
    const [retried] = await db.select().from(issues).where(eq(issues.id, seeded.gre138));
    const [recovery] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.recoveryId));
    expect(retried?.status).toBe("todo");
    expect(recovery?.status).toBe("resolved");
    expect(cardFor(await build(seeded.companyId), seeded.gre138)?.kinds ?? []).not.toContain("recovery");

    // Dismiss the company-level connection alert.
    const alert = feed.cards.find((card) => card.task === null)!;
    await run(testApp, action(alert, "dismiss"));
    expect((await build(seeded.companyId)).cards.find((card) => card.id === alert.id)).toBeUndefined();

    // Cancel the task.
    await run(testApp, action(cardFor(feed, seeded.gre241), "cancel_task"));
    const [cancelled] = await db.select().from(issues).where(eq(issues.id, seeded.gre241));
    expect(cancelled?.status).toBe("cancelled");
    expect(cardFor(await build(seeded.companyId), seeded.gre241)).toBeNull();
  });

  it("marks a recovery resolved and sends the task where the board chooses", async () => {
    const seeded = await seedLiveScenario();
    const testApp = app(seeded.companyId);
    const card = cardFor(await build(seeded.companyId), seeded.gre138);

    const resolve = action(card, "resolve");
    expect(resolve.input?.options?.map((option) => option.value)).toEqual(["done", "in_review", "todo"]);
    await run(testApp, resolve, "in_review");

    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.gre138));
    const [recovery] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, seeded.recoveryId));
    expect(issue?.status).toBe("in_review");
    expect(recovery?.status).toBe("resolved");
  });

  it("asks the owning agent for clarity, wakes it, and links its answer back to the same card", async () => {
    const seeded = await seedLiveScenario();
    const testApp = app(seeded.companyId);
    const card = cardFor(await build(seeded.companyId), seeded.gre138)!;
    const ask = action(card, "ask_clarity");
    const clientRequestId = randomUUID();

    const [response] = await run(testApp, {
      ...ask,
      requests: ask.requests.map((call) => ({ ...call, body: { ...call.body, clientRequestId } })),
    }, "Why does the ledger need a new table?");

    expect(response!.status).toBe(201);
    expect(response!.body).toMatchObject({ cardId: card.id, issueId: seeded.gre138, agentId: seeded.workerId, woken: true });
    expect(wakeup).toHaveBeenCalledWith(seeded.workerId, expect.objectContaining({
      reason: "issue_commented",
      contextSnapshot: expect.objectContaining({ issueId: seeded.gre138, wakeCommentId: response!.body.commentId }),
    }));
    const [question] = await db.select().from(issueComments).where(eq(issueComments.id, response!.body.commentId));
    expect(question?.body).toContain("Why does the ledger need a new table?");

    // A repeated click is the same question, not a second one.
    const repeat = await request(testApp).post(ask.requests[0]!.path)
      .send({ question: "Why does the ledger need a new table?", clientRequestId }).expect(200);
    expect(repeat.body.commentId).toBe(response!.body.commentId);
    expect(wakeup).toHaveBeenCalledTimes(1);

    const waiting = cardFor(await build(seeded.companyId), seeded.gre138)!;
    expect(waiting.id).toBe(card.id);
    expect(waiting.clarity).toMatchObject({ question: "Why does the ledger need a new table?", agent: { name: "Worker" }, answer: null });
    expect(waiting.nextStep).toMatch(/^Waiting for Worker to answer your question\./);

    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.gre138,
      authorAgentId: seeded.workerId,
      authorType: "agent",
      body: "Costs need one row per client per month.",
      createdAt: new Date(Date.now() + 1000),
    });
    const answered = cardFor(await build(seeded.companyId), seeded.gre138)!;
    expect(answered.clarity?.answer?.body).toBe("Costs need one row per client per month.");
    expect(answered.nextStep).not.toMatch(/^Waiting for/);
  });

  // GRE-316: Mica had no GitHub access, and each of three tasks sent its own card.
  it("shows one card when three tasks of one agent wait for the same missing connection", async () => {
    const companyId = randomUUID();
    const micaId = randomUUID();
    const otherId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "GRE Co", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([micaId, otherId].map((id) => ({
      id, companyId, name: id === micaId ? "Mica" : "Other", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    })));
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: USER_ID, status: "active", membershipRole: "owner" });
    const tasks = [303, 304, 305].map((number) => ({ id: randomUUID(), number }));
    const otherTask = randomUUID();
    await db.insert(issues).values([
      ...tasks.map(({ id, number }) => ({ id, companyId, identifier: `GRE-${number}`, issueNumber: number, title: `Task ${number}`, status: "in_review", priority: "medium", assigneeAgentId: micaId })),
      { id: otherTask, companyId, identifier: "GRE-306", issueNumber: 306, title: "Task 306", status: "in_progress", priority: "medium", assigneeAgentId: otherId },
    ]);
    const intent = (issueId: string, agentId: string) => ({
      companyId, issueId, kind: "connection_intent", status: "pending", title: "Connect GitHub",
      addresseeUserId: USER_ID, createdByAgentId: agentId,
      payload: { version: 1, serviceSlug: "github", serviceName: "GitHub", requestingAgentId: agentId, requestingAgentName: "Agent", phase: "requested" },
    });
    await db.insert(issueThreadInteractions).values([...tasks.map(({ id }) => intent(id, micaId)), intent(otherTask, otherId)]);
    // A question on one of the tasks stays on that task's own card.
    await db.insert(issueThreadInteractions).values({
      companyId, issueId: tasks[0]!.id, kind: "ask_user_questions", status: "pending", title: "Which branch?", createdByAgentId: micaId,
      payload: { version: 1, questions: [{ id: "branch", prompt: "Which branch?", selectionMode: "single", options: [{ id: "main", label: "main" }] }] },
    });

    const feed = await build(companyId);

    const shared = feed.cards.filter((card) => card.id.startsWith("connection:"));
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      id: `connection:${micaId}:github:`,
      kind: "connection",
      task: null,
      title: "Mica needs GitHub for 3 tasks",
      reason: "3 tasks wait for the same GitHub connection: GRE-303, GRE-304, GRE-305. One answer covers all of them.",
      waiting: { id: micaId, name: "Mica" },
    });
    expect(shared[0]!.items).toHaveLength(3);
    expect(action(shared[0]!, "reconnect")).toMatchObject({ type: "link", label: "Connect" });
    // No task card repeats the connection request.
    for (const { id } of tasks) {
      expect(cardFor(feed, id)?.kinds ?? []).not.toContain("connection");
    }
    expect(cardFor(feed, tasks[0]!.id)).toMatchObject({ kind: "question", kinds: ["question"] });
    // Another agent's single request keeps its own task card.
    expect(cardFor(feed, otherTask)).toMatchObject({ kind: "connection" });
    expect(feed.count).toBe(3);
    expect(feed.countsByKind).toMatchObject({ connection: 2, question: 1 });
  });

  it("refuses clarity on a card that is gone, and refuses agent callers", async () => {
    const seeded = await seedLiveScenario();
    await request(app(seeded.companyId))
      .post(`/api/companies/${seeded.companyId}/decisions-feed/cards/${encodeURIComponent(`task:${randomUUID()}`)}/clarity`)
      .send({ question: "Anything?" })
      .expect(404);
    await request(app(seeded.companyId, { type: "agent", source: "agent_key", companyId: seeded.companyId, agentId: seeded.workerId }))
      .get(`/api/companies/${seeded.companyId}/decisions-feed`)
      .expect(403);
    expect(wakeup).not.toHaveBeenCalled();
  });
});
