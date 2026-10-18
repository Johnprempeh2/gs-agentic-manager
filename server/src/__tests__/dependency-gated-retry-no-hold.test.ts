import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  issueComments,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
  workspaceOperations,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@greatstone/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@greatstone/shared/telemetry")>(
    "@greatstone/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "ok",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { legacyExecutionNeedsReconciliation, LEGACY_RECOVERY_CAUSE } from "../services/legacy-execution-recovery.ts";
import { runningProcesses } from "../adapters/index.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

// GRE-1444 (week-2 R1: GRE-1094, GRE-1190, GRE-1082): a scheduled retry that
// the dispatch gate cancels because dependencies are still blocked never
// started provider work. Without that evidence the stranded-work sweep held
// the issue for execution reconciliation, and every later wake (assignment,
// comment, mention, blockers resolved) was skipped or parked for good.
describeEmbeddedPostgres("dependency-gated scheduled retry does not hold the issue", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-dependency-gated-retry-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const dependentId = randomUUID();
    const blockerId = randomUUID();
    const sourceRunId = randomUUID();
    const retryRunId = randomUUID();
    const prefix = `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "GSAM", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: randomUUID(),
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ridge",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${prefix}-1`,
      },
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: `${prefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: dependentId, type: "blocks" });
    const longAgo = new Date(Date.now() - 60 * 60_000);
    // The comment wake's run, cancelled at dispatch with bootstrap evidence.
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "cancelled",
      error: "Cancelled because issue dependencies are still blocked; GS Agentic Manager will wake the assignee when blockers resolve",
      errorCode: "issue_dependencies_blocked",
      contextSnapshot: { issueId: dependentId },
      resultJson: {
        stopReason: "issue_dependencies_blocked",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
      createdAt: longAgo,
      finishedAt: longAgo,
    });
    // Its transient retry, due now, as seen on GRE-1094 run 6fa9ed6b.
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      scheduledRetryAt: new Date(Date.now() - 30 * 60_000),
      contextSnapshot: { issueId: dependentId },
      createdAt: new Date(longAgo.getTime() + 1_000),
    });
    return { companyId, agentId, dependentId, blockerId, retryRunId };
  }

  async function legacyHolds(issueId: string) {
    return db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
    ));
  }

  it("records that the suppressed retry never started and leaves no reconciliation hold", async () => {
    const { dependentId, retryRunId } = await seed();
    const heartbeat = heartbeatService(db);

    await heartbeat.promoteDueScheduledRetries(new Date());
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId));
    expect(retry).toMatchObject({ status: "cancelled", errorCode: "issue_dependencies_blocked" });
    expect(retry!.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(legacyExecutionNeedsReconciliation(retry!)).toBe(false);

    await heartbeat.reconcileStrandedAssignedIssues();
    expect(await legacyHolds(dependentId)).toHaveLength(0);
  });

  it("wakes the assignee once the blocker finishes", async () => {
    const { companyId, dependentId, blockerId } = await seed();
    const heartbeat = heartbeatService(db);
    await heartbeat.promoteDueScheduledRetries(new Date());
    await heartbeat.reconcileStrandedAssignedIssues();

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
    await heartbeat.reconcileResolvedDependencyWakes({ companyId, issueIds: [dependentId] });

    const wakes = (await db.select().from(agentWakeupRequests)).filter(
      (row) => (row.payload as Record<string, unknown> | null)?.issueId === dependentId &&
        row.reason === "issue_blockers_resolved",
    );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.status).not.toBe("skipped");
    expect(await legacyHolds(dependentId)).toHaveLength(0);
  });
});
