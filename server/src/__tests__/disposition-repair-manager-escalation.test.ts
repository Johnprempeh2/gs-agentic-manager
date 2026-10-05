// GRE-753 (register row 75): when disposition repair gives up on an agent's
// task, the agent's manager owns the recovery and is woken once. The board owns
// it only when there is no usable manager, or on a second give-up.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Manager looked at the escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "test-private-reference") }),
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
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres disposition repair manager escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MANAGER_WAKE_KEY_SUFFIX = ":manager_escalation";

describeEmbeddedPostgres("disposition repair give-up routes to the assignee's manager (GRE-753)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-disposition-manager-escalation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    vi.clearAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(agentTaskSessions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
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
  }, 30_000);

  async function seedExhaustedRepair(opts: { withManager: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const managerId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-10-05T02:00:00.000Z");
    const finishedAt = new Date("2026-10-05T02:05:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    if (opts.withManager) {
      await db.insert(agents).values({
        id: managerId,
        companyId,
        name: "Everest",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ridge",
      role: "engineer",
      status: "idle",
      reportsTo: opts.withManager ? managerId : null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await insertParkedRepairRun({ companyId, agentId, issueId, runId, wakeupRequestId, startedAt: now, finishedAt });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Agent-only task that keeps parking",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });
    // The repair runs posted comments, which the source fingerprint ignores (GRE-712).
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Handing back: waiting on review of the PR.",
      createdAt: finishedAt,
    });
    await markRepairExhausted(issueId, runId);
    return { companyId, agentId, managerId, runId, issueId };
  }

  async function insertParkedRepairRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
    wakeupRequestId: string;
    startedAt: Date;
    finishedAt: Date;
  }) {
    await db.insert(agentWakeupRequests).values({
      id: input.wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_disposition_repair",
      payload: { issueId: input.issueId },
      status: "cancelled",
      runId: input.runId,
      claimedAt: input.startedAt,
      finishedAt: input.finishedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "cancelled",
      wakeupRequestId: input.wakeupRequestId,
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId, wakeReason: "issue_disposition_repair" },
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      updatedAt: input.finishedAt,
      errorCode: "issue_continuation_waiting_on_review",
      error: "Continuation parked",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
  }

  async function markRepairExhausted(issueId: string, runId: string) {
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    const state = await collectDispositionRepairSourceState(db, { issue });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_disposition_repair",
          retryReason: "issue_disposition_repair",
          dispositionRepairFingerprint: state.fingerprint,
          dispositionRepairAttempt: 5,
          dispositionRepairMaxAttempts: 5,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
  }

  function managerWakes(companyId: string, issueId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.idempotencyKey} = ${`issue_disposition_repair:${issueId}${MANAGER_WAKE_KEY_SUFFIX}`}`,
        ),
      );
  }

  function activeAction(companyId: string, issueId: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, issueId),
          eq(issueRecoveryActions.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  it("names the manager as owner and wakes it once with the attempts and last hand-back", async () => {
    const { companyId, agentId, managerId, issueId } = await seedExhaustedRepair({ withManager: true });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(result).toMatchObject({ dispositionRepairRequeued: 0, escalated: 1 });

    const [issue, action, wakes, comments] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!),
      activeAction(companyId, issueId),
      managerWakes(companyId, issueId),
      db.select().from(issueComments).where(eq(issueComments.issueId, issueId)),
    ]);
    expect(issue).toMatchObject({ status: "blocked", assigneeAgentId: agentId });
    expect(action).toMatchObject({
      ownerType: "agent",
      ownerAgentId: managerId,
      returnOwnerAgentId: agentId,
      wakePolicy: expect.objectContaining({ type: "manager_escalation", reason: "unchanged_source_state_exhausted" }),
      evidence: expect.objectContaining({ routingPolicy: "manager_escalation_once_v1", sourceAttemptCount: 5 }),
    });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentId: managerId,
      reason: "source_scoped_recovery_action",
      payload: expect.objectContaining({ issueId, recoveryActionId: action!.id }),
    });
    const notice = comments.find((comment) => comment.metadata?.recovery?.kind === "disposition_repair_escalated");
    expect(notice?.body).toContain("Attempts: 5/5");
    expect(notice?.body).toContain("Recovery owner: Everest (manager of the assigned agent)");
    expect(notice?.body).toContain("> Handing back: waiting on review of the PR.");
    expect(wakes[0]!.payload).toMatchObject({ commentId: notice!.id });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakes[0]!.id));
    expect(run?.contextSnapshot).toMatchObject({
      issueId,
      wakeReason: "source_scoped_recovery_action",
      recoveryActionId: action!.id,
      dispositionRepairEscalation: {
        assigneeAgentId: agentId,
        attemptCount: 5,
        maxAttempts: 5,
        terminalReason: "unchanged_source_state_exhausted",
        lastHandBackExcerpt: "Handing back: waiting on review of the PR.",
      },
    });

    // The sweep that follows must leave the manager-owned action alone.
    await heartbeatService(db).drainActiveRunExecutions();
    const again = await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(again.escalated).toBe(0);
    expect(await managerWakes(companyId, issueId)).toHaveLength(1);
    expect(await activeAction(companyId, issueId)).toMatchObject({ ownerAgentId: managerId });
  });

  it("keeps the board as owner when the agent has no manager", async () => {
    const { companyId, agentId, issueId } = await seedExhaustedRepair({ withManager: false });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const action = await activeAction(companyId, issueId);
    expect(action).toMatchObject({
      ownerType: "board",
      ownerAgentId: null,
      wakePolicy: expect.objectContaining({ type: "board_escalation" }),
      evidence: expect.objectContaining({ routingPolicy: "board_escalation_no_takeover_v1" }),
    });
    const otherWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), sql`${agentWakeupRequests.agentId} <> ${agentId}`));
    expect(otherWakes).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("Recovery owner: board"))).toBe(true);
  });

  it("does not wake the manager again on a second give-up for the same task", async () => {
    const { companyId, agentId, managerId, issueId } = await seedExhaustedRepair({ withManager: true });

    await heartbeatService(db).reconcileStrandedAssignedIssues();
    await heartbeatService(db).drainActiveRunExecutions();
    expect(await managerWakes(companyId, issueId)).toHaveLength(1);

    // The manager hands the task back; the agent parks again and repair gives up again.
    const first = await activeAction(companyId, issueId);
    await db
      .update(issueRecoveryActions)
      .set({ status: "resolved", outcome: "restored", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.id, first!.id));
    const secondRunId = randomUUID();
    const parkedAt = new Date();
    await insertParkedRepairRun({
      companyId,
      agentId,
      issueId,
      runId: secondRunId,
      wakeupRequestId: randomUUID(),
      startedAt: parkedAt,
      finishedAt: parkedAt,
    });
    await db
      .update(issues)
      .set({ status: "in_progress", checkoutRunId: secondRunId, executionRunId: null })
      .where(eq(issues.id, issueId));
    await markRepairExhausted(issueId, secondRunId);

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const second = await activeAction(companyId, issueId);
    expect(second).toMatchObject({
      ownerType: "board",
      ownerAgentId: null,
      wakePolicy: expect.objectContaining({ type: "board_escalation" }),
    });
    const wakes = await managerWakes(companyId, issueId);
    expect(wakes).toHaveLength(1);
    const managerWakeCount = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, managerId)));
    expect(managerWakeCount).toHaveLength(1);
  });
});
