import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_RUN_SILENT_TIMEOUT_MS,
  RUN_SILENT_TIMEOUT_ERROR_CODE,
  RUN_SILENT_TIMEOUT_RETRY_WAKE_REASON,
  SILENT_RETRY_MAX_DEFER_MS,
  SILENT_RETRY_RESUME_SETTLE_MS,
  awakeSilenceAgeMs,
  evaluateSilentRetryPressure,
  isSilentRetryHoldPending,
  readSilentRetryHold,
} from "../services/run-silent-timeout.ts";
import {
  HOST_BLIND_GAP_MS,
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
    `Skipping embedded Postgres silent-run overload tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const MIN = 60_000;
const TIMEOUT = DEFAULT_RUN_SILENT_TIMEOUT_MS;
const idleHost = () => ({ load1: 1, cpus: 10 });
const overloadedHost = () => ({ load1: 20, cpus: 10 });

/** A tracker whose clock the test moves; started long ago, so no startup blind time. */
function manualTracker(startMs: number) {
  let clock = startMs;
  const tracker = createHostBlindTimeTracker({ now: () => clock, startedAt: startMs });
  return {
    tracker,
    /** Advance the clock; `asleep` skips sampling so the gap is recorded as blind. */
    advance(ms: number, opts: { asleep?: boolean } = {}) {
      if (opts.asleep) {
        clock += ms;
      } else {
        for (let left = ms; left > 0; left -= 5_000) {
          clock += Math.min(5_000, left);
          tracker.sample();
        }
      }
      tracker.sample();
    },
    get now() {
      return clock;
    },
  };
}

describe("host blind time (GRE-181)", () => {
  it("records a sampler gap as blind time and nothing else", () => {
    const host = manualTracker(0);
    host.advance(10 * MIN);
    expect(host.tracker.blindMsBetween(0, host.now)).toBe(0);
    host.advance(15 * MIN, { asleep: true });
    expect(host.tracker.blindMsBetween(0, host.now)).toBe(15 * MIN);
    expect(host.tracker.lastResumeAt()).toBe(host.now);
    // A short pause under the gap bar is not blind.
    host.advance(HOST_BLIND_GAP_MS - 1, { asleep: true });
    expect(host.tracker.blindMsBetween(0, host.now)).toBe(15 * MIN);
  });

  it("counts time before the process started as blind", () => {
    const tracker = createHostBlindTimeTracker({ now: () => 100 * MIN, startedAt: 90 * MIN });
    expect(tracker.blindMsBetween(80 * MIN, 100 * MIN)).toBe(10 * MIN);
  });

  it("replays 28 Sep: 31 min of wall silence with 15 min asleep is not a hang", () => {
    // Run starts, host awake 13 min, lid closed 15 min, a dark wake, 3 min awake.
    const host = manualTracker(0);
    const runStartedAt = host.now;
    host.advance(13 * MIN);
    host.advance(15 * MIN, { asleep: true });
    host.advance(3 * MIN);
    const run = { lastOutputAt: null, processStartedAt: new Date(runStartedAt), startedAt: null, createdAt: null };
    const age = awakeSilenceAgeMs(run, new Date(host.now), host.tracker.blindMsBetween)!;
    expect(age.wallMs).toBe(31 * MIN);
    expect(age.blindMs).toBe(15 * MIN);
    expect(age.awakeMs).toBe(16 * MIN);
    expect(age.awakeMs).toBeLessThan(TIMEOUT);
  });
});

describe("silent retry pressure (GRE-181)", () => {
  const admit = { admit: true } as const;
  const base = { now: 60 * MIN, lastResumeAt: 0, admission: admit, load: idleHost() };

  it("allows the retry on a settled, idle host", () => {
    expect(evaluateSilentRetryPressure(base)).toEqual({ overloaded: false });
  });

  it("holds the retry just after sleep, under the run cap or low memory, and under CPU load", () => {
    expect(
      evaluateSilentRetryPressure({ ...base, lastResumeAt: base.now - SILENT_RETRY_RESUME_SETTLE_MS + 1 }),
    ).toMatchObject({ overloaded: true, reason: "host_resumed" });
    expect(
      evaluateSilentRetryPressure({ ...base, admission: { admit: false, message: "Held: low memory" } }),
    ).toMatchObject({ overloaded: true, reason: "run_admission" });
    expect(evaluateSilentRetryPressure({ ...base, load: overloadedHost() })).toMatchObject({
      overloaded: true,
      reason: "cpu_load",
    });
  });

  it("fails open when load cannot be read", () => {
    expect(evaluateSilentRetryPressure({ ...base, load: null })).toEqual({ overloaded: false });
  });
});

describeEmbeddedPostgres("silent-run stop timing and overload hold (GRE-181)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousInWorktree = process.env.GSAM_IN_WORKTREE;

  beforeAll(async () => {
    process.env.GSAM_IN_WORKTREE = "false";
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-silent-overload-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Retry runs queued by a test start in the background; a TRUNCATE can
    // deadlock with them, so try again rather than leave rows behind.
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

  async function seed(opts: { now: Date; silentMs: number }) {
    const { now } = opts;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date(now.getTime() - opts.silentMs);

    await db.insert(companies).values({
      id: companyId,
      name: "Overload Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work on a busy host",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt: new Date(startedAt.getTime() - MIN),
      updatedAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      contextSnapshot: { issueId, taskId: issueId },
      logBytes: 0,
      createdAt: startedAt,
    });
    await db
      .update(issues)
      .set({ executionRunId: runId, checkoutRunId: runId })
      .where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, runId };
  }

  const retryWakes = (companyId: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, RUN_SILENT_TIMEOUT_RETRY_WAKE_REASON),
        ),
      );
  const cancelRetryRuns = async (heartbeat: ReturnType<typeof heartbeatService>, runId: string) => {
    const retries = await db
      .select()
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot}->>'silentTimeoutRetryOfRunId' = ${runId}`);
    for (const retry of retries) await heartbeat.cancelRun(retry.id, "test cleanup");
    return retries;
  };
  const readRun = async (runId: string) =>
    (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;

  it("stops a silent run on an awake host within one scheduler interval of timeoutMs", async () => {
    const host = manualTracker(Date.now() - 3 * 60 * MIN);
    host.advance(3 * 60 * MIN - 1);
    const now = new Date(host.now);
    const heartbeat = heartbeatService(db, { hostBlindTime: host.tracker, hostLoadReader: idleHost });

    // 1 s short of the limit: still running.
    const early = await seed({ now, silentMs: TIMEOUT - 1_000 });
    expect((await heartbeat.stopSilentRuns({ now, companyId: early.companyId })).stopped).toBe(0);
    expect((await readRun(early.runId)).status).toBe("running");
    await heartbeat.cancelRun(early.runId, "test cleanup");

    // The next tick (30 s later) is past the limit: stopped, and the recorded
    // silence is within one 30 s scheduler interval of timeoutMs.
    const late = await seed({ now, silentMs: TIMEOUT + 29_000 });
    const result = await heartbeat.stopSilentRuns({ now, companyId: late.companyId });
    expect(result).toMatchObject({ stopped: 1, retried: 1, retriesHeld: 0 });
    const run = await readRun(late.runId);
    const silentTimeout = (run.resultJson as { silentTimeout: { silenceMs: number; blindMs: number } }).silentTimeout;
    expect(silentTimeout.blindMs).toBe(0);
    expect(silentTimeout.silenceMs - TIMEOUT).toBeGreaterThanOrEqual(0);
    expect(silentTimeout.silenceMs - TIMEOUT).toBeLessThan(30_000);
    expect(await cancelRetryRuns(heartbeat, late.runId)).toHaveLength(1);
  });

  it("does not stop a run for time the host was asleep", async () => {
    // 28 Sep shape: 31 min since the run started, 15 of them with the lid closed.
    const host = manualTracker(Date.now() - 3 * 60 * MIN);
    host.advance(3 * 60 * MIN - 31 * MIN - 1);
    host.advance(13 * MIN);
    host.advance(15 * MIN, { asleep: true });
    host.advance(3 * MIN);
    const now = new Date(host.now);
    const { companyId, runId } = await seed({ now, silentMs: 31 * MIN });
    const heartbeat = heartbeatService(db, { hostBlindTime: host.tracker, hostLoadReader: idleHost });

    expect((await heartbeat.stopSilentRuns({ now, companyId })).stopped).toBe(0);
    expect((await readRun(runId)).status).toBe("running");
    await heartbeat.cancelRun(runId, "test cleanup");
  });

  it("holds the fresh retry while the host is overloaded, then sends it once when it recovers", async () => {
    const host = manualTracker(Date.now() - 3 * 60 * MIN);
    host.advance(3 * 60 * MIN - 1);
    const now = new Date(host.now);
    const { companyId, issueId, runId } = await seed({ now, silentMs: 25 * MIN });
    let load = overloadedHost;
    const heartbeat = heartbeatService(db, { hostBlindTime: host.tracker, hostLoadReader: () => load() });

    const held = await heartbeat.stopSilentRuns({ now, companyId });
    expect(held).toMatchObject({ stopped: 1, retried: 0, retriesHeld: 1 });
    const stopped = await readRun(runId);
    expect(stopped).toMatchObject({ status: "cancelled", errorCode: RUN_SILENT_TIMEOUT_ERROR_CODE });
    expect(readSilentRetryHold(stopped.resultJson)).toMatchObject({ retryDeferReason: "cpu_load" });
    expect(isSilentRetryHoldPending(stopped, now)).toBe(true);
    expect(await retryWakes(companyId)).toHaveLength(0);

    // Stranded-issue recovery leaves the held retry to the watchdog.
    await heartbeat.reconcileStrandedAssignedIssues();
    expect(
      await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    ).toHaveLength(1);
    const [issueWhileHeld] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueWhileHeld!.status).toBe("in_progress");

    // Still overloaded on the next sweep: nothing changes.
    const later = new Date(now.getTime() + 5 * MIN);
    expect((await heartbeat.stopSilentRuns({ now: later, companyId })).heldRetries).toMatchObject({ held: 1, released: 0 });
    expect(await retryWakes(companyId)).toHaveLength(0);

    // Load drops: the retry goes out once, in a fresh session.
    load = idleHost;
    const released = await heartbeat.stopSilentRuns({ now: later, companyId });
    expect(released.heldRetries).toMatchObject({ released: 1 });
    expect(await retryWakes(companyId)).toHaveLength(1);
    expect(readSilentRetryHold((await readRun(runId)).resultJson)).toMatchObject({ retryResolution: "retried" });
    const retryRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot}->>'silentTimeoutRetryOfRunId' = ${runId}`);
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]!.contextSnapshot).toMatchObject({ issueId, forceFreshSession: true });
    expect(retryRuns[0]!.createdAt.getTime()).toBeGreaterThan(stopped.createdAt.getTime());

    // Idempotent: another sweep sends nothing more.
    expect((await heartbeat.stopSilentRuns({ now: later, companyId })).heldRetries.released).toBe(0);
    expect(await retryWakes(companyId)).toHaveLength(1);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.filter((c) => c.body.includes("overloaded"))).toHaveLength(1);
    expect(comments.filter((c) => c.body.includes("held fresh retry"))).toHaveLength(1);
    await cancelRetryRuns(heartbeat, runId);
  });

  it("holds the retry right after the host wakes from sleep", async () => {
    const host = manualTracker(Date.now() - 3 * 60 * MIN);
    host.advance(3 * 60 * MIN - 45 * MIN - 1);
    host.advance(25 * MIN);
    host.advance(15 * MIN, { asleep: true });
    host.advance(5 * MIN - 1);
    const now = new Date(host.now);
    // Silent 45 min wall, 30 min awake: past the limit, but the host woke just under 5 min ago.
    const { companyId, runId } = await seed({ now, silentMs: 45 * MIN });
    const heartbeat = heartbeatService(db, { hostBlindTime: host.tracker, hostLoadReader: idleHost });

    expect(await heartbeat.stopSilentRuns({ now, companyId })).toMatchObject({ stopped: 1, retriesHeld: 1 });
    expect(readSilentRetryHold((await readRun(runId)).resultJson)).toMatchObject({ retryDeferReason: "host_resumed" });
    expect(await retryWakes(companyId)).toHaveLength(0);
  });

  it("escalates to blocked when the host stays overloaded past the hold deadline", async () => {
    const host = manualTracker(Date.now() - 3 * 60 * MIN);
    host.advance(3 * 60 * MIN - 1);
    const now = new Date(host.now);
    const { companyId, issueId, runId } = await seed({ now, silentMs: 25 * MIN });
    const heartbeat = heartbeatService(db, { hostBlindTime: host.tracker, hostLoadReader: overloadedHost });

    expect((await heartbeat.stopSilentRuns({ now, companyId })).retriesHeld).toBe(1);

    const pastDeadline = new Date(now.getTime() + SILENT_RETRY_MAX_DEFER_MS + MIN);
    const result = await heartbeat.stopSilentRuns({ now: pastDeadline, companyId });
    expect(result.heldRetries).toMatchObject({ escalated: 1, released: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("blocked");
    expect(readSilentRetryHold((await readRun(runId)).resultJson)).toMatchObject({ retryResolution: "escalated" });
    expect(await retryWakes(companyId)).toHaveLength(0);
  });
});
