import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@greatstone/shared";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueRecoveryActions,
  issueDocuments,
  issues,
  workspaceRuntimeServices,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.ts";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";
import { REVIEW_WAIT_MONITOR_SERVICE_NAME, REVIEW_WAIT_RECHECK_MS } from "../services/recovery/review-wait.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";

/** GRE-295: fails like an ACP startup deadline that passed while the host slept. */
const STARTUP_DEADLINE_TEST_ADAPTER = "monitor_startup_deadline_test";
const STARTUP_DEADLINE = "The ACP startup handshake did not finish before the startup deadline.";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue monitor scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: STARTUP_DEADLINE_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: STARTUP_DEADLINE,
        errorCode: "acpx_handshake_timeout",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        resultJson: { phase: "ensure_session" },
      }),
      testEnvironment: async () => ({
        adapterType: STARTUP_DEADLINE_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat runs to settle");
  }

  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);

    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    // The no-op process fixtures deliberately leave no task disposition. The
    // real lifecycle can now leave a bounded, scheduled repair after the
    // monitor assertions. Cancel that remaining work only during teardown.
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) await heartbeat.cancelRun(run.id, "Monitor fixture teardown", { suppressImmediateRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    seededAgentIds.clear();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    unregisterServerAdapter(STARTUP_DEADLINE_TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused";
    issueStatus?: "in_progress" | "in_review";
    monitorAttemptCount?: number;
    monitor?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitor = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Check deploy",
      scheduledBy: "assignee",
      ...(input?.monitor ?? {}),
    };

    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor Bot",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor,
      },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: monitorAttemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: typeof monitor.serviceName === "string" ? monitor.serviceName : null,
          externalRef: typeof monitor.externalRef === "string" ? monitor.externalRef : null,
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  it("triggers due issue monitors once and clears the one-shot schedule", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_triggered");
  });

  it.each(["unknown", "exhausted"] as const)("does not replay a quota monitor with %s execution evidence", async (kind) => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId } = await seedFixture({
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "failed", errorCode: "provider_quota",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"), contextSnapshot: { issueId },
      scheduledRetryAttempt: kind === "exhausted" ? 2 : 0,
      resultJson: kind === "exhausted" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null,
    });
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions)).toMatchObject([{ ownerType: "board", evidence: { runId: sourceRunId } }]);
  });

  it("wakes a cross-agent review participant for provider quota monitors", async () => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId: assigneeAgentId } = await seedFixture({
      issueStatus: "in_review",
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Quota-limited reviewer",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(participantAgentId);
    const monitorState = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: monitorState,
      },
    }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId: participantAgentId, status: "failed",
      errorCode: "provider_quota", finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: participantAgentId,
      reason: "execution_review_participant_recovery",
    });
    const [scheduled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
    expect(scheduled).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(await heartbeat.promoteDueScheduledRetries(scheduled.scheduledRetryAt!)).toMatchObject({ promoted: 1 });
    await heartbeat.resumeQueuedRuns();
    await waitForHeartbeatIdle();
    const participantRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, participantAgentId));
    expect(participantRuns).toHaveLength(2);
    expect(participantRuns.find((run) => run.id === scheduled.id)?.errorCode).not.toBe("issue_assignee_changed");
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const triggeredAt = new Date("2026-04-11T12:00:00.000Z");

    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: triggeredAt,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((row) => row.action)).toContain("issue.monitor_triggered");
    const triggerEvent = activity.find((row) => row.action === "issue.monitor_triggered");
    expect(triggerEvent?.actorType).toBe("user");
    expect(triggerEvent?.actorId).toBe("local-board");
    expect(triggerEvent?.details).toMatchObject({
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });
  });

  it("clears due monitors that cannot be dispatched and records a skip", async () => {
    const { issueId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_skipped");
  });

  it("clears exhausted monitors and queues bounded owner recovery instead of another due check", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_recovery");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      clearReason: "max_attempts_exhausted",
      maxAttempts: 1,
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).toContain("issue.monitor_recovery_wake_queued");
    expect(activity).not.toContain("issue.monitor_triggered");
  });

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, issueId))
      .then((rows) => rows.find((row) => row.companyId === companyId && row.originKind === "stranded_issue_recovery") ?? null);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      priority: "high",
      assigneeAdapterOverrides: null,
    });
    expect(["todo", "in_progress"]).toContain(recoveryIssue?.status);
  });

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(JSON.stringify(wakeup?.payload)).not.toContain("provider.example");
    expect(wakeup?.payload).not.toHaveProperty("externalRef");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(JSON.stringify(activity.map((row) => row.details))).not.toContain("provider.example");
    expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).not.toHaveProperty("externalRef");
  });

  describe("GRE-100: cancelling a monitor-started run", () => {
    async function startMonitorRun(input?: { maxAttempts?: number }) {
      const fixture = await seedFixture({
        monitorAttemptCount: 2,
        monitor: input?.maxAttempts ? { maxAttempts: input.maxAttempts } : undefined,
      });
      // Keep the monitor-started run alive long enough to be stopped.
      await db.update(agents).set({
        adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"], cwd: process.cwd() },
      }).where(eq(agents.id, fixture.agentId));
      const heartbeat = heartbeatService(db);
      await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));
      const run = await db.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, fixture.agentId))
        .then((rows) => rows[0]!);
      expect(run.contextSnapshot).toMatchObject({ source: "issue.monitor", monitorAttemptCount: 3 });
      const triggered = await db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!);
      expect(triggered.monitorNextCheckAt).toBeNull();
      expect(triggered.monitorAttemptCount).toBe(3);
      return { ...fixture, heartbeat, runId: run.id };
    }

    it("gives the monitor back: next check still set and attempt count unchanged", async () => {
      const { issueId, heartbeat, runId } = await startMonitorRun({ maxAttempts: 5 });
      const before = Date.now();

      await heartbeat.cancelRun(runId, "Cancelled by a board operator", {
        resultJson: { cancelledByActorType: "user" },
      });

      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorNextCheckAt).not.toBeNull();
      expect(issue.monitorNextCheckAt!.getTime()).toBeGreaterThan(before);
      expect(issue.monitorAttemptCount).toBe(2);
      const monitor = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor;
      expect(monitor).toMatchObject({
        nextCheckAt: issue.monitorNextCheckAt!.toISOString(),
        notes: "Check deploy",
        scheduledBy: "assignee",
        maxAttempts: 5,
      });
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "scheduled",
        attemptCount: 2,
        nextCheckAt: issue.monitorNextCheckAt!.toISOString(),
      });
      const actions = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))
        .then((rows) => rows.map((row) => row.action));
      expect(actions.filter((action) => action === "issue.monitor_restored")).toHaveLength(1);

      // Idempotent: a repeat stop of the finished run changes nothing.
      await heartbeat.cancelRun(runId, "Cancelled by a board operator");
      const again = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(again.monitorNextCheckAt?.toISOString()).toBe(issue.monitorNextCheckAt!.toISOString());
      expect(again.monitorAttemptCount).toBe(2);
    });

    it("keeps the monitor used up when the operator chose stop and cancel monitor", async () => {
      const { issueId, heartbeat, runId } = await startMonitorRun();

      await heartbeat.cancelRun(runId, "Cancelled by a board operator", { cancelMonitor: true });

      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorNextCheckAt).toBeNull();
      expect(issue.monitorAttemptCount).toBe(3);
      expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    });

    it("does not give the monitor back once the issue is re-armed", async () => {
      const { issueId, heartbeat, runId } = await startMonitorRun();
      const rearmedAt = new Date("2026-05-01T00:00:00.000Z");
      await db.update(issues).set({ monitorNextCheckAt: rearmedAt }).where(eq(issues.id, issueId));

      await heartbeat.cancelRun(runId, "Cancelled by a board operator");

      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorNextCheckAt?.toISOString()).toBe(rearmedAt.toISOString());
      expect(issue.monitorAttemptCount).toBe(3);
    });
  });

  describe("GRE-295: a monitor-started run that dies before the provider starts", () => {
    /** The GRE-157 shape: an issue waiting on a one-shot reminder monitor. */
    async function fireParkedReminder(monitor: Record<string, unknown>) {
      const fixture = await seedFixture({
        monitor: { kind: "external_service", serviceName: "reminder", maxAttempts: 1, ...monitor },
      });
      await db.update(agents).set({ adapterType: STARTUP_DEADLINE_TEST_ADAPTER, adapterConfig: {} })
        .where(eq(agents.id, fixture.agentId));
      const heartbeat = heartbeatService(db);
      const before = Date.now();
      const tick = await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));
      expect(tick.enqueued).toBe(1);
      await heartbeat.drainActiveRunExecutions();
      await waitForHeartbeatIdle();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, fixture.agentId));
      expect(run).toMatchObject({ status: "failed", errorCode: "acpx_handshake_timeout" });
      const issue = await db.select().from(issues).where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]!);
      const actions = await db.select().from(activityLog).where(eq(activityLog.entityId, fixture.issueId));
      return { issue, actions, before };
    }

    it("gives the reminder back with its attempt while the monitor timeout is ahead", async () => {
      const { issue, actions, before } = await fireParkedReminder({ timeoutAt: "2099-01-01T08:00:00.000Z" });

      // Not moved to blocked behind a manual hold; the live path is the re-armed monitor.
      expect(issue.status).toBe("in_progress");
      expect(issue.monitorNextCheckAt).not.toBeNull();
      expect(issue.monitorNextCheckAt!.getTime()).toBeGreaterThan(before);
      expect(issue.monitorAttemptCount).toBe(0);
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "scheduled",
        attemptCount: 0,
        maxAttempts: 1,
        timeoutAt: "2099-01-01T08:00:00.000Z",
      });
      const restored = actions.filter((row) => row.action === "issue.monitor_restored");
      expect(restored).toHaveLength(1);
      expect(restored[0]?.details).toMatchObject({ reason: "monitor_run_not_started", attemptCount: 0 });
      // No manual reconciliation hold replaces the live path.
      const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
      expect(holds.filter((row) => row.status === "active")).toHaveLength(0);
    });

    it("re-arms without a refund when the monitor has no timeout, so the attempt budget still bounds it", async () => {
      const { issue } = await fireParkedReminder({});

      expect(issue.monitorNextCheckAt).not.toBeNull();
      expect(issue.monitorAttemptCount).toBe(1);
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "scheduled",
        attemptCount: 1,
      });
    });
  });

  describe("GRE-589: a review-wait monitor on an issue with an open blocker", () => {
    /** An in_review issue whose reviewer waits on a check, optionally behind an open blocker. */
    async function seedReviewWait(input: { blocked: boolean }) {
      const fixture = await seedFixture({
        issueStatus: "in_review",
        monitor: { kind: "external_service", serviceName: REVIEW_WAIT_MONITOR_SERVICE_NAME, externalRef: randomUUID() },
      });
      const reviewerAgentId = randomUUID();
      await db.insert(agents).values({
        id: reviewerAgentId,
        companyId: fixture.companyId,
        name: "Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        permissions: {},
      });
      seededAgentIds.add(reviewerAgentId);
      const monitorState = await db.select({ executionState: issues.executionState }).from(issues)
        .where(eq(issues.id, fixture.issueId))
        .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
      await db.update(issues).set({
        executionState: {
          status: "pending",
          currentStageId: randomUUID(),
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: fixture.agentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: monitorState,
        },
      }).where(eq(issues.id, fixture.issueId));

      let blockerIssueId: string | null = null;
      if (input.blocked) {
        blockerIssueId = randomUUID();
        const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
        await db.insert(issues).values({
          id: blockerIssueId,
          companyId: fixture.companyId,
          title: "Blocker",
          status: "in_progress",
          priority: "medium",
          issueNumber: 2,
          identifier: issue!.identifier!.replace(/-1$/, "-2"),
        });
        await db.insert(issueRelations).values({
          companyId: fixture.companyId,
          issueId: blockerIssueId,
          relatedIssueId: fixture.issueId,
          type: "blocks",
        });
      }
      return { ...fixture, reviewerAgentId, blockerIssueId };
    }

    async function reviewerWakeups(reviewerAgentId: string) {
      return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, reviewerAgentId));
    }

    it("creates no run while the blocker is open and keeps the monitor armed", async () => {
      const { issueId, reviewerAgentId, blockerIssueId } = await seedReviewWait({ blocked: true });
      const tickAt = new Date("2026-04-11T12:31:00.000Z");

      await heartbeatService(db).tickTimers(tickAt);

      expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
      expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      const nextCheckAt = new Date(tickAt.getTime() + REVIEW_WAIT_RECHECK_MS).toISOString();
      expect(issue.monitorNextCheckAt?.toISOString()).toBe(nextCheckAt);
      expect(issue.monitorWakeRequestedAt).toBeNull();
      expect(issue.monitorAttemptCount).toBe(0);
      expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor).toMatchObject({
        nextCheckAt,
        serviceName: REVIEW_WAIT_MONITOR_SERVICE_NAME,
      });
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "scheduled",
        nextCheckAt,
        attemptCount: 0,
      });
      const deferred = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))
        .then((rows) => rows.filter((row) => row.action === "issue.monitor_deferred"));
      expect(deferred).toHaveLength(1);
      expect(deferred[0]?.details).toMatchObject({
        reason: "issue_dependencies_blocked",
        unresolvedBlockerIssueIds: [blockerIssueId],
        targetAgentId: reviewerAgentId,
      });
    });

    it("wakes the reviewer once after the blocker is done", async () => {
      const { issueId, reviewerAgentId, blockerIssueId } = await seedReviewWait({ blocked: true });
      const heartbeat = heartbeatService(db);
      const firstTick = new Date("2026-04-11T12:31:00.000Z");
      await heartbeat.tickTimers(firstTick);
      expect(await reviewerWakeups(reviewerAgentId)).toHaveLength(0);

      await db.update(issues).set({ status: "done", completedAt: firstTick }).where(eq(issues.id, blockerIssueId!));
      const dueTick = new Date(firstTick.getTime() + REVIEW_WAIT_RECHECK_MS + 60_000);
      await heartbeat.tickTimers(dueTick);
      await heartbeat.tickTimers(new Date(dueTick.getTime() + REVIEW_WAIT_RECHECK_MS + 60_000));

      const wakeups = await reviewerWakeups(reviewerAgentId);
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]).toMatchObject({ reason: "execution_review_participant_recovery" });
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorNextCheckAt).toBeNull();
      expect(issue.monitorAttemptCount).toBe(1);
    });

    it("wakes the reviewer as before when the issue has no blocker", async () => {
      const { issueId, agentId, reviewerAgentId } = await seedReviewWait({ blocked: false });

      await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));

      const wakeups = await db.select().from(agentWakeupRequests);
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]).toMatchObject({ agentId: reviewerAgentId, reason: "execution_review_participant_recovery" });
      expect(wakeups.some((wake) => wake.agentId === agentId)).toBe(false);
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorNextCheckAt).toBeNull();
      expect(issue.monitorAttemptCount).toBe(1);
      const actions = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))
        .then((rows) => rows.map((row) => row.action));
      expect(actions).toContain("issue.monitor_triggered");
      expect(actions).not.toContain("issue.monitor_deferred");
    });
  });

  // GRE-755 (follow-up to GRE-589): a reviewer run on an in_review issue ended
  // without a decision while the issue had an open blocker. Review recovery
  // queued execution_review_participant_recovery and dispatch cancelled it at
  // once (issue_dependencies_blocked): 13 such cancels since 4 Oct.
  describe("GRE-755: review participant recovery on an issue with an open blocker", () => {
    /** An in_review issue whose reviewer run ended without a decision, optionally behind an open blocker. */
    async function seedEndedReview(input: { blocked: boolean; reviewRunStatus?: "succeeded" | "failed" }) {
      const companyId = randomUUID();
      const authorAgentId = randomUUID();
      const reviewerAgentId = randomUUID();
      const issueId = randomUUID();
      const reviewRunId = randomUUID();
      const reviewWakeId = randomUUID();
      const finishedAt = new Date("2026-04-11T12:00:00.000Z");
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "GS Agentic Manager",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      for (const [id, name] of [[authorAgentId, "Author"], [reviewerAgentId, "Reviewer"]] as const) {
        await db.insert(agents).values({
          id,
          companyId,
          name,
          role: "engineer",
          status: "active",
          adapterType: "process",
          adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
          permissions: {},
        });
        seededAgentIds.add(id);
      }
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Review behind a blocker",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: authorAgentId,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        executionState: {
          status: "pending",
          currentStageId: randomUUID(),
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
          returnAssignee: { type: "agent", agentId: authorAgentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      });
      await db.insert(agentWakeupRequests).values({
        id: reviewWakeId,
        companyId,
        agentId: reviewerAgentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "execution_review_requested",
        payload: { issueId },
        status: "completed",
        runId: reviewRunId,
        requestedAt: new Date(finishedAt.getTime() - 60_000),
        finishedAt,
        updatedAt: finishedAt,
      });
      await db.insert(heartbeatRuns).values({
        id: reviewRunId,
        companyId,
        agentId: reviewerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: input.reviewRunStatus ?? "succeeded",
        // A failed run that keeps its conversation goes to the sweep's
        // bounded retry, not to legacy reconciliation.
        ...(input.reviewRunStatus === "failed"
          ? { errorCode: "adapter_failed", resultJson: { conversationContinuation: "continue_conversation_v1" } }
          : {}),
        wakeupRequestId: reviewWakeId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "execution_review_requested" },
        startedAt: new Date(finishedAt.getTime() - 60_000),
        finishedAt,
        updatedAt: finishedAt,
      });

      let blockerIssueId: string | null = null;
      if (input.blocked) {
        blockerIssueId = randomUUID();
        await db.insert(issues).values({
          id: blockerIssueId,
          companyId,
          title: "Blocker",
          status: "in_progress",
          priority: "medium",
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        });
        await db.insert(issueRelations).values({
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: issueId,
          type: "blocks",
        });
      }
      return { companyId, issueId, reviewerAgentId, reviewRunId, blockerIssueId };
    }

    async function reviewRecoveryWakeups(reviewerAgentId: string) {
      return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, reviewerAgentId))
        .then((rows) => rows.filter((row) => row.reason === "execution_review_participant_recovery"));
    }

    async function reviewerRunIds(reviewerAgentId: string) {
      return db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, reviewerAgentId))
        .then((rows) => rows.map((row) => row.id));
    }

    /** Releases the issue lock held by the ended review run: the path that queued the cancelled runs. */
    async function releaseReviewRun(companyId: string, issueId: string, runId: string) {
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const release = createReleaseIssueExecution({
        issueLock: createPostgresWakeQueueAdapter(db, {
          resolveResponsibleUserId: async () => "responsible-user",
          getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
          resolveSessionBeforeForWakeup: async () => null,
        }),
        recovery: {
          escalateStrandedAssignedIssue: async () => {},
          escalateStrandedRecoveryIssueInPlace: async () => {},
          scheduleReviewWaitMonitor: async () => {},
        },
      });
      return release({ companyId, runId, now: new Date() });
    }

    it("queues no reviewer run when the review run ends while the blocker is open", async () => {
      const { companyId, issueId, reviewerAgentId, reviewRunId } = await seedEndedReview({ blocked: true });

      const result = await releaseReviewRun(companyId, issueId, reviewRunId);

      expect(result.outcome.kind).toBe("released");
      expect(await reviewRecoveryWakeups(reviewerAgentId)).toHaveLength(0);
      expect(await reviewerRunIds(reviewerAgentId)).toEqual([reviewRunId]);
      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue).toMatchObject({ status: "in_review", executionRunId: null });
    });

    it("still queues the reviewer when the review run ends with no blocker", async () => {
      const { companyId, issueId, reviewerAgentId, reviewRunId } = await seedEndedReview({ blocked: false });

      const result = await releaseReviewRun(companyId, issueId, reviewRunId);

      expect(result.outcome.kind).toBe("queued_review_participant_recovery");
      expect(await reviewRecoveryWakeups(reviewerAgentId)).toHaveLength(1);
    });

    it.each(["succeeded", "failed"] as const)(
      "the stranded-issue sweep creates no reviewer run while the blocker is open (review run %s)",
      async (reviewRunStatus) => {
        const { issueId, reviewerAgentId, reviewRunId } = await seedEndedReview({ blocked: true, reviewRunStatus });

        const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

        expect(result.reviewParticipantRequeued).toBe(0);
        expect(result.escalated).toBe(0);
        expect(await reviewRecoveryWakeups(reviewerAgentId)).toHaveLength(0);
        expect(await reviewerRunIds(reviewerAgentId)).toEqual([reviewRunId]);
        const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
        expect(issue.status).toBe("in_review");
      },
    );

    it("wakes the reviewer once after the blocker is done", async () => {
      const { companyId, issueId, reviewerAgentId, reviewRunId, blockerIssueId } =
        await seedEndedReview({ blocked: true });
      const heartbeat = heartbeatService(db);
      expect((await releaseReviewRun(companyId, issueId, reviewRunId)).outcome.kind).toBe("released");
      await heartbeat.reconcileStrandedAssignedIssues();
      expect(await reviewRecoveryWakeups(reviewerAgentId)).toHaveLength(0);

      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, blockerIssueId!));
      const first = await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.reconcileStrandedAssignedIssues();

      expect(first.reviewParticipantRequeued).toBe(1);
      expect(await reviewRecoveryWakeups(reviewerAgentId)).toHaveLength(1);
    });
  });
});
