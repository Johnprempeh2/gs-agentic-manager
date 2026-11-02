import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";

// GRE-3646 (found on GRE-3547): Ridge, the assignee, asked Bedrock a question
// with ask_agent. Bedrock's queued `agent_question` run was cancelled with
// `issue_assignee_changed` because Bedrock was not the assignee, and nothing
// woke Bedrock again. The question stayed pending for 12 hours.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-question wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GRE-3646: an ask_agent wake survives the ownership check", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-question-wake-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const ridge = randomUUID();
    const bedrock = randomUUID();
    const summit = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    for (const [id, name] of [[ridge, "Ridge"], [bedrock, "Bedrock"], [summit, "Summit"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });
    }
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Critical repair",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: ridge,
    });
    return { companyId, issueId, ridge, bedrock, summit };
  }

  async function seedQuestion(input: {
    companyId: string;
    issueId: string;
    askerAgentId: string;
    addresseeAgentId: string;
    status?: "pending" | "answered" | "cancelled";
  }) {
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: "ask_agent",
      status: input.status ?? "pending",
      continuationPolicy: "none",
      requestedResolverPolicy: "not_creator",
      effectiveResolverPolicy: "not_creator",
      resolverPolicyProvenance: "inherited",
      effectiveResolverPolicySource: "requested",
      createdByAgentId: input.askerAgentId,
      addresseeAgentId: input.addresseeAgentId,
      payload: { version: 1, question: "Which migration broke the board?" },
    });
    return interactionId;
  }

  // The context snapshot the agent-questions routes queue (routes/issues.ts).
  async function queueQuestionRun(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    interactionId: string;
    wakeReason: "agent_question" | "agent_question_answered";
    interactionStatus: string;
  }) {
    const runId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      status: "queued",
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        interactionId: input.interactionId,
        interactionKind: "ask_agent",
        interactionStatus: input.interactionStatus,
        wakeReason: input.wakeReason,
        source:
          input.wakeReason === "agent_question"
            ? "issue.agent_question.asked"
            : "issue.agent_question.answered",
      },
      createdAt: now,
      updatedAt: now,
    });
    return runId;
  }

  async function checkStaleness(companyId: string, runId: string) {
    return createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      runId,
      companyId,
      expectedStatus: "queued",
      now: new Date(),
    });
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status);
  }

  it("lets the addressee's agent_question run start when the addressee is not the assignee", async () => {
    const { companyId, issueId, ridge, bedrock } = await seed();
    const interactionId = await seedQuestion({ companyId, issueId, askerAgentId: ridge, addresseeAgentId: bedrock });
    const runId = await queueQuestionRun({
      companyId, issueId, agentId: bedrock, interactionId,
      wakeReason: "agent_question", interactionStatus: "pending",
    });

    const outcome = await checkStaleness(companyId, runId);

    expect(outcome.outcome).not.toBe("cancelled");
    expect(await runStatus(runId)).toBe("queued");
  });

  it("lets the asker's agent_question_answered run start when the asker is not the assignee", async () => {
    const { companyId, issueId, bedrock, summit } = await seed();
    // Summit asked on Ridge's task, so Summit is not the assignee either.
    const interactionId = await seedQuestion({
      companyId, issueId, askerAgentId: summit, addresseeAgentId: bedrock, status: "answered",
    });
    const runId = await queueQuestionRun({
      companyId, issueId, agentId: summit, interactionId,
      wakeReason: "agent_question_answered", interactionStatus: "answered",
    });

    const outcome = await checkStaleness(companyId, runId);

    expect(outcome.outcome).not.toBe("cancelled");
    expect(await runStatus(runId)).toBe("queued");
  });

  it("still cancels an agent_question run for an agent the question was not addressed to", async () => {
    const { companyId, issueId, ridge, bedrock, summit } = await seed();
    const interactionId = await seedQuestion({ companyId, issueId, askerAgentId: ridge, addresseeAgentId: bedrock });
    const runId = await queueQuestionRun({
      companyId, issueId, agentId: summit, interactionId,
      wakeReason: "agent_question", interactionStatus: "pending",
    });

    expect(await checkStaleness(companyId, runId)).toMatchObject({
      outcome: "cancelled",
      errorCode: "issue_assignee_changed",
    });
  });

  it("still cancels an agent_question_answered run for an agent who did not ask", async () => {
    const { companyId, issueId, ridge, bedrock, summit } = await seed();
    const interactionId = await seedQuestion({
      companyId, issueId, askerAgentId: ridge, addresseeAgentId: bedrock, status: "answered",
    });
    const runId = await queueQuestionRun({
      companyId, issueId, agentId: summit, interactionId,
      wakeReason: "agent_question_answered", interactionStatus: "answered",
    });

    expect(await checkStaleness(companyId, runId)).toMatchObject({
      outcome: "cancelled",
      errorCode: "issue_assignee_changed",
    });
  });

  it("still cancels the addressee's run once the question is no longer pending", async () => {
    const { companyId, issueId, ridge, bedrock } = await seed();
    const interactionId = await seedQuestion({
      companyId, issueId, askerAgentId: ridge, addresseeAgentId: bedrock, status: "cancelled",
    });
    const runId = await queueQuestionRun({
      companyId, issueId, agentId: bedrock, interactionId,
      wakeReason: "agent_question", interactionStatus: "pending",
    });

    expect(await checkStaleness(companyId, runId)).toMatchObject({
      outcome: "cancelled",
      errorCode: "issue_assignee_changed",
    });
  });

  it("still cancels when the named question belongs to a different task", async () => {
    const { companyId, issueId, ridge, bedrock } = await seed();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId, companyId, title: "Other task", status: "in_progress", priority: "medium",
      assigneeAgentId: bedrock,
    });
    const interactionId = await seedQuestion({
      companyId, issueId: otherIssueId, askerAgentId: ridge, addresseeAgentId: bedrock,
    });
    const runId = await queueQuestionRun({
      companyId, issueId, agentId: bedrock, interactionId,
      wakeReason: "agent_question", interactionStatus: "pending",
    });

    expect(await checkStaleness(companyId, runId)).toMatchObject({
      outcome: "cancelled",
      errorCode: "issue_assignee_changed",
    });
  });
});
