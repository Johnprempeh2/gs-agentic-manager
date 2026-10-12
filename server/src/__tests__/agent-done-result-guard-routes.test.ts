import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
} from "@greatstone/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  AGENT_DONE_WITHOUT_RESULT_CODE,
  AGENT_DONE_WITHOUT_RESULT_MESSAGE,
} from "../services/agent-done-result-guard.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent done guard route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// GRE-573: Mica closed GRE-494 as done 21 seconds after "I will post it here",
// with no answer. An agent closing its own task must have posted a result in
// the same run.
describeEmbeddedPostgres("agent done needs a result in the run (GRE-573)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-done-guard-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const peerAgentId = randomUUID();
    const memberUserId = "done-guard-member";
    await db.insert(companies).values({
      id: companyId,
      name: "Done Guard",
      issuePrefix: `DG${companyId.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      [assigneeAgentId, peerAgentId].map((id, index) => ({
        id,
        companyId,
        name: index === 0 ? "Mica" : "Peer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: memberUserId,
      status: "active",
      membershipRole: "operator",
    });
    const issueId = randomUUID();
    const runId = await seedRun(companyId, assigneeAgentId, issueId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "DG-1",
      title: "Write up the idea",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });
    // Every run opens with an acknowledgement; that alone is not a result.
    await addComment({ companyId, issueId, agentId: assigneeAgentId, runId, body: "I will post it here." });
    return { companyId, assigneeAgentId, peerAgentId, memberUserId, issueId, runId };
  }

  async function seedRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  async function addComment(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    runId: string;
    body: string;
  }) {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorAgentId: input.agentId,
      authorType: "agent",
      createdByRunId: input.runId,
      body: input.body,
    });
  }

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use(errorHandler);
    return testApp;
  }

  function agentActor(companyId: string, agentId: string, runId: string) {
    return { type: "agent", source: "agent_key", companyId, agentId, runId };
  }

  async function statusOf(issueId: string) {
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return row?.status;
  }

  it("refuses the assignee's done when the run only acknowledged", async () => {
    const s = await seed();

    const res = await request(app(agentActor(s.companyId, s.assigneeAgentId, s.runId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toEqual({
      error: AGENT_DONE_WITHOUT_RESULT_MESSAGE,
      code: AGENT_DONE_WITHOUT_RESULT_CODE,
    });
    expect(res.body.error).toMatch(/^Post your result first/);
    expect(await statusOf(s.issueId)).toBe("in_progress");
  });

  it("does not count a result posted by an earlier run", async () => {
    const s = await seed();
    const earlierRunId = await seedRun(s.companyId, s.assigneeAgentId, s.issueId);
    await addComment({ ...s, agentId: s.assigneeAgentId, runId: earlierRunId, body: "Old result." });
    await addComment({ ...s, agentId: s.assigneeAgentId, runId: earlierRunId, body: "More old result." });

    const res = await request(app(agentActor(s.companyId, s.assigneeAgentId, s.runId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(await statusOf(s.issueId)).toBe("in_progress");
  });

  it.each([
    [
      "a result comment",
      async (s: Awaited<ReturnType<typeof seed>>) => {
        await addComment({ ...s, agentId: s.assigneeAgentId, body: "Here is the idea: ..." });
      },
    ],
    [
      "a document revision",
      async (s: Awaited<ReturnType<typeof seed>>) => {
        const documentId = randomUUID();
        await db.insert(documents).values({
          id: documentId,
          companyId: s.companyId,
          title: "Result",
          latestBody: "The idea.",
          createdByAgentId: s.assigneeAgentId,
        });
        await db.insert(issueDocuments).values({
          companyId: s.companyId,
          issueId: s.issueId,
          documentId,
          key: "result",
        });
        await db.insert(documentRevisions).values({
          companyId: s.companyId,
          documentId,
          revisionNumber: 1,
          body: "The idea.",
          createdByAgentId: s.assigneeAgentId,
          createdByRunId: s.runId,
        });
      },
    ],
    [
      "a work product",
      async (s: Awaited<ReturnType<typeof seed>>) => {
        await db.insert(issueWorkProducts).values({
          companyId: s.companyId,
          issueId: s.issueId,
          type: "pull_request",
          provider: "github",
          title: "PR",
          status: "open",
          createdByRunId: s.runId,
        });
      },
    ],
  ])("allows the assignee's done after %s in the run", async (_label, addResult) => {
    const s = await seed();
    await addResult(s);

    const res = await request(app(agentActor(s.companyId, s.assigneeAgentId, s.runId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(s.issueId)).toBe("done");
  });

  it("allows the assignee's done when the result rides on the closing request", async () => {
    const s = await seed();

    const res = await request(app(agentActor(s.companyId, s.assigneeAgentId, s.runId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "done", comment: "Here is the idea: ..." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(s.issueId)).toBe("done");
  });

  it("leaves board users closing the task unchanged", async () => {
    const s = await seed();

    const res = await request(app({
      type: "board",
      source: "session",
      userId: s.memberUserId,
      companyIds: [s.companyId],
      memberships: [{ companyId: s.companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    }))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(s.issueId)).toBe("done");
  });

  it("does not apply to another agent closing the task", async () => {
    const s = await seed();
    await db.update(issues).set({ status: "todo", checkoutRunId: null, executionRunId: null })
      .where(eq(issues.id, s.issueId));
    const peerRunId = await seedRun(s.companyId, s.peerAgentId, s.issueId);

    const res = await request(app(agentActor(s.companyId, s.peerAgentId, peerRunId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "done" });

    expect(res.body.code, JSON.stringify(res.body)).not.toBe(AGENT_DONE_WITHOUT_RESULT_CODE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(s.issueId)).toBe("done");
  });
});
