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
    summary: "Stale-lock drain test run.",
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
    `Skipping stale-lock deferred wake drain tests on this host: ${
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

// GRE-25 (GRE-23 D1): the stale-lock sweep cleared a dead lock but left the
// wakes that were deferred behind it in `deferred_issue_execution` forever.
describeEmbeddedPostgres("stale-lock sweep drains deferred wakes", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-lock-drain-");
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

  async function seedDeferredWakeBehindDeadLock() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const deadRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: deadRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale lock with a deferred wake",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      checkoutRunId: deadRunId,
      executionRunId: deadRunId,
      executionLockedAt: new Date(),
    });
    runningProcesses.set(deadRunId, {
      child: {} as import("node:child_process").ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });

    const idempotencyKey = `stale-lock-drain:${issueId}`;
    const wake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId },
      idempotencyKey,
      contextSnapshot: { issueId, wakeReason: "issue_blockers_resolved" },
    });
    expect(wake).toBeNull();
    await expect(readWakeStatus(idempotencyKey)).resolves.toBe("deferred_issue_execution");
    return { issueId, deadRunId, idempotencyKey };
  }

  async function readWakeStatus(idempotencyKey: string) {
    const [row] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    return row?.status ?? null;
  }

  // The run ends without its finalizer releasing the issue lock (for example
  // the server stopped between the terminal write and the release).
  async function endRunWithoutRelease(runId: string, status: "succeeded" | "failed") {
    runningProcesses.delete(runId);
    await db
      .update(heartbeatRuns)
      .set({ status, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
  }

  it("promotes a wake deferred behind a lock whose run ended without releasing it", async () => {
    const { issueId, deadRunId, idempotencyKey } = await seedDeferredWakeBehindDeadLock();
    await endRunWithoutRelease(deadRunId, "succeeded");

    const result = await heartbeat.sweepStaleIssueLocks();
    expect(result.issueIds).toEqual([issueId]);

    expect(await readWakeStatus(idempotencyKey)).not.toBe("deferred_issue_execution");
    const successorRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} <> ${deadRunId} and ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`);
    expect(successorRuns).toHaveLength(1);
  });

  it("keeps the wake held when the dead run still needs execution reconciliation", async () => {
    const { issueId, deadRunId, idempotencyKey } = await seedDeferredWakeBehindDeadLock();
    // A failed legacy run with no safe recovery evidence must not be replayed;
    // the normal release holds its queue the same way.
    await endRunWithoutRelease(deadRunId, "failed");

    const result = await heartbeat.sweepStaleIssueLocks();
    expect(result.issueIds).toEqual([issueId]);

    expect(await readWakeStatus(idempotencyKey)).toBe("deferred_issue_execution");
    const successorRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} <> ${deadRunId}`);
    expect(successorRuns).toHaveLength(0);
  });
});
