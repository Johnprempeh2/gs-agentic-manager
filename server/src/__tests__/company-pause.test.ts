import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  routineRuns,
  routineTriggers,
  toolAccessAuditEvents,
  toolApplications,
  toolConnections,
} from "@greatstone/db";
import { resumeCompanySchema } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// No adapter process may start: a run that does get queued stays queued.
vi.doMock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    type: "process",
    execute: vi.fn(() => new Promise(() => {})),
    testEnvironment: vi.fn(),
  })),
  runningProcesses: new Map(),
}));

const { heartbeatService } = await import("../services/heartbeat.ts");
const { companyService } = await import("../services/companies.ts");
const { routineService } = await import("../services/routines.ts");
const { toolAccessService } = await import("../services/tool-access.ts");
const { createToolGatewayService } = await import("../services/tool-gateway.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company pause tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HOUR = 60 * 60 * 1000;
const BOARD = { actorType: "user" as const, actorId: "board-user" };

describeEmbeddedPostgres("company pause and resume (GRE-1364)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousInWorktree = process.env.GSAM_IN_WORKTREE;

  beforeAll(async () => {
    process.env.GSAM_IN_WORKTREE = "false";
    tempDb = await startEmbeddedPostgresTestDatabase("company-pause-");
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

  /** AT-4.1 shape: an agent timer, an hourly catch-up routine, a running run and a queued wake. */
  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pause Co",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      lastHeartbeatAt: new Date(Date.now() - 2 * HOUR),
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Ops", status: "in_progress" });

    const routines = routineService(db, {
      runtimeEnv: { GSAM_IN_WORKTREE: "false" },
      heartbeat: { wakeup: async () => null },
    });
    const routine = await routines.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Hourly check",
        description: "Hourly check",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "enqueue_missed_with_cap",
      },
      {},
    );
    const { trigger } = await routines.createTrigger(routine.id, {
      kind: "schedule",
      cronExpression: "0 * * * *",
      timezone: "UTC",
    }, {});

    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date(),
    }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "timer",
      status: "queued",
    }).returning();

    return { companyId, agentId, routine, routines, trigger, runId: run!.id, wakeId: wake!.id };
  }

  async function seedConnections(companyId: string) {
    const [app] = await db.insert(toolApplications).values({ companyId, name: "Tools", type: "mcp_http" }).returning();
    const [tool] = await db.insert(toolConnections).values({
      companyId,
      applicationId: app!.id,
      name: "Remote tools",
      uid: `tool-${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      credentialPolicy: "shared",
      config: { url: "https://8.8.8.8/mcp" },
    }).returning();
    const [ai] = await db.insert(toolConnections).values({
      companyId,
      applicationId: app!.id,
      name: "Company Claude",
      uid: `ai-${randomUUID()}`,
      connectionPurpose: "ai",
      transport: "runtime_auth",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config: { ai: { provider: "anthropic", method: "subscription" } },
    }).returning();
    const [off] = await db.insert(toolConnections).values({
      companyId,
      applicationId: app!.id,
      name: "Already off",
      uid: `off-${randomUUID()}`,
      transport: "mcp_remote",
      status: "disabled",
      enabled: false,
      credentialPolicy: "shared",
      config: { url: "https://8.8.4.4/mcp" },
    }).returning();
    await db.insert(connectionGrants).values([
      { companyId, connectionId: tool!.id, kind: "organization" },
      { companyId, connectionId: ai!.id, kind: "organization" },
      { companyId, connectionId: off!.id, kind: "organization" },
    ]);
    return { tool: tool!, ai: ai!, off: off! };
  }

  async function connectionRow(id: string) {
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, id));
    return row!;
  }

  async function grantStatuses(connectionId: string) {
    const rows = await db.select({ status: connectionGrants.status }).from(connectionGrants)
      .where(eq(connectionGrants.connectionId, connectionId));
    return rows.map((row) => row.status);
  }

  it("AT-4.1: pause cancels the run and queued wake; no timer wake and no routine run while paused", async () => {
    const { companyId, agentId, routine, routines, trigger, runId, wakeId } = await seedCompany();
    const companies_ = companyService(db);

    const paused = await companies_.pause(companyId, BOARD, { reason: "Client asked to stop" });
    expect(paused).toMatchObject({ status: "paused" });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("cancelled");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake?.status).toBe("cancelled");

    const timerTick = await heartbeatService(db).tickTimers(new Date());
    expect(timerTick).toMatchObject({ enqueued: 0 });
    const runsAfterTick = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runsAfterTick).toHaveLength(1);

    // The trigger is due and its policy would replay missed ticks.
    await db.update(routineTriggers)
      .set({ nextRunAt: new Date(Date.now() - 5 * HOUR) })
      .where(eq(routineTriggers.id, trigger.id));
    expect(await routines.tickScheduledTriggers(new Date())).toEqual({ triggered: 0 });
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
    await expect(routines.runRoutine(routine.id, { source: "manual" })).rejects.toMatchObject({ status: 409 });

    const [log] = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "company.paused")));
    expect(log?.details).toMatchObject({
      reason: "Client asked to stop",
      runsCancelled: 1,
      wakeupsCancelled: 1,
    });
  });

  it("AT-4.2: pause suspends every connection and grant, records each, and no gateway session works", async () => {
    const { companyId, agentId, runId } = await seedCompany();
    const { tool, ai, off } = await seedConnections(companyId);
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "test-secret" });
    const session = await gateway.createSession({ companyId, agentId, runId });

    await companyService(db).pause(companyId, BOARD, {});

    for (const id of [tool.id, ai.id]) {
      const row = await connectionRow(id);
      expect(row.enabled).toBe(false);
      expect(row.pauseSuspendedAt).not.toBeNull();
    }
    // A connection that was already off is left as it was, but its grant is held too.
    expect((await connectionRow(off.id)).pauseSuspendedAt).toBeNull();
    for (const id of [tool.id, ai.id, off.id]) {
      expect(await grantStatuses(id)).toEqual(["suspended"]);
    }

    const audit = await db.select().from(toolAccessAuditEvents)
      .where(and(eq(toolAccessAuditEvents.companyId, companyId), eq(toolAccessAuditEvents.reasonCode, "company_paused")));
    expect(audit.filter((row) => row.action === "tool_connection.pause_suspended")).toHaveLength(2);
    expect(audit.filter((row) => row.action === "connection_grant.pause_suspended")).toHaveLength(3);

    await expect(gateway.listToolsForSession(session.token)).rejects.toMatchObject({ reasonCode: "company_paused" });

    // Pausing again changes nothing and records nothing new.
    await companyService(db).pause(companyId, BOARD, {});
    const auditAgain = await db.select().from(toolAccessAuditEvents)
      .where(and(eq(toolAccessAuditEvents.companyId, companyId), eq(toolAccessAuditEvents.reasonCode, "company_paused")));
    expect(auditAgain.filter((row) => row.action.endsWith("pause_suspended"))).toHaveLength(5);
  });

  it("AT-4.4: resume needs an operator and a reason, and turns no connection back on by itself", async () => {
    expect(resumeCompanySchema.safeParse({ reason: "Paid" }).success).toBe(false);
    expect(resumeCompanySchema.safeParse({ operator: "John", reason: " " }).success).toBe(false);
    expect(resumeCompanySchema.safeParse({ operator: "John", reason: "Invoice paid" }).success).toBe(true);

    const { companyId } = await seedCompany();
    const { tool, ai, off } = await seedConnections(companyId);
    const svc = companyService(db);
    await svc.pause(companyId, BOARD, {});
    const resumed = await svc.resume(companyId, BOARD, { operator: "John Prempeh", reason: "Invoice paid" });
    expect(resumed).toMatchObject({ status: "active" });
    await expect(svc.resume(companyId, BOARD, { operator: "John", reason: "again" })).rejects.toMatchObject({ status: 409 });

    const [log] = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "company.resumed")));
    expect(log?.details).toMatchObject({
      operator: "John Prempeh",
      reason: "Invoice paid",
      connectionsAwaitingReenable: 2,
    });

    // Still off after resume.
    expect((await connectionRow(tool.id)).enabled).toBe(false);
    expect((await connectionRow(ai.id)).enabled).toBe(false);

    const failingTools = toolAccessService(db, {
      remoteHttpRequest: async () => new Response("down", { status: 503 }),
    });
    // A plain settings patch cannot turn a pause-suspended connection on.
    await expect(failingTools.updateConnection(tool.id, { enabled: true })).rejects.toMatchObject({ status: 409 });

    // The health check fails, so it stays off and its grant stays held.
    await expect(failingTools.reenableConnectionAfterPause(tool.id, BOARD)).rejects.toBeTruthy();
    expect((await connectionRow(tool.id)).enabled).toBe(false);
    expect((await connectionRow(tool.id)).pauseSuspendedAt).not.toBeNull();
    expect(await grantStatuses(tool.id)).toEqual(["suspended"]);

    // An AI account whose credential is healthy comes back, with its grant.
    const back = await failingTools.reenableConnectionAfterPause(ai.id, BOARD);
    expect(back).toMatchObject({ enabled: true, pauseSuspendedAt: null });
    expect(await grantStatuses(ai.id)).toEqual(["active"]);
    await expect(failingTools.reenableConnectionAfterPause(ai.id, BOARD)).rejects.toMatchObject({ status: 409 });

    // An AI account whose credential was rejected stays off.
    await db.update(toolConnections).set({ enabled: false, pauseSuspendedAt: new Date(), healthStatus: "error" })
      .where(eq(toolConnections.id, ai.id));
    await db.update(connectionGrants).set({ status: "suspended" }).where(eq(connectionGrants.connectionId, ai.id));
    await expect(failingTools.reenableConnectionAfterPause(ai.id, BOARD)).rejects.toMatchObject({ status: 422 });
    expect(await grantStatuses(ai.id)).toEqual(["suspended"]);

    // A connection that was already off before the pause is turned on as usual, which frees its grant.
    await failingTools.updateConnection(off.id, { enabled: true, status: "active" });
    expect(await grantStatuses(off.id)).toEqual(["active"]);
  });

  it("AT-4.4: nothing turns on while the company is paused", async () => {
    const { companyId } = await seedCompany();
    const { tool, off } = await seedConnections(companyId);
    await companyService(db).pause(companyId, BOARD, {});
    const tools = toolAccessService(db);
    await expect(tools.reenableConnectionAfterPause(tool.id, BOARD)).rejects.toMatchObject({ status: 409 });
    await expect(tools.updateConnection(off.id, { enabled: true })).rejects.toMatchObject({ status: 409 });
  });

  it("AT-4.5: after a 3-day pause an hourly catch-up routine replays nothing and each agent gets one timer wake", async () => {
    const { companyId, agentId, routine, routines, trigger } = await seedCompany();
    const svc = companyService(db);
    const start = new Date("2026-10-01T00:30:00.000Z");
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-10-01T01:00:00.000Z") })
      .where(eq(routineTriggers.id, trigger.id));
    await svc.pause(companyId, BOARD, {});

    // The scheduler keeps ticking through the pause.
    for (let hour = 1; hour <= 36; hour += 1) {
      expect(await routines.tickScheduledTriggers(new Date(start.getTime() + hour * HOUR))).toEqual({ triggered: 0 });
    }
    // Then the host was down for the rest of the 3 days: the trigger is 36 ticks behind.
    const [behind] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id));
    expect(behind!.nextRunAt!.getTime()).toBeLessThan(start.getTime() + 37 * HOUR);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id))).toHaveLength(0);

    await svc.resume(companyId, BOARD, { operator: "John Prempeh", reason: "Back after three days" });
    const resumedAt = new Date();
    const [rebased] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id));
    expect(rebased!.nextRunAt!.getTime()).toBeGreaterThan(resumedAt.getTime());
    expect(await routines.tickScheduledTriggers(resumedAt)).toEqual({ triggered: 0 });
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id))).toHaveLength(0);

    // Its last timer heartbeat was 3 days ago: one wake, not one per missed hour.
    await db.update(agents).set({ lastHeartbeatAt: new Date(Date.now() - 72 * HOUR) }).where(eq(agents.id, agentId));
    const heartbeat = heartbeatService(db);
    const first = await heartbeat.tickTimers(new Date());
    const second = await heartbeat.tickTimers(new Date());
    expect(first.enqueued).toBeLessThanOrEqual(1);
    expect(second.enqueued).toBe(0);
    const timerWakes = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.source, "timer"), sql`${agentWakeupRequests.status} <> 'cancelled'`));
    expect(timerWakes.length).toBeLessThanOrEqual(1);
  });
});
