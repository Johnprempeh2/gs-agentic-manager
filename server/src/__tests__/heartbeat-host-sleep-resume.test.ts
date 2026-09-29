import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createHostBlindTimeTracker } from "../services/host-blind-time.ts";
import {
  FAILURE_RETRIES_BEFORE_HOST_SLEEP_KEY,
  HOST_SLEEP_RETRY_MAX_ATTEMPTS,
  HOST_SLEEP_RETRY_REASON,
  isHostSleepLoss,
} from "../services/host-sleep-loss.ts";
import {
  accountingForScheduledRetry,
  executionFailureRetryCount,
  executionRetryAttemptCount,
} from "../services/execution-recovery-attempt.ts";

vi.doMock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    type: "process",
    execute: vi.fn(() => new Promise(() => {})),
    testEnvironment: vi.fn(),
  })),
  runningProcesses: new Map(),
}));

const { heartbeatService } = await import("../services/heartbeat.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres host-sleep resume tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MIN = 60_000;
const LEASE_LOST = "Legacy controller lease lost";
const STARTUP_DEADLINE = "The ACP startup handshake did not finish before the startup deadline.";

/**
 * Host timeline in real time: awake from `start`, asleep for `sleepMs` from
 * `sleepAt` (skipped when null), then awake until now.
 */
function hostTimeline(input: { start: number; sleepAt: number | null; sleepMs: number; end: number }) {
  let clock = input.start;
  const tracker = createHostBlindTimeTracker({ now: () => clock, startedAt: input.start });
  const awakeUntil = (to: number) => {
    while (clock < to) {
      clock = Math.min(to, clock + 5_000);
      tracker.sample();
    }
  };
  if (input.sleepAt !== null) {
    awakeUntil(input.sleepAt);
    clock += input.sleepMs;
    tracker.sample();
  }
  awakeUntil(input.end);
  return tracker;
}

describe("host sleep loss (GRE-200)", () => {
  const start = Date.parse("2026-09-29T07:00:00.000Z");
  // 29 Sep: lid closed ~08:03, opened ~09:04.
  const tracker = hostTimeline({
    start,
    sleepAt: Date.parse("2026-09-29T08:03:30.000Z"),
    sleepMs: 61 * MIN,
    end: Date.parse("2026-09-29T10:00:00.000Z"),
  });
  const across = {
    status: "cancelled",
    error: LEASE_LOST,
    startedAt: new Date("2026-09-29T08:03:07.769Z"),
    finishedAt: new Date("2026-09-29T09:04:41.417Z"),
  };

  it("matches a lease loss or startup deadline whose run spans the sleep", () => {
    expect(isHostSleepLoss(across, tracker.blindMsBetween)).toBe(true);
    expect(isHostSleepLoss({ ...across, status: "failed", error: STARTUP_DEADLINE }, tracker.blindMsBetween)).toBe(true);
  });

  it("does not match the same error on an awake host", () => {
    const awake = {
      ...across,
      startedAt: new Date("2026-09-29T09:30:00.000Z"),
      finishedAt: new Date("2026-09-29T09:31:00.000Z"),
    };
    expect(isHostSleepLoss(awake, tracker.blindMsBetween)).toBe(false);
  });

  it("does not match other failures across a sleep, or runs still going", () => {
    expect(isHostSleepLoss({ ...across, error: "Cancelled" }, tracker.blindMsBetween)).toBe(false);
    expect(isHostSleepLoss({ ...across, error: "model_not_found" }, tracker.blindMsBetween)).toBe(false);
    expect(isHostSleepLoss({ ...across, status: "running" }, tracker.blindMsBetween)).toBe(false);
  });
});

describe("host sleep retry accounting (GRE-200)", () => {
  it("keeps the failure count across the sleep lane", () => {
    const spent = {
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 } },
    };
    expect(accountingForScheduledRetry(spent, HOST_SLEEP_RETRY_REASON, 1).failureRetries).toBe(2);
    const sleepRetry = {
      scheduledRetryAttempt: 3,
      scheduledRetryReason: HOST_SLEEP_RETRY_REASON,
      contextSnapshot: {
        executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 },
        [FAILURE_RETRIES_BEFORE_HOST_SLEEP_KEY]: 2,
      },
    };
    expect(executionFailureRetryCount(sleepRetry)).toBe(2);
    expect(executionRetryAttemptCount(sleepRetry, HOST_SLEEP_RETRY_REASON)).toBe(3);
    // The sleep lane is its own bounded counter; a failure lane resets it.
    expect(executionRetryAttemptCount(spent, HOST_SLEEP_RETRY_REASON)).toBe(0);
  });
});

