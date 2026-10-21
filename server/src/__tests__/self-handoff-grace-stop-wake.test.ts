import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
    summary: "Self-handoff grace stop test run.",
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
    `Skipping self-handoff grace stop wake tests on this host: ${
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

// GRE-1668 (R1, 21 Oct): Everest handed its own task to Mica (GRE-36 self
// hand-off) and posted "Assigned to Mica". Mica's wake was parked behind
// Everest's run. The run was still going when the grace period ended, so it
// was stopped, and the release treated that stop like an operator Stop: no
// drain. The stranded-queue sweep then looked only for a run by Mica on the
// task, found none, and skipped the wake on every tick. Mica never woke.
describeEmbeddedPostgres("self-handoff grace stop still wakes the new assignee", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-handoff-grace-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  });

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

  // The old owner's run holds the task and hands it to the new owner, whose
  // assignment wake parks behind the run. The old owner then comments, and
  // that comment joins the parked wake. The run ends with `oldOwnerRunEnd`;
  // like the live claude_local run it carries the conversation-continuation
  // policy, so the release needs no action-outcome reconciliation.
  async function selfHandoffWithParkedWake(oldOwnerRunEnd: Partial<typeof heartbeatRuns.$inferInsert>) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const oldOwnerId = await insertAgent(companyId, "Everest");
    const newOwnerId = await insertAgent(companyId, "Mica");
    const issueId = randomUUID();
    const oldOwnerRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: oldOwnerRunId,
      companyId,
      agentId: oldOwnerId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task handed over by its own run",
      status: "todo",
      priority: "medium",
      assigneeAgentId: newOwnerId,
      responsibleUserId: "responsible-user",
      checkoutRunId: oldOwnerRunId,
      executionRunId: oldOwnerRunId,
      executionLockedAt: new Date(),
    });
    runningProcesses.set(oldOwnerRunId, {
      child: {} as import("node:child_process").ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });

    expect(await heartbeat.wakeup(newOwnerId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update", handoffFromRunId: oldOwnerRunId },
      requestedByActorType: "agent",
      requestedByActorId: oldOwnerId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned", source: "issue.update", handoffFromRunId: oldOwnerRunId },
    })).toBeNull();

    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: oldOwnerId,
      authorType: "agent",
      createdByRunId: oldOwnerRunId,
      body: "Assigned to Mica.",
    });
    expect(await heartbeat.wakeup(newOwnerId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId, mutation: "comment" },
      requestedByActorType: "agent",
      requestedByActorId: oldOwnerId,
      contextSnapshot: { issueId, taskId: issueId, commentId, wakeCommentId: commentId, wakeReason: "issue_commented", source: "issue.comment" },
    })).toBeNull();

    runningProcesses.delete(oldOwnerRunId);
    await db.update(heartbeatRuns)
      .set({ finishedAt: new Date(), updatedAt: new Date(), ...oldOwnerRunEnd })
      .where(eq(heartbeatRuns.id, oldOwnerRunId));
    await db.update(issues)
      .set({ executionRunId: null, executionLockedAt: null, executionAgentNameKey: null, checkoutRunId: null })
      .where(eq(issues.id, issueId));

    const parked = await readNewOwnerWakes(newOwnerId);
    expect(parked).toHaveLength(1);
    expect(parked[0]?.status).toBe("deferred_issue_execution");
    return { newOwnerId, issueId, oldOwnerRunId };
  }

  async function readNewOwnerWakes(agentId: string) {
    return db.select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
  }

  async function ageWakes(agentId: string) {
    await db.update(agentWakeupRequests)
      .set({ updatedAt: new Date(Date.now() - 3 * 60 * 1000) })
      .where(eq(agentWakeupRequests.agentId, agentId));
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

  it("wakes the new assignee once after the grace period stopped the old owner's run", async () => {
    const { newOwnerId, issueId } = await selfHandoffWithParkedWake({
      status: "cancelled",
      errorCode: "issue_reassigned",
      error: "Stopped after the self-handoff grace period ended",
      resultJson: {
        conversationContinuation: "continue_conversation_v1",
        executionCancellation: { state: "acknowledged" },
        reassignmentStopConfirmed: true,
        handoffGraceExpired: true,
      },
    });
    await ageWakes(newOwnerId);

    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => (await countRuns(newOwnerId, issueId)) === 1)).toBe(true);
    expect((await readNewOwnerWakes(newOwnerId)).every((wake) => wake.status !== "deferred_issue_execution")).toBe(true);

    // A second sweep must not start another run.
    await heartbeat.resumeQueuedRuns();
    expect(await countRuns(newOwnerId, issueId)).toBe(1);
    await settleRuns(newOwnerId);
  });

  it("still leaves the wake parked when an operator stopped the old owner's run", async () => {
    const { newOwnerId, issueId } = await selfHandoffWithParkedWake({
      status: "cancelled",
      resultJson: { conversationContinuation: "continue_conversation_v1", executionCancellation: { state: "acknowledged" } },
    });
    await ageWakes(newOwnerId);

    await heartbeat.resumeQueuedRuns();
    expect((await readNewOwnerWakes(newOwnerId))[0]?.status).toBe("deferred_issue_execution");
    expect(await countRuns(newOwnerId, issueId)).toBe(0);
  });
});
