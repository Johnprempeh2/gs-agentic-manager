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
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";

// GRE-1896 (register rows 147 + 139): when the last blocker of a blocked agent
// task closed, the platform woke the agent but left the task `blocked`, and the
// wake did not say what the blocker's owner had written. John kept asking "why
// is this still blocked?" and passed the fix on to each agent by hand.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocker-done route tests on this host: ${
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

describeEmbeddedPostgres("GRE-1896: a task goes back to todo when its last blocker closes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocker-done-todo-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const nonce = randomUUID().slice(0, 8);
    const prefix = `BD${nonce.slice(0, 4).toUpperCase()}`;
    const [company] = await db.insert(companies).values({
      name: `Blocker done ${nonce}`,
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
        ...(input.status === "blocked" ? { blockedTransitionAt: new Date() } : {}),
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
      agentId: closer.id,
      status: "running",
      contextSnapshot: {},
    }).returning();
    const closeAs = (issueId: string, body: Record<string, unknown>) =>
      request(createApp(db, agentActor(company!, closer, run!.id)))
        .patch(`/api/issues/${issueId}`)
        .send(body);
    return { company: company!, closer, owner, run: run!, seedIssue, block, closeAs };
  }

  const statusOf = async (issueId: string) =>
    db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]?.status);
  const blockerWakesFor = async (agentId: string, issueId: string) =>
    db
      .select({
        payload: agentWakeupRequests.payload,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      );
  const commentById = async (commentId: string) =>
    db
      .select({ issueId: issueComments.issueId, body: issueComments.body, authorType: issueComments.authorType })
      .from(issueComments)
      .where(eq(issueComments.id, commentId))
      .then((rows) => rows[0] ?? null);
  // Wakes go out after the reply. Wait for them, then a little longer so a
  // duplicate would show up too.
  const settledBlockerWakesFor = async (agentId: string, issueId: string, expected: number) => {
    await vi.waitFor(async () => expect(await blockerWakesFor(agentId, issueId)).toHaveLength(expected), {
      timeout: 5000,
      interval: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return blockerWakesFor(agentId, issueId);
  };

  it("B blocked by A: A done moves B to todo and wakes its owner once with A's closing comment", async () => {
    const f = await seedFixture();
    const a = await f.seedIssue({ title: "Fix the GitHub grant", status: "in_progress", assigneeAgentId: f.closer.id });
    const b = await f.seedIssue({ title: "Open the pull request", status: "blocked", assigneeAgentId: f.owner.id });
    await f.block(a.id, b.id);

    const res = await f.closeAs(a.id, {
      status: "done",
      comment: "Fixed: the GitHub grant now covers the repo. Push again.",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(b.id)).toBe("todo");

    const wakes = await settledBlockerWakesFor(f.owner.id, b.id, 1);
    expect(wakes).toHaveLength(1);
    const payload = wakes[0]!.payload as Record<string, unknown>;
    expect(payload.resolvedBlockerIssueId).toBe(a.id);
    const commentId = payload.commentId as string;
    expect(commentId).toEqual(expect.any(String));
    const note = await commentById(commentId);
    expect(note).toMatchObject({ issueId: b.id, authorType: "system" });
    expect(note!.body).toContain(`${a.identifier} is done and no open blockers are left, so this task is back in todo.`);
    expect(note!.body).toContain("> Fixed: the GitHub grant now covers the repo. Push again.");
  });

  it("B blocked by A and C: B stays blocked when A closes and moves when C closes", async () => {
    const f = await seedFixture();
    const a = await f.seedIssue({ title: "First blocker", status: "in_progress", assigneeAgentId: f.closer.id });
    const c = await f.seedIssue({ title: "Second blocker", status: "in_progress", assigneeAgentId: f.closer.id });
    const b = await f.seedIssue({ title: "Waits on both", status: "blocked", assigneeAgentId: f.owner.id });
    await f.block(a.id, b.id);
    await f.block(c.id, b.id);

    const first = await f.closeAs(a.id, { status: "done", comment: "First part shipped." });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    console.log("DEBUG2", JSON.stringify(await db.select({reason: agentWakeupRequests.reason, status: agentWakeupRequests.status, src: agentWakeupRequests.source}).from(agentWakeupRequests).where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${b.id}`)));
    expect(await statusOf(b.id)).toBe("blocked");
    expect(await settledBlockerWakesFor(f.owner.id, b.id, 0)).toHaveLength(0);

    const second = await f.closeAs(c.id, { status: "done", comment: "Second part shipped." });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await statusOf(b.id)).toBe("todo");
    const wakes = await settledBlockerWakesFor(f.owner.id, b.id, 1);
    expect(wakes).toHaveLength(1);
    const note = await commentById((wakes[0]!.payload as Record<string, unknown>).commentId as string);
    expect(note!.body).toContain(`${c.identifier} is done`);
    expect(note!.body).toContain("> Second part shipped.");
  });

  it("the dependency backstop also moves a freed task to todo and wakes it with the closing comment", async () => {
    // A blocker with a workspace is only ready after its workspace finalizes,
    // so its dependents are freed by the backstop, not by the close itself.
    const f = await seedFixture();
    const a = await f.seedIssue({ title: "Release the fix", status: "done", assigneeAgentId: f.closer.id });
    const b = await f.seedIssue({ title: "Measure after release", status: "blocked", assigneeAgentId: f.owner.id });
    await f.block(a.id, b.id);
    await db.insert(issueComments).values({
      companyId: f.company.id,
      issueId: a.id,
      authorType: "agent",
      authorAgentId: f.closer.id,
      body: "Released as live-2026-10-22.1.",
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes({ companyId: f.company.id });

    expect(result.issueIds).toEqual([b.id]);
    expect(await statusOf(b.id)).toBe("todo");
    const wakes = await settledBlockerWakesFor(f.owner.id, b.id, 1);
    const note = await commentById((wakes[0]!.payload as Record<string, unknown>).commentId as string);
    expect(note).toMatchObject({ issueId: b.id, authorType: "system" });
    expect(note!.body).toContain("> Released as live-2026-10-22.1.");

    // A second pass finds nothing left to do.
    const again = await heartbeatService(db).reconcileResolvedDependencyWakes({ companyId: f.company.id });
    expect(again.healed).toBe(0);
    expect(await blockerWakesFor(f.owner.id, b.id)).toHaveLength(1);
  });

  it("a task held by an unblock note is not re-woken by a done blocker still on record", async () => {
    const f = await seedFixture();
    const a = await f.seedIssue({ title: "Merged fix", status: "done", assigneeAgentId: f.closer.id });
    const b = await f.seedIssue({ title: "Measure after release", status: "in_progress", assigneeAgentId: f.owner.id });
    await f.block(a.id, b.id);

    // GRE-1786: the task is parked on a release while the done blocker is
    // still recorded. Each park used to wake the owner straight back up.
    const res = await request(createApp(db, boardActor(f.company)))
      .patch(`/api/issues/${b.id}`)
      .send({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Release the fix to live.", waitingOn: "board" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(b.id)).toBe("blocked");
    expect(await settledBlockerWakesFor(f.owner.id, b.id, 0)).toHaveLength(0);
  });
});
