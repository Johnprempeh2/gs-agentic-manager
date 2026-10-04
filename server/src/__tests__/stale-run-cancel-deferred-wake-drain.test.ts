import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  workspaceOperations,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-run cancel drain test run.",
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
    `Skipping stale-run cancel deferred wake drain tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

// GRE-631 (GRE-595): the executor resubmitted to review while its own run
// still held the issue, so the reviewer's wake was deferred. The release
// promoted an older executor wake instead; the stale-run gate then cancelled
// that run (assignee changed) and cleared the lock without draining, so the
// reviewer's wake stayed `deferred_issue_execution` forever.
describeEmbeddedPostgres("stale-run cancel drains deferred wakes", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-run-cancel-drain-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await waitForCondition(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return runs.every((run) => run.status !== "queued" && run.status !== "running");
    });
    const runIds = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).then((rows) => rows.map((r) => r.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return id;
  }

  async function readWakeStatus(idempotencyKey: string) {
    const [row] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    return row?.status ?? null;
  }

  it("promotes the reviewer's wake after the old owner's promoted run is cancelled as stale", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const executorId = await insertAgent(companyId, "Mica");
    const reviewerId = await insertAgent(companyId, "Keystone");
    const issueId = randomUUID();
    const executorRunId = randomUUID();
    const stageId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: executorRunId,
      companyId,
      agentId: executorId,
      status: "running",
      invocationSource: "automation",
      startedAt: new Date(),
      contextSnapshot: { issueId, wakeReason: "issue_commented" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resubmitted to review while the executor run held the issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: executorId,
      responsibleUserId: "responsible-user",
      checkoutRunId: executorRunId,
      executionRunId: executorRunId,
      executionLockedAt: new Date(),
    });
    runningProcesses.set(executorRunId, {
      child: {} as import("node:child_process").ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });

    // 1. An older executor wake (blocker resolved) is parked behind its own run.
    const executorKey = `stale-run-drain:executor:${issueId}`;
    expect(await heartbeat.wakeup(executorId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId },
      idempotencyKey: executorKey,
      contextSnapshot: { issueId, wakeReason: "issue_blockers_resolved" },
    })).toBeNull();

    // 2. The same run resubmits to review: the issue moves to the reviewer.
    const executionState = {
      status: "pending",
      monitor: null,
      reviewRequest: null,
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
      returnAssignee: { type: "agent", agentId: executorId, userId: null },
      completedStageIds: [],
      lastDecisionId: randomUUID(),
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount: 1,
    };
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: reviewerId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId, userId: null }],
        }],
      },
      executionState,
    }).where(eq(issues.id, issueId));

    const reviewerKey = `stale-run-drain:reviewer:${issueId}`;
    expect(await heartbeat.wakeup(reviewerId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "execution_review_requested",
      payload: { issueId, mutation: "update" },
      idempotencyKey: reviewerKey,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "execution_review_requested", source: "issue.execution_stage" },
    })).toBeNull();
    expect(await readWakeStatus(executorKey)).toBe("deferred_issue_execution");
    expect(await readWakeStatus(reviewerKey)).toBe("deferred_issue_execution");

    // 3. The executor run ends. Replay its release (the sweep uses the same
    // drain as a normal finish). The drain promotes the older executor wake.
    runningProcesses.delete(executorRunId);
    await db.update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, executorRunId));
    await heartbeat.sweepStaleIssueLocks();

    // The promoted executor run is cancelled before start: the issue now
    // belongs to the reviewer.
    const executorCancelled = await waitForCondition(async () => {
      const rows = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.agentId} = ${executorId} and ${heartbeatRuns.id} <> ${executorRunId}`);
      return rows.some((row) => row.status === "cancelled" && row.errorCode === "issue_assignee_changed");
    });
    expect(executorCancelled).toBe(true);

    // 4. The reviewer must get a live run; the wake must not stay parked.
    const reviewerWoken = await waitForCondition(async () => {
      const rows = await db.select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.agentId} = ${reviewerId} and ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`);
      return rows.length > 0;
    });
    expect(await readWakeStatus(reviewerKey)).not.toBe("deferred_issue_execution");
    expect(reviewerWoken).toBe(true);

    // Let the reviewer run settle before cleanup deletes its rows.
    const reviewerRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerId));
    await waitForCondition(async () => {
      const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, reviewerId));
      return rows.every((row) => row.status !== "queued" && row.status !== "running");
    });
    await Promise.all(reviewerRuns.map((run) => heartbeat.waitForRunExecutionDrain(run.id)));
  });
});
