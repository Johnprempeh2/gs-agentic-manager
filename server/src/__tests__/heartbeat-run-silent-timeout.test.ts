import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  agentTaskSessions,
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
import {
  DEFAULT_RUN_SILENT_TIMEOUT_MS,
  RUN_SILENT_TIMEOUT_ERROR_CODE,
  RUN_SILENT_TIMEOUT_RETRY_WAKE_REASON,
  resolveRunSilentTimeoutMs,
  runRequiresFreshSession,
} from "../services/run-silent-timeout.ts";

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
    `Skipping embedded Postgres silent-run timeout tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("run silent timeout policy", () => {
  it("defaults to 20 minutes, honours per-agent config, and 0 turns it off", () => {
    expect(resolveRunSilentTimeoutMs({})).toBe(DEFAULT_RUN_SILENT_TIMEOUT_MS);
    expect(DEFAULT_RUN_SILENT_TIMEOUT_MS).toBe(20 * 60 * 1000);
    expect(resolveRunSilentTimeoutMs({ heartbeat: { silentTimeoutSec: 600 } })).toBe(600_000);
    expect(resolveRunSilentTimeoutMs({ heartbeat: { silentTimeoutSec: 0 } })).toBeNull();
    expect(resolveRunSilentTimeoutMs({ heartbeat: { silentTimeoutSec: 5 } })).toBe(60_000);
  });

  it("flags silent-timeout and hung-cancel runs for a fresh session", () => {
    expect(runRequiresFreshSession({ errorCode: RUN_SILENT_TIMEOUT_ERROR_CODE })).toBe(true);
    expect(runRequiresFreshSession({ errorCode: "cancelled", resultJson: { freshSessionOnRetry: true } })).toBe(true);
    expect(runRequiresFreshSession({ errorCode: "cancelled", resultJson: {} })).toBe(false);
  });
});

describeEmbeddedPostgres("heartbeat silent-run stop (GRE-34)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousInWorktree = process.env.GSAM_IN_WORKTREE;

  beforeAll(async () => {
    // A worktree instance suppresses all wakes; this suite needs the retry wake.
    process.env.GSAM_IN_WORKTREE = "false";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-silent-timeout-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    if (previousInWorktree === undefined) delete process.env.GSAM_IN_WORKTREE;
    else process.env.GSAM_IN_WORKTREE = previousInWorktree;
    await tempDb?.cleanup();
  });

  async function seed(opts: { silentMs: number; priorSilentStop?: boolean }) {
    const now = new Date();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Silent Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Hung work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    if (opts.priorSilentStop) {
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        status: "cancelled",
        invocationSource: "automation",
        errorCode: RUN_SILENT_TIMEOUT_ERROR_CODE,
        contextSnapshot: { issueId },
        createdAt: new Date(startedAt.getTime() - 60_000),
        finishedAt: startedAt,
      });
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt: new Date(now.getTime() - opts.silentMs),
      lastOutputSeq: 4,
      lastOutputStream: "stdout",
      contextSnapshot: { issueId, taskId: issueId },
      logBytes: 0,
    });
    await db
      .update(issues)
      .set({ executionRunId: runId, checkoutRunId: runId })
      .where(eq(issues.id, issueId));
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "claude_local",
      taskKey: issueId,
      sessionParamsJson: { sessionId: "broken-session" },
      sessionDisplayId: "broken-session",
      lastRunId: runId,
    });
    return { now, companyId, agentId, issueId, runId };
  }

  it("stops a silent run, drops its session and queues one fresh-session retry", async () => {
    const { now, companyId, agentId, issueId, runId } = await seed({ silentMs: 25 * 60 * 1000 });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.silentStops).toMatchObject({ stopped: 1, retried: 1, escalated: 0 });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({ status: "cancelled", errorCode: RUN_SILENT_TIMEOUT_ERROR_CODE });

    const sessions = await db
      .select()
      .from(agentTaskSessions)
      .where(and(eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.taskKey, issueId)));
    expect(sessions).toHaveLength(0);

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, RUN_SILENT_TIMEOUT_RETRY_WAKE_REASON));
    expect(wakes).toHaveLength(1);
    const retryRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot}->>'silentTimeoutRetryOfRunId' = ${runId}`);
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]!.contextSnapshot).toMatchObject({ issueId, forceFreshSession: true });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const silentComments = comments.filter((c) => c.body.includes(RUN_SILENT_TIMEOUT_ERROR_CODE));
    expect(silentComments).toHaveLength(1);
    expect(silentComments[0]!.body).toContain("fresh retry");

    // Idempotent: a second scan does not stop or retry again.
    const again = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(again.silentStops.stopped).toBe(0);
    expect(
      await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, RUN_SILENT_TIMEOUT_RETRY_WAKE_REASON)),
    ).toHaveLength(1);
  });

  it("does not stop a run that is still writing output", async () => {
    const { now, companyId, runId } = await seed({ silentMs: 5 * 60 * 1000 });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.silentStops.stopped).toBe(0);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.status).toBe("running");
    await heartbeat.cancelRun(runId, "test cleanup");
  });

  it("blocks the issue instead of retrying when the fresh retry also hangs", async () => {
    const { now, companyId, issueId, runId } = await seed({
      silentMs: 25 * 60 * 1000,
      priorSilentStop: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.silentStops).toMatchObject({ stopped: 1, retried: 0, escalated: 1 });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.errorCode).toBe(RUN_SILENT_TIMEOUT_ERROR_CODE);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("blocked");
    expect(
      await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, RUN_SILENT_TIMEOUT_RETRY_WAKE_REASON)),
    ).toHaveLength(0);
  });

  it("a manual cancel of a hung run drops the session so the retry starts fresh", async () => {
    const { agentId, issueId, runId } = await seed({ silentMs: 45 * 60 * 1000 });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(runId, "Cancelled by board");

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.status).toBe("cancelled");
    expect(runRequiresFreshSession(run)).toBe(true);
    const sessions = await db
      .select()
      .from(agentTaskSessions)
      .where(and(eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.taskKey, issueId)));
    expect(sessions).toHaveLength(0);
  });

  it("a manual cancel of a live run keeps its session", async () => {
    const { agentId, issueId, runId } = await seed({ silentMs: 2 * 60 * 1000 });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(runId, "Cancelled by board");

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runRequiresFreshSession(run)).toBe(false);
    const sessions = await db
      .select()
      .from(agentTaskSessions)
      .where(and(eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.taskKey, issueId)));
    expect(sessions).toHaveLength(1);
  });
});
