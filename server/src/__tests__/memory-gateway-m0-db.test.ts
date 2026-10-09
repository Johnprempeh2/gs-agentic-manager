import request from "supertest";
import { expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  memoryConflicts,
  memoryExtractedFacts,
  memoryIngestOutbox,
  memoryOperations,
  memoryRecords,
  memoryRelationships,
  memoryReviewEvents,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
} from "@greatstone/db";
import type { MemoryScope } from "@greatstone/shared";
import { memoryRoutes } from "../routes/memory.js";
import { MemoryEngineUnavailableError, type MemoryEngine } from "../services/memory-gateway/engine.js";
import {
  MEMORY_RETENTION_INTERVAL_MS,
  resetMemoryRetentionSchedule,
  runScheduledMemoryIngestDrain,
  runScheduledMemoryRetention,
} from "../services/memory-gateway/scheduled-work.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Memory gateway M0 (GRE-1079). Each case failed before the change: retention
// ran only when someone called the route, the outbox drain was never started
// and parked entries were reported nowhere, and review events had no app or
// session.

const DAY = 24 * 60 * 60 * 1000;

function switchableEngine() {
  const state = { mode: "down" as "down" | "up" | "reject", retained: [] as string[] };
  const engine: MemoryEngine = {
    async retain(doc) {
      if (state.mode === "down") throw new MemoryEngineUnavailableError("connect ECONNREFUSED 127.0.0.1:18888");
      if (state.mode === "reject") throw Object.assign(new Error(`bad document ${doc.content}`), { status: 422 });
      state.retained.push(doc.documentId);
    },
    async recall() {
      return [];
    },
    async deleteDocument() {
      if (state.mode === "down") throw new MemoryEngineUnavailableError("connect ECONNREFUSED 127.0.0.1:18888");
    },
  };
  return { engine, state };
}

