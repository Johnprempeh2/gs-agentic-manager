import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  HOST_RESUME_SETTLE_MS,
  createHostBlindTimeTracker,
} from "../services/host-blind-time.ts";

vi.doMock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    type: "process",
    execute: vi.fn(() => new Promise(() => {})),
    testEnvironment: vi.fn(),
  })),
  runningProcesses: new Map(),
}));

const { heartbeatService } = await import("../services/heartbeat.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dark-wake dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MIN = 60_000;

/**
 * A host that is awake, sleeps for 15 minutes, then wakes. `awakeFor` moves
 * the clock forward while the sampler keeps running, as on an awake host.
 */
function darkWakeHost() {
  const start = Date.parse("2026-09-30T09:30:00.000Z");
  let clock = start;
  const tracker = createHostBlindTimeTracker({ now: () => clock, startedAt: start });
  const awakeFor = (ms: number) => {
    const to = clock + ms;
    while (clock < to) {
      clock = Math.min(to, clock + 5_000);
      tracker.sample();
    }
  };
  awakeFor(16 * MIN);
  // 30 Sep: the lid stays closed; macOS wakes for ~2 s every 15 minutes.
  clock += 15 * MIN;
  tracker.sample();
  return { tracker, awakeFor };
}

describe("host resume settle window (GRE-317)", () => {
  it("is open right after a sleep gap and closes once the host stays awake", () => {
    const host = darkWakeHost();
    expect(host.tracker.resumedWithin(HOST_RESUME_SETTLE_MS)).toBe(true);
    host.awakeFor(2_000);
    expect(host.tracker.resumedWithin(HOST_RESUME_SETTLE_MS)).toBe(true);
    host.awakeFor(HOST_RESUME_SETTLE_MS);
    expect(host.tracker.resumedWithin(HOST_RESUME_SETTLE_MS)).toBe(false);
  });

  it("does not treat a fresh process start as a resume", () => {
    let clock = 1_000_000;
    const tracker = createHostBlindTimeTracker({ now: () => clock, startedAt: clock });
    clock += 1_000;
    tracker.sample();
    expect(tracker.resumedWithin(HOST_RESUME_SETTLE_MS)).toBe(false);
  });
});

describeEmbeddedPostgres("scheduler dispatch in a dark wake (GRE-317)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousInWorktree = process.env.GSAM_IN_WORKTREE;

  beforeAll(async () => {
    process.env.GSAM_IN_WORKTREE = "false";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-dark-wake-dispatch-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
        return;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  });

  afterAll(async () => {
    if (previousInWorktree === undefined) delete process.env.GSAM_IN_WORKTREE;
    else process.env.GSAM_IN_WORKTREE = previousInWorktree;
    await tempDb?.cleanup();
  });

  /** Cairn's shape: an hourly timer heartbeat whose interval has elapsed. */
  async function seedTimerAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Dark Wake Co",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cairn",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600, wakeOnDemand: true } },
      permissions: {},
      lastHeartbeatAt: new Date(Date.now() - 2 * 60 * MIN),
    });
    return { companyId, agentId };
  }

  async function runsFor(agentId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  }

  it("holds a due timer heartbeat in a dark wake and starts it once the host stays awake", async () => {
    const { agentId } = await seedTimerAgent();
    const host = darkWakeHost();
    const heartbeat = heartbeatService(db, { hostBlindTime: host.tracker });

    const inDarkWake = await heartbeat.tickTimers(new Date());
    expect(inDarkWake).toMatchObject({ checked: 0, enqueued: 0 });
    expect(await runsFor(agentId)).toHaveLength(0);

    host.awakeFor(HOST_RESUME_SETTLE_MS);
    const awake = await heartbeat.tickTimers(new Date());
    expect(awake.enqueued).toBe(1);
    expect(await runsFor(agentId)).toHaveLength(1);
  });

  it("holds a due scheduled retry in a dark wake and promotes it once the host stays awake", async () => {
    const { companyId, agentId } = await seedTimerAgent();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "scheduled_retry",
      wakeupRequestId,
      scheduledRetryAt: new Date(Date.now() - MIN),
      scheduledRetryReason: "host_sleep_resume",
      scheduledRetryAttempt: 1,
    });
    const host = darkWakeHost();
    const heartbeat = heartbeatService(db, { hostBlindTime: host.tracker });

    expect(await heartbeat.promoteDueScheduledRetries()).toEqual({ promoted: 0, runIds: [] });
    const [held] = await runsFor(agentId);
    expect(held?.status).toBe("scheduled_retry");

    host.awakeFor(HOST_RESUME_SETTLE_MS);
    expect(await heartbeat.promoteDueScheduledRetries()).toEqual({ promoted: 1, runIds: [runId] });
  });
});
