import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IssueUnblockDescriptor } from "@greatstone/shared";
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
        summary: "Chased the client.",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  WAITING_DATE_PASSED_WAKE_REASON,
  buildWaitingDatePassedIdempotencyKey,
  carryWaitingDateMarker,
  needsWaitingDatePassedWake,
} from "../services/recovery/waiting-date.ts";

const NOW = new Date("2026-10-22T09:00:00Z");

describe("waiting date passed: selection rule", () => {
  const base = {
    status: "blocked",
    hiddenAt: null,
    assigneeAgentId: "agent-1",
    unblockDescriptor: {
      owner: { agentId: "agent-1" },
      action: "Chase the client",
      waitingOn: "client",
      expectedBy: "2026-10-20",
    } as IssueUnblockDescriptor,
  };

  it("is due for a blocked, visible, assigned task whose date has passed", () => {
    expect(needsWaitingDatePassedWake(base, NOW)).toBe(true);
  });

  it("is not due when unblocked, hidden, unassigned, future-dated or already woken for this date", () => {
    expect(needsWaitingDatePassedWake({ ...base, status: "todo" }, NOW)).toBe(false);
    expect(needsWaitingDatePassedWake({ ...base, hiddenAt: new Date() }, NOW)).toBe(false);
    expect(needsWaitingDatePassedWake({ ...base, assigneeAgentId: null }, NOW)).toBe(false);
    expect(needsWaitingDatePassedWake({
      ...base,
      unblockDescriptor: { ...base.unblockDescriptor, expectedBy: "2026-10-22" },
    }, NOW)).toBe(false);
    expect(needsWaitingDatePassedWake({
      ...base,
      unblockDescriptor: { ...base.unblockDescriptor, expectedByWokenFor: "2026-10-20" },
    }, NOW)).toBe(false);
  });

  it("ignores a client-sent marker and keeps the stored one only while the date is unchanged", () => {
    const stored = { ...base.unblockDescriptor, expectedByWokenFor: "2026-10-20" };
    expect(carryWaitingDateMarker({ ...base.unblockDescriptor, expectedByWokenFor: "2026-10-30" }, null))
      .not.toHaveProperty("expectedByWokenFor");
    expect(carryWaitingDateMarker({ ...base.unblockDescriptor, action: "Chase again" }, stored))
      .toMatchObject({ expectedByWokenFor: "2026-10-20", action: "Chase again" });
    expect(carryWaitingDateMarker({ ...base.unblockDescriptor, expectedBy: "2026-10-27" }, stored))
      .not.toHaveProperty("expectedByWokenFor");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres waiting-date tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("waiting on someone outside until a date: sweep", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-waiting-date-");
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

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Greatstone",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "john-board-user",
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
    return { companyId, agentId, issuePrefix, next: 1 };
  }

  async function seedIssue(
    company: Awaited<ReturnType<typeof seedCompany>>,
    opts: { expectedBy?: string; status?: string; hidden?: boolean; descriptor?: boolean } = {},
  ) {
    const issueId = randomUUID();
    const number = company.next++;
    const status = opts.status ?? "blocked";
    await db.insert(issues).values({
      id: issueId,
      companyId: company.companyId,
      title: "Waits on the client's sign-off",
      status,
      priority: "medium",
      assigneeAgentId: company.agentId,
      issueNumber: number,
      identifier: `${company.issuePrefix}-${number}`,
      unblockDescriptor: opts.descriptor === false
        ? null
        : {
          owner: { agentId: company.agentId },
          action: "Chase the client for sign-off.",
          waitingOn: "client",
          expectedBy: opts.expectedBy ?? "2026-10-20",
        },
      blockedTransitionAt: status === "blocked" ? new Date("2026-10-10T09:00:00Z") : null,
      hiddenAt: opts.hidden ? new Date() : null,
    });
    return issueId;
  }

  async function dateWakes(companyId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        like(agentWakeupRequests.idempotencyKey, `${WAITING_DATE_PASSED_WAKE_REASON}:%`),
      ));
  }

  async function sweep(opts: { companyId?: string; now?: Date } = {}) {
    const result = await heartbeatService(db).reconcileWaitingDatesPassed({ now: NOW, ...opts });
    await heartbeatService(db).drainActiveRunExecutions();
    return result;
  }

  it("wakes the assignee once when the date has passed, not twice", async () => {
    const company = await seedCompany();
    const issueId = await seedIssue(company);

    const first = await sweep();
    expect(first.issueIds).toEqual([issueId]);
    const wakes = await dateWakes(company.companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentId: company.agentId,
      reason: WAITING_DATE_PASSED_WAKE_REASON,
      idempotencyKey: buildWaitingDatePassedIdempotencyKey(issueId, "2026-10-20"),
      payload: expect.objectContaining({ issueId, expectedBy: "2026-10-20", waitingOn: "client" }),
    });

    const row = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(row.unblockDescriptor).toMatchObject({ expectedBy: "2026-10-20", expectedByWokenFor: "2026-10-20" });

    const logged = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.waiting_date_passed_woken")));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.details).toMatchObject({ expectedBy: "2026-10-20", waitingOn: "client" });

    const second = await sweep();
    expect(second.issueIds).toEqual([]);
    expect(await dateWakes(company.companyId)).toHaveLength(1);
  });

  it("does not wake again when the descriptor is rewritten with the same date, but does for a new date", async () => {
    const company = await seedCompany();
    const issueId = await seedIssue(company);
    await sweep();
    expect(await dateWakes(company.companyId)).toHaveLength(1);
    // The test run checked the task out; put it back to waiting.
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));

    // The agent rewrites its note but keeps the date (even sending a stale marker).
    await issueService(db).update(issueId, {
      unblockDescriptor: {
        owner: { agentId: company.agentId },
        action: "Chased once; waiting for their reply.",
        waitingOn: "client",
        expectedBy: "2026-10-20",
        expectedByWokenFor: "2026-01-01",
      },
    });
    const rewritten = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(rewritten.status).toBe("blocked");
    expect(rewritten.unblockDescriptor).toMatchObject({
      action: "Chased once; waiting for their reply.",
      expectedByWokenFor: "2026-10-20",
    });
    expect((await sweep()).issueIds).toEqual([]);
    expect(await dateWakes(company.companyId)).toHaveLength(1);

    // A new date, still in the future: nothing yet.
    await issueService(db).update(issueId, {
      unblockDescriptor: {
        owner: { agentId: company.agentId },
        action: "Chased; they promised an answer by Monday.",
        waitingOn: "client",
        expectedBy: "2026-10-26",
      },
    });
    expect((await sweep()).issueIds).toEqual([]);

    // Once that new date has passed, one more wake.
    const later = new Date("2026-10-27T09:00:00Z");
    expect((await sweep({ now: later })).issueIds).toEqual([issueId]);
    expect((await sweep({ now: later })).issueIds).toEqual([]);
    const wakes = await dateWakes(company.companyId);
    expect(wakes.map((wake) => wake.idempotencyKey).sort()).toEqual([
      buildWaitingDatePassedIdempotencyKey(issueId, "2026-10-20"),
      buildWaitingDatePassedIdempotencyKey(issueId, "2026-10-26"),
    ]);
  });

  it("ignores unblocked, hidden, undated and future-dated tasks, and the expected day itself", async () => {
    const company = await seedCompany();
    await seedIssue(company, { status: "todo", descriptor: false });
    await seedIssue(company, { status: "in_progress", expectedBy: "2026-10-01" });
    await seedIssue(company, { hidden: true });
    await seedIssue(company, { descriptor: false });
    await seedIssue(company, { expectedBy: "2026-10-30" });
    await seedIssue(company, { expectedBy: "2026-10-22" });

    expect((await sweep()).issueIds).toEqual([]);
    expect(await dateWakes(company.companyId)).toHaveLength(0);
  });

  it("keeps each company to its own tasks", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const issueA = await seedIssue(companyA);
    const issueB = await seedIssue(companyB);

    expect((await sweep({ companyId: companyA.companyId })).issueIds).toEqual([issueA]);
    expect(await dateWakes(companyA.companyId)).toHaveLength(1);
    expect(await dateWakes(companyB.companyId)).toHaveLength(0);
    const rowB = await db.select().from(issues).where(eq(issues.id, issueB)).then((rows) => rows[0]!);
    expect(rowB.unblockDescriptor).not.toHaveProperty("expectedByWokenFor");

    // The wake for company A went to company A's agent only.
    const wakesA = await dateWakes(companyA.companyId);
    expect(wakesA[0]!.agentId).toBe(companyA.agentId);

    expect((await sweep()).issueIds).toEqual([issueB]);
    expect((await dateWakes(companyB.companyId))[0]!.agentId).toBe(companyB.agentId);
  });
});