describeEmbeddedPostgres("terminal run recovery after host sleep (GRE-200)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousInWorktree = process.env.GSAM_IN_WORKTREE;

  beforeAll(async () => {
    process.env.GSAM_IN_WORKTREE = "false";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-host-sleep-resume-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
        return;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  });

  afterAll(async () => {
    if (previousInWorktree === undefined) delete process.env.GSAM_IN_WORKTREE;
    else process.env.GSAM_IN_WORKTREE = previousInWorktree;
    await tempDb?.cleanup();
  });

  /**
   * An in_progress issue whose latest run is the second transient retry
   * (the failure budget is spent) and ended with `error` after running from
   * 70 to 5 minutes ago, the 29 Sep shape.
   */
  async function seedLostRun(input: {
    runStatus: "cancelled" | "failed";
    errorCode: string;
    error: string;
    sleptDuringRun: boolean;
    sleepRetryAttempt?: number;
  }) {
    const now = Date.now();
    const startedAt = new Date(now - 70 * MIN);
    const finishedAt = new Date(now - 5 * MIN);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Sleep Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ridge",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "transient_failure_retry",
      payload: { issueId },
      status: input.runStatus,
      runId,
      claimedAt: startedAt,
      finishedAt,
      error: input.error,
    });
    const inSleepLane = input.sleepRetryAttempt !== undefined;
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.runStatus,
      wakeupRequestId,
      scheduledRetryAttempt: inSleepLane ? input.sleepRetryAttempt : 2,
      scheduledRetryReason: inSleepLane ? HOST_SLEEP_RETRY_REASON : "transient_failure",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: inSleepLane ? "host_sleep_resume_retry" : "transient_failure_retry",
        retryReason: inSleepLane ? HOST_SLEEP_RETRY_REASON : "transient_failure",
        executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 },
        ...(inSleepLane ? { [FAILURE_RETRIES_BEFORE_HOST_SLEEP_KEY]: 2 } : {}),
      },
      startedAt,
      finishedAt,
      updatedAt: finishedAt,
      errorCode: input.errorCode,
      error: input.error,
      resultJson: {
        stopReason: input.runStatus,
        conversationContinuation: "continue_conversation_v1",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work that should survive a closed lid",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: null,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt,
    });

    const hostBlindTime = hostTimeline({
      start: now - 3 * 60 * MIN,
      sleepAt: input.sleptDuringRun ? now - 69 * MIN : null,
      sleepMs: 61 * MIN,
      end: now,
    });
    return { agentId, issueId, runId, heartbeat: heartbeatService(db, { hostBlindTime }) };
  }

  async function readState(issueId: string, runId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const successor = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows[0] ?? null);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    return { issue, successor, comments };
  }

  it("resumes a run whose lease was lost across a sleep, without spending the failure budget", async () => {
    const { agentId, issueId, runId, heartbeat } = await seedLostRun({
      runStatus: "cancelled",
      errorCode: "adapter_failed",
      error: LEASE_LOST,
      sleptDuringRun: true,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(0);
    expect(result.continuationRequeued).toBe(1);

    const { issue, successor, comments } = await readState(issueId, runId);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.assigneeAgentId).toBe(agentId);
    expect(comments.filter((c) => c.body.includes("no live execution path"))).toHaveLength(0);
    expect(successor).toMatchObject({
      agentId,
      status: "scheduled_retry",
      scheduledRetryReason: HOST_SLEEP_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });
    expect(executionFailureRetryCount(successor!)).toBe(2);

    // Recovery is idempotent: a second sweep reuses the same successor.
    await heartbeat.reconcileStrandedAssignedIssues();
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(successors).toHaveLength(1);
  });

  it("resumes a run whose startup deadline passed across a sleep, even as setup_failed", async () => {
    const { issueId, runId, heartbeat } = await seedLostRun({
      runStatus: "failed",
      errorCode: "setup_failed",
      error: STARTUP_DEADLINE,
      sleptDuringRun: true,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(0);

    const { issue, successor } = await readState(issueId, runId);
    expect(issue?.status).toBe("in_progress");
    expect(successor).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryReason: HOST_SLEEP_RETRY_REASON,
    });
  });

  it("keeps today's behaviour with no sleep gap: the spent budget blocks the issue", async () => {
    const { issueId, runId, heartbeat } = await seedLostRun({
      runStatus: "cancelled",
      errorCode: "adapter_failed",
      error: LEASE_LOST,
      sleptDuringRun: false,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const { issue, successor, comments } = await readState(issueId, runId);
    expect(issue?.status).toBe("blocked");
    expect(successor).toBeNull();
    expect(comments[0]?.body).toContain("bounded retry budget");
  });

  it("falls back to the failure budget once the sleep lane is spent", async () => {
    const { issueId, runId, heartbeat } = await seedLostRun({
      runStatus: "cancelled",
      errorCode: "adapter_failed",
      error: LEASE_LOST,
      sleptDuringRun: true,
      sleepRetryAttempt: HOST_SLEEP_RETRY_MAX_ATTEMPTS,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const { issue, successor } = await readState(issueId, runId);
    expect(issue?.status).toBe("blocked");
    expect(successor).toBeNull();
  });
});
