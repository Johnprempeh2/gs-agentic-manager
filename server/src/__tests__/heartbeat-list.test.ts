import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { boundHeartbeatRunEventPayloadForStorage, heartbeatService } from "../services/heartbeat.ts";
import { summarizeRunFailureRate } from "../services/run-failure-rate.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat list tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat list", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-list-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("counts more than 1,000 finished runs by status in one query, inside the window only (GRE-1325)", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    for (const id of [companyId, otherCompanyId]) {
      await db.insert(companies).values({
        id,
        name: "GS Agentic Manager",
        issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    const agentRow = (id: string, company: string) => ({
      id, companyId: company, name: `Agent ${id.slice(0, 4)}`, role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(agents).values([agentRow(agentId, companyId), agentRow(otherAgentId, otherCompanyId)]);

    const since = new Date("2026-10-01T00:00:00Z");
    const before = new Date("2026-10-08T00:00:00Z");
    const inside = new Date("2026-10-04T12:00:00Z");
    const run = (status: string, finishedAt: Date | null, overrides: { companyId?: string; agentId?: string } = {}) => ({
      companyId, agentId, invocationSource: "assignment", status, finishedAt, ...overrides,
    });
    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 1150 }, () => run("succeeded", inside)),
      ...Array.from({ length: 40 }, () => run("failed", inside)),
      ...Array.from({ length: 6 }, () => run("timed_out", inside)),
      ...Array.from({ length: 4 }, () => run("interrupted", inside)),
      ...Array.from({ length: 25 }, () => run("cancelled", inside)),
      run("succeeded", since), // inclusive start
      run("failed", before), // exclusive end
      run("failed", new Date("2026-09-20T00:00:00Z")), // before the window
      run("running", null), // not finished
      run("failed", inside, { companyId: otherCompanyId, agentId: otherAgentId }), // another company
    ]);

    const heartbeat = heartbeatService(db);
    const counts = await heartbeat.countFinishedByStatus(companyId, { since, before });
    const rate = summarizeRunFailureRate({ since, before, counts });
    expect(rate.byStatus).toEqual({ succeeded: 1151, failed: 40, timed_out: 6, interrupted: 4, cancelled: 25 });
    expect(rate).toMatchObject({ failed: 50, judged: 1201, failedPer100: 4.2 });

    const none = await heartbeat.countFinishedByStatus(companyId, { since, before, agentId: otherAgentId });
    expect(summarizeRunFailureRate({ since, before, counts: none })).toMatchObject({ judged: 0, failedPer100: null });
  });

  it("returns runs even when the linked db schema lacks processGroupId", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      livenessState: "advanced",
      livenessReason: "run produced action evidence",
      continuationAttempt: 1,
      lastUsefulActionAt: new Date("2026-04-18T12:00:00Z"),
      nextAction: "continue implementation",
      contextSnapshot: { issueId: randomUUID() },
    });

    const originalDescriptor = Object.getOwnPropertyDescriptor(heartbeatRuns, "processGroupId");
    Object.defineProperty(heartbeatRuns, "processGroupId", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      const runs = await heartbeatService(db).list(companyId, agentId, 5);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(runId);
      expect(runs[0]?.processGroupId ?? null).toBeNull();
      expect(runs[0]).toMatchObject({
        livenessState: "advanced",
        livenessReason: "run produced action evidence",
        continuationAttempt: 1,
        nextAction: "continue implementation",
      });
      expect(runs[0]?.lastUsefulActionAt).toEqual(new Date("2026-04-18T12:00:00Z"));
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(heartbeatRuns, "processGroupId", originalDescriptor);
      } else {
        delete (heartbeatRuns as Record<string, unknown>).processGroupId;
      }
    }
  });

  it("filters by status and bounds by createdAt (GRE-794)", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    for (const id of [companyId, otherCompanyId]) {
      await db.insert(companies).values({
        id,
        name: "GS Agentic Manager",
        issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    for (const [id, company] of [[agentId, companyId], [otherAgentId, otherCompanyId]] as const) {
      await db.insert(agents).values({
        id,
        companyId: company,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }

    const run = (status: string, createdAt: string, company = companyId, agent = agentId) => ({
      id: randomUUID(),
      companyId: company,
      agentId: agent,
      invocationSource: "assignment",
      status,
      createdAt: new Date(createdAt),
    });
    const rows = [
      run("failed", "2026-09-27T10:00:00Z"),
      run("succeeded", "2026-09-28T10:00:00Z"),
      run("interrupted", "2026-09-29T10:00:00Z"),
      run("failed", "2026-10-01T10:00:00Z"),
      run("cancelled", "2026-10-02T10:00:00Z"),
      run("failed", "2026-09-30T10:00:00Z", otherCompanyId, otherAgentId),
    ];
    await db.insert(heartbeatRuns).values(rows);
    const ids = (list: { id: string }[]) => list.map((r) => r.id);
    const svc = heartbeatService(db);

    // No new filter: every company row, newest first, as before.
    expect(ids(await svc.list(companyId))).toEqual([rows[4].id, rows[3].id, rows[2].id, rows[1].id, rows[0].id]);

    const failed = await svc.list(companyId, undefined, undefined, { statuses: ["failed"] });
    expect(failed.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(ids(failed)).toEqual([rows[3].id, rows[0].id]);

    // since is inclusive, before is exclusive.
    const window = await svc.list(companyId, undefined, undefined, {
      since: new Date("2026-09-28T10:00:00Z"),
      before: new Date("2026-10-01T10:00:00Z"),
    });
    expect(ids(window)).toEqual([rows[2].id, rows[1].id]);

    const combined = await svc.list(companyId, agentId, 1, {
      summary: true,
      statuses: ["failed", "interrupted", "cancelled"],
      before: new Date("2026-10-02T10:00:00Z"),
    });
    expect(ids(combined)).toEqual([rows[3].id]);
  });

  it("returns small result json payloads unchanged from getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "done",
        structured: { ok: true },
      },
    });

    const run = await heartbeatService(db).getRun(runId);

    expect(run?.resultJson).toEqual({
      summary: "done",
      structured: { ok: true },
    });
  });

  it("returns summary list rows without heavy run detail fields", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "Failed after doing useful work",
      usageJson: {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 123,
      },
      resultJson: {
        summary: "large run summary",
        stdout: "x".repeat(20_000),
      },
      sessionIdBefore: "session-before",
      sessionIdAfter: "session-after",
      logStore: "local",
      logRef: "logs/run.log",
      logSha256: "abc123",
      externalRunId: "external-run",
      processPid: 12345,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });

    const runs = await heartbeatService(db).list(companyId, undefined, 5, { summary: true });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      error: "Failed after doing useful work",
      usageJson: null,
      resultJson: null,
      sessionIdBefore: null,
      sessionIdAfter: null,
      logStore: null,
      logRef: null,
      logSha256: null,
      externalRunId: null,
      processPid: null,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });
  });

  it("bounds oversized legacy result json payloads on getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const oversizedStdout = Array.from({ length: 8_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}-${randomUUID()}`,
    ).join("|");
    const oversizedNestedPayload = Array.from({ length: 6_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}:${randomUUID()}`,
    ).join("|");

    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "completed",
        stdout: oversizedStdout,
        nestedHuge: { payload: oversizedNestedPayload },
        workspaceRestoreFailure: "restore_unsafe_archive",
        finalResponseRecorded: true,
        executionBeforeRestore: { errorCode: "model_error", exitCode: 2, timedOut: false },
      },
    });

    const run = await heartbeatService(db).getRun(runId);
    const result = run?.resultJson as Record<string, unknown> | null;

    expect(result).toMatchObject({
      summary: "completed",
      truncated: true,
      truncationReason: "oversized_result_json",
      stdoutTruncated: true,
      workspaceRestoreFailure: "restore_unsafe_archive",
      finalResponseRecorded: true,
      executionBeforeRestore: { errorCode: "model_error", exitCode: 2, timedOut: false },
    });
    expect(typeof result?.stdout).toBe("string");
    expect((result?.stdout as string).length).toBeLessThan(oversizedStdout.length);
    expect(result).not.toHaveProperty("nestedHuge");
  });
});

describe("heartbeat run event payload bounding", () => {
  it("truncates oversized adapter metadata before storage", () => {
    const payload = boundHeartbeatRunEventPayloadForStorage({
      adapterType: "codex_local",
      prompt: "x".repeat(40_000),
      context: {
        issueId: "issue-1",
        memory: "y".repeat(40_000),
      },
    });

    expect(payload.adapterType).toBe("codex_local");
    expect(typeof payload.prompt).toBe("string");
    expect((payload.prompt as string).length).toBeLessThan(20_000);
    expect(payload.prompt).toContain("[truncated");
    expect(payload.context).toMatchObject({
      issueId: "issue-1",
    });
    expect(JSON.stringify(payload).length).toBeLessThan(45_000);
  });
});
