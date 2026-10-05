import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  issueRecoveryActions,
  issueRelations,
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
    summary: "Parked hand-off restart test run.",
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
    `Skipping parked hand-off wake restart tests on this host: ${
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

// GRE-750 (register row 50, GRE-595): a review hand-off wake parked behind the
// executor's run carries no comment ids. When the release that should send it
// is lost, the stranded-queue sweep skipped it and the reviewer never woke.
describeEmbeddedPostgres("sweep restarts parked hand-off wakes", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-parked-handoff-restart-");
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
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issueRelations);
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

  // The executor's run holds the task, the task moves to the reviewer, and
  // the reviewer's wake is parked. The run then ends but its release is lost:
  // the lock is gone and nothing sends the parked wake.
  async function parkReviewHandoffAndLoseRelease(
    executorRunEnd: Partial<typeof heartbeatRuns.$inferInsert> = { status: "succeeded" },
  ) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Hand-off wake parked behind the executor run",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerId,
      responsibleUserId: "responsible-user",
      checkoutRunId: executorRunId,
      executionRunId: executorRunId,
      executionLockedAt: new Date(),
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
      executionState: {
        status: "pending",
        monitor: null,
        reviewRequest: null,
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
        returnAssignee: { type: "agent", agentId: executorId, userId: null },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
    });
    runningProcesses.set(executorRunId, {
      child: {} as import("node:child_process").ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });

    const reviewerKey = `parked-handoff:reviewer:${issueId}`;
    expect(await heartbeat.wakeup(reviewerId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "execution_review_requested",
      payload: { issueId, mutation: "update" },
      idempotencyKey: reviewerKey,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "execution_review_requested", source: "issue.execution_stage" },
    })).toBeNull();

    runningProcesses.delete(executorRunId);
    await db.update(heartbeatRuns)
      .set({ finishedAt: new Date(), updatedAt: new Date(), ...executorRunEnd })
      .where(eq(heartbeatRuns.id, executorRunId));
    await db.update(issues)
      .set({ executionRunId: null, executionLockedAt: null, executionAgentNameKey: null, checkoutRunId: null })
      .where(eq(issues.id, issueId));

    return { companyId, executorId, reviewerId, issueId, reviewerKey };
  }

  async function readWakeStatus(idempotencyKey: string) {
    const [row] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    return row?.status ?? null;
  }

  async function ageWake(idempotencyKey: string) {
    await db.update(agentWakeupRequests)
      .set({ updatedAt: new Date(Date.now() - 3 * 60 * 1000) })
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
  }

  async function countRuns(agentId: string, issueId: string) {
    const rows = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((row) => (row.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId).length;
  }

  async function settleRuns(agentId: string) {
    await waitForCondition(async () => {
      const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows.every((row) => row.status !== "queued" && row.status !== "running");
    }, 15_000);
    const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    await Promise.all(rows.map((run) => heartbeat.waitForRunExecutionDrain(run.id)));
  }

  it("restarts a parked review hand-off once, after it has waited two minutes", async () => {
    const { reviewerId, issueId, reviewerKey } = await parkReviewHandoffAndLoseRelease();

    // A fresh wake is left alone: the normal release may still be on its way.
    await heartbeat.resumeQueuedRuns();
    expect(await readWakeStatus(reviewerKey)).toBe("deferred_issue_execution");
    expect(await countRuns(reviewerId, issueId)).toBe(0);

    await ageWake(reviewerKey);
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => (await countRuns(reviewerId, issueId)) === 1)).toBe(true);
    expect(await readWakeStatus(reviewerKey)).not.toBe("deferred_issue_execution");

    // A second sweep must not start another reviewer run.
    await heartbeat.resumeQueuedRuns();
    expect(await countRuns(reviewerId, issueId)).toBe(1);
    await settleRuns(reviewerId);
  });

  it("leaves the wake parked while the reviewer is paused, then restarts it after resume", async () => {
    const { reviewerId, issueId, reviewerKey } = await parkReviewHandoffAndLoseRelease();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerId));
    await ageWake(reviewerKey);

    await heartbeat.resumeQueuedRuns();
    expect(await readWakeStatus(reviewerKey)).toBe("deferred_issue_execution");
    expect(await countRuns(reviewerId, issueId)).toBe(0);

    await db.update(agents).set({ status: "active" }).where(eq(agents.id, reviewerId));
    await ageWake(reviewerKey);
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => (await countRuns(reviewerId, issueId)) === 1)).toBe(true);
    await settleRuns(reviewerId);
  });

  it("does not restart the wake when the operator stopped the last run", async () => {
    const { reviewerId, issueId, reviewerKey } = await parkReviewHandoffAndLoseRelease({
      status: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    await ageWake(reviewerKey);

    await heartbeat.resumeQueuedRuns();
    expect(await readWakeStatus(reviewerKey)).toBe("deferred_issue_execution");
    expect(await countRuns(reviewerId, issueId)).toBe(0);
  });

  it("does not restart the wake while a recovery hold is active", async () => {
    const { companyId, reviewerId, issueId, reviewerKey } = await parkReviewHandoffAndLoseRelease();
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "execution_reconciliation",
      status: "active",
      cause: "uncertain_provider_action",
      fingerprint: `parked-handoff-hold:${issueId}`,
      nextAction: "Confirm the provider action before replay.",
      evidence: {},
    });
    await ageWake(reviewerKey);

    await heartbeat.resumeQueuedRuns();
    expect(await readWakeStatus(reviewerKey)).toBe("deferred_issue_execution");
    expect(await countRuns(reviewerId, issueId)).toBe(0);
    const [hold] = await db.select({ status: issueRecoveryActions.status }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
    expect(hold?.status).toBe("active");
  });

  // GRE-755: a task that still waits on an open blocker gets no run; the
  // wake is sent once the blocker is done.
  it("leaves the wake parked while the task has an open blocker, then restarts it", async () => {
    const { companyId, reviewerId, issueId, reviewerKey } = await parkReviewHandoffAndLoseRelease();
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Open blocker",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    await ageWake(reviewerKey);

    await heartbeat.resumeQueuedRuns();
    expect(await readWakeStatus(reviewerKey)).toBe("deferred_issue_execution");
    expect(await countRuns(reviewerId, issueId)).toBe(0);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => (await countRuns(reviewerId, issueId)) === 1)).toBe(true);
    await settleRuns(reviewerId);
  });
});
