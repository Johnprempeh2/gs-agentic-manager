import request from "supertest";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  memoryIngestOutbox,
  memoryOperations,
  memoryRecords,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
} from "@greatstone/db";
import type { MemoryScope } from "@greatstone/shared";
import { memoryRoutes } from "../routes/memory.js";
import {
  MemoryEngineUnavailableError,
  type MemoryEngine,
  type MemoryEngineDocument,
} from "../services/memory-gateway/engine.js";
import {
  drainMemoryIngestOutbox,
  getDailyPlanUsage,
  memoryIngestEngineFor,
} from "../services/memory-gateway/ingest-outbox.js";
import { createDbMemoryIngestStore } from "../services/memory-gateway/ingest-outbox-db.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/** What Hindsight passes through from the Claude CLI when the plan is used up. */
const PLAN_LIMIT_BODY =
  '{"detail":"Claude Code CLI failed: You\'ve hit your weekly limit · resets Oct 6, 9am (UTC)"}';

/**
 * One engine double, switched between the states the outbox must survive.
 * There is no second route: every call lands here.
 */
function scriptedEngine() {
  const state = {
    mode: "down" as "down" | "plan_limit" | "up",
    calls: 0,
    retained: [] as MemoryEngineDocument[],
  };
  const engine: MemoryEngine = {
    async retain(doc) {
      state.calls += 1;
      if (state.mode === "down") throw new MemoryEngineUnavailableError("connect ECONNREFUSED 127.0.0.1:18888");
      if (state.mode === "plan_limit") throw Object.assign(new Error(PLAN_LIMIT_BODY), { status: 500 });
      state.retained.push(doc);
      return { usage: { inputTokens: 1200, outputTokens: 300 } };
    },
    async recall() {
      return [];
    },
    async deleteDocument() {},
  };
  return { engine, state };
}

