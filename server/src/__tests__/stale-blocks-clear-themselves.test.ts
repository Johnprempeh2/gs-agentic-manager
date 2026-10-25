import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  issueThreadInteractions,
} from "@greatstone/db";
import type { IssueUnblockDescriptor } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";

// GRE-2286: GRE-1989 stayed blocked for over an hour after John accepted the
// staging upload card it waited on, because the only link to that card was
// free text in the unblock note. The note now links the card itself, and an
// answered card (or a closed last blocker) frees the task and wakes its owner.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-block tests on this host: ${
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
  return { type: "agent", agentId: agent.id, companyId: company.id, runId, source: "agent_key" };
}

describeEmbeddedPostgres("GRE-2286: stale blocks clear themselves", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-blocks-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const nonce = randomUUID().slice(0, 8);
    const prefix = `SB${nonce.slice(0, 4).toUpperCase()}`;
    const [company] = await db.insert(companies).values({
      name: `Stale blocks ${nonce}`,
      issuePrefix: prefix,
      defaultResponsibleUserId: "board-user",
    }).returning();
    const newAgent = async (name: string) => {
      const [agent] = await db.insert(agents).values({
        companyId: company!.id,
        name: `${name} ${nonce}`,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      }).returning();
      return agent!;
    };
    const closer = await newAgent("Closer");
    const owner = await newAgent("Owner");
    let n = 0;
    const seedIssue = async (input: {
      title: string;
      status?: string;
      assigneeAgentId?: string | null;
      unblockDescriptor?: IssueUnblockDescriptor | null;
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
        responsibleUserId: "board-user",
        unblockDescriptor: input.unblockDescriptor ?? null,
        ...(input.status === "blocked" ? { blockedTransitionAt: new Date() } : {}),
      }).returning();
      return issue!;
    };
    const seedCard = async (issueId: string, input?: { title?: string; continuationPolicy?: string; status?: string }) => {
      const [card] = await db.insert(issueThreadInteractions).values({
        companyId: company!.id,
        issueId,
        kind: "request_confirmation",
        status: input?.status ?? "pending",
        continuationPolicy: input?.continuationPolicy ?? "none",
        title: input?.title ?? "Upload the build to staging",
        payload: { version: 1, prompt: "May I upload the build to staging?" },
      }).returning();
      return card!;
    };
    const waitingOn = (cardId: string): IssueUnblockDescriptor => ({
      owner: "board",
      action: "Answer the staging upload card",
      waitingOn: "board",
      interactionId: cardId,
    });
    const block = (blockerId: string, blockedId: string) =>
      db.insert(issueRelations).values({
        companyId: company!.id,
        issueId: blockerId,
        relatedIssueId: blockedId,
        type: "blocks",
      });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id,
      agentId: closer.id,
      status: "running",
      contextSnapshot: {},
    }).returning();
    const board = () => request(createApp(db, boardActor(company!)));
    const closeAs = (issueId: string, body: Record<string, unknown>) =>
      request(createApp(db, agentActor(company!, closer, run!.id)))
        .patch(`/api/issues/${issueId}`)
        .send(body);
    return { company: company!, closer, owner, seedIssue, seedCard, waitingOn, block, board, closeAs };
  }

  const issueRow = async (issueId: string) =>
    db
      .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
  const wakesFor = async (agentId: string, issueId: string) =>
    db
      .select({
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      );
  // Wakes go out after the reply. Wait for them, then a little longer so a
  // duplicate would show up too.
  const settledWakesFor = async (agentId: string, issueId: string, expected: number) => {
    await vi.waitFor(async () => expect(await wakesFor(agentId, issueId)).toHaveLength(expected), {
      timeout: 5000,
      interval: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return wakesFor(agentId, issueId);
  };
  const noteFor = async (commentId: string) =>
    db
      .select({ issueId: issueComments.issueId, body: issueComments.body, authorType: issueComments.authorType })
      .from(issueComments)
      .where(eq(issueComments.id, commentId))
      .then((rows) => rows[0] ?? null);

  it("card accepted: the waiting task goes to todo, its note is cleared and its owner is woken once", async () => {
    const f = await seedFixture();
    // The card sits on another task, as when a parent asks for the upload.
    const cardHolder = await f.seedIssue({ title: "Staging upload", status: "in_progress", assigneeAgentId: f.closer.id });
    const card = await f.seedCard(cardHolder.id);
    const waiting = await f.seedIssue({
      title: "Verify on staging",
      status: "blocked",
      assigneeAgentId: f.owner.id,
      unblockDescriptor: f.waitingOn(card.id),
    });

    const res = await f.board().post(`/api/issues/${cardHolder.id}/interactions/${card.id}/accept`).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await issueRow(waiting.id)).toEqual({ status: "todo", unblockDescriptor: null });
    const wakes = await settledWakesFor(f.owner.id, waiting.id, 1);
    expect(wakes[0]).toMatchObject({
      reason: "issue_status_changed",
      idempotencyKey: `card_answered_unblocked:${waiting.id}:${card.id}`,
    });
    const payload = wakes[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ mutation: "card_answered", interactionId: card.id, interactionStatus: "accepted" });
    const note = await noteFor(payload.commentId as string);
    expect(note).toMatchObject({ issueId: waiting.id, authorType: "system" });
    expect(note!.body).toContain('The card "Upload the build to staging" this task waited on was accepted');
  });

  it("card on the task itself: one wake, the card's own continuation", async () => {
    const f = await seedFixture();
    const task = await f.seedIssue({ title: "Upload and verify", status: "in_progress", assigneeAgentId: f.owner.id });
    const card = await f.seedCard(task.id, { continuationPolicy: "wake_assignee" });
    await db.update(issues)
      .set({ status: "blocked", blockedTransitionAt: new Date(), unblockDescriptor: f.waitingOn(card.id) })
      .where(eq(issues.id, task.id));

    const res = await f.board().post(`/api/issues/${task.id}/interactions/${card.id}/accept`).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(task.id)).status).toBe("todo");
    const wakes = await settledWakesFor(f.owner.id, task.id, 1);
    expect(wakes[0]!.idempotencyKey).toBe(`interaction:${card.id}:accepted`);
  });

  it("card rejected: the task goes to todo and the note quotes the reason", async () => {
    const f = await seedFixture();
    const task = await f.seedIssue({ title: "Upload and verify", status: "in_progress", assigneeAgentId: f.owner.id });
    const card = await f.seedCard(task.id);
    await db.update(issues)
      .set({ status: "blocked", blockedTransitionAt: new Date(), unblockDescriptor: f.waitingOn(card.id) })
      .where(eq(issues.id, task.id));

    const res = await f.board()
      .post(`/api/issues/${task.id}/interactions/${card.id}/reject`)
      .send({ reason: "Use the second staging site instead." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await issueRow(task.id)).toEqual({ status: "todo", unblockDescriptor: null });
    const wakes = await settledWakesFor(f.owner.id, task.id, 1);
    expect(wakes[0]!.idempotencyKey).toBe(`card_answered_unblocked:${task.id}:${card.id}`);
    const note = await noteFor((wakes[0]!.payload as Record<string, unknown>).commentId as string);
    expect(note!.body).toContain("was rejected");
    expect(note!.body).toContain("> Use the second staging site instead.");
  });

  it("an answered card leaves the task blocked while another blocker is open", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue({ title: "Fix the build", status: "in_progress", assigneeAgentId: f.closer.id });
    const task = await f.seedIssue({ title: "Upload and verify", status: "in_progress", assigneeAgentId: f.owner.id });
    const card = await f.seedCard(task.id);
    await db.update(issues)
      .set({ status: "blocked", blockedTransitionAt: new Date(), unblockDescriptor: f.waitingOn(card.id) })
      .where(eq(issues.id, task.id));
    await f.block(blocker.id, task.id);

    const res = await f.board().post(`/api/issues/${task.id}/interactions/${card.id}/accept`).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(task.id)).status).toBe("blocked");
    expect(await settledWakesFor(f.owner.id, task.id, 0)).toHaveLength(0);
  });

  it("last blocker done: the task goes to todo and its owner is woken once", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue({ title: "Fix the build", status: "in_progress", assigneeAgentId: f.closer.id });
    const task = await f.seedIssue({ title: "Ship it", status: "blocked", assigneeAgentId: f.owner.id });
    await f.block(blocker.id, task.id);

    const res = await f.closeAs(blocker.id, { status: "done", comment: "Build fixed." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(task.id)).status).toBe("todo");
    const wakes = await settledWakesFor(f.owner.id, task.id, 1);
    expect(wakes[0]!.reason).toBe("issue_blockers_resolved");
  });

  it("last blocker cancelled: the blocker is removed, the task goes to todo and its owner is woken once", async () => {
    const f = await seedFixture();
    const blocker = await f.seedIssue({ title: "Old approach", status: "in_progress", assigneeAgentId: f.closer.id });
    const task = await f.seedIssue({ title: "Ship it", status: "blocked", assigneeAgentId: f.owner.id });
    await f.block(blocker.id, task.id);

    const res = await f.closeAs(blocker.id, {
      status: "cancelled",
      comment: "Not needed any more.",
      blockedDependents: { action: "remove" },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(task.id)).status).toBe("todo");
    const wakes = await settledWakesFor(f.owner.id, task.id, 1);
    expect(wakes[0]).toMatchObject({ reason: "issue_status_changed" });
    expect((wakes[0]!.payload as Record<string, unknown>).mutation).toBe("blocker_handoff");
  });

  it("swallowed first wake: the backstop frees a task whose card was answered without freeing it, once", async () => {
    const f = await seedFixture();
    const task = await f.seedIssue({ title: "Upload and verify", status: "in_progress", assigneeAgentId: f.owner.id });
    // Answered while a release was in progress: the card is accepted but
    // nothing freed the task or woke its owner.
    const card = await f.seedCard(task.id, { status: "accepted" });
    await db.update(issues)
      .set({ status: "blocked", blockedTransitionAt: new Date(), unblockDescriptor: f.waitingOn(card.id) })
      .where(eq(issues.id, task.id));

    const result = await heartbeatService(db).reconcileAnsweredCardBlocks({ companyId: f.company.id });

    expect(result.issueIds).toEqual([task.id]);
    expect(await issueRow(task.id)).toEqual({ status: "todo", unblockDescriptor: null });
    const wakes = await wakesFor(f.owner.id, task.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.idempotencyKey).toBe(`card_answered_unblocked:${task.id}:${card.id}`);

    const again = await heartbeatService(db).reconcileAnsweredCardBlocks({ companyId: f.company.id });
    expect(again.released).toBe(0);
    expect(await wakesFor(f.owner.id, task.id)).toHaveLength(1);
  });

  it("the backstop leaves a task alone while its card is still pending", async () => {
    const f = await seedFixture();
    const task = await f.seedIssue({ title: "Upload and verify", status: "in_progress", assigneeAgentId: f.owner.id });
    const card = await f.seedCard(task.id);
    await db.update(issues)
      .set({ status: "blocked", blockedTransitionAt: new Date(), unblockDescriptor: f.waitingOn(card.id) })
      .where(eq(issues.id, task.id));

    const result = await heartbeatService(db).reconcileAnsweredCardBlocks({ companyId: f.company.id });

    expect(result.released).toBe(0);
    expect((await issueRow(task.id)).status).toBe("blocked");
  });

  it("an unblock note may link only a pending card in the same company", async () => {
    const f = await seedFixture();
    const other = await seedFixture();
    const task = await f.seedIssue({ title: "Upload and verify", status: "in_progress", assigneeAgentId: f.owner.id });
    const pending = await f.seedCard(task.id);
    const answered = await f.seedCard(task.id, { status: "accepted" });
    const otherTask = await other.seedIssue({ title: "Elsewhere", status: "in_progress" });
    const foreign = await other.seedCard(otherTask.id);

    const linkTo = (cardId: string) =>
      f.board().patch(`/api/issues/${task.id}`).send({ status: "blocked", unblockDescriptor: f.waitingOn(cardId) });

    const foreignRes = await linkTo(foreign.id);
    expect(foreignRes.status).toBe(422);
    const answeredRes = await linkTo(answered.id);
    expect(answeredRes.status).toBe(422);
    expect(JSON.stringify(answeredRes.body)).toContain("already accepted");
    const ok = await linkTo(pending.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await issueRow(task.id)).unblockDescriptor).toMatchObject({ interactionId: pending.id });
  });
});
