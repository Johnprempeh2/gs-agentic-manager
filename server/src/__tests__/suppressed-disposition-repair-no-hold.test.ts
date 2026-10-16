import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "ok", provider: "test", model: "test-model",
      })),
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { recoveryService } from "../services/recovery/service.ts";
import { legacyExecutionNeedsReconciliation, LEGACY_RECOVERY_CAUSE } from "../services/legacy-execution-recovery.ts";
import { runningProcesses } from "../adapters/index.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

// GRE-1560 (14 Oct R1: GRE-193): a disposition repair was queued while the
// task was in_progress. Before it dispatched, the task moved to review, so the
// dispatch gate cancelled the repair as "recorded_disposition". The cancel
// carried no "provider never started" evidence, so the stranded-work sweep
// held the task for execution reconciliation, and every later wake (review
// changes requested, comments) was skipped or parked for good.
describeEmbeddedPostgres("suppressed disposition repair does not hold the issue", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-suppressed-repair-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    runningProcesses.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedQueuedRepair() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Repair Co", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "fixture-owner",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Beacon", role: "pm", status: "idle", adapterType: "test_adapter",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Full experimental build", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, responsibleUserId: "fixture-owner",
    });
    // A successful turn that left no disposition: the repair source.
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, invocationSource: "on_demand", status: "succeeded", runtimeMode: "legacy",
      contextSnapshot: { issueId }, livenessState: "blocked", finishedAt: new Date(),
      resultJson: { summary: "All done. Need approval. I will continue." },
    });
    const recovery = recoveryService(db, {
      enqueueWakeup: async (targetAgentId, opts) => db.transaction(async (tx) => {
        const [wake] = await tx.insert(agentWakeupRequests).values({
          companyId, agentId: targetAgentId, source: "automation", reason: opts?.reason, payload: opts?.payload,
          idempotencyKey: opts?.idempotencyKey, status: "queued",
        }).returning();
        const [run] = await tx.insert(heartbeatRuns).values({
          companyId, agentId: targetAgentId, invocationSource: "automation", triggerDetail: "system", status: "queued",
          runtimeMode: "legacy", wakeupRequestId: wake.id, contextSnapshot: opts?.contextSnapshot,
        }).returning();
        await tx.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
        return run;
      }),
    });
    await recovery.reconcileLegacyContinuation(sourceRunId);
    const [repair] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued"),
    ));
    expect(repair?.contextSnapshot).toMatchObject({ legacyDispositionEpisode: { id: sourceRunId } });
    return { companyId, agentId, issueId, repairRunId: repair!.id };
  }

  async function waitForSettled(runId: string) {
    const heartbeat = heartbeatService(db);
    let run: typeof heartbeatRuns.$inferSelect | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      void heartbeat.resumeQueuedRuns().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
      [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (run && !["queued", "running"].includes(run.status)) break;
    }
    return run;
  }

  it("records that the suppressed repair never reached the provider and leaves no reconciliation hold", { timeout: 30_000 }, async () => {
    const { issueId, repairRunId } = await seedQueuedRepair();
    // The task records its own disposition before the repair dispatches.
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));

    const repair = await waitForSettled(repairRunId);
    expect(repair).toMatchObject({ status: "cancelled", errorCode: "legacy_disposition_repair_suppressed" });
    expect(repair!.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(legacyExecutionNeedsReconciliation(repair!)).toBe(false);

    // Review sends the task back to its owner, as on GRE-193.
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    const holds = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
    ));
    expect(holds).toHaveLength(0);
  });
});
