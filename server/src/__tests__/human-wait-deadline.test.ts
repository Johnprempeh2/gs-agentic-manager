import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
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
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  workspaceOperations,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "hashed") }),
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
        summary: "Re-checked the block.",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { needsMeService } from "../services/needs-me.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  HUMAN_WAIT_RECHECK_AFTER_MS,
  HUMAN_WAIT_RECHECK_WAKE_REASON,
  buildHumanWaitRecheckIdempotencyKey,
} from "../services/recovery/human-wait-deadline.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres human-wait deadline tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const JOHN = "john-board-user";
const HOUR_MS = 60 * 60 * 1000;

describeEmbeddedPostgres("waits on John or the board: 24h limit (GRE-500)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-human-wait-deadline-");
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

  async function seedWait(opts: {
    ageMs: number;
    owner?: "board" | { userId: string } | { agentId: string };
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Greatstone",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: JOHN,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ridge",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const blockedTransitionAt = new Date(Date.now() - opts.ageMs);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Waits on John to pick a month",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      unblockDescriptor: { owner: opts.owner ?? "board", action: "John picks the release month." },
      blockedTransitionAt,
      createdAt: blockedTransitionAt,
      updatedAt: blockedTransitionAt,
    });
    return { companyId, agentId, issueId, blockedTransitionAt };
  }

  // A re-check wake can coalesce into a run already queued for the issue; the
  // heartbeat then records it under another reason but keeps our key.
  async function recheckWakes(companyId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        like(agentWakeupRequests.idempotencyKey, `${HUMAN_WAIT_RECHECK_WAKE_REASON}:%`),
      ));
  }

  async function overdueWaits(companyId: string) {
    return (await needsMeService(db).build(companyId, { userId: JOHN })).overdueWaits;
  }

  it("leaves a wait under 24h as it is today: no wake, not listed", async () => {
    const { companyId } = await seedWait({ ageMs: 23 * HOUR_MS });

    const result = await heartbeatService(db).reconcileOverdueHumanWaits();

    expect(result.issueIds).toEqual([]);
    expect(await recheckWakes(companyId)).toHaveLength(0);
    expect(await overdueWaits(companyId)).toEqual([]);
  });

  it("lists a wait over 24h with its age and wakes the assignee exactly once", async () => {
    const { companyId, agentId, issueId, blockedTransitionAt } = await seedWait({ ageMs: 25 * HOUR_MS });

    const listedBefore = await overdueWaits(companyId);
    expect(listedBefore).toHaveLength(1);
    expect(listedBefore[0]).toMatchObject({
      id: issueId,
      owner: "board",
      action: "John picks the release month.",
      waitingSinceAt: blockedTransitionAt.toISOString(),
      recheckWokenAt: null,
    });
    expect(listedBefore[0]!.waitingForMs).toBeGreaterThanOrEqual(HUMAN_WAIT_RECHECK_AFTER_MS);

    const first = await heartbeatService(db).reconcileOverdueHumanWaits();
    expect(first.issueIds).toEqual([issueId]);

    const wakes = await recheckWakes(companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentId,
      reason: HUMAN_WAIT_RECHECK_WAKE_REASON,
      idempotencyKey: buildHumanWaitRecheckIdempotencyKey(issueId, blockedTransitionAt),
      payload: expect.objectContaining({ issueId, waitingSinceAt: blockedTransitionAt.toISOString() }),
    });

    const listedAfter = await overdueWaits(companyId);
    expect(listedAfter).toHaveLength(1);
    expect(listedAfter[0]!.recheckWokenAt).not.toBeNull();

    // Second sweep: same wait, no second wake.
    await heartbeatService(db).drainActiveRunExecutions();
    const second = await heartbeatService(db).reconcileOverdueHumanWaits();
    expect(second.issueIds).toEqual([]);
    expect(await recheckWakes(companyId)).toHaveLength(1);
  });

  it("drops a resolved wait from the list, and a new wait gets its own one wake", async () => {
    const { companyId, issueId } = await seedWait({ ageMs: 25 * HOUR_MS });
    await heartbeatService(db).reconcileOverdueHumanWaits();
    await heartbeatService(db).drainActiveRunExecutions();
    expect(await recheckWakes(companyId)).toHaveLength(1);

    await issueService(db).update(issueId, { status: "todo" });
    expect(await overdueWaits(companyId)).toEqual([]);

    // A new wait on the board, 25h later.
    await issueService(db).update(issueId, {
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "John signs the contract." },
    });
    const newTransitionAt = new Date(Date.now() - 25 * HOUR_MS);
    await db.update(issues).set({ blockedTransitionAt: newTransitionAt }).where(eq(issues.id, issueId));

    const result = await heartbeatService(db).reconcileOverdueHumanWaits();
    expect(result.issueIds).toEqual([issueId]);
    const wakes = await recheckWakes(companyId);
    expect(wakes).toHaveLength(2);
    expect(wakes.map((wake) => wake.idempotencyKey)).toContain(
      buildHumanWaitRecheckIdempotencyKey(issueId, newTransitionAt),
    );
  });

  it("only lists waits owned by the board or this user; agent-owned waits are left alone", async () => {
    const other = await seedWait({ ageMs: 30 * HOUR_MS, owner: { userId: "someone-else" } });
    const agentOwned = await seedWait({ ageMs: 30 * HOUR_MS, owner: { agentId: randomUUID() } });

    expect(await overdueWaits(other.companyId)).toEqual([]);
    expect(await overdueWaits(agentOwned.companyId)).toEqual([]);

    const result = await heartbeatService(db).reconcileOverdueHumanWaits();
    // A wait on another person still gets its one re-check; an agent-owned
    // wait is not a human wait at all.
    expect(result.issueIds).toEqual([other.issueId]);
    expect(await recheckWakes(agentOwned.companyId)).toHaveLength(0);
  });
});
