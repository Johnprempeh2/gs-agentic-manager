import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

// Closing a blocker as a duplicate (or cancelling it) must not leave the tasks
// it blocks waiting for ever. A cancelled blocker never counts as resolved.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocker handoff route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(company: CompanyRow, agent: AgentRow, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId,
    source: "agent_key",
  };
}

describeEmbeddedPostgres("closing a blocker hands off its open dependents", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocker-handoff-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const nonce = randomUUID().slice(0, 8);
    const prefix = `HO${nonce.slice(0, 4).toUpperCase()}`;
    const [company] = await db.insert(companies).values({
      name: `Handoff ${nonce}`,
      issuePrefix: prefix,
      defaultResponsibleUserId: "board-user",
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: `Agent ${nonce}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    let n = 0;
    const seedIssue = async (input: {
      title: string;
      status?: string;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
    }) => {
      n += 1;
      const [issue] = await db.insert(issues).values({
        companyId: company!.id,
        identifier: `${prefix}-${n}`,
        issueNumber: n,
        title: input.title,
        status: input.status ?? "todo",
        priority: "medium",
        assigneeAgentId: input.assigneeAgentId ?? null,
        assigneeUserId: input.assigneeUserId ?? null,
        responsibleUserId: "board-user",
      }).returning();
      return issue!;
    };
    const block = (blockerId: string, blockedId: string) =>
      db.insert(issueRelations).values({
        companyId: company!.id,
        issueId: blockerId,
        relatedIssueId: blockedId,
        type: "blocks",
      });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      contextSnapshot: {},
    }).returning();
    return { company: company!, agent: agent!, run: run!, seedIssue, block };
  }

  const blockersOf = async (issueId: string) =>
    db
      .select({ id: issueRelations.issueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.relatedIssueId, issueId), eq(issueRelations.type, "blocks")))
      .then((rows) => rows.map((row) => row.id).sort());
  const statusOf = async (issueId: string) =>
    db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.status);
  const commentsOf = async (issueId: string) =>
    db
      .select({ body: issueComments.body, authorType: issueComments.authorType })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));

  it("an agent key closing a duplicate moves its dependents to the kept task", async () => {
    const f = await seedFixture();
    const kept = await f.seedIssue({ title: "Kept task" });
    const duplicate = await f.seedIssue({ title: "Duplicate task", assigneeAgentId: f.agent.id });
    const dependent = await f.seedIssue({ title: "Waits on the work", status: "blocked" });
    const doneDependent = await f.seedIssue({ title: "Already done", status: "done" });
    await f.block(duplicate.id, dependent.id);
    await f.block(duplicate.id, doneDependent.id);

    const res = await request(createApp(db, agentActor(f.company, f.agent, f.run.id)))
      .patch(`/api/issues/${duplicate.id}`)
      .send({ status: "cancelled", duplicateOfIssueId: kept.id });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(duplicate.id)).toBe("cancelled");
    expect(await blockersOf(dependent.id)).toEqual([kept.id]);
    expect(await statusOf(dependent.id)).toBe("blocked");
    const comments = await commentsOf(dependent.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorType: "system" });
    expect(comments[0]!.body).toContain(`${duplicate.identifier} was closed as a duplicate of ${kept.identifier}`);
    // Closed dependents are left alone.
    expect(await blockersOf(doneDependent.id)).toEqual([duplicate.id]);
    expect(await commentsOf(doneDependent.id)).toHaveLength(0);
  });

  it("reads a 'Duplicate of' link from the closing comment", async () => {
    const f = await seedFixture();
    const kept = await f.seedIssue({ title: "Kept task" });
    const duplicate = await f.seedIssue({ title: "Duplicate task", assigneeAgentId: f.agent.id });
    const dependent = await f.seedIssue({ title: "Waits on the work", status: "blocked" });
    await f.block(duplicate.id, dependent.id);

    const res = await request(createApp(db, agentActor(f.company, f.agent, f.run.id)))
      .patch(`/api/issues/${duplicate.id}`)
      .send({ status: "cancelled", comment: `Duplicate of ${kept.identifier}; closing.` });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await blockersOf(dependent.id)).toEqual([kept.id]);
  });

  it("refuses to cancel a blocker with open dependents when no choice is given", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue({ title: "Blocker" });
    const dependent = await f.seedIssue({ title: "Waits on the blocker", status: "blocked" });
    await f.block(blocker.id, dependent.id);

    const res = await request(createApp(db, boardActor(f.company)))
      .patch(`/api/issues/${blocker.id}`)
      .send({ status: "cancelled", comment: "Not a duplicate of anything, just dropping it." });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toContain(`${dependent.identifier} (blocked)`);
    expect(res.body.details).toMatchObject({
      code: "issue_close_has_blocked_dependents",
      dependents: [{ id: dependent.id, identifier: dependent.identifier, status: "blocked" }],
      options: ["move", "remove"],
    });
    expect(await statusOf(blocker.id)).toBe("todo");
    expect(await blockersOf(dependent.id)).toEqual([blocker.id]);
  });

  it("an agent key cancelling a blocker with no dependents is not asked anything", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue({ title: "Lonely", assigneeAgentId: f.agent.id });

    const res = await request(createApp(db, agentActor(f.company, f.agent, f.run.id)))
      .patch(`/api/issues/${blocker.id}`)
      .send({ status: "cancelled" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(blocker.id)).toBe("cancelled");
  });

  it("removing the blocker returns a dependent with no other blockers to todo", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue({ title: "Blocker", assigneeAgentId: f.agent.id });
    const otherDone = await f.seedIssue({ title: "Finished", status: "done" });
    const dependent = await f.seedIssue({ title: "Waits", status: "blocked", assigneeUserId: "board-user" });
    await f.block(blocker.id, dependent.id);
    await f.block(otherDone.id, dependent.id);

    const res = await request(createApp(db, agentActor(f.company, f.agent, f.run.id)))
      .patch(`/api/issues/${blocker.id}`)
      .send({ status: "cancelled", blockedDependents: { action: "remove" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await blockersOf(dependent.id)).toEqual([otherDone.id]);
    expect(await statusOf(dependent.id)).toBe("todo");
    const [comment] = await commentsOf(dependent.id);
    expect(comment!.body).toContain("removed from this task's blockers");
    expect(comment!.body).toContain("back in todo");
  });

  it("moving onto a task that is already done returns the dependent to todo", async () => {
    const f = await seedFixture();
    const kept = await f.seedIssue({ title: "Kept and done", status: "done" });
    const duplicate = await f.seedIssue({ title: "Duplicate" });
    const dependent = await f.seedIssue({ title: "Waits", status: "blocked", assigneeAgentId: f.agent.id });
    await f.block(duplicate.id, dependent.id);

    const res = await request(createApp(db, boardActor(f.company)))
      .patch(`/api/issues/${duplicate.id}`)
      .send({ status: "cancelled", blockedDependents: { action: "move", issueId: kept.id } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await blockersOf(dependent.id)).toEqual([kept.id]);
    expect(await statusOf(dependent.id)).toBe("todo");
  });

  it("does not move blockers onto a cancelled task or into a loop", async () => {
    const f = await seedFixture();
    const cancelledTarget = await f.seedIssue({ title: "Gone", status: "cancelled" });
    const duplicate = await f.seedIssue({ title: "Duplicate" });
    const dependent = await f.seedIssue({ title: "Waits", status: "blocked" });
    await f.block(duplicate.id, dependent.id);
    const app = createApp(db, boardActor(f.company));

    const onCancelled = await request(app)
      .patch(`/api/issues/${duplicate.id}`)
      .send({ status: "cancelled", duplicateOfIssueId: cancelledTarget.id });
    expect(onCancelled.status, JSON.stringify(onCancelled.body)).toBe(422);

    // The dependent already blocks the kept task, so waiting on it would loop.
    const loopTarget = await f.seedIssue({ title: "Waits on dependent", status: "blocked" });
    await f.block(dependent.id, loopTarget.id);
    const loop = await request(app)
      .patch(`/api/issues/${duplicate.id}`)
      .send({ status: "cancelled", duplicateOfIssueId: loopTarget.id });
    expect(loop.status, JSON.stringify(loop.body)).toBe(422);

    // Both refusals roll back the close.
    expect(await statusOf(duplicate.id)).toBe("todo");
    expect(await blockersOf(dependent.id)).toEqual([duplicate.id]);
  });

  it("rejects handoff fields when the task is not being closed", async () => {
    const f = await seedFixture();
    const kept = await f.seedIssue({ title: "Kept" });
    const issue = await f.seedIssue({ title: "Open" });

    const res = await request(createApp(db, boardActor(f.company)))
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "Renamed", duplicateOfIssueId: kept.id });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it("a blocker becoming done returns an unowned blocked dependent to todo", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue({ title: "Blocker", assigneeAgentId: f.agent.id });
    const userDependent = await f.seedIssue({ title: "User waits", status: "blocked", assigneeUserId: "board-user" });
    const heldDependent = await f.seedIssue({ title: "Also held by a person", status: "blocked" });
    const stillBlocked = await f.seedIssue({ title: "Two blockers", status: "blocked" });
    const otherOpen = await f.seedIssue({ title: "Other open blocker" });
    await db
      .update(issues)
      .set({ unblockDescriptor: { owner: "board", action: "Approve the budget" } })
      .where(eq(issues.id, heldDependent.id));
    await f.block(blocker.id, userDependent.id);
    await f.block(blocker.id, heldDependent.id);
    await f.block(blocker.id, stillBlocked.id);
    await f.block(otherOpen.id, stillBlocked.id);

    const res = await request(createApp(db, agentActor(f.company, f.agent, f.run.id)))
      .patch(`/api/issues/${blocker.id}`)
      .send({ status: "done", comment: "Finished." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(userDependent.id)).toBe("todo");
    const [comment] = await commentsOf(userDependent.id);
    expect(comment!.body).toContain(`${blocker.identifier} is done`);
    // A named unblock owner is a reason to stay blocked; so is an open blocker.
    expect(await statusOf(heldDependent.id)).toBe("blocked");
    expect(await statusOf(stillBlocked.id)).toBe("blocked");
  });
});
