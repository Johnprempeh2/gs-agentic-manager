import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  budgetIncidents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { budgetService } from "../services/budgets.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import type { DiskSnapshot, MemorySnapshot } from "../services/run-admission.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Budget hold test run.",
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

const GB = 1024 * 1024 * 1024;
const BOARD_USER = "board-user";

describeEmbeddedPostgres("hold at a budget hard stop (GRE-1365, AT-2.6)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let budgets!: ReturnType<typeof budgetService>;
  let memory: MemorySnapshot | null = null;
  let disk: DiskSnapshot | null = null;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("budget-hard-stop-hold-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      memoryReader: async () => memory,
      diskReader: async () => disk,
    });
    budgets = budgetService(db, {
      cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
      noticeHardStop: heartbeat.noticeBudgetHardStop,
      releaseHeldWorkForScope: (scope) =>
        heartbeat.releaseBudgetHeldWork({ companyId: scope.companyId }).then(() => undefined),
    });
  });

  afterEach(async () => {
    memory = null;
    disk = null;
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    runningProcesses.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setMode(budgetHardStopMode: "stop" | "hold" | undefined) {
    await instanceSettingsService(db).updateGeneral({ budgetHardStopMode });
  }

  /** An agent with a 500-cent hard cap, three open tasks and a queued wake on each. */
  async function seedAtTheCap() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Hold Co",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Spender",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
      permissions: {},
    });
    const issueIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issues).values(
      issueIds.map((id, index) => ({
        id,
        companyId,
        title: `Task ${index + 1}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      })),
    );
    await budgets.upsertPolicy(companyId, { scopeType: "agent", scopeId: agentId, amount: 500 }, BOARD_USER);
    const queued = await db
      .insert(agentWakeupRequests)
      .values([
        ...issueIds.map((issueId) => ({
          companyId,
          agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId },
          status: "queued",
        })),
        // A wake with no task: nothing to resume, so it is cancelled as before.
        { companyId, agentId, source: "on_demand", triggerDetail: "manual", reason: "manual", status: "queued" },
      ])
      .returning({ id: agentWakeupRequests.id });
    return { companyId, agentId, issueIds, queuedIds: queued.map((row) => row.id) };
  }

  async function hitTheCap(companyId: string, agentId: string) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "test",
        costCents: 600,
        occurredAt: new Date(),
      })
      .returning();
    await budgets.evaluateCostEvent(event!);
    const [incident] = await db
      .select()
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.thresholdType, "hard"), eq(budgetIncidents.status, "open")));
    return incident!;
  }

  async function wakeStatuses(ids: string[]) {
    const rows = await db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, ids));
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  async function releaseWakes(companyId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "budget_hold_released")));
  }

  async function releaseRuns(companyId: string) {
    const rows = await db
      .select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    // Only runs the release started; the follow-ups a finished run asks for
    // (disposition repair) are the normal lifecycle, not a second wake.
    return rows
      .map((row) => ({ status: row.status, ...(row.contextSnapshot as { issueId?: string; wakeReason?: string }) }))
      .filter((run) => run.wakeReason === "budget_hold_released");
  }

  it("stop (the default) still cancels the queued wakes", async () => {
    await setMode(undefined);
    const { companyId, agentId, queuedIds } = await seedAtTheCap();
    await hitTheCap(companyId, agentId);

    expect([...(await wakeStatuses(queuedIds)).values()]).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
    expect((await budgets.overview(companyId)).heldTaskCount).toBe(0);
  });

  it("holds the three queued wakes; after an approved raise each task gets exactly one wake, under the RAM and disk guards", async () => {
    await setMode("hold");
    const { companyId, agentId, issueIds, queuedIds } = await seedAtTheCap();
    const incident = await hitTheCap(companyId, agentId);

    const held = await wakeStatuses(queuedIds);
    expect(queuedIds.slice(0, 3).map((id) => held.get(id))).toEqual(["budget_held", "budget_held", "budget_held"]);
    expect(held.get(queuedIds[3]!)).toBe("cancelled");
    expect((await budgets.overview(companyId)).heldTaskCount).toBe(3);

    // A new wake for a held task while stopped is held with it, not dropped.
    await expect(
      heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: issueIds[0] },
        contextSnapshot: { issueId: issueIds[0], wakeReason: "issue_commented" },
        requestedByActorType: "system",
        requestedByActorId: "test",
      }),
    ).rejects.toThrow(/budget/);
    expect((await budgets.overview(companyId)).heldTaskCount).toBe(3);

    // The approved raise wakes each held task once. Memory is low, so the
    // run admission guard keeps every new run queued.
    memory = { availableBytes: 0.5 * GB, pressure: "normal" };
    await budgets.resolveIncident(companyId, incident.id, { action: "raise_budget_and_resume", amount: 5_000 }, BOARD_USER);

    const released = await releaseWakes(companyId);
    expect(released.map((wake) => (wake.payload as { issueId: string }).issueId).sort()).toEqual([...issueIds].sort());
    expect((await budgets.overview(companyId)).heldTaskCount).toBe(0);
    let runs = await releaseRuns(companyId);
    expect(runs.map((run) => run.issueId).sort()).toEqual([...issueIds].sort());
    expect(runs.every((run) => run.status === "queued")).toBe(true);

    // Memory recovers but disk is low: still held by the disk guard.
    memory = null;
    disk = { availableBytes: 1 * GB };
    await heartbeat.resumeQueuedRuns();
    runs = await releaseRuns(companyId);
    expect(runs.every((run) => run.status === "queued")).toBe(true);

    // A second release (the sweep, or a repeat raise) wakes nobody again.
    expect(await heartbeat.releaseBudgetHeldWork()).toMatchObject({ released: 0 });
    expect(await releaseWakes(companyId)).toHaveLength(3);

    disk = null;
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    runs = await releaseRuns(companyId);
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.status !== "queued" && run.status !== "running")).toBe(true);
  });

  it("keep paused leaves the work held, the board sees the count, and the sweep does not wake it", async () => {
    await setMode("hold");
    const { companyId, agentId, queuedIds } = await seedAtTheCap();
    const incident = await hitTheCap(companyId, agentId);

    await budgets.resolveIncident(companyId, incident.id, { action: "keep_paused" }, BOARD_USER);
    expect(await heartbeat.releaseBudgetHeldWork({ companyId })).toMatchObject({ released: 0, held: 3 });

    const held = await wakeStatuses(queuedIds.slice(0, 3));
    expect([...held.values()]).toEqual(["budget_held", "budget_held", "budget_held"]);
    const overview = await budgets.overview(companyId);
    expect(overview.heldTaskCount).toBe(3);
    expect(overview.policies.find((policy) => policy.scopeId === agentId)?.heldTaskCount).toBe(3);
    expect(await releaseWakes(companyId)).toHaveLength(0);
    expect(await releaseRuns(companyId)).toHaveLength(0);
  });

  it("an operator company pause clears held work, so a resume wakes nothing old (GRE-1364)", async () => {
    await setMode("hold");
    const { companyId, agentId, queuedIds } = await seedAtTheCap();
    await hitTheCap(companyId, agentId);

    await heartbeat.cancelCompanyPauseWork(companyId, "Cancelled: company paused");
    expect([...(await wakeStatuses(queuedIds)).values()].every((status) => status === "cancelled")).toBe(true);
    expect((await budgets.overview(companyId)).heldTaskCount).toBe(0);
  });

  it("drops a held task that was finished while held", async () => {
    await setMode("hold");
    const { companyId, agentId, issueIds } = await seedAtTheCap();
    const incident = await hitTheCap(companyId, agentId);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueIds[0]!));

    await budgets.resolveIncident(companyId, incident.id, { action: "raise_budget_and_resume", amount: 5_000 }, BOARD_USER);

    const released = await releaseWakes(companyId);
    expect(released.map((wake) => (wake.payload as { issueId: string }).issueId).sort()).toEqual(
      issueIds.slice(1).sort(),
    );
    expect((await budgets.overview(companyId)).heldTaskCount).toBe(0);
  });
});
