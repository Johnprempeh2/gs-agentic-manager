import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { getHeartbeatRunRuntimeStatus } from "../services/heartbeat-run-runtime-status.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import type { MemorySnapshot } from "../services/run-admission.ts";
import { runningProcesses } from "../adapters/index.ts";

// Every adapter run blocks until the test releases it, so runs stay "running"
// and the instance cap is observable.
const adapterGate = vi.hoisted(() => {
  const waiters: Array<() => void> = [];
  const state = { active: 0, maxActive: 0 };
  return {
    state,
    waiters,
    releaseOne() {
      waiters.shift()?.();
    },
    releaseAll() {
      while (waiters.length) waiters.shift()?.();
    },
  };
});

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => {
    adapterGate.state.active += 1;
    adapterGate.state.maxActive = Math.max(
      adapterGate.state.maxActive,
      adapterGate.state.active,
    );
    await new Promise<void>((resolve) => adapterGate.waiters.push(resolve));
    adapterGate.state.active -= 1;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Run admission test run.",
      provider: "test",
      model: "test-model",
    };
  }),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

const GB = 1024 * 1024 * 1024;

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat run admission guard (GRE-105)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let memory: MemorySnapshot | null = null;
  let beforeMemoryRead: (() => Promise<void>) | null = null;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-heartbeat-run-admission-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      memoryReader: async () => {
        await beforeMemoryRead?.();
        return memory;
      },
    });
  }, 20_000);

  afterEach(async () => {
    // Lift the guard so held runs drain and finish before the tables reset.
    memory = null;
    beforeMemoryRead = null;
    await db.delete(instanceSettings);
    await heartbeat.resumeQueuedRuns();
    adapterGate.releaseAll();
    await waitFor(async () => {
      adapterGate.releaseAll();
      await heartbeat.resumeQueuedRuns();
      const rows = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]));
      return rows.length === 0;
    });
    await heartbeat.drainActiveRunExecutions();
    adapterGate.state.active = 0;
    adapterGate.state.maxActive = 0;
    memory = null;
    runningProcesses.clear();
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Admission Co",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, maxConcurrentRuns: number) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent-${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns } },
      permissions: {},
    });
    return agentId;
  }

  async function queueRun(companyId: string, agentId: string, createdAt: Date) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        responsibleUserId: "responsible-user",
        contextSnapshot: {},
        createdAt,
      })
      .returning({ id: heartbeatRuns.id });
    return run!.id;
  }

  async function statuses(runIds: string[]) {
    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  async function setAdmission(runAdmission: {
    maxConcurrentRuns?: number;
    minAvailableMemoryMb?: number;
  }) {
    await instanceSettingsService(db).updateGeneral({ runAdmission });
  }

  it("holds queued runs at the instance cap, fairly across agents, and starts them when a slot frees", async () => {
    await setAdmission({ maxConcurrentRuns: 2 });
    const companyId = await seedCompany();
    const busy = await seedAgent(companyId, 5);
    const other = await seedAgent(companyId, 5);
    const t0 = Date.now() - 60_000;
    // The busy agent queued first and has more work; fairness still gives the
    // other agent one of the two instance slots.
    const busyRuns = [
      await queueRun(companyId, busy, new Date(t0)),
      await queueRun(companyId, busy, new Date(t0 + 1_000)),
      await queueRun(companyId, busy, new Date(t0 + 2_000)),
    ];
    const otherRun = await queueRun(companyId, other, new Date(t0 + 3_000));

    await heartbeat.resumeQueuedRuns();
    await waitFor(async () => adapterGate.state.active === 2);

    let current = await statuses([...busyRuns, otherRun]);
    expect(current.get(busyRuns[0]!)).toBe("running");
    expect(current.get(otherRun)).toBe("running");
    expect(current.get(busyRuns[1]!)).toBe("queued");
    expect(current.get(busyRuns[2]!)).toBe("queued");
    expect(getHeartbeatRunRuntimeStatus(busyRuns[1]!)?.message).toMatch(
      /^Waiting: instance run cap reached/,
    );

    // Finishing one run frees a slot; the held run starts without a manual drain.
    adapterGate.releaseOne();
    expect(
      await waitFor(async () => (await statuses([busyRuns[1]!])).get(busyRuns[1]!) === "running"),
    ).toBe(true);
    current = await statuses([busyRuns[2]!]);
    expect(current.get(busyRuns[2]!)).toBe("queued");
    expect(adapterGate.state.maxActive).toBe(2);
  });

  it("lets only one of two concurrent start gates take the last instance slot", async () => {
    await setAdmission({ maxConcurrentRuns: 2 });
    const companyId = await seedCompany();
    const first = await seedAgent(companyId, 5);
    const second = await seedAgent(companyId, 5);
    const third = await seedAgent(companyId, 5);
    const t0 = Date.now() - 60_000;
    const firstRun = await queueRun(companyId, first, new Date(t0));
    await heartbeat.startNextQueuedRunForAgent(first);
    await waitFor(async () => adapterGate.state.active === 1);

    // cap = running + 1. The start lock is per agent, so both gates run at
    // once. Hold each gate's memory read until both have read the running
    // count, so the gates overlap on every run of the test.
    let arrived = 0;
    let releaseReads!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    beforeMemoryRead = async () => {
      arrived += 1;
      if (arrived === 2) releaseReads();
      await bothArrived;
    };
    const secondRun = await queueRun(companyId, second, new Date(t0 + 1_000));
    const thirdRun = await queueRun(companyId, third, new Date(t0 + 2_000));
    const [secondStarted, thirdStarted] = await Promise.all([
      heartbeat.startNextQueuedRunForAgent(second),
      heartbeat.startNextQueuedRunForAgent(third),
    ]);
    beforeMemoryRead = null;

    expect(secondStarted.length + thirdStarted.length).toBe(1);
    const current = await statuses([firstRun, secondRun, thirdRun]);
    expect(
      [...current.values()].filter((status) => status === "running"),
    ).toHaveLength(2);
    expect(
      [...current.values()].filter((status) => status === "queued"),
    ).toHaveLength(1);
    await waitFor(async () => adapterGate.state.active === 2);
    expect(adapterGate.state.maxActive).toBe(2);
  });

  it("keeps runs queued while RAM is below the floor and starts them once it recovers", async () => {
    await setAdmission({ maxConcurrentRuns: 6, minAvailableMemoryMb: 2048 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, 5);
    const runId = await queueRun(companyId, agentId, new Date());

    memory = { availableBytes: 1 * GB, pressure: "normal" };
    await heartbeat.resumeQueuedRuns();
    expect((await statuses([runId])).get(runId)).toBe("queued");
    expect(getHeartbeatRunRuntimeStatus(runId)?.message).toMatch(
      /^Waiting: low memory \(1 GB free, floor 2 GB\)/,
    );

    // GRE-198: macOS "warn" pressure with free RAM above the floor admits.
    memory = { availableBytes: 6 * GB, pressure: "warn" };
    await heartbeat.resumeQueuedRuns();
    expect(
      await waitFor(async () => (await statuses([runId])).get(runId) === "running"),
    ).toBe(true);
    await waitFor(async () => adapterGate.state.active === 1);
    adapterGate.releaseAll();
    expect(
      await waitFor(async () => (await statuses([runId])).get(runId) === "succeeded"),
    ).toBe(true);
  });

  it("still applies the per-agent maxConcurrentRuns under the instance cap", async () => {
    await setAdmission({ maxConcurrentRuns: 6 });
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, 1);
    const t0 = Date.now() - 60_000;
    const runs = [
      await queueRun(companyId, agentId, new Date(t0)),
      await queueRun(companyId, agentId, new Date(t0 + 1_000)),
    ];

    await heartbeat.resumeQueuedRuns();
    await waitFor(async () => adapterGate.state.active === 1);
    const current = await statuses(runs);
    expect(current.get(runs[0]!)).toBe("running");
    expect(current.get(runs[1]!)).toBe("queued");
    const [row] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runs[1]!));
    expect(row?.status).toBe("queued");
  });
});
