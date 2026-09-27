import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LIVE_RELEASE_MONITOR_SERVICE_NAME } from "@greatstone/shared";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  workspaceRuntimeServices,
} from "@greatstone/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import { LIVE_RELEASE_ACTIVITY_ACTION, announceLiveRelease } from "../services/live-release-announce.ts";
import type { LiveReleaseEvent } from "../services/live-release.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const LIVE_COMMIT = "a".repeat(40);
const event: LiveReleaseEvent = {
  commit: LIVE_COMMIT,
  tag: "live-2026-09-28.1",
  startedAt: "2026-09-28T10:00:00.000Z",
  previousCommit: "9".repeat(40),
  previousTag: "live-2026-09-27.1",
};
// Live contains aaaaaaa; bbbbbbb is not released yet.
const isRefLive = (ref: string) => (ref === "aaaaaaa" ? true : ref === "bbbbbbb" ? false : null);

describeEmbeddedPostgres("live release announcement (GRE-50)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let issueNumber = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-release-announce-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    const pending = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) await heartbeat.cancelRun(run.id, "Fixture teardown", { suppressImmediateRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    // The woken no-op runs finish in the background; retry until they settle.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        for (const table of [
          heartbeatRunEvents, issueRecoveryActions, issueThreadInteractions, issueComments, documentRevisions,
          issueDocuments, documents, activityLog, environmentLeases, workspaceRuntimeServices, issues, heartbeatRuns,
          agentWakeupRequests, agentRuntimeState, agents, companySkills, companies,
        ]) {
          await db.delete(table);
        }
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Greatstone",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "john",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Summit",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(input: { companyId: string; agentId: string; monitor?: Record<string, unknown> }) {
    const id = randomUUID();
    issueNumber += 1;
    const nextCheckAt = new Date("2099-01-01T00:00:00.000Z");
    const monitor = input.monitor
      ? { nextCheckAt: nextCheckAt.toISOString(), notes: "After-check", scheduledBy: "assignee", ...input.monitor }
      : null;
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: "After-check once the fix is live",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: input.agentId,
      issueNumber,
      identifier: `T-${issueNumber}`,
      executionPolicy: monitor ? normalizeIssueExecutionPolicy({ mode: "normal", commentRequired: true, stages: [], monitor }) : null,
      ...(monitor
        ? {
            monitorNextCheckAt: nextCheckAt,
            monitorAttemptCount: 0,
            monitorNotes: "After-check",
            monitorScheduledBy: "assignee",
          }
        : {}),
    });
    return id;
  }

  async function seedCard(input: { companyId: string; agentId: string; issueId: string; idempotencyKey: string }) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: "request_confirmation",
      status: "pending",
      idempotencyKey: input.idempotencyKey,
      createdByAgentId: input.agentId,
      payload: { version: 1, prompt: "Is it released?", acceptLabel: "Released", rejectLabel: "Not yet" },
    });
    return id;
  }

  const wakesFor = (issueId: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`);

  it("records the release, wakes waiting issues once, and leaves others alone", async () => {
    const { companyId, agentId } = await seedCompany();
    const waiting = await seedIssue({ companyId, agentId, monitor: { serviceName: LIVE_RELEASE_MONITOR_SERVICE_NAME } });
    const waitingForLiveCommit = await seedIssue({
      companyId,
      agentId,
      monitor: { serviceName: LIVE_RELEASE_MONITOR_SERVICE_NAME, externalRef: "aaaaaaa" },
    });
    const waitingForLaterCommit = await seedIssue({
      companyId,
      agentId,
      monitor: { serviceName: LIVE_RELEASE_MONITOR_SERVICE_NAME, externalRef: "bbbbbbb" },
    });
    const otherMonitor = await seedIssue({ companyId, agentId, monitor: { serviceName: "Vendor deploy" } });
    const notWaiting = await seedIssue({ companyId, agentId });

    await announceLiveRelease(db, event, isRefLive);

    const activity = await db.select().from(activityLog).where(eq(activityLog.action, LIVE_RELEASE_ACTIVITY_ACTION));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ companyId, entityType: "release", entityId: LIVE_COMMIT });
    expect(activity[0].details).toMatchObject({ commit: LIVE_COMMIT, tag: "live-2026-09-28.1", startedAt: event.startedAt });

    for (const issueId of [waiting, waitingForLiveCommit]) {
      const wakes = await wakesFor(issueId);
      expect(wakes).toHaveLength(1);
      expect(wakes[0].reason).toBe("issue_monitor_due");
      expect(wakes[0].payload).toMatchObject({ liveRelease: { commit: LIVE_COMMIT, tag: "live-2026-09-28.1" } });
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(row.monitorNextCheckAt).toBeNull();
    }
    for (const issueId of [waitingForLaterCommit, otherMonitor, notWaiting]) {
      expect(await wakesFor(issueId)).toHaveLength(0);
    }
    // The not-yet-live wait keeps its own deadline.
    const [later] = await db.select().from(issues).where(eq(issues.id, waitingForLaterCommit));
    expect(later.monitorNextCheckAt?.toISOString()).toBe("2099-01-01T00:00:00.000Z");

    // Announcing the same release again (a crash before live.json was written) does nothing new.
    await announceLiveRelease(db, event, isRefLive);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, LIVE_RELEASE_ACTIVITY_ACTION))).toHaveLength(1);
    expect(await wakesFor(waiting)).toHaveLength(1);
    expect(await wakesFor(waitingForLiveCommit)).toHaveLength(1);
  });

  it("withdraws answered 'is it released?' cards and wakes their agent once", async () => {
    const { companyId, agentId } = await seedCompany();
    const answeredIssue = await seedIssue({ companyId, agentId });
    const answered = await seedCard({ companyId, agentId, issueId: answeredIssue, idempotencyKey: `confirmation:${answeredIssue}:release:aaaaaaa` });
    const openIssue = await seedIssue({ companyId, agentId });
    const notYet = await seedCard({ companyId, agentId, issueId: openIssue, idempotencyKey: `confirmation:${openIssue}:release:bbbbbbb` });
    const noRef = await seedCard({ companyId, agentId, issueId: openIssue, idempotencyKey: `confirmation:${openIssue}:pr6-released` });

    await announceLiveRelease(db, event, isRefLive);

    const status = async (id: string) =>
      (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)))[0]?.status;
    expect(await status(answered)).toBe("cancelled");
    expect(await status(notYet)).toBe("pending");
    expect(await status(noRef)).toBe("pending");

    const wakes = await wakesFor(answeredIssue);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].reason).toBe("live_release");
    expect(wakes[0].payload).toMatchObject({ liveRelease: { commit: LIVE_COMMIT }, withdrawnInteractionIds: [answered] });
    expect(await wakesFor(openIssue)).toHaveLength(0);

    await announceLiveRelease(db, event, isRefLive);
    expect(await wakesFor(answeredIssue)).toHaveLength(1);
  });
});
