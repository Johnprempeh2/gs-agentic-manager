import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@greatstone/db";
import { AGENT_QUESTION_MAX_OPEN_PER_ISSUE } from "@greatstone/shared";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent question route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent questions (routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-questions-");
    db = createDb(tempDb.connectionString);
  });

  // Wakes are fire-and-forget and may land a run row just after a response,
  // so teardown is best-effort in foreign-key order.
  afterEach(async () => {
    const cleanups = [
      () => db.delete(issueThreadInteractions),
      () => db.delete(activityLog),
      () => db.delete(agentWakeupRequests),
      () => db.delete(heartbeatRuns),
      () => db.delete(agentWakeupRequests),
      () => db.delete(heartbeatRuns),
      () => db.delete(issues),
      () => db.delete(companyMemberships),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  function agentActor(companyId: string, agentId: string, runId: string) {
    return { type: "agent", source: "agent_key", companyId, agentId, runId };
  }

  function boardActor(companyId: string, userId: string) {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    };
  }

  let sequence = 0;

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const userId = `${prefix.toLowerCase()}-operator`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    return { companyId, userId };
  }

  async function seedAgent(companyId: string, name: string, status = "idle") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(companyId: string, prefix: string, assigneeAgentId: string) {
    const issueId = randomUUID();
    sequence += 1;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-${sequence}`,
      title: `${prefix} task ${sequence}`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
    });
    return issueId;
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

  async function seedScenario(prefix: string) {
    const { companyId, userId } = await seedCompany(prefix);
    const askerId = await seedAgent(companyId, "Ada");
    const targetId = await seedAgent(companyId, "Grace");
    const issueId = await seedIssue(companyId, prefix, askerId);
    const askerRunId = await seedRun(companyId, askerId, issueId);
    const targetRunId = await seedRun(companyId, targetId, issueId);
    return { companyId, userId, askerId, targetId, issueId, askerRunId, targetRunId };
  }

  // A wake for an agent while the asking run still holds the task is deferred
  // until that run ends, so match the wake by what it was for, not its status.
  async function waitForWake(companyId: string, agentId: string, reason: string) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const rows = (await db
        .select({
          reason: agentWakeupRequests.reason,
          payload: agentWakeupRequests.payload,
          idempotencyKey: agentWakeupRequests.idempotencyKey,
        })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
        )))
        .filter((row) => {
          const context = (row.payload as Record<string, any> | null)?._paperclipWakeContext;
          return row.reason === reason || context?.wakeReason === reason;
        });
      if (rows.length > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return [];
  }

  async function activityActions(companyId: string, issueId: string) {
    const rows = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, issueId)));
    return rows;
  }

  it("asks, wakes the asked agent, stores the answer on the task and wakes the asker", async () => {
    const s = await seedScenario("ASK");

    const asked = await request(app(agentActor(s.companyId, s.askerId, s.askerRunId)))
      .post(`/api/issues/${s.issueId}/agent-questions`)
      .send({ targetAgentId: s.targetId, question: "Which client contact signed the NDA?" });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({
      kind: "ask_agent",
      status: "pending",
      issueId: s.issueId,
      createdByAgentId: s.askerId,
      addresseeAgentId: s.targetId,
      payload: { version: 1, question: "Which client contact signed the NDA?" },
    });
    const interactionId = asked.body.id as string;

    const targetWakes = await waitForWake(s.companyId, s.targetId, "agent_question");
    expect(targetWakes.map((row) => row.idempotencyKey)).toEqual([`agent-question:${interactionId}`]);
    const actionsAfterAsk = await activityActions(s.companyId, s.issueId);
    expect(actionsAfterAsk).toContainEqual(expect.objectContaining({
      action: "issue.agent_question_asked",
      details: expect.objectContaining({ interactionId, targetAgentId: s.targetId }),
    }));

    // The asked agent cannot use the generic resolution routes on the task.
    const generic = await request(app(agentActor(s.companyId, s.targetId, s.targetRunId)))
      .post(`/api/issues/${s.issueId}/interactions/${interactionId}/respond`)
      .send({ answers: [] });
    expect(generic.status).toBeGreaterThanOrEqual(400);

    const answered = await request(app(agentActor(s.companyId, s.targetId, s.targetRunId)))
      .post(`/api/issues/${s.issueId}/agent-questions/${interactionId}/answer`)
      .send({ answer: "Jane Smith signed it on 3 March." });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body).toMatchObject({
      id: interactionId,
      status: "answered",
      resolvedByAgentId: s.targetId,
      result: { version: 1, outcome: "answered", answer: "Jane Smith signed it on 3 March." },
    });

    const [stored] = await db
      .select({ status: issueThreadInteractions.status, result: issueThreadInteractions.result })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));
    expect(stored).toMatchObject({ status: "answered", result: { answer: "Jane Smith signed it on 3 March." } });

    const askerWakes = await waitForWake(s.companyId, s.askerId, "agent_question_answered");
    expect(askerWakes.map((row) => row.idempotencyKey)).toEqual([`agent-question-answered:${interactionId}`]);
    const actionsAfterAnswer = await activityActions(s.companyId, s.issueId);
    expect(actionsAfterAnswer).toContainEqual(expect.objectContaining({
      action: "issue.agent_question_answered",
      details: expect.objectContaining({ interactionId, askedByAgentId: s.askerId }),
    }));

    // One answer per question.
    const again = await request(app(agentActor(s.companyId, s.targetId, s.targetRunId)))
      .post(`/api/issues/${s.issueId}/agent-questions/${interactionId}/answer`)
      .send({ answer: "Actually, someone else." });
    expect(again.status).toBe(409);

    // The task itself is unchanged by the asked agent.
    const [issue] = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, s.issueId));
    expect(issue).toEqual({ status: "in_progress", assigneeAgentId: s.askerId });
  }, 30_000);

  it("only lets the asked agent answer", async () => {
    const s = await seedScenario("ONL");
    const otherId = await seedAgent(s.companyId, "Linus");
    const otherRunId = await seedRun(s.companyId, otherId, s.issueId);
    const asked = await request(app(agentActor(s.companyId, s.askerId, s.askerRunId)))
      .post(`/api/issues/${s.issueId}/agent-questions`)
      .send({ targetAgentId: s.targetId, question: "Is the invoice sent?" });
    expect(asked.status).toBe(201);

    const byOther = await request(app(agentActor(s.companyId, otherId, otherRunId)))
      .post(`/api/issues/${s.issueId}/agent-questions/${asked.body.id}/answer`)
      .send({ answer: "Yes" });
    expect(byOther.status).toBe(403);

    const byAsker = await request(app(agentActor(s.companyId, s.askerId, s.askerRunId)))
      .post(`/api/issues/${s.issueId}/agent-questions/${asked.body.id}/answer`)
      .send({ answer: "Yes" });
    expect(byAsker.status).toBe(403);

    const byBoard = await request(app(boardActor(s.companyId, s.userId)))
      .post(`/api/issues/${s.issueId}/agent-questions/${asked.body.id}/answer`)
      .send({ answer: "Yes" });
    expect(byBoard.status).toBe(403);

    const [stored] = await db
      .select({ status: issueThreadInteractions.status })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, asked.body.id));
    expect(stored.status).toBe("pending");
  }, 30_000);

  it("refuses another company's agent, itself and a removed agent", async () => {
    const s = await seedScenario("REF");
    const other = await seedCompany("OTH");
    const foreignAgentId = await seedAgent(other.companyId, "Outsider");
    const removedId = await seedAgent(s.companyId, "Gone", "terminated");
    const client = app(agentActor(s.companyId, s.askerId, s.askerRunId));

    const foreign = await request(client)
      .post(`/api/issues/${s.issueId}/agent-questions`)
      .send({ targetAgentId: foreignAgentId, question: "Hello?" });
    expect(foreign.status).toBe(404);

    const self = await request(client)
      .post(`/api/issues/${s.issueId}/agent-questions`)
      .send({ targetAgentId: s.askerId, question: "Hello?" });
    expect(self.status).toBe(422);

    const removed = await request(client)
      .post(`/api/issues/${s.issueId}/agent-questions`)
      .send({ targetAgentId: removedId, question: "Hello?" });
    expect(removed.status).toBe(422);

    // An agent in another company cannot ask on this task either.
    const foreignRunId = await seedRun(other.companyId, foreignAgentId, s.issueId);
    const crossCompany = await request(app(agentActor(other.companyId, foreignAgentId, foreignRunId)))
      .post(`/api/issues/${s.issueId}/agent-questions`)
      .send({ targetAgentId: s.targetId, question: "Hello?" });
    expect([403, 404]).toContain(crossCompany.status);

    const rows = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, s.issueId));
    expect(rows).toEqual([]);
  }, 30_000);

  it("caps open questions per task", async () => {
    const s = await seedScenario("CAP");
    const client = app(agentActor(s.companyId, s.askerId, s.askerRunId));
    for (let index = 0; index < AGENT_QUESTION_MAX_OPEN_PER_ISSUE; index += 1) {
      const res = await request(client)
        .post(`/api/issues/${s.issueId}/agent-questions`)
        .send({ targetAgentId: s.targetId, question: `Question ${index + 1}?` });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const over = await request(client)
      .post(`/api/issues/${s.issueId}/agent-questions`)
      .send({ targetAgentId: s.targetId, question: "One too many?" });
    expect(over.status).toBe(409);
    expect(over.body.details).toMatchObject({ code: "agent_question_limit_reached" });

    // Once one is answered there is room again.
    const [first] = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, s.issueId))
      .limit(1);
    const answered = await request(app(agentActor(s.companyId, s.targetId, s.targetRunId)))
      .post(`/api/issues/${s.issueId}/agent-questions/${first.id}/answer`)
      .send({ answer: "Done" });
    expect(answered.status).toBe(200);
    const after = await request(client)
      .post(`/api/issues/${s.issueId}/agent-questions`)
      .send({ targetAgentId: s.targetId, question: "Room again?" });
    expect(after.status).toBe(201);
  }, 30_000);
});
