import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@greatstone/adapter-utils";
import {
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  companyMemberships,
  connectionGrants,
  costEvents,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issueComments,
  issues,
} from "@greatstone/db";
import { AI_ACCESS_ROUTE_DEFINITIONS, type AiAccessRoute } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { budgetService } from "../services/budgets.js";
import { BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS, heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";

// GRE-1361 (B6): guard tests that pin how the AI supply route behaves today, so
// it cannot drift. Acceptance tests AT-2.5, AT-2.7, AT-2.8 and AT-2.10 from the
// GRE-1357 gap map. Every test drives real heartbeat runs on an embedded
// database with a fake harness, and counts runs and cost rows.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Execute = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
type Seen = { runId: string; env: Record<string, string> };

const BOOTSTRAP = { kind: "bootstrap", providerWorkStarted: false } as const;

describeEmbeddedPostgres("AI supply guards (GRE-1361)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let home = "";

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-supply-"));
    vi.stubEnv("GSAM_HOME", home);
    vi.stubEnv("GSAM_INSTANCE_ID", "ai-supply");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ai-supply-guards-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 90_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter("claude_local");
    await instanceSettingsService(db).updateGeneral({ aiAccessRoute: null });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  /** A company, its owner and one Claude agent. Each test gets its own. */
  async function install(input: { agentStatus?: "idle" | "active" } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = `owner-${companyId}`;
    await db.insert(companies).values({
      id: companyId,
      name: "AI supply guards",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: userId,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Engineer", role: "engineer", status: input.agentStatus ?? "idle", adapterType: "claude_local",
      adapterConfig: { cwd: home, engine: "cli", model: "claude-test-model", dangerouslySkipPermissions: true },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId, userId };
  }
  type Install = Awaited<ReturnType<typeof install>>;

  /** The fake Claude harness. Records each call, then returns what the test says. */
  function fakeHarness(execute: Execute) {
    const seen: Seen[] = [];
    registerServerAdapter({
      ...getServerAdapter("claude_local"),
      execute: vi.fn(async (ctx: AdapterExecutionContext) => {
        const config = ctx.config as Record<string, unknown>;
        seen.push({ runId: ctx.runId, env: (config.env ?? {}) as Record<string, string> });
        return execute(ctx);
      }),
    });
    return seen;
  }

  async function connect(f: Install, route: AiAccessRoute, credential: string) {
    const { provider, method } = AI_ACCESS_ROUTE_DEFINITIONS[route];
    return aiConnectionService(db).save(f.companyId, f.userId, {
      provider, method, name: `Client ${route}`, ownership: "personal", agentIds: [f.agentId], allAgents: false,
      ...(method === "api_key" ? { apiKey: credential } : { loginSessionId: "fixture" }),
    }, credential);
  }

  async function newIssue(f: Install, status: "todo" | "in_progress" = "todo") {
    const [issue] = await db.insert(issues).values({
      companyId: f.companyId, title: "Guarded task", status, assigneeAgentId: f.agentId,
      responsibleUserId: f.userId, createdByUserId: f.userId,
    }).returning();
    return issue!;
  }

  async function startRun(f: Install, issueId: string) {
    const run = await heartbeat.invoke(
      f.agentId, "assignment", { issueId, wakeReason: "issue_assigned", responsibleUserId: f.userId }, "system",
    );
    expect(run).not.toBeNull();
    return run!;
  }

  async function settled(runId: string) {
    await expect.poll(async () => (await heartbeat.getRun(runId))?.status, { timeout: 20_000 })
      .toMatch(/^(succeeded|failed|cancelled|timed_out)$/);
    return (await heartbeat.getRun(runId))!;
  }

  async function runsFor(agentId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  }

  /** The 30 s wait is skipped by promoting on a fake clock, so first let the
   * failed run release its environment lease, as it does well within 30 s. */
  async function leaseReleased(runId: string) {
    await expect.poll(async () => {
      const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
      return leases.every((l) => l.releasedAt !== null && l.status !== "pending_cleanup" && l.cleanupStatus !== "failed");
    }, { timeout: 10_000 }).toBe(true);
  }

  async function retryOf(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  }

  // AT-2.5: the hard stop cancels the active run and the queued wakes, refuses
  // new work, says why once on each task the agent holds, and keeps the assignee.
  it("AT-2.5 a hard stop cancels the agent's work, comments once per held task and keeps the assignee", async () => {
    const f = await install();
    await db.insert(budgetPolicies).values({
      companyId: f.companyId, scopeType: "agent", scopeId: f.agentId, metric: "billed_cents",
      windowKind: "calendar_month_utc", amount: 500, warnPercent: 80, hardStopEnabled: true, isActive: true,
    });
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    fakeHarness(async (ctx) => {
      await ctx.onCancellationReady?.();
      started();
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) return resolve();
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // The real harness confirms the provider process stopped.
      return { exitCode: null, signal: "SIGTERM", timedOut: false, resultJson: { executionCancellation: { state: "acknowledged" } } };
    });

    const active = await newIssue(f, "in_progress");
    const waiting = await newIssue(f, "todo");
    const [finished] = await db.insert(issues).values({
      companyId: f.companyId, title: "Finished task", status: "done", assigneeAgentId: f.agentId,
    }).returning();
    const run = await startRun(f, active.id);
    await running;
    expect((await heartbeat.getRun(run.id))?.status).toBe("running");
    const [queuedWake] = await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId: f.agentId, source: "assignment", reason: "issue_assigned",
      payload: { issueId: waiting.id }, status: "queued",
    }).returning();

    const budgets = budgetService(db, {
      cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
      noticeHardStop: heartbeat.noticeBudgetHardStop,
    });
    const [spend] = await db.insert(costEvents).values({
      companyId: f.companyId, agentId: f.agentId, provider: "anthropic", biller: "anthropic",
      billingType: "metered_api", model: "claude-test-model", costCents: 600, occurredAt: new Date(),
    }).returning();
    // The same event seen twice (at-least-once delivery) must not repeat anything.
    await budgets.evaluateCostEvent(spend!);
    await budgets.evaluateCostEvent(spend!);

    const cancelled = await settled(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toBe("Cancelled due to budget pause");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queuedWake!.id));
    expect(wake!.status).toBe("cancelled");
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent).toMatchObject({ status: "paused", pauseReason: "budget" });

    // No new run starts while the agent is over its cap.
    const before = (await runsFor(f.agentId)).length;
    await expect(heartbeat.invoke(f.agentId, "assignment", { issueId: waiting.id, wakeReason: "issue_assigned" }, "system"))
      .rejects.toThrow();
    expect(await budgets.getInvocationBlock(f.companyId, f.agentId, { issueId: waiting.id })).toBeTruthy();
    expect((await runsFor(f.agentId)).length).toBe(before);

    for (const held of [active, waiting]) {
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, held.id));
      const notices = comments.filter((c) => c.body.includes("reached its monthly budget"));
      expect(notices, `one budget notice on ${held.title}`).toHaveLength(1);
      expect(notices[0]!.body).toContain("raises the agent's budget");
      const [kept] = await db.select().from(issues).where(eq(issues.id, held.id));
      expect(kept!.assigneeAgentId).toBe(f.agentId);
    }
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, finished!.id))).toHaveLength(0);
  }, 60_000);

  // AT-2.7 (transient): two retries 30 s apart, then stop. Three runs in all.
  it("AT-2.7 retries a transient failure at most twice, 30 seconds apart", async () => {
    expect(BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS).toEqual([30_000, 30_000]);
    const f = await install();
    const seen = fakeHarness(async () => ({
      exitCode: 1, signal: null, timedOut: false, errorMessage: "Upstream overloaded",
      errorCode: "claude_transient_upstream", errorFamily: "transient_upstream", executionRecovery: BOOTSTRAP,
      resultJson: { executionRecovery: BOOTSTRAP, errorFamily: "transient_upstream" },
    }));
    const issue = await newIssue(f);
    let current = await settled((await startRun(f, issue.id)).id);
    expect(current).toMatchObject({ status: "failed", errorCode: "claude_transient_upstream" });

    for (const attempt of [1, 2]) {
      await expect.poll(async () => (await retryOf(current.id)).length, { timeout: 10_000 }).toBe(1);
      const [retry] = await retryOf(current.id);
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: attempt, scheduledRetryReason: "transient_failure" });
      const gapMs = retry!.scheduledRetryAt!.getTime() - current.finishedAt!.getTime();
      expect(gapMs).toBeGreaterThanOrEqual(29_000);
      expect(gapMs).toBeLessThanOrEqual(31_000);
      await leaseReleased(current.id);
      // Not before it is due.
      expect((await heartbeat.promoteDueScheduledRetries(new Date(retry!.scheduledRetryAt!.getTime() - 1))).promoted).toBe(0);
      expect((await heartbeat.promoteDueScheduledRetries(retry!.scheduledRetryAt!)).runIds).toEqual([retry!.id]);
      await heartbeat.startNextQueuedRunForAgent(f.agentId);
      current = await settled(retry!.id);
      expect(current.status, `${current.errorCode}: ${current.error}`).toBe("failed");
    }

    // The third failure is final: no successor and nothing left scheduled.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await retryOf(current.id)).toHaveLength(0);
    const runs = await runsFor(f.agentId);
    expect(runs.map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
    expect(seen).toHaveLength(3);
  }, 90_000);

  // AT-2.7 (quota): no retry before the provider's reset time, and the retry
  // runs on the same connection although another account is connected.
  it("AT-2.7 waits for the quota reset and retries on the same AI connection", async () => {
    const f = await install();
    const seat = await connect(f, "claude_subscription", "client-seat-token");
    await connect(f, "claude_api_key", "client-api-key");
    await instanceSettingsService(db).updateGeneral({ aiAccessRoute: "claude_subscription" });
    const resetAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    let calls = 0;
    const issue = await newIssue(f);
    const seen = fakeHarness(async () => {
      calls += 1;
      if (calls > 1) {
        await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issue.id));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      }
      return {
        exitCode: 1, signal: null, timedOut: false, errorMessage: "You've hit your session limit",
        errorCode: "provider_quota", errorFamily: "provider_quota", retryNotBefore: resetAt, executionRecovery: BOOTSTRAP,
        resultJson: { executionRecovery: BOOTSTRAP, errorFamily: "provider_quota", retryNotBefore: resetAt },
      };
    });
    const first = await settled((await startRun(f, issue.id)).id);
    expect(first).toMatchObject({ status: "failed", errorCode: "provider_quota" });

    await expect.poll(async () => (await retryOf(first.id)).length, { timeout: 10_000 }).toBe(1);
    const [retry] = await retryOf(first.id);
    expect(retry!.status).toBe("scheduled_retry");
    expect(retry!.scheduledRetryAt!.toISOString()).toBe(resetAt);
    expect((await heartbeat.promoteDueScheduledRetries(new Date(new Date(resetAt).getTime() - 1))).promoted).toBe(0);
    expect(await runsFor(f.agentId)).toHaveLength(2);
    expect(seen).toHaveLength(1);

    await leaseReleased(first.id);
    expect((await heartbeat.promoteDueScheduledRetries(new Date(resetAt))).runIds).toEqual([retry!.id]);
    await heartbeat.startNextQueuedRunForAgent(f.agentId);
    const second = await settled(retry!.id);
    expect(second.status, second.error ?? "").toBe("succeeded");

    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("client-seat-token");
      expect(call.env.ANTHROPIC_API_KEY ?? "").toBe("");
    }
    for (const run of [first, second]) {
      expect(run.contextSnapshot?.aiConnection).toMatchObject({ connectionId: seat.connectionId, method: "subscription" });
    }
  }, 90_000);

  // AT-2.7 (dead credential, GRE-15): the provider refused the login, so the
  // run is not retried; the connection is flagged for a person instead.
  it("AT-2.7 does not retry a run whose credential the provider rejected", async () => {
    const f = await install();
    const seat = await connect(f, "claude_subscription", "client-seat-token");
    await instanceSettingsService(db).updateGeneral({ aiAccessRoute: "claude_subscription" });
    const seen = fakeHarness(async () => ({
      exitCode: 1, signal: null, timedOut: false, errorCode: "claude_auth_required",
      errorMessage: "The provider rejected the login.", resultJson: {},
    }));
    const issue = await newIssue(f);
    const run = await settled((await startRun(f, issue.id)).id);
    expect(run).toMatchObject({ status: "failed", errorCode: "claude_auth_required" });

    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await retryOf(run.id)).toHaveLength(0);
    expect((await runsFor(f.agentId)).map((r) => r.status)).toEqual(["failed"]);
    expect(seen).toHaveLength(1);
    const [summary] = (await aiConnectionService(db).list(f.companyId, f.userId)).filter((a) => a.id === seat.connectionId);
    expect(summary?.status).toBe("needs_attention");
  }, 60_000);

  // AT-2.8: a dead subscription grant does not fall back to a working API key.
  it("AT-2.8 fails a subscription-route run with a dead grant and never uses the working API key", async () => {
    const f = await install();
    const seat = await connect(f, "claude_subscription", "client-seat-token");
    await connect(f, "claude_api_key", "client-api-key");
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.connectionId, seat.connectionId));
    await instanceSettingsService(db).updateGeneral({ aiAccessRoute: "claude_subscription" });
    const seen = fakeHarness(async () => ({
      exitCode: 0, signal: null, timedOut: false, provider: "anthropic", billingType: "api", costUsd: 1,
      usage: { inputTokens: 100, outputTokens: 100 }, resultJson: {},
    }));
    const issue = await newIssue(f);
    const run = await settled((await startRun(f, issue.id)).id);

    expect(run.status).toBe("failed");
    // The run's code is the setup family; the reason names the dead connection.
    expect(run.errorCode).toBe("configuration_incomplete");
    expect((run.resultJson as { configurationIncomplete?: { reason?: string } }).configurationIncomplete?.reason)
      .toBe("ai_connection_unavailable");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(seen).toEqual([]);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toEqual([]);
    for (const other of await runsFor(f.agentId)) {
      expect((other.contextSnapshot as { aiConnection?: { method?: string } } | null)?.aiConnection?.method).not.toBe("api_key");
    }
  }, 60_000);

  // AT-2.10: a failed run that used tokens keeps its cost event, and that cost
  // counts against the agent's budget.
  it("AT-2.10 keeps the cost of a failed run and counts it against the budget", async () => {
    const f = await install();
    await db.insert(budgetPolicies).values({
      companyId: f.companyId, scopeType: "agent", scopeId: f.agentId, metric: "billed_cents",
      windowKind: "calendar_month_utc", amount: 100, warnPercent: 80, hardStopEnabled: true, isActive: true,
    });
    fakeHarness(async () => ({
      exitCode: 1, signal: null, timedOut: false, errorMessage: "Harness crashed after work", errorCode: "adapter_failed",
      provider: "anthropic", biller: "anthropic", billingType: "api", model: "claude-test-model", costUsd: 1.23,
      usage: { inputTokens: 1_000, outputTokens: 500 }, resultJson: {},
    }));
    const issue = await newIssue(f);
    const run = await settled((await startRun(f, issue.id)).id);
    expect(run.status).toBe("failed");

    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: f.agentId, billingType: "metered_api", costCents: 123, inputTokens: 1_000, outputTokens: 500 });

    const budgets = budgetService(db);
    expect(await budgets.getInvocationBlock(f.companyId, f.agentId, { issueId: issue.id })).toBeTruthy();
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent).toMatchObject({ status: "paused", pauseReason: "budget" });
    const [policy] = await db.select().from(budgetPolicies)
      .where(and(eq(budgetPolicies.scopeType, "agent"), eq(budgetPolicies.scopeId, f.agentId)));
    const overview = await budgets.overview(f.companyId);
    const agentRow = overview.policies.find((p) => p.policyId === policy!.id);
    expect(agentRow?.observedAmount).toBe(123);
  }, 60_000);
});