describeEmbeddedPostgres("memory ingest outbox (database)", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-outbox-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(memoryIngestOutbox);
      await db.delete(memoryOperations);
      await db.delete(memoryRecords);
      await db.delete(memoryScopes);
      await db.delete(memorySettings);
      await db.delete(principalPermissionGrants);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function setup() {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Outbox");
    const fake = scriptedEngine();
    const factory = (db: typeof ctx.db) => memoryRoutes(db, { engine: fake.engine, engineTimeoutMs: 200 });
    const board = routeApp(ctx.db, seeded.actor, factory);
    const [agent] = await ctx.db
      .insert(agents)
      .values({
        companyId: seeded.companyId,
        name: "Mason",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    const asAgent = routeApp(
      ctx.db,
      { type: "agent", agentId: agent.id, companyId: seeded.companyId, runId: null, source: "agent_key" } as never,
      factory,
    );
    const base = `/api/companies/${seeded.companyId}/memory`;
    expect((await request(board).patch(`${base}/settings`).send({ enabled: true })).status).toBe(200);
    const scopes = await request(asAgent).get(`${base}/scopes`);
    const working = (scopes.body as MemoryScope[]).find((scope) => scope.kind === "agent")!;
    return { ...seeded, fake, asAgent, base, working };
  }

  it("defers on outage and plan limit, never fails the record, then syncs and reports plan use", async () => {
    const { fake, asAgent, base, working, companyId } = await setup();
    const store = createDbMemoryIngestStore(ctx.db);
    const ingestEngine = memoryIngestEngineFor(fake.engine, { timeoutMs: 200 });

    // 1. Engine down at write time: the contribution is kept and queued.
    const write = await request(asAgent).post(`${base}/records`).send({
      scopeId: working.id,
      content: "Kestrel Works pays invoices on net 30 terms.",
      entities: ["Kestrel Works"],
      status: "observation",
    });
    expect(write.status).toBe(201);
    expect(write.body).toMatchObject({ engineAvailable: false });
    const recordId = write.body.record.id as string;

    const [queued] = await ctx.db.select().from(memoryIngestOutbox).where(eq(memoryIngestOutbox.recordId, recordId));
    expect(queued).toMatchObject({ op: "retain", state: "pending", attempts: 1, lastErrorKind: "engine_unavailable" });
    expect((queued.payload as { documentId: string }).documentId).toBe(recordId);
    const firstRetryAt = queued.nextAttemptAt;
    expect(firstRetryAt.getTime()).toBeGreaterThan(Date.now());

    // Nothing is due yet, so a drain now spends no engine call.
    const callsBefore = fake.state.calls;
    expect((await drainMemoryIngestOutbox({ store, engine: ingestEngine })).claimed).toBe(0);
    expect(fake.state.calls).toBe(callsBefore);

    // 2. Plan limit when the retry comes due: deferred to the reset time, still pending.
    fake.state.mode = "plan_limit";
    const atRetry = new Date(firstRetryAt.getTime() + 1_000);
    const limited = await drainMemoryIngestOutbox({ store, engine: ingestEngine, now: () => atRetry });
    expect(limited).toMatchObject({ claimed: 1, deferred: 1, synced: 0, parked: 0, haltedOn: "plan_limit" });
    const [afterLimit] = await ctx.db.select().from(memoryIngestOutbox).where(eq(memoryIngestOutbox.id, queued.id));
    expect(afterLimit).toMatchObject({ state: "pending", attempts: 2, lastErrorKind: "plan_limit" });
    expect(afterLimit.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(Date.UTC(atRetry.getUTCFullYear(), 9, 6, 9, 0));
    const [recordAfterLimit] = await ctx.db.select().from(memoryRecords).where(eq(memoryRecords.id, recordId));
    expect(recordAfterLimit.syncState).toBe("pending");
    expect(recordAfterLimit.syncError).toMatch(/^plan_limit:/);

    // 3. After the reset the engine is up: one call, record synced, usage stored.
    fake.state.mode = "up";
    const afterReset = new Date(afterLimit.nextAttemptAt.getTime() + 1_000);
    const drained = await drainMemoryIngestOutbox({ store, engine: ingestEngine, now: () => afterReset });
    expect(drained).toMatchObject({ claimed: 1, synced: 1, deferred: 0 });
    expect(fake.state.retained.map((doc) => doc.documentId)).toEqual([recordId]);
    const [recordSynced] = await ctx.db.select().from(memoryRecords).where(eq(memoryRecords.id, recordId));
    expect(recordSynced).toMatchObject({ syncState: "synced", syncError: null });

    // A repeat drain does nothing: the entry is done.
    expect((await drainMemoryIngestOutbox({ store, engine: ingestEngine, now: () => afterReset })).claimed).toBe(0);

    // 4. Daily plan use by memory is reported from the synced entries.
    const usage = await getDailyPlanUsage({ store, companyId, days: 30, now: afterReset });
    expect(usage).toEqual([
      expect.objectContaining({ deliveries: 1, modelCalls: 1, inputTokens: 1200, outputTokens: 300 }),
    ]);

    // No row in any table carries a failed state for an outage or plan limit.
    const failedRecords = await ctx.db.select().from(memoryRecords).where(eq(memoryRecords.syncState, "failed"));
    expect(failedRecords).toEqual([]);
  });

  it("marks the entry synced when the direct call succeeds, so the drain never resends it", async () => {
    const { fake, asAgent, base, working } = await setup();
    fake.state.mode = "up";
    const write = await request(asAgent).post(`${base}/records`).send({
      scopeId: working.id,
      content: "Kestrel Works ships from Leeds.",
      status: "observation",
    });
    expect(write.body).toMatchObject({ engineAvailable: true });
    const [entry] = await ctx.db
      .select()
      .from(memoryIngestOutbox)
      .where(eq(memoryIngestOutbox.recordId, write.body.record.id));
    expect(entry).toMatchObject({ state: "synced", inputTokens: 1200, outputTokens: 300 });

    const store = createDbMemoryIngestStore(ctx.db);
    const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const drained = await drainMemoryIngestOutbox({
      store,
      engine: memoryIngestEngineFor(fake.engine),
      now: () => later,
    });
    expect(drained.claimed).toBe(0);
    expect(fake.state.calls).toBe(1);
  });

  it("parks a rejected entry for an owner and shows the record as failed, without dropping it", async () => {
    const { fake, asAgent, base, working } = await setup();
    const write = await request(asAgent).post(`${base}/records`).send({
      scopeId: working.id,
      content: "Kestrel Works contact is the operations lead.",
      status: "observation",
    });
    const recordId = write.body.record.id as string;
    const store = createDbMemoryIngestStore(ctx.db);
    const rejecting = {
      async apply() {
        throw Object.assign(new Error("document too large"), { status: 413 });
      },
    };
    const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const drained = await drainMemoryIngestOutbox({ store, engine: rejecting, now: () => later });
    expect(drained).toMatchObject({ claimed: 1, parked: 1 });
    const [entry] = await ctx.db.select().from(memoryIngestOutbox).where(eq(memoryIngestOutbox.recordId, recordId));
    expect(entry).toMatchObject({ state: "needs_attention", lastErrorKind: "rejected" });
    const [record] = await ctx.db.select().from(memoryRecords).where(eq(memoryRecords.id, recordId));
    expect(record.syncState).toBe("failed");
  });
});
