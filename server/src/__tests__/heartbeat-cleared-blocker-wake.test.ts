import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

// GRE-1082: a run cancelled because dependencies were blocked must wake the
// assignee once the blockers stop counting, however that happens.
describeEmbeddedPostgres("wake when blockers are cleared", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-cleared-blocker-wake-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
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
  }, 30_000);

  async function seed(opts: { blockers?: number; blockerStatus?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const dependentId = randomUUID();
    const blockerIds = Array.from({ length: opts.blockers ?? 1 }, () => randomUUID());
    const prefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
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
      name: "Priya",
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
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${prefix}-1`,
      },
      ...blockerIds.map((id, i) => ({
        id,
        companyId,
        title: `Blocker ${i}`,
        status: opts.blockerStatus ?? "in_progress",
        priority: "medium",
        issueNumber: i + 2,
        identifier: `${prefix}-${i + 2}`,
      })),
    ]);
    await db.insert(issueRelations).values(
      blockerIds.map((id) => ({ companyId, issueId: id, relatedIssueId: dependentId, type: "blocks" })),
    );
    // The dispatch gate's cancellation, exactly as GRE-1082 saw it.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "cancelled",
      error: "Cancelled because issue dependencies are still blocked; GS Agentic Manager will wake the assignee when blockers resolve",
      errorCode: "issue_dependencies_blocked",
      contextSnapshot: { issueId: dependentId },
      finishedAt: new Date(),
    });
    return { companyId, agentId, dependentId, blockerIds };
  }

  async function wakesFor(issueId: string) {
    const rows = await db.select().from(agentWakeupRequests);
    return rows.filter(
      (row) => (row.payload as Record<string, unknown> | null)?.issueId === issueId &&
        row.reason === "issue_blockers_resolved",
    );
  }

  it("wakes once when the blocks relation is removed", async () => {
    const { companyId, dependentId, blockerIds } = await seed();
    await db.delete(issueRelations).where(eq(issueRelations.issueId, blockerIds[0]!));
    const heartbeat = heartbeatService(db);
    expect((await heartbeat.reconcileResolvedDependencyWakes({ companyId, issueIds: [dependentId] })).healed).toBe(1);
    expect((await heartbeat.reconcileResolvedDependencyWakes({ companyId, issueIds: [dependentId] })).healed).toBe(0);
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(0);
    expect(await wakesFor(dependentId)).toHaveLength(1);
  });

  it("wakes once when blockedByIssueIds is patched to []", async () => {
    const { companyId, dependentId } = await seed();
    await issueService(db).update(dependentId, { blockedByIssueIds: [] });
    const heartbeat = heartbeatService(db);
    expect((await heartbeat.reconcileResolvedDependencyWakes({ companyId, issueIds: [dependentId] })).healed).toBe(1);
    expect((await heartbeat.reconcileResolvedDependencyWakes({ companyId, issueIds: [dependentId] })).healed).toBe(0);
    expect(await wakesFor(dependentId)).toHaveLength(1);
  });

  it("wakes once when a reopened blocker is then cleared", async () => {
    const { companyId, dependentId, blockerIds } = await seed({ blockerStatus: "done" });
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, blockerIds[0]!));
    const heartbeat = heartbeatService(db);
    // Reopened blocker counts again: no wake.
    expect((await heartbeat.reconcileResolvedDependencyWakes({ companyId, issueIds: [dependentId] })).healed).toBe(0);
    await issueService(db).update(dependentId, { blockedByIssueIds: [] });
    expect((await heartbeat.reconcileResolvedDependencyWakes({ companyId, issueIds: [dependentId] })).healed).toBe(1);
    expect(await wakesFor(dependentId)).toHaveLength(1);
  });

  it("does not wake twice when the blocker completes and the route path already woke", async () => {
    const { companyId, agentId, dependentId, blockerIds } = await seed();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerIds[0]!));
    const heartbeat = heartbeatService(db);
    // The route's issue_blockers_resolved wake for the completion lands first.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: dependentId },
      status: "queued",
    });
    expect((await heartbeat.reconcileResolvedDependencyWakes({ companyId, issueIds: [dependentId] })).healed).toBe(0);
    expect(await wakesFor(dependentId)).toHaveLength(1);
  });

  it("does not wake while another blocker remains", async () => {
    const { companyId, dependentId, blockerIds } = await seed({ blockers: 2 });
    await db.delete(issueRelations).where(eq(issueRelations.issueId, blockerIds[0]!));
    const heartbeat = heartbeatService(db);
    expect((await heartbeat.reconcileResolvedDependencyWakes({ companyId, issueIds: [dependentId] })).healed).toBe(0);
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(0);
    expect(await wakesFor(dependentId)).toHaveLength(0);
  });

  it("periodic backstop wakes the stranded in_progress issue once", async () => {
    const { dependentId, blockerIds } = await seed();
    // Relation removed by a path that never called the event hook.
    await db.delete(issueRelations).where(eq(issueRelations.issueId, blockerIds[0]!));
    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reconcileResolvedDependencyWakes();
    expect(first.healed).toBe(1);
    expect(first.issueIds).toEqual([dependentId]);
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(0);
    expect(await wakesFor(dependentId)).toHaveLength(1);
  });
});
