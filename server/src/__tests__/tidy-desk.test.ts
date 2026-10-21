import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueRelations,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { attentionService } from "../services/attention.js";
import { issueService } from "../services/issues.js";
import { issueTablingService, returnDueTabledIssues } from "../services/issue-tabling.js";
import { detectLooksFinished, looksFinishedService, LOOKS_FINISHED_ORIGIN_KIND } from "../services/looks-finished.js";
import { issueTablingRoutes } from "../routes/issue-tabling.js";
import { ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";

// Tidy desk (21 Oct): parked work leaves the Desk and Decisions, finished-looking
// work is flagged, and outside waits table the task until a date. The scenarios
// are the ones found on live.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BOARD_USER = "board-user";
const DAY = 24 * 60 * 60 * 1000;

describeEmbeddedPostgres("tidy desk", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tidy-desk-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ceoId, companyId, name: "Everest", role: "ceo", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      },
      {
        id: workerId, companyId, name: "Worker", role: "engineer", status: "idle", reportsTo: ceoId,
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      },
    ]);
    return { companyId, ceoId, workerId };
  }

  let counter = 0;
  async function insertIssue(input: {
    companyId: string;
    title: string;
    status: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    unblockDescriptor?: { owner: "board"; action: string } | null;
    blockedTransitionAt?: Date | null;
    completedAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
  }) {
    const id = randomUUID();
    counter += 1;
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: `TD-${counter}`,
      title: input.title,
      status: input.status,
      priority: "medium",
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      originKind: "manual",
      unblockDescriptor: input.unblockDescriptor ?? null,
      blockedTransitionAt: input.blockedTransitionAt ?? null,
      completedAt: input.completedAt ?? null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    return id;
  }

  async function blocks(companyId: string, blockerId: string, blockedId: string) {
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: blockedId, type: "blocks" });
  }

  async function blockerCards(companyId: string) {
    const feed = await attentionService(db).list(companyId, { userId: BOARD_USER });
    return feed.items.filter((item) => item.sourceKind === "blocker_attention");
  }

  function app(companyId: string, actor: Record<string, unknown>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = { companyIds: [companyId], isInstanceAdmin: false, ...actor };
      next();
    });
    server.use("/api", issueTablingRoutes(db));
    server.use(errorHandler);
    return server;
  }

  describe("parked means gone", () => {
    it("a parked booking trial no longer 'Blocks 11 tasks and needs human attention'", async () => {
      const { companyId } = await seedCompany("TDA");
      // The trial is the parent; its unowned sub-task is the terminal blocker.
      const trialId = await insertIssue({ companyId, title: "Booking trial", status: "todo" });
      const setupId = await insertIssue({ companyId, title: "Set up the booking page", status: "todo", parentId: trialId });
      for (let index = 0; index < 11; index += 1) {
        const blockedId = await insertIssue({ companyId, title: `Follow-up ${index}`, status: "blocked" });
        await blocks(companyId, setupId, blockedId);
      }

      // The probe goes red first: before parking, the card is there.
      const before = await blockerCards(companyId);
      expect(before.map((item) => item.whyNow)).toEqual(["Blocks 11 tasks and needs human attention."]);

      await issueTablingService(db).table(trialId, { until: null, userId: BOARD_USER });
      expect(await blockerCards(companyId)).toEqual([]);
    });

    it("a backlog blocker needs no human while only backlog work waits on it", async () => {
      const { companyId } = await seedCompany("TDB");
      const trialId = await insertIssue({ companyId, title: "Booking trial", status: "backlog" });
      const backlogStepId = await insertIssue({ companyId, title: "Later step", status: "backlog" });
      const blockedId = await insertIssue({ companyId, title: "Waiting work", status: "blocked" });
      await blocks(companyId, trialId, backlogStepId);
      await blocks(companyId, backlogStepId, blockedId);
      expect(await blockerCards(companyId)).toEqual([]);

      // Live work straight behind the backlog task does need a human.
      const liveId = await insertIssue({ companyId, title: "Live work", status: "blocked" });
      await blocks(companyId, trialId, liveId);
      const cards = await blockerCards(companyId);
      expect(cards.some((item) => item.subject.id === trialId)).toBe(true);
    });

    it("the Desk list leaves out tabled tasks and everything under them", async () => {
      const { companyId } = await seedCompany("TDC");
      const parkedId = await insertIssue({ companyId, title: "Parked", status: "todo", assigneeUserId: BOARD_USER });
      const childId = await insertIssue({ companyId, title: "Child", status: "todo", parentId: parkedId, assigneeUserId: BOARD_USER });
      const grandchildId = await insertIssue({ companyId, title: "Grandchild", status: "todo", parentId: childId, assigneeUserId: BOARD_USER });
      const liveId = await insertIssue({ companyId, title: "Live", status: "todo", assigneeUserId: BOARD_USER });
      await issueTablingService(db).table(parkedId, { until: null, userId: BOARD_USER });

      const all = await issueService(db).list(companyId, { assigneeUserId: BOARD_USER });
      expect(all.map((issue) => issue.id).sort()).toEqual([parkedId, childId, grandchildId, liveId].sort());
      const desk = await issueService(db).list(companyId, { assigneeUserId: BOARD_USER, excludeParked: true });
      expect(desk.map((issue) => issue.id)).toEqual([liveId]);
    });
  });

  describe("looks finished", () => {
    it("flags the CRM tasks still blocked days after their blocker shipped, without changing status", async () => {
      const { companyId, ceoId, workerId } = await seedCompany("TDD");
      const now = new Date();
      const shippedAt = new Date(now.getTime() - 3 * DAY);
      const prId = await insertIssue({ companyId, title: "CRM sync PR", status: "done", completedAt: shippedAt });
      const crmIds = [
        await insertIssue({ companyId, title: "CRM contacts", status: "blocked", assigneeAgentId: workerId, createdAt: new Date(now.getTime() - 5 * DAY) }),
        await insertIssue({ companyId, title: "CRM deals", status: "blocked", assigneeAgentId: workerId, createdAt: new Date(now.getTime() - 5 * DAY) }),
      ];
      for (const id of crmIds) await blocks(companyId, prId, id);
      // A task whose blocker closed but which has moved on since is not flagged.
      const movedOnId = await insertIssue({ companyId, title: "Moved on", status: "in_progress" });
      await blocks(companyId, prId, movedOnId);
      await db.insert(issueComments).values({ companyId, issueId: movedOnId, body: "Working on it", createdAt: new Date(now.getTime() - DAY) });

      const service = looksFinishedService(db, { now: () => now });
      const result = await service.refreshCompany(companyId);
      expect(result.flagged).toBe(2);

      const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
      for (const id of crmIds) {
        const row = rows.find((issue) => issue.id === id)!;
        expect(row.status).toBe("blocked");
        expect(row.looksFinishedAt).toBeTruthy();
        expect(row.looksFinishedReasons?.[0]).toMatch(/^Every task blocking it is closed/);
      }
      expect(rows.find((issue) => issue.id === movedOnId)?.looksFinishedAt).toBeNull();

      // Everest gets one review task a day listing them.
      const review = await service.ensureDailyReview(companyId, result.open);
      expect(review).toMatchObject({ assigneeAgentId: ceoId, originKind: LOOKS_FINISHED_ORIGIN_KIND, status: "todo" });
      expect(review?.description).toContain("CRM contacts");
      expect(await service.ensureDailyReview(companyId, result.open)).toBeNull();

      const flaggedLogs = await db.select().from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.looks_finished_flagged")));
      expect(flaggedLogs).toHaveLength(2);
    });

    it("flags a parent whose sub-tasks are all closed, and not one with open or no sub-tasks", async () => {
      const { companyId } = await seedCompany("TDE");
      const doneParentId = await insertIssue({ companyId, title: "All done under me", status: "in_progress" });
      await insertIssue({ companyId, title: "a", status: "done", parentId: doneParentId });
      await insertIssue({ companyId, title: "b", status: "cancelled", parentId: doneParentId });
      const openParentId = await insertIssue({ companyId, title: "Still going", status: "in_progress" });
      await insertIssue({ companyId, title: "c", status: "done", parentId: openParentId });
      await insertIssue({ companyId, title: "d", status: "todo", parentId: openParentId });
      const loneId = await insertIssue({ companyId, title: "No sub-tasks", status: "todo" });

      const { reasons } = await detectLooksFinished(db, companyId);
      expect(reasons.get(doneParentId)).toEqual(["All 2 sub-tasks are done or cancelled."]);
      expect(reasons.has(openParentId)).toBe(false);
      expect(reasons.has(loneId)).toBe(false);
    });

    it("waits out the grace after a blocker closes so the unblock wake can act first", async () => {
      const { companyId } = await seedCompany("TDF");
      const now = new Date();
      const blockerId = await insertIssue({ companyId, title: "Just closed", status: "done", completedAt: new Date(now.getTime() - 5 * 60 * 1000) });
      const blockedId = await insertIssue({ companyId, title: "Waiting", status: "blocked" });
      await blocks(companyId, blockerId, blockedId);
      const { reasons } = await detectLooksFinished(db, companyId, now);
      expect(reasons.has(blockedId)).toBe(false);
    });

    it("Not finished holds until new work, and a status change by hand settles the flag", async () => {
      const { companyId } = await seedCompany("TDG");
      const parentId = await insertIssue({ companyId, title: "Parent", status: "in_review" });
      await insertIssue({ companyId, title: "Only child", status: "done", parentId });
      let now = new Date();
      const service = looksFinishedService(db, { now: () => now });
      await service.refreshCompany(companyId);
      expect((await issueService(db).getById(parentId))?.looksFinishedAt).toBeTruthy();

      await service.dismiss(parentId);
      now = new Date(now.getTime() + 60 * 1000);
      await service.refreshCompany(companyId);
      expect((await issueService(db).getById(parentId))?.looksFinishedAt).toBeNull();

      // New work after "Not finished": the check may flag it again.
      await db.insert(issueComments).values({ companyId, issueId: parentId, body: "Back on it", createdAt: new Date(now.getTime() + 1000) });
      now = new Date(now.getTime() + 60 * 1000);
      await service.refreshCompany(companyId);
      expect((await issueService(db).getById(parentId))?.looksFinishedAt).toBeTruthy();

      // Closing keeps the flag (Reopen reads it); reopening clears it.
      await issueService(db).update(parentId, { status: "done" });
      expect((await issueService(db).getById(parentId))?.looksFinishedAt).toBeTruthy();
      await issueService(db).update(parentId, { status: "todo" });
      const reopened = await issueService(db).getById(parentId);
      expect(reopened?.looksFinishedAt).toBeNull();
      expect(reopened?.looksFinishedDismissedAt).toBeTruthy();
    });

    it("dismiss route clears the flag and logs who did it", async () => {
      const { companyId } = await seedCompany("TDH");
      const parentId = await insertIssue({ companyId, title: "Parent", status: "todo" });
      await insertIssue({ companyId, title: "Only child", status: "done", parentId });
      await looksFinishedService(db).refreshCompany(companyId);

      const board = app(companyId, { type: "board", source: "local_implicit", userId: BOARD_USER });
      const res = await request(board).post(`/api/issues/${parentId}/looks-finished/dismiss`).send({}).expect(200);
      expect(res.body.looksFinishedAt).toBeNull();
      const logs = await db.select().from(activityLog)
        .where(and(eq(activityLog.entityId, parentId), eq(activityLog.action, "issue.looks_finished_dismissed")));
      expect(logs).toHaveLength(1);
      expect(logs[0]?.actorId).toBe(BOARD_USER);
    });
  });

  describe("waiting on someone outside", () => {
    it("the 'when a client is near' task stops alerting, records who, and comes back on its date", async () => {
      const { companyId, workerId } = await seedCompany("TDI");
      const transitionAt = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1000);
      const issueId = await insertIssue({
        companyId,
        title: "Visit when a client is near",
        status: "blocked",
        assigneeAgentId: workerId,
        unblockDescriptor: { owner: "board", action: "Tell me when a client is near" },
        blockedTransitionAt: transitionAt,
      });
      expect((await blockerCards(companyId)).some((item) => item.subject.id === issueId)).toBe(true);

      const returnAt = new Date(Date.now() + 14 * DAY).toISOString();
      const agentApp = app(companyId, { type: "agent", agentId: workerId, companyId, userId: undefined });
      // Agents must say who and when.
      await request(agentApp).post(`/api/issues/${issueId}/table`).send({ returnAt }).expect(422);
      // Another agent may not park someone else's task.
      const otherApp = app(companyId, { type: "agent", agentId: randomUUID(), companyId, userId: undefined });
      await request(otherApp).post(`/api/issues/${issueId}/table`).send({ returnAt, waitingOn: "Acme" }).expect(403);

      const res = await request(agentApp)
        .post(`/api/issues/${issueId}/table`)
        .send({ returnAt, waitingOn: "Acme's office manager" })
        .expect(200);
      expect(res.body).toMatchObject({ status: "backlog", tabledFromStatus: "blocked" });
      expect(new Date(res.body.tabledUntil).toISOString()).toBe(returnAt);
      expect(await blockerCards(companyId)).toEqual([]);

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.map((comment) => comment.body)).toEqual([
        `Waiting on someone outside: Acme's office manager. It comes back on ${returnAt.slice(0, 10)}.`,
      ]);
      const tabledLog = await db.select().from(activityLog)
        .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.tabled")));
      expect(tabledLog[0]?.details).toMatchObject({ waitingOn: "Acme's office manager" });

      const heartbeat = { wakeup: async () => null };
      await returnDueTabledIssues(db, { heartbeat, now: () => new Date(Date.now() + 15 * DAY) });
      const back = await issueService(db).getById(issueId);
      expect(back?.status).toBe("blocked");
      expect(back?.tabledAt).toBeNull();
    });
  });
});
