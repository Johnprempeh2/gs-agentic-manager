import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueThreadInteractions,
  issues,
  workspaceOperations,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// GRE-3652 (found on GRE-3646): an ask_agent question asked on a task with an
// open blocker never reached the addressee. Both dependency gates (enqueue and
// claim) only excuse comment-backed interaction wakes, and a question wake has
// no comment, so the run was skipped or cancelled with
// `issue_dependencies_blocked` and the question stayed pending.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Answered the question.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-question dependency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("GRE-3652: an ask_agent wake on a dependency-blocked task", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-question-blocked-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  });

  afterEach(async () => {
    await waitForCondition(async () => {
      const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return rows.every((run) => run.status !== "queued" && run.status !== "running");
    });
    const runIds = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .then((rows) => rows.map((row) => row.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Ridge owns a task blocked by an open task and asks Bedrock a question on it.
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
    const blockerId = randomUUID();
    const issueId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId, companyId, title: "Upstream fix", status: "in_progress", priority: "high",
        responsibleUserId: "responsible-user",
      },
      {
        id: issueId, companyId, title: "Blocked repair", status: "blocked", priority: "high",
        assigneeAgentId: ridge, responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks",
    });
    return { companyId, issueId, blockerId, ridge, bedrock, summit };
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

  // The context snapshot the agent-questions route queues (routes/issues.ts).
  function questionContext(issueId: string, interactionId: string, wakeReason = "agent_question") {
    return {
      issueId,
      taskId: issueId,
      interactionId,
      interactionKind: "ask_agent",
      interactionStatus: wakeReason === "agent_question" ? "pending" : "answered",
      wakeReason,
      source: wakeReason === "agent_question" ? "issue.agent_question.asked" : "issue.agent_question.answered",
    };
  }

  function wakeForQuestion(agentId: string, issueId: string, interactionId: string, wakeReason = "agent_question") {
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: wakeReason,
      payload: { issueId, interactionId, interactionKind: "ask_agent", mutation: "interaction" },
      requestedByActorType: "agent",
      contextSnapshot: questionContext(issueId, interactionId, wakeReason),
    });
  }

  // A run queued without enqueueWakeup, as a deferred wake is when the asker's
  // own run releases the task: only the claim gate sees it.
  async function insertQueuedQuestionRun(companyId: string, agentId: string, issueId: string, interactionId: string) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "agent_question", payload: { issueId, interactionId }, status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "queued", wakeupRequestId, contextSnapshot: questionContext(issueId, interactionId),
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    return runId;
  }

  async function readRun(runId: string) {
    return db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function waitForTerminal(runId: string) {
    await waitForCondition(async () => {
      const run = await readRun(runId);
      return run?.status !== "queued" && run?.status !== "running";
    });
    return readRun(runId);
  }

  it("starts the addressee's run in bounded interaction mode when the question is asked", async () => {
    const { companyId, issueId, blockerId, ridge, bedrock } = await seed();
    const interactionId = await seedQuestion({ companyId, issueId, askerAgentId: ridge, addresseeAgentId: bedrock });

    const run = await wakeForQuestion(bedrock, issueId, interactionId);

    expect(run).not.toBeNull();
    const finished = await waitForTerminal(run!.id);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.contextSnapshot).toMatchObject({
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: [blockerId],
    });
  });

  it("starts the asker's run in bounded interaction mode when the answer arrives", async () => {
    const { companyId, issueId, bedrock, summit } = await seed();
    // Summit asked on Ridge's task, so Summit is not the assignee either.
    const interactionId = await seedQuestion({
      companyId, issueId, askerAgentId: summit, addresseeAgentId: bedrock, status: "answered",
    });

    const run = await wakeForQuestion(summit, issueId, interactionId, "agent_question_answered");

    expect(run).not.toBeNull();
    const finished = await waitForTerminal(run!.id);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true });
  });

  it("claims a queued question run in bounded interaction mode instead of cancelling it", async () => {
    const { companyId, issueId, blockerId, ridge, bedrock } = await seed();
    const interactionId = await seedQuestion({ companyId, issueId, askerAgentId: ridge, addresseeAgentId: bedrock });
    const runId = await insertQueuedQuestionRun(companyId, bedrock, issueId, interactionId);

    await heartbeat.resumeQueuedRuns();

    const finished = await waitForTerminal(runId);
    expect(finished?.errorCode).not.toBe("issue_dependencies_blocked");
    expect(finished?.status).toBe("succeeded");
    expect(finished?.contextSnapshot).toMatchObject({
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: [blockerId],
    });
  });

  it("still skips a question wake for an agent the question was not addressed to", async () => {
    const { companyId, issueId, ridge, bedrock, summit } = await seed();
    const interactionId = await seedQuestion({ companyId, issueId, askerAgentId: ridge, addresseeAgentId: bedrock });

    const run = await wakeForQuestion(summit, issueId, interactionId);

    expect(run).toBeNull();
    const skipped = await db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.agentId} = ${summit}`)
      .then((rows) => rows[0] ?? null);
    expect(skipped).toMatchObject({ status: "skipped", reason: "issue_dependencies_blocked" });
  });

  it("still cancels a queued question run once the question is no longer pending", async () => {
    const { companyId, issueId, ridge, bedrock } = await seed();
    const interactionId = await seedQuestion({
      companyId, issueId, askerAgentId: ridge, addresseeAgentId: bedrock, status: "cancelled",
    });
    const runId = await insertQueuedQuestionRun(companyId, bedrock, issueId, interactionId);

    await heartbeat.resumeQueuedRuns();

    const finished = await waitForTerminal(runId);
    expect(finished).toMatchObject({ status: "cancelled", errorCode: "issue_dependencies_blocked" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
});
