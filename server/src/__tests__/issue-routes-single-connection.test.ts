import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";

// Issue routes that hold a transaction must make every read through it. A read
// through the outer pool needs a second connection while the route holds the
// first, and enough concurrent requests (one per pool slot) leave every
// connection idle in transaction for good. Serving each request from a
// one-connection pool turns that into a deterministic hang.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres single-connection issue route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const boardUserId = "board-user";

describeEmbeddedPostgres("issue routes on a single pooled connection", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-routes-single-connection-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const nonce = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const prefix = `SC${nonce}`;
    const [company] = await db
      .insert(companies)
      .values({
        name: `Single connection ${nonce}`,
        issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: boardUserId,
      })
      .returning();
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "owner",
    });
    const [manager] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    const [coder] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: manager!.id,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    let issueNumber = 0;
    const seedIssue = async (values: Partial<typeof issues.$inferInsert> = {}) => {
      issueNumber += 1;
      const [issue] = await db
        .insert(issues)
        .values({
          companyId: company!.id,
          title: `Single-connection task ${issueNumber}`,
          status: "todo",
          priority: "medium",
          issueNumber,
          identifier: `${prefix}-${issueNumber}`,
          responsibleUserId: boardUserId,
          ...values,
        })
        .returning();
      return issue!;
    };
    const seedRun = async (agentId: string, issueId: string) => {
      const [run] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: company!.id,
          agentId,
          invocationSource: "manual",
          status: "running",
          startedAt: new Date(),
          contextSnapshot: { issueId },
        })
        .returning();
      return run!.id;
    };
    return { company: company!, manager: manager!, coder: coder!, seedIssue, seedRun };
  }

  function boardActor(companyId: string): Actor {
    return {
      type: "board",
      userId: boardUserId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
      source: "local_implicit",
    };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Actor {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  async function onSingleConnection(
    actor: Actor,
    send: (app: express.Express) => request.Test,
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const singleDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(singleDb, {} as any, opts));
    app.use(errorHandler);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        send(app).then((res) => res),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("issue route waited for a second pooled connection")),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      // Ends a stuck transaction too, so later tests are not blocked by its
      // row locks.
      await singleDb.$client.end({ timeout: 1 });
    }
  }

  async function recoveryActionStatus(actionId: string) {
    const [row] = await db
      .select({ status: issueRecoveryActions.status })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    return row?.status;
  }

  describe("POST /issues/:id/recovery-actions/resolve", () => {
    it("lets the board complete the source task", async () => {
      const f = await seedCompany();
      const source = await f.seedIssue({ status: "in_progress", assigneeAgentId: f.coder.id });
      const action = await issueRecoveryActionService(db).upsertSourceScoped({
        companyId: f.company.id,
        sourceIssueId: source.id,
        kind: "missing_disposition",
        ownerType: "agent",
        ownerAgentId: f.manager.id,
        cause: "successful_run_missing_issue_disposition",
        fingerprint: "single-connection:complete",
        nextAction: "Choose a valid issue disposition.",
        wakePolicy: { type: "wake_owner" },
      });

      const res = await onSingleConnection(boardActor(f.company.id), (app) =>
        request(app)
          .post(`/api/issues/${source.id}/recovery-actions/resolve`)
          .send({ actionId: action.id, outcome: "restored", sourceIssueStatus: "done" }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.issue).toMatchObject({ id: source.id, status: "done" });
      expect(await recoveryActionStatus(action.id)).toBe("resolved");
    });

    it("lets the board retry an exhausted disposition with the recorded owner", async () => {
      const f = await seedCompany();
      const source = await f.seedIssue({ status: "blocked", assigneeAgentId: f.coder.id });
      const action = await issueRecoveryActionService(db).upsertSourceScoped({
        companyId: f.company.id,
        sourceIssueId: source.id,
        kind: "deliberate_wait_without_target",
        ownerType: "board",
        previousOwnerAgentId: f.coder.id,
        returnOwnerAgentId: f.coder.id,
        cause: "deliberate_wait_without_target",
        fingerprint: "single-connection:retry",
        nextAction: "Review the outcome.",
        wakePolicy: { type: "board_escalation" },
      });
      const wake = vi.fn(async () => null);

      const res = await onSingleConnection(
        boardActor(f.company.id),
        (app) =>
          request(app)
            .post(`/api/issues/${source.id}/recovery-actions/resolve`)
            .send({ actionId: action.id, outcome: "restored", sourceIssueStatus: "todo" }),
        { recoveryActionEnqueueWakeup: wake },
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.recoveryAction).toMatchObject({ id: action.id, outcome: "handed_back" });
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it("lets the recovery owner agent hand the task back to its assignee", async () => {
      const f = await seedCompany();
      const source = await f.seedIssue({ status: "blocked", assigneeAgentId: f.coder.id });
      const action = await issueRecoveryActionService(db).upsertSourceScoped({
        companyId: f.company.id,
        sourceIssueId: source.id,
        kind: "workspace_validation",
        ownerType: "agent",
        ownerAgentId: f.manager.id,
        previousOwnerAgentId: f.coder.id,
        returnOwnerAgentId: f.coder.id,
        cause: "workspace_validation_failed",
        fingerprint: "single-connection:hand-back",
        nextAction: "Repair the workspace and hand the issue back.",
        wakePolicy: { type: "wake_owner" },
      });
      const runId = await f.seedRun(f.manager.id, source.id);
      const wake = vi.fn(async () => null);

      const res = await onSingleConnection(
        agentActor(f.company.id, f.manager.id, runId),
        (app) =>
          request(app)
            .post(`/api/issues/${source.id}/recovery-actions/resolve`)
            .send({ actionId: action.id, outcome: "restored", sourceIssueStatus: "todo" }),
        { recoveryActionEnqueueWakeup: wake },
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.issue).toMatchObject({ status: "todo", assigneeAgentId: f.coder.id });
      expect(res.body.recoveryAction).toMatchObject({ id: action.id, outcome: "handed_back" });
    });

    it("checks an assignee agent's in-review hand-off for a review path", async () => {
      const f = await seedCompany();
      const source = await f.seedIssue({ status: "blocked", assigneeAgentId: f.coder.id });
      const action = await issueRecoveryActionService(db).upsertSourceScoped({
        companyId: f.company.id,
        sourceIssueId: source.id,
        kind: "issue_graph_liveness",
        ownerType: "agent",
        ownerAgentId: f.coder.id,
        cause: "issue_graph_liveness",
        fingerprint: "single-connection:in-review",
        nextAction: "Restore a live execution path.",
        wakePolicy: { type: "manual" },
      });
      const runId = await f.seedRun(f.coder.id, source.id);

      const res = await onSingleConnection(agentActor(f.company.id, f.coder.id, runId), (app) =>
        request(app)
          .post(`/api/issues/${source.id}/recovery-actions/resolve`)
          .send({ actionId: action.id, outcome: "restored", sourceIssueStatus: "in_review" }),
      );

      // No review path exists, so the hand-off is refused after every check
      // has run inside the transaction.
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.details?.code).toBe("invalid_issue_disposition");
      expect(await recoveryActionStatus(action.id)).toBe("active");
    });
  });

  it("PATCH /issues/:id hands a cancelled blocker's dependents back inside its transaction", async () => {
    const f = await seedCompany();
    const blocker = await f.seedIssue();
    const dependent = await f.seedIssue({ status: "blocked", assigneeUserId: boardUserId });
    await db.insert(issueRelations).values({
      companyId: f.company.id,
      issueId: blocker.id,
      relatedIssueId: dependent.id,
      type: "blocks",
    });

    const res = await onSingleConnection(boardActor(f.company.id), (app) =>
      request(app)
        .patch(`/api/issues/${blocker.id}`)
        .send({ status: "cancelled", blockedDependents: { action: "remove" } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [dependentAfter] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, dependent.id));
    expect(dependentAfter?.status).toBe("todo");
    expect(
      await db
        .select()
        .from(issueRelations)
        .where(and(eq(issueRelations.issueId, blocker.id), eq(issueRelations.relatedIssueId, dependent.id))),
    ).toHaveLength(0);
  });

  it("POST /issues/:id/comments approves a review inside its transaction", async () => {
    const f = await seedCompany();
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: randomUUID(),
          type: "review",
          participants: [{ type: "user", userId: boardUserId }],
        },
      ],
    })!;
    const issue = await f.seedIssue({
      status: "in_review",
      assigneeUserId: boardUserId,
      executionPolicy: policy as unknown as Record<string, unknown>,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0]!.id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "user", userId: boardUserId },
        returnAssignee: { type: "user", userId: boardUserId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const res = await onSingleConnection(boardActor(f.company.id), (app) =>
      request(app)
        .post(`/api/issues/${issue.id}/comments`)
        .send({ body: "## Review: APPROVED\n\nLooks good." }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [issueAfter] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(issueAfter?.status).toBe("done");
  });
});
