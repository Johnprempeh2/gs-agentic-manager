import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { explicitOperatorRunIdentity } from "../services/run-identity.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Live, 30 Sep 20:49 to 21:15: a queued-message interrupt run was queued a
// second after another run had already delivered its messages. Its identity
// check refused it on every pass, which failed recovery for every agent and
// stalled the agent's queue for 24 minutes.
describeEmbeddedPostgres("heartbeat: a spent queued-message interrupt", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-stale-queued-interrupt-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("is discarded when claimed instead of failing every recovery pass", { timeout: 20_000 }, async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const receiptId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Interrupt Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lead",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    // The queue receipt another run already consumed.
    await db.insert(agentWakeupRequests).values({
      id: receiptId,
      companyId,
      agentId,
      source: "on_demand",
      status: "completed",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      status: "queued",
      idempotencyKey: `queued-comment-interrupt:${receiptId}`,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "queued",
      wakeupRequestId,
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));

    // The pass keeps admission follow-ups alive, so watch the run, not the promise.
    void heartbeatService(db).resumeQueuedRuns().catch(() => undefined);
    let run: typeof heartbeatRuns.$inferSelect | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (run?.status !== "queued") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(run).toMatchObject({
      status: "cancelled",
      error: "Cancelled because its queued messages were already delivered",
      errorCode: "queued_interrupt_spent",
    });
  });

  // Review, 1 Oct: "Send now" on a queued decision answer (no typed message)
  // carries no comment ids. It is a real delivery and must keep its authority.
  it("keeps the authority of an interrupt that delivers only a decision answer", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const receiptId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Answer Co",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Lead", role: "ceo", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "on_demand", status: "queued", contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: receiptId, companyId, agentId, source: "on_demand", status: "coalesced", runId,
      payload: {
        queuedCommentInterrupt: { actorId: "board-user", requestedAt: new Date().toISOString() },
        mutation: "interaction", interactionId: randomUUID(), interactionStatus: "answered",
      },
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "on_demand", status: "queued", runId,
      idempotencyKey: `queued-comment-interrupt:${receiptId}`,
      requestedByActorType: "user", requestedByActorId: "board-user",
    });
    await db.update(heartbeatRuns).set({ wakeupRequestId }).where(eq(heartbeatRuns.id, runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));

    await expect(explicitOperatorRunIdentity(db, run!)).resolves.toMatchObject({ actorId: "board-user" });
    // The same receipt from a different actor is still refused, and not as "spent".
    await db.update(agentWakeupRequests).set({ requestedByActorId: "someone-else" })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await expect(explicitOperatorRunIdentity(db, run!)).rejects.toMatchObject({
      status: 403, details: undefined,
    });
  });

  // Review, 1 Oct: a run refused on every pass stayed queued for ever.
  it("settles a run that fails to claim five passes in a row", { timeout: 30_000 }, async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stuck Co",
      issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Lead", role: "ceo", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } }, permissions: {},
    });
    // A manual wake must come from a user; this one never will.
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "on_demand", status: "queued",
      payload: { manualUserWake: true }, requestedByActorType: "agent", requestedByActorId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "on_demand", status: "queued", wakeupRequestId,
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));

    const heartbeat = heartbeatService(db);
    let run: typeof heartbeatRuns.$inferSelect | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      void heartbeat.resumeQueuedRuns().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
      [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (run?.status !== "queued") break;
    }
    expect(run).toMatchObject({ status: "cancelled", errorCode: "claim_failed" });
    expect(run?.error).toContain("could not start after 5 tries: Manual wake requires an authenticated user");
  });
});