describeEmbeddedPostgres("memory gateway M0 hardening (GRE-1079)", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-m0-", {
    resetEach: async (db) => {
      resetMemoryRetentionSchedule();
      await db.delete(activityLog);
      await db.delete(memoryExtractedFacts);
      await db.delete(memoryConflicts);
      await db.delete(memoryRelationships);
      await db.delete(memoryReviewEvents);
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

  async function setup(name: string) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    const fake = switchableEngine();
    const factory = (db: typeof ctx.db) => memoryRoutes(db, { engine: fake.engine, engineTimeoutMs: 200 });
    const board = routeApp(ctx.db, { ...seeded.actor, sessionId: "session-john-1" } as never, factory);
    const [agent] = await ctx.db
      .insert(agents)
      .values({ companyId: seeded.companyId, name: "Mason", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await ctx.db
      .insert(principalPermissionGrants)
      .values({ companyId: seeded.companyId, principalType: "agent", principalId: agent.id, permissionKey: "memory:contribute", scope: null });
    const asAgent = routeApp(
      ctx.db,
      { type: "agent", agentId: agent.id, companyId: seeded.companyId, runId: null, keyId: "key-mason-1", source: "agent_key" } as never,
      factory,
    );
    const base = `/api/companies/${seeded.companyId}/memory`;
    expect((await request(board).patch(`${base}/settings`).send({ enabled: true, retainMode: "chunks" })).status).toBe(200);
    const scopes = (await request(asAgent).get(`${base}/scopes`)).body as MemoryScope[];
    const org = scopes.find((scope) => scope.kind === "organization")!;
    const working = scopes.find((scope) => scope.kind === "agent")!;
    return { ...seeded, fake, board, asAgent, agent, base, org, working };
  }

  it("stores the person, app and session on propose, confirm and reject", async () => {
    const { fake, board, asAgent, agent, base, org, companyId, userId } = await setup("Provenance");
    fake.state.mode = "up";
    const proposed = await request(asAgent).post(`${base}/records`).send({ scopeId: org.id, content: "Invoices go out on the first working day." });
    expect(proposed.status).toBe(201);
    const recordId = proposed.body.record.id as string;
    expect((await request(board).post(`${base}/records/${recordId}/review`).send({ action: "dispute", reason: "Check the date" })).status).toBe(200);
    expect((await request(board).post(`${base}/records/${recordId}/review`).send({ action: "approve", reason: "Confirmed" })).status).toBe(200);

    const events = await ctx.db
      .select()
      .from(memoryReviewEvents)
      .where(and(eq(memoryReviewEvents.companyId, companyId), eq(memoryReviewEvents.recordId, recordId)));
    const byAction = new Map(events.map((event) => [event.action, event]));
    expect(byAction.get("contribute")).toMatchObject({ agentId: agent.id, app: "gsam_agent_key", sessionId: "key-mason-1" });
    expect(byAction.get("dispute")).toMatchObject({ userId, app: "gsam_web", sessionId: "session-john-1" });
    expect(byAction.get("approve")).toMatchObject({ userId, app: "gsam_web", sessionId: "session-john-1" });

    // The history the review screen reads carries them too.
    const history = await request(board).get(`${base}/records/${recordId}/history`);
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.body)).toContain("session-john-1");

    // The audit ledger row for each call has them as well.
    const ops = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.companyId, companyId));
    expect(ops.find((op) => op.operation === "contribute")).toMatchObject({ app: "gsam_agent_key", sessionId: "key-mason-1" });
    expect(ops.find((op) => op.operation === "review_approve")).toMatchObject({ app: "gsam_web", sessionId: "session-john-1" });
  });

  it("runs retention on a schedule, logs it, and forgets the text but keeps the record", async () => {
    const { fake, board, asAgent, base, org, working, companyId } = await setup("ScheduledRetention");
    fake.state.mode = "up";
    const note = (await request(asAgent).post(`${base}/records`).send({ scopeId: working.id, content: "Scratch: Kestrel PO 4471" })).body.record;
    const stale = (await request(board).post(`${base}/records`).send({ scopeId: org.id, content: "Old unreviewed idea about Kestrel" })).body.record;
    const fresh = (await request(board).post(`${base}/records`).send({ scopeId: org.id, content: "New idea" })).body.record;
    const ago = (days: number) => new Date(Date.now() - days * DAY);
    await ctx.db.update(memoryRecords).set({ updatedAt: ago(91), lastUsedAt: ago(91) }).where(eq(memoryRecords.id, note.id));
    await ctx.db.update(memoryRecords).set({ createdAt: ago(181) }).where(eq(memoryRecords.id, stale.id));

    // The engine is down: the deletes wait in the outbox, retention still runs.
    fake.state.mode = "down";
    const now = new Date();
    expect(await runScheduledMemoryRetention(ctx.db, now)).toEqual({ ran: 1 });

    const rows = new Map((await ctx.db.select().from(memoryRecords)).map((row) => [row.id, row]));
    for (const id of [note.id, stale.id]) {
      // Delete = forget: the row stays as a tombstone with no text.
      expect(rows.get(id)).toMatchObject({ status: "deleted", title: null, content: null, entities: [], topics: [] });
    }
    expect(rows.get(fresh.id)?.status).toBe("unreviewed");
    const deletes = await ctx.db.select().from(memoryIngestOutbox).where(eq(memoryIngestOutbox.op, "delete"));
    expect(deletes.map((row) => row.recordId).sort()).toEqual([note.id, stale.id].sort());
    expect(deletes.every((row) => row.state === "pending")).toBe(true);
    // No copy of the text is left in a retain payload either.
    const retains = await ctx.db.select().from(memoryIngestOutbox).where(eq(memoryIngestOutbox.op, "retain"));
    expect(JSON.stringify(retains.filter((row) => row.recordId !== fresh.id).map((row) => row.payload))).not.toContain("Kestrel");

    // Logged: one audit row for the pass, a review event per record, by the scheduler.
    const passes = await ctx.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.companyId, companyId), eq(memoryOperations.operation, "retention")));
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({
      outcome: "ok",
      actorType: "system",
      app: "gsam_scheduler",
      detail: { trigger: "schedule", count: 2, deleted: 2, byRule: { agent_working_notes: 1, unreviewed: 1 } },
    });
    const events = await ctx.db.select().from(memoryReviewEvents).where(eq(memoryReviewEvents.action, "delete"));
    expect(events.map((event) => [event.recordId, event.actorType, event.reason]).sort()).toEqual(
      [
        [note.id, "system", "Retention: agent_working_notes"],
        [stale.id, "system", "Retention: unreviewed"],
      ].sort(),
    );

    // Once a day: a later sweep the same day, or after a restart, does not run again.
    expect(await runScheduledMemoryRetention(ctx.db, new Date(now.getTime() + 60_000))).toEqual({ ran: 0 });
    resetMemoryRetentionSchedule();
    expect(await runScheduledMemoryRetention(ctx.db, new Date(now.getTime() + 60_000))).toEqual({ ran: 0 });
    // The audit row is stamped by the database clock, so allow a few minutes.
    expect(await runScheduledMemoryRetention(ctx.db, new Date(now.getTime() + MEMORY_RETENTION_INTERVAL_MS + 5 * 60_000))).toEqual({ ran: 1 });
  });

  it("drains the retry queue when the engine is back", async () => {
    const { fake, asAgent, base, working } = await setup("Drain");
    const write = await request(asAgent).post(`${base}/records`).send({ scopeId: working.id, content: "Kestrel pays on net 30." });
    expect(write.body).toMatchObject({ engineAvailable: false });
    const recordId = write.body.record.id as string;
    const [queued] = await ctx.db.select().from(memoryIngestOutbox).where(eq(memoryIngestOutbox.recordId, recordId));
    expect(queued.state).toBe("pending");

    fake.state.mode = "up";
    const due = new Date(queued.nextAttemptAt.getTime() + 1_000);
    const result = await runScheduledMemoryIngestDrain(ctx.db, fake.engine, { now: () => due, engineTimeoutMs: 200 });
    expect(result).toMatchObject({ claimed: 1, synced: 1, failed: [] });
    expect(fake.state.retained).toEqual([recordId]);
    const [record] = await ctx.db.select().from(memoryRecords).where(eq(memoryRecords.id, recordId));
    expect(record.syncState).toBe("synced");
  });

  it("reports an entry the engine refuses, and an overdue one, once each and without the text", async () => {
    const { fake, asAgent, base, working, companyId } = await setup("DrainFailures");
    const refused = (await request(asAgent).post(`${base}/records`).send({ scopeId: working.id, content: "Kestrel secret-ish detail" })).body.record;
    const [entry] = await ctx.db.select().from(memoryIngestOutbox).where(eq(memoryIngestOutbox.recordId, refused.id));

    fake.state.mode = "reject";
    let at = new Date(entry.nextAttemptAt.getTime() + 1_000);
    const first = await runScheduledMemoryIngestDrain(ctx.db, fake.engine, { now: () => at, engineTimeoutMs: 200 });
    expect(first.failed).toEqual([expect.objectContaining({ recordId: refused.id, kind: "rejected" })]);
    const [parked] = await ctx.db.select().from(memoryIngestOutbox).where(eq(memoryIngestOutbox.id, entry.id));
    expect(parked.state).toBe("needs_attention");

    const failedRows = await ctx.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.companyId, companyId), eq(memoryOperations.operation, "ingest_failed")));
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]).toMatchObject({ outcome: "failed", recordId: refused.id, actorType: "system", detail: { outboxId: entry.id, kind: "rejected" } });
    expect(JSON.stringify(failedRows[0].detail)).not.toContain("Kestrel");

    // A parked entry is not claimed again, so it is reported once.
    at = new Date(at.getTime() + DAY);
    expect((await runScheduledMemoryIngestDrain(ctx.db, fake.engine, { now: () => at })).claimed).toBe(0);

    // Overdue: reported when it reaches the threshold, not on every later retry.
    fake.state.mode = "down";
    const slow = (await request(asAgent).post(`${base}/records`).send({ scopeId: working.id, content: "Another note" })).body.record;
    for (let pass = 0; pass < 3; pass += 1) {
      const [current] = await ctx.db.select().from(memoryIngestOutbox).where(eq(memoryIngestOutbox.recordId, slow.id));
      at = new Date(current.nextAttemptAt.getTime() + 1_000);
      await runScheduledMemoryIngestDrain(ctx.db, fake.engine, { now: () => at, engineTimeoutMs: 200, overdueAfterAttempts: 2 });
    }
    const overdueRows = await ctx.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.companyId, companyId), eq(memoryOperations.operation, "ingest_overdue")));
    expect(overdueRows).toHaveLength(1);
    expect(overdueRows[0]).toMatchObject({ outcome: "overdue", recordId: slow.id, detail: expect.objectContaining({ attempts: 2 }) });
  });
});
