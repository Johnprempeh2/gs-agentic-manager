import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  decisions,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  issueComments,
  issueExecutionDecisions,
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
const { decisionsFeedService, taskIdOf } = await import("../services/decisions-feed.js");
const { resolveReviewEscalationUserId } = await import("../services/review-escalation-user.js");

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
    await db.delete(decisions);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
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

  it("shows an internet outage as one dismissable notice card (GRE-999)", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "GRE Co", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false });
    const dir = mkdtempSync(join(tmpdir(), "feed-outage-"));
    const connectivityStateFile = join(dir, "outages.json");
    writeFileSync(connectivityStateFile, JSON.stringify({
      offlineSince: null,
      lastCheckAt: null,
      outages: [{ id: "outage-1", startedAt: "2026-10-07T13:02:00.000Z", endedAt: "2026-10-07T14:05:00.000Z", endIsApproximate: false, checks: [] }],
    }));
    try {
      const feedNow = () => decisionsFeedService(db, { connectivityStateFile, now: () => Date.parse("2026-10-07T14:06:00.000Z") })
        .build(companyId, { userId: USER_ID });
      const feed = await feedNow();
      expect(feed.cards).toHaveLength(1);
      const [card] = feed.cards;
      expect(card).toMatchObject({
        kind: "outage",
        title: "GSAM was offline from 14:02 to 15:05",
        reason: "GSAM was offline from 14:02 to 15:05, 1 h 3 min, London time. Agent runs in that time: 0 failed, 0 retried.",
      });
      await run(app(companyId), action(card!, "dismiss"));
      expect((await feedNow()).cards).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  /** X is blocked by Y; Y has no owner, so nothing moves without the board. */
  async function seedBlockedPair() {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "GRE Co", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: workerId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: USER_ID, status: "active", membershipRole: "owner",
    });
    const blocker = randomUUID();
    const blocked = randomUUID();
    await db.insert(issues).values([
      { id: blocker, companyId, identifier: "GRE-158", issueNumber: 158, title: "Pick a ledger owner", status: "todo", priority: "high" },
      { id: blocked, companyId, identifier: "GRE-159", issueNumber: 159, title: "Ledger export", status: "blocked", priority: "high", assigneeAgentId: workerId },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blocker, relatedIssueId: blocked, type: "blocks" });
    return { companyId, workerId, blocker, blocked };
  }

  async function addOpenDecision(seeded: { companyId: string; workerId: string }, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: seeded.companyId, agentId: seeded.workerId, status: "succeeded", contextSnapshot: { issueId } });
    const decisionId = randomUUID();
    await db.insert(decisions).values({
      id: decisionId,
      companyId: seeded.companyId,
      originAgentId: seeded.workerId,
      originIssueId: issueId,
      originRunId: runId,
      title: "Which ledger format?",
      body: "CSV or JSON.",
      options: [],
      status: "open",
      expiresAt: new Date(Date.now() + 24 * HOUR),
      signedSpec: "test",
      targetSnapshots: {},
    });
    return decisionId;
  }

  async function expectBadge(companyId: string, count: number) {
    const testApp = app(companyId);
    expect((await request(testApp).get(`/api/companies/${companyId}/decisions-feed/count`).expect(200)).body.count).toBe(count);
    expect((await request(testApp).get(`/api/companies/${companyId}/sidebar-badges`).expect(200)).body.decisions).toBe(count);
  }

  it("shows one card for a blocked task with its own question and a stalled blocker (GRE-431)", async () => {
    const seeded = await seedBlockedPair();
    await db.insert(issueThreadInteractions).values({
      companyId: seeded.companyId,
      issueId: seeded.blocked,
      kind: "ask_user_questions",
      status: "pending",
      title: "Which month should the ledger export first?",
      createdByAgentId: seeded.workerId,
      payload: { version: 1, questions: [{ id: "month", prompt: "Which month?", selectionMode: "single", options: [{ id: "sep", label: "September" }] }] },
    });

    const feed = await build(seeded.companyId);

    // Both rows are about GRE-159: its question, and the blocker it waits on.
    expect(feed.cards).toHaveLength(1);
    expect(feed.count).toBe(1);
    const card = feed.cards[0]!;
    expect(card).toMatchObject({ id: `task:${seeded.blocked}`, kind: "question", kinds: ["question", "blocked"], title: "GRE-159 Ledger export" });
    expect(card.items.map((item) => item.sourceKind).sort()).toEqual(["blocker_attention", "issue_thread_interaction"]);
    expect(card.nextStep).toContain("blocked by GRE-158");
    expect(card.actions.map((candidate) => candidate.id)).toEqual(expect.arrayContaining(["reassign_blocker", "instruct_blocker", "reassign", "instruct", "cancel_task"]));
    // The blocker's actions act on the blocker; the task's own act on the task.
    expect(action(card, "reassign_blocker").requests[0]!.path).toBe(`/api/issues/${seeded.blocker}`);
    expect(action(card, "instruct_blocker").requests[0]!.path).toBe(`/api/issues/${seeded.blocker}/comments`);
    expect(action(card, "reassign").requests[0]!.path).toBe(`/api/issues/${seeded.blocked}`);
    await expectBadge(seeded.companyId, 1);

    await run(app(seeded.companyId), action(card, "reassign_blocker"), seeded.workerId);
    const [reassigned] = await db.select().from(issues).where(eq(issues.id, seeded.blocker));
    expect(reassigned?.assigneeAgentId).toBe(seeded.workerId);
  });

  it("keeps a stalled blocker on its own card when the blocked task has nothing else", async () => {
    const seeded = await seedBlockedPair();

    const feed = await build(seeded.companyId);

    expect(feed.cards.map((card) => card.id)).toEqual([`task:${seeded.blocker}`]);
    expect(feed.cards[0]!.actions.map((candidate) => candidate.id)).not.toContain("reassign_blocker");
  });

  it("groups a decision row into its origin issue's card, even without a related issue (GRE-431)", async () => {
    const seeded = await seedBlockedPair();
    await addOpenDecision(seeded, seeded.blocked);

    const feed = await build(seeded.companyId);

    expect(feed.cards).toHaveLength(1);
    expect(feed.cards[0]).toMatchObject({ id: `task:${seeded.blocked}`, kinds: ["blocked", "decision"] });
    const decisionRow = feed.cards[0]!.items.find((item) => item.sourceKind === "decision")!;
    expect(taskIdOf({ ...decisionRow, relatedIssue: null })).toBe(seeded.blocked);
  });

  it("shows one card for a blocker that waits on an open decision, with no extra blocker card (GRE-431)", async () => {
    const seeded = await seedBlockedPair();
    await addOpenDecision(seeded, seeded.blocker);

    const feed = await build(seeded.companyId);

    // The open decision is a live wait on the board, so GRE-158 is not a stalled blocker.
    expect(feed.cards).toHaveLength(1);
    expect(feed.cards[0]).toMatchObject({ id: `task:${seeded.blocker}`, kind: "decision", kinds: ["decision"] });
    await expectBadge(seeded.companyId, 1);
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

  // GRE-320: the card sent every instruction as a resume, and the comment route
  // refuses resume for in_review and backlog with a 409.
  it.each(["in_review", "backlog"] as const)("posts an instruction on a %s task and wakes its owner without moving it", async (status) => {
    const seeded = await seedLiveScenario();
    await db.update(issues).set({ status }).where(eq(issues.id, seeded.gre241));
    const testApp = app(seeded.companyId);
    const instruct = action(cardFor(await build(seeded.companyId), seeded.gre241), "instruct");

    const [response] = await run(testApp, instruct, "Use the main branch.");

    expect(response!.status).toBe(201);
    const [instruction] = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.gre241));
    expect(instruction?.body).toBe("Use the main branch.");
    // The comment route sends its wakes after it responds.
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledWith(seeded.workerId, expect.objectContaining({
      reason: "issue_commented",
      contextSnapshot: expect.objectContaining({ issueId: seeded.gre241, wakeCommentId: instruction!.id }),
    })));
    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.gre241));
    expect(task?.status).toBe(status);
  });

  it.each(["todo", "in_progress", "blocked"] as const)("keeps the instruction a resume on a %s task", async (status) => {
    const seeded = await seedLiveScenario();
    await db.update(issues).set({ status }).where(eq(issues.id, seeded.gre241));
    const instruct = action(cardFor(await build(seeded.companyId), seeded.gre241), "instruct");
    expect(instruct.requests).toEqual([expect.objectContaining({ method: "POST", body: { resume: true } })]);
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

  // GRE-450: asks that need John at the computer stay off the phone count.
  it("keeps 'at your desk' cards apart: out of the count, with the command and a Done that wakes the agent", async () => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "GRE Co", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: workerId, companyId, name: "Ridge", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: USER_ID, status: "active", membershipRole: "owner",
    });
    const deskTask = randomUUID();
    const phoneTask = randomUUID();
    await db.insert(issues).values([
      { id: deskTask, companyId, identifier: "GRE-407", issueNumber: 407, title: "Restart WSL", status: "in_review", priority: "high", assigneeAgentId: workerId },
      { id: phoneTask, companyId, identifier: "GRE-408", issueNumber: 408, title: "Pick a name", status: "in_review", priority: "medium", assigneeAgentId: workerId },
    ]);
    const testApp = app(companyId);

    // The field rides on request_confirmation; "none" becomes a wake so Done reaches the agent.
    const created = await request(testApp)
      .post(`/api/issues/${deskTask}/interactions`)
      .send({
        kind: "request_confirmation",
        continuationPolicy: "none",
        payload: { version: 1, prompt: "Restart WSL on the host, then press Done.", atDesk: { command: "wsl --shutdown" } },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ continuationPolicy: "wake_assignee", payload: { atDesk: { command: "wsl --shutdown" } } });
    // And on ask_user_questions.
    await request(testApp)
      .post(`/api/issues/${deskTask}/interactions`)
      .send({
        kind: "ask_user_questions",
        payload: {
          version: 1,
          atDesk: {},
          questions: [{ id: "wsl", prompt: "Did WSL come back?", selectionMode: "single", options: [{ id: "yes", label: "Yes" }] }],
        },
      })
      .expect(201);
    await request(testApp)
      .post(`/api/issues/${phoneTask}/interactions`)
      .send({ kind: "request_confirmation", payload: { version: 1, prompt: "Use the name Atlas?" } })
      .expect(201);

    const feed = await build(companyId);
    expect(feed.cards).toHaveLength(2);
    expect(cardFor(feed, phoneTask)?.atDesk).toBeNull();
    const desk = cardFor(feed, deskTask)!;
    expect(desk.atDesk).toEqual({ command: "wsl --shutdown" });
    // Only the phone card counts: badge, needs-me and the count route agree.
    expect(feed).toMatchObject({ count: 1, atDeskCount: 1 });
    const badge = await request(testApp).get(`/api/companies/${companyId}/sidebar-badges`).expect(200);
    expect(badge.body.decisions).toBe(1);
    const needsMe = await request(testApp).get(`/api/companies/${companyId}/needs-me`).expect(200);
    expect(needsMe.body.count).toBe(1);
    const count = await request(testApp).get(`/api/companies/${companyId}/decisions-feed/count`).expect(200);
    expect(count.body.count).toBe(1);

    // Done accepts the confirmation and wakes the agent to check.
    await run(testApp, action(desk, "done"));
    const [accepted] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, created.body.id));
    expect(accepted?.status).toBe("accepted");
    await vi.waitFor(() => expect(wakeup).toHaveBeenCalledWith(workerId, expect.anything()));
  });

  it("keeps a card on the phone when an at-desk ask shares it with phone work", async () => {
    const seeded = await seedLiveScenario();
    await db.insert(issueThreadInteractions).values({
      companyId: seeded.companyId,
      issueId: seeded.gre138,
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: seeded.workerId,
      payload: { version: 1, prompt: "Save the token on the host.", atDesk: { command: null } },
    });
    const feed = await build(seeded.companyId);
    const card = cardFor(feed, seeded.gre138)!;
    expect(card.kinds).toContain("recovery");
    expect(card.atDesk).toBeNull();
    expect(card.actions.map((candidate) => candidate.id)).not.toContain("done");
    expect(feed.atDeskCount).toBe(0);
  });

  /**
   * The live board on 3-4 Oct (GRE-504): one agent's runs stopped on setup
   * again and again, one failed run per wake, on several tasks.
   */
  const NO_DEFAULT = "Connect an account and choose your personal default";
  const NOT_PERMITTED = "This connection is not permitted for this agent";

  async function seedSetupFailures() {
    const companyId = randomUUID();
    const everestId = randomUUID();
    const beaconId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "GRE Co", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([everestId, beaconId].map((id) => ({
      id,
      companyId,
      name: id === everestId ? "Everest" : "Beacon",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { aiConnection: { provider: "openai" } },
      permissions: {},
    })));
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: USER_ID, status: "active", membershipRole: "owner",
    });
    let issueNumber = 600;
    async function task(agentId: string) {
      const id = randomUUID();
      issueNumber += 1;
      await db.insert(issues).values({
        id, companyId, identifier: `GRE-${issueNumber}`, issueNumber, title: `Task ${issueNumber}`, status: "blocked", priority: "medium", assigneeAgentId: agentId,
      });
      return id;
    }
    async function fail(agentId: string, issueId: string, error: string, at: Date) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        errorCode: "configuration_incomplete",
        error,
        resultJson: { configurationIncomplete: { reason: "ai_connection_unavailable", actionUrl: `/agents/${agentId}/runtime` } },
        contextSnapshot: { issueId },
        createdAt: at,
        finishedAt: at,
      });
      return runId;
    }
    /** The recovery the failure left on the task; it points at the newest run. */
    async function recover(agentId: string, issueId: string, latestRunId: string, at: Date) {
      const id = randomUUID();
      await db.insert(issueRecoveryActions).values({
        id,
        companyId,
        sourceIssueId: issueId,
        kind: "configuration_validation",
        status: "active",
        ownerType: "board",
        previousOwnerAgentId: agentId,
        returnOwnerAgentId: agentId,
        cause: "configuration_incomplete",
        fingerprint: `setup:${issueId}`,
        evidence: { latestRunId, failureSummary: "The run stopped before it started: setup is not complete." },
        nextAction: RECONNECT,
        createdAt: at,
        updatedAt: at,
      });
      return id;
    }
    const t0 = Date.now() - 6 * HOUR;
    const at = (hours: number) => new Date(t0 + hours * HOUR);
    const first = await task(everestId);
    const second = await task(everestId);
    await fail(everestId, first, NO_DEFAULT, at(0));
    const firstRun = await fail(everestId, first, NO_DEFAULT, at(1));
    const secondRun = await fail(everestId, second, NO_DEFAULT, at(2));
    const firstRecovery = await recover(everestId, first, firstRun, at(1));
    const secondRecovery = await recover(everestId, second, secondRun, at(2));
    return { companyId, everestId, beaconId, first, second, firstRecovery, secondRecovery, at, task, fail, recover };
  }

  function setupCards(feed: DecisionsFeed) {
    return feed.cards.filter((card) => card.setup);
  }

  it("shows repeated setup failures of one agent and cause as one card with a count, last seen and the fix link (GRE-504)", async () => {
    const seeded = await seedSetupFailures();

    const feed = await build(seeded.companyId);

    expect(feed.cards).toHaveLength(1);
    const card = feed.cards[0]!;
    expect(card.id).toMatch(new RegExp(`^setup:${seeded.everestId}:ai_connection_unavailable:`));
    expect(card).toMatchObject({
      kind: "recovery",
      task: null,
      title: "Everest cannot start: setup is not complete",
      reason: NO_DEFAULT,
      waiting: { id: seeded.everestId, name: "Everest" },
    });
    expect(card.setup).toEqual({
      agent: { id: seeded.everestId, name: "Everest" },
      cause: NO_DEFAULT,
      failureCount: 3,
      lastSeenAt: seeded.at(2).toISOString(),
      fixHref: `/agents/${seeded.everestId}/runtime`,
      tasks: [
        { id: seeded.first, identifier: "GRE-601", title: "Task 601" },
        { id: seeded.second, identifier: "GRE-602", title: "Task 602" },
      ],
      fixedAt: null,
    });
    expect(card.actions[0]).toMatchObject({ id: "fix_setup", type: "link", href: `/agents/${seeded.everestId}/runtime` });
    expect(feed.count).toBe(1);

    // A later failure with the same cause adds to the count, not a new card.
    await seeded.fail(seeded.everestId, seeded.second, NO_DEFAULT, seeded.at(3));
    const later = await build(seeded.companyId);
    expect(later.cards).toHaveLength(1);
    expect(later.cards[0]!.setup).toMatchObject({ failureCount: 4, lastSeenAt: seeded.at(3).toISOString() });

    // Retry all sends every stopped task back to its owner, through the same endpoint as one task's Retry.
    const retry = action(card, "retry");
    expect(retry.label).toBe("Retry all 2");
    await run(app(seeded.companyId), retry);
    const retried = await db.select({ status: issues.status }).from(issues).where(eq(issues.assigneeAgentId, seeded.everestId));
    expect(retried.map((row) => row.status)).toEqual(["todo", "todo"]);
  });

  it("keeps a different cause or a different agent on its own card (GRE-504)", async () => {
    const seeded = await seedSetupFailures();
    const third = await seeded.task(seeded.everestId);
    const thirdRun = await seeded.fail(seeded.everestId, third, NOT_PERMITTED, seeded.at(3));
    await seeded.recover(seeded.everestId, third, thirdRun, seeded.at(3));
    const beaconTask = await seeded.task(seeded.beaconId);
    const beaconRun = await seeded.fail(seeded.beaconId, beaconTask, NO_DEFAULT, seeded.at(4));
    await seeded.recover(seeded.beaconId, beaconTask, beaconRun, seeded.at(4));

    const feed = await build(seeded.companyId);

    const cards = setupCards(feed);
    expect(cards).toHaveLength(3);
    expect(feed.count).toBe(3);
    const byCause = (agentId: string, cause: string) =>
      cards.filter((card) => card.setup!.agent?.id === agentId && card.setup!.cause === cause);
    expect(byCause(seeded.everestId, NO_DEFAULT)).toHaveLength(1);
    expect(byCause(seeded.everestId, NO_DEFAULT)[0]!.setup!.failureCount).toBe(3);
    // One task of its own keeps its task card, with the setup count and fix link on it.
    const notPermitted = byCause(seeded.everestId, NOT_PERMITTED)[0]!;
    expect(notPermitted).toMatchObject({ id: `task:${third}`, title: "GRE-603 Task 603" });
    expect(notPermitted.setup).toMatchObject({ failureCount: 1, fixHref: `/agents/${seeded.everestId}/runtime` });
    expect(notPermitted.actions.map((candidate) => candidate.id)).toEqual(expect.arrayContaining(["fix_setup", "retry", "reassign"]));
    const beacon = byCause(seeded.beaconId, NO_DEFAULT)[0]!;
    expect(beacon).toMatchObject({ id: `task:${beaconTask}`, waiting: { name: "Beacon" } });
    expect(beacon.setup).toMatchObject({ failureCount: 1, fixHref: `/agents/${seeded.beaconId}/runtime` });
  });

  it("clears the setup card once the agent's next run succeeds (GRE-504)", async () => {
    const seeded = await seedSetupFailures();
    await db.insert(heartbeatRuns).values({
      companyId: seeded.companyId,
      agentId: seeded.everestId,
      invocationSource: "assignment",
      status: "succeeded",
      createdAt: seeded.at(4),
      finishedAt: seeded.at(4),
    });

    const fixed = await build(seeded.companyId);

    // The setup item is gone. The two tasks it stopped are still blocked, so
    // one card says the setup works again and offers one Retry for both.
    expect(fixed.cards).toHaveLength(1);
    const card = fixed.cards[0]!;
    expect(card.title).toBe("Everest's setup works again: 2 tasks still stopped");
    expect(card.reason).toContain("The setup works again");
    expect(card.setup?.fixedAt).toBe(seeded.at(4).toISOString());
    expect(card.actions.map((candidate) => candidate.id)).not.toContain("fix_setup");
    expect(action(card, "retry").requests).toHaveLength(2);

    // Once the tasks move on, nothing is left.
    await db.update(issues).set({ status: "todo" }).where(eq(issues.assigneeAgentId, seeded.everestId));
    expect((await build(seeded.companyId)).cards).toEqual([]);
  });

  describe("review cards (GRE-870)", () => {
    const OTHER_USER_ID = "other-user";

    afterEach(async () => {
      // The agent's run is named by its activity rows: clear them before the runs go.
      await db.delete(activityLog);
      await db.delete(authUsers).where(inArray(authUsers.id, [USER_ID, OTHER_USER_ID]));
    });

    /**
     * GRE-800 on 5 Oct: the task waits on John's review stage, Mason gets it
     * back. The card showed Reassign and Cancel but no Approve.
     */
    async function seedReview(input: {
      reviewer: { type: "user"; userId: string } | { type: "agent" };
      responsibleUserId?: string;
      changesRequestedCount?: number;
      /** The agent stage escalated to this user after its last round. */
      escalatedTo?: string;
    }) {
      const companyId = randomUUID();
      const masonId = randomUUID();
      const keystoneId = randomUUID();
      const issueId = randomUUID();
      const stageId = randomUUID();
      const now = new Date();
      await db.insert(companies).values({ id: companyId, name: "GRE Co", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false });
      await db.insert(agents).values([[masonId, "Mason"], [keystoneId, "Keystone"]].map(([id, name]) => ({
        id: id!, companyId, name: name!, role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      })));
      await db.insert(authUsers).values([
        { id: USER_ID, name: "John Prempeh", email: "john@example.com", createdAt: now, updatedAt: now },
        { id: OTHER_USER_ID, name: "Other User", email: "other@example.com", createdAt: now, updatedAt: now },
      ]);
      await db.insert(companyMemberships).values([USER_ID, OTHER_USER_ID].map((principalId) => ({
        companyId, principalType: "user", principalId, status: "active", membershipRole: "owner",
      })));
      const stageParticipant = input.reviewer.type === "user"
        ? { type: "user" as const, userId: input.reviewer.userId, agentId: null }
        : { type: "agent" as const, userId: null, agentId: keystoneId };
      const participant = input.escalatedTo
        ? { type: "user" as const, userId: input.escalatedTo, agentId: null }
        : stageParticipant;
      await db.insert(issues).values({
        id: issueId,
        companyId,
        identifier: "GRE-800",
        issueNumber: 800,
        title: "Approval card shows the full send",
        status: "in_review",
        priority: "high",
        responsibleUserId: input.responsibleUserId ?? null,
        assigneeAgentId: participant.agentId,
        assigneeUserId: participant.userId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), ...stageParticipant }] }],
        },
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: participant,
          returnAssignee: { type: "agent", agentId: masonId, userId: null },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          changesRequestedCount: input.changesRequestedCount ?? 0,
        },
      });
      return { companyId, masonId, keystoneId, issueId };
    }

    function otherUserApp(companyId: string) {
      return app(companyId, {
        type: "board",
        source: "session",
        userId: OTHER_USER_ID,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "owner" }],
        isInstanceAdmin: false,
      });
    }

    it("shows the reviewer Approve and Request changes, names them, and approving finishes the review", async () => {
      const seeded = await seedReview({ reviewer: { type: "user", userId: USER_ID } });
      const card = cardFor(await build(seeded.companyId), seeded.issueId);

      expect(card?.kind).toBe("review");
      expect(card?.reviewer).toEqual({ type: "user", id: USER_ID, name: "John Prempeh", isYou: true });
      // Mason gets the task back, so Mason is the one waiting.
      expect(card?.waiting?.name).toBe("Mason");
      const ids = card!.actions.map((candidate) => candidate.id);
      expect(ids.slice(0, 2)).toEqual(["approve", "request_changes"]);
      expect(action(card, "request_changes").input).toEqual(expect.objectContaining({ field: "comment", required: true }));

      await run(app(seeded.companyId), action(card, "approve"));

      const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(task?.status).toBe("done");
      expect((task?.executionState as { status?: string } | null)?.status).toBe("completed");
      const [decision] = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, seeded.issueId));
      expect(decision).toEqual(expect.objectContaining({ outcome: "approved", actorUserId: USER_ID, body: "Approved from Decisions." }));
      expect(cardFor(await build(seeded.companyId), seeded.issueId)).toBeNull();
    });

    it("sends the task back to its owner with the reason, and refuses Request changes with no reason", async () => {
      const seeded = await seedReview({ reviewer: { type: "user", userId: USER_ID } });
      const testApp = app(seeded.companyId);
      const requestChanges = action(cardFor(await build(seeded.companyId), seeded.issueId), "request_changes");

      const empty = await request(testApp).patch(requestChanges.requests[0]!.path).send(requestChanges.requests[0]!.body);
      expect(empty.status).toBe(422);
      const [unchanged] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(unchanged?.status).toBe("in_review");

      await run(testApp, requestChanges, "Render the HTML part as a page.");

      const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(task?.status).toBe("in_progress");
      expect(task?.assigneeAgentId).toBe(seeded.masonId);
      expect((task?.executionState as { status?: string } | null)?.status).toBe("changes_requested");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
      expect(comments.map((comment) => comment.body)).toContain("Render the HTML part as a page.");
    });

    it("gives another user no verdict buttons, names the reviewer, and the server refuses their approval", async () => {
      const seeded = await seedReview({ reviewer: { type: "user", userId: USER_ID } });
      const card = cardFor(await decisionsFeedService(db).build(seeded.companyId, { userId: OTHER_USER_ID }), seeded.issueId);

      expect(card?.reviewer).toEqual({ type: "user", id: USER_ID, name: "John Prempeh", isYou: false });
      expect(card?.nextStep).toBe("The task stays in review until John Prempeh approves it or asks for changes.");
      const ids = card!.actions.map((candidate) => candidate.id);
      expect(ids).not.toContain("approve");
      expect(ids).not.toContain("request_changes");

      // The reviewer's own action, sent by an agent that is not the reviewer, is refused.
      const reviewerCard = cardFor(await build(seeded.companyId), seeded.issueId);
      const approve = action(reviewerCard, "approve").requests[0]!;
      const agentApp = app(seeded.companyId, { type: "agent", agentId: seeded.keystoneId, companyId: seeded.companyId, source: "agent_key" });
      const refused = await request(agentApp).patch(approve.path).send(approve.body);
      expect([403, 422]).toContain(refused.status);
      const [stillPending] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(stillPending?.status).toBe("in_review");
      expect((stillPending?.executionState as { status?: string } | null)?.status).toBe("pending");

      // Another board user may still force-close the task (existing board
      // override), but that dissolves the review: it is never recorded as approved.
      const forced = await request(otherUserApp(seeded.companyId)).patch(approve.path).send(approve.body);
      expect(forced.status).toBe(200);
      const [closed] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(closed?.executionState).toBeNull();
      expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, seeded.issueId))).toEqual([]);
    });

    it("escalates an old local-board task to the real owner after the agent's last round, who can then approve", async () => {
      const seeded = await seedReview({ reviewer: { type: "agent" }, responsibleUserId: "local-board", changesRequestedCount: 2 });
      // Only John is an active human owner; the second user is a plain member.
      await db.update(companyMemberships).set({ membershipRole: "member" })
        .where(eq(companyMemberships.principalId, OTHER_USER_ID));
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId, companyId: seeded.companyId, agentId: seeded.keystoneId, invocationSource: "assignment",
        status: "running", contextSnapshot: { issueId: seeded.issueId },
      });
      const keystoneApp = app(seeded.companyId, { type: "agent", agentId: seeded.keystoneId, companyId: seeded.companyId, source: "agent_key", runId });

      const third = await request(keystoneApp).patch(`/api/issues/${seeded.issueId}`)
        .send({ status: "in_progress", comment: "Not ready: the HTML part is still raw." });
      expect(third.status, JSON.stringify(third.body)).toBe(200);

      const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      const state = task?.executionState as { status?: string; currentParticipant?: { type: string; userId: string | null } } | null;
      expect(task?.status).toBe("in_review");
      expect(state?.status).toBe("pending");
      expect(state?.currentParticipant).toEqual(expect.objectContaining({ type: "user", userId: USER_ID }));
      expect(task?.assigneeUserId).toBe(USER_ID);

      const card = cardFor(await build(seeded.companyId), seeded.issueId);
      expect(card?.reviewer).toEqual(expect.objectContaining({ id: USER_ID, isYou: true }));
      await run(app(seeded.companyId), action(card, "approve"));
      const [approved] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(approved?.status).toBe("done");
    });

    it("says a comment sent with a refused reassignment was not saved, and a plain comment still posts", async () => {
      const seeded = await seedReview({ reviewer: { type: "agent" }, escalatedTo: USER_ID, changesRequestedCount: 3 });
      const otherApp = otherUserApp(seeded.companyId);

      const refused = await request(otherApp).patch(`/api/issues/${seeded.issueId}`)
        .send({ comment: "looks like we are good to go", assigneeAgentId: seeded.masonId });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toMatch(/^Comment not saved\./);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toEqual([]);

      const posted = await request(otherApp).post(`/api/issues/${seeded.issueId}/comments`)
        .send({ body: "looks like we are good to go" });
      expect(posted.status).toBe(201);
      const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(task?.status).toBe("in_review");
      expect((task?.executionState as { currentParticipant?: { userId: string | null } } | null)?.currentParticipant?.userId).toBe(USER_ID);
    });

    it("keeps local-board as the escalation when the owner is not clear", async () => {
      const seeded = await seedReview({ reviewer: { type: "agent" }, responsibleUserId: "local-board" });
      // Two human owners: no guess.
      expect(await resolveReviewEscalationUserId(db, { companyId: seeded.companyId, responsibleUserId: "local-board" })).toBeUndefined();
      // One owner: bound to that user. A real responsible user is never rebound.
      await db.update(companyMemberships).set({ membershipRole: "member" })
        .where(eq(companyMemberships.principalId, OTHER_USER_ID));
      expect(await resolveReviewEscalationUserId(db, { companyId: seeded.companyId, responsibleUserId: "local-board" })).toBe(USER_ID);
      expect(await resolveReviewEscalationUserId(db, { companyId: seeded.companyId, responsibleUserId: OTHER_USER_ID })).toBeUndefined();
    });

    describe("a review left on the legacy local-board user", () => {
      const BEN_ID = "ben-admin";

      afterEach(async () => {
        await db.delete(authUsers).where(eq(authUsers.id, BEN_ID));
      });

      /**
       * Live on 6 Oct: GRE-800, GRE-656 and GRE-822 wait on `local-board`,
       * which nobody can sign in as. John (owner) must get the verdict; Ben
       * (admin) and an owner of another company must not.
       */
      async function seedLocalBoardReview() {
        const seeded = await seedReview({ reviewer: { type: "user", userId: "local-board" } });
        const now = new Date();
        await db.insert(authUsers).values({ id: BEN_ID, name: "Ben", email: "ben@example.com", createdAt: now, updatedAt: now });
        // John stays owner; the second user becomes Ben's kind of member: an admin.
        await db.update(companyMemberships).set({ membershipRole: "admin" })
          .where(eq(companyMemberships.principalId, OTHER_USER_ID));
        await db.insert(companyMemberships).values([
          { companyId: seeded.companyId, principalType: "user", principalId: "local-board", status: "active", membershipRole: "owner" },
          { companyId: seeded.companyId, principalType: "user", principalId: BEN_ID, status: "active", membershipRole: "admin" },
        ]);
        return seeded;
      }

      function boardApp(companyId: string, userId: string, membershipRole: string) {
        return app(companyId, {
          type: "board",
          source: "session",
          userId,
          companyIds: [companyId],
          memberships: [{ companyId, status: "active", membershipRole }],
          isInstanceAdmin: false,
        });
      }

      it("gives the owner Approve and Request changes, and the approval is recorded as theirs", async () => {
        const seeded = await seedLocalBoardReview();
        const card = cardFor(await build(seeded.companyId), seeded.issueId);

        expect(card?.reviewer).toEqual({ type: "user", id: "local-board", name: "Board", isYou: true });
        expect(card?.nextStep).toBe("The task stays in review until you approve it or ask for changes.");
        expect(card!.actions.map((candidate) => candidate.id).slice(0, 2)).toEqual(["approve", "request_changes"]);

        await run(app(seeded.companyId), action(card, "approve"));

        const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
        expect(task?.status).toBe("done");
        expect((task?.executionState as { status?: string } | null)?.status).toBe("completed");
        const [decision] = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, seeded.issueId));
        expect(decision).toEqual(expect.objectContaining({ outcome: "approved", actorUserId: USER_ID }));
      });

      it("lets the owner request changes on a local-board review", async () => {
        const seeded = await seedLocalBoardReview();
        const requestChanges = action(cardFor(await build(seeded.companyId), seeded.issueId), "request_changes");

        await run(app(seeded.companyId), requestChanges, "Render the HTML part as a page.");

        const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
        expect(task?.status).toBe("in_progress");
        expect(task?.assigneeAgentId).toBe(seeded.masonId);
        expect((task?.executionState as { status?: string } | null)?.status).toBe("changes_requested");
      });

      it("gives an admin no verdict, and never records the admin's approval", async () => {
        const seeded = await seedLocalBoardReview();
        const card = cardFor(await decisionsFeedService(db).build(seeded.companyId, { userId: BEN_ID }), seeded.issueId);

        expect(card?.reviewer).toEqual(expect.objectContaining({ id: "local-board", isYou: false }));
        expect(card!.actions.map((candidate) => candidate.id)).not.toContain("approve");
        expect(card!.actions.map((candidate) => candidate.id)).not.toContain("request_changes");

        // A comment that reads as an approval does not finish the review for Ben.
        const comment = await request(boardApp(seeded.companyId, BEN_ID, "admin"))
          .post(`/api/issues/${seeded.issueId}/comments`)
          .send({ body: "## Review: APPROVED\n\nLooks good." });
        expect(comment.status).toBe(201);
        const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
        expect(task?.status).toBe("in_review");
        expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, seeded.issueId))).toEqual([]);
      });

      it("gives an owner of another company nothing for this company's local-board review", async () => {
        const seeded = await seedLocalBoardReview();
        const elsewhereId = randomUUID();
        const strangerId = "other-company-owner";
        await db.insert(companies).values({ id: elsewhereId, name: "Else Co", issuePrefix: "ELS", requireBoardApprovalForNewAgents: false });
        await db.insert(companyMemberships).values({
          companyId: elsewhereId, principalType: "user", principalId: strangerId, status: "active", membershipRole: "owner",
        });

        const card = cardFor(await decisionsFeedService(db).build(seeded.companyId, { userId: strangerId }), seeded.issueId);
        expect(card?.reviewer).toEqual(expect.objectContaining({ id: "local-board", isYou: false }));
        expect(card!.actions.map((candidate) => candidate.id)).not.toContain("approve");
      });

      it("counts the owner's local-board tasks as theirs in Needs me and the my-tasks list", async () => {
        const seeded = await seedLocalBoardReview();
        const assignedId = randomUUID();
        await db.insert(issues).values({
          id: assignedId, companyId: seeded.companyId, identifier: "GRE-656", issueNumber: 656,
          title: "Old board task", status: "todo", priority: "medium", assigneeUserId: "local-board",
        });

        const mine = await request(app(seeded.companyId)).get(`/api/companies/${seeded.companyId}/issues?assigneeUserId=me`);
        expect(mine.status).toBe(200);
        expect((mine.body as Array<{ id: string }>).map((row) => row.id)).toEqual(expect.arrayContaining([assignedId, seeded.issueId]));
        const bens = await request(boardApp(seeded.companyId, BEN_ID, "admin")).get(`/api/companies/${seeded.companyId}/issues?assigneeUserId=me`);
        expect(bens.status).toBe(200);
        expect(bens.body).toEqual([]);

        const needsMe = await request(app(seeded.companyId)).get(`/api/companies/${seeded.companyId}/needs-me`);
        expect(needsMe.status).toBe(200);
        expect((needsMe.body.assignedTasks as Array<{ id: string }>).map((row) => row.id)).toContain(assignedId);
      });
    });

    it("leaves an agent review alone: no card and no verdict buttons for the board", async () => {
      const seeded = await seedReview({ reviewer: { type: "agent" } });
      const card = cardFor(await build(seeded.companyId), seeded.issueId);
      expect(card?.actions.map((candidate) => candidate.id) ?? []).not.toContain("approve");
      expect(card?.actions.map((candidate) => candidate.id) ?? []).not.toContain("request_changes");
    });
  });
});
