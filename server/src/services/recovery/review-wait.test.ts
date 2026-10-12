import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  issueThreadInteractions,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  REVIEW_WAIT_ACTIVITY_SOURCE,
  REVIEW_WAIT_ACTIVITY_WINDOW_MS,
  REVIEW_WAIT_COMMENT_ONLY_MAX_DEFERRALS,
  REVIEW_WAIT_MAX_DEFERRALS,
  REVIEW_WAIT_PENDING_CARD_RECHECK_MS,
  REVIEW_WAIT_RECHECK_MS,
  decideReviewWait,
  isReviewerWaitingOnCheck,
  readReviewWaitEvidence,
  reviewWaitRecheckMs,
} from "./review-wait.js";

const NOW = new Date("2026-09-28T07:57:19Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60 * 1000);

describe("decideReviewWait (GRE-97)", () => {
  it("waits when the reviewer commented within N = 30 minutes", () => {
    expect(
      decideReviewWait({ latestReviewerCommentAt: minutesAgo(2), activeCheckIssueCount: 0, pendingLinkedCardCount: 0, priorDeferrals: 0 }, NOW),
    ).toEqual({ kind: "waiting", reason: "reviewer_comment" });
  });

  it("waits when a check issue is being worked, even with an old comment", () => {
    expect(
      decideReviewWait({ latestReviewerCommentAt: minutesAgo(600), activeCheckIssueCount: 1, pendingLinkedCardCount: 0, priorDeferrals: 0 }, NOW),
    ).toEqual({ kind: "waiting", reason: "active_check_issue" });
  });

  it("is a stall with no recent comment and no check", () => {
    expect(
      decideReviewWait(
        {
          latestReviewerCommentAt: new Date(NOW.getTime() - REVIEW_WAIT_ACTIVITY_WINDOW_MS - 1),
          activeCheckIssueCount: 0, pendingLinkedCardCount: 0,
          priorDeferrals: 0,
        },
        NOW,
      ),
    ).toEqual({ kind: "stalled", reason: "no_activity" });
  });

  it("is a stall once the deferral budget is spent", () => {
    expect(
      decideReviewWait(
        { latestReviewerCommentAt: minutesAgo(1), activeCheckIssueCount: 1, pendingLinkedCardCount: 0, priorDeferrals: REVIEW_WAIT_MAX_DEFERRALS },
        NOW,
      ),
    ).toEqual({ kind: "stalled", reason: "budget_exhausted" });
  });
});

describe("decideReviewWait budget by evidence (GRE-218)", () => {
  const commentOnly = (priorDeferrals: number) =>
    decideReviewWait({ latestReviewerCommentAt: minutesAgo(1), activeCheckIssueCount: 0, pendingLinkedCardCount: 0, priorDeferrals }, NOW);
  const activeCheck = (priorDeferrals: number) =>
    decideReviewWait({ latestReviewerCommentAt: minutesAgo(1), activeCheckIssueCount: 1, pendingLinkedCardCount: 0, priorDeferrals }, NOW);

  it("keeps the full budget for an active check and a short one for a comment", () => {
    expect(REVIEW_WAIT_COMMENT_ONLY_MAX_DEFERRALS).toBe(2);
    expect(REVIEW_WAIT_MAX_DEFERRALS).toBe(8);
  });

  it.each([0, 1])("comment only, %i prior deferrals: waiting", (priorDeferrals) => {
    expect(commentOnly(priorDeferrals)).toEqual({ kind: "waiting", reason: "reviewer_comment" });
  });

  it("comment only, 2 prior deferrals: budget exhausted", () => {
    expect(commentOnly(2)).toEqual({ kind: "stalled", reason: "budget_exhausted" });
  });

  it.each([2, 3, 4, 5, 6, 7])("active check, %i prior deferrals: waiting", (priorDeferrals) => {
    expect(activeCheck(priorDeferrals)).toEqual({ kind: "waiting", reason: "active_check_issue" });
  });

  it("active check, 8 prior deferrals: budget exhausted", () => {
    expect(activeCheck(8)).toEqual({ kind: "stalled", reason: "budget_exhausted" });
  });

  it("no evidence: no activity, whatever the deferral count", () => {
    for (const priorDeferrals of [0, 2, 8]) {
      expect(
        decideReviewWait({ latestReviewerCommentAt: null, activeCheckIssueCount: 0, pendingLinkedCardCount: 0, priorDeferrals }, NOW),
      ).toEqual({ kind: "stalled", reason: "no_activity" });
    }
  });
});

describe("decideReviewWait with a pending card on a linked issue (GRE-290)", () => {
  it("waits with no budget while a linked card is pending, and rechecks less often", () => {
    for (const priorDeferrals of [0, 2, REVIEW_WAIT_MAX_DEFERRALS, 50]) {
      const decision = decideReviewWait(
        { latestReviewerCommentAt: null, activeCheckIssueCount: 0, pendingLinkedCardCount: 1, priorDeferrals },
        NOW,
      );
      expect(decision).toEqual({ kind: "waiting", reason: "pending_linked_card" });
      expect(reviewWaitRecheckMs(decision)).toBe(REVIEW_WAIT_PENDING_CARD_RECHECK_MS);
    }
  });

  it("uses the normal rules and recheck once no card is pending", () => {
    const decision = decideReviewWait(
      { latestReviewerCommentAt: minutesAgo(1), activeCheckIssueCount: 0, pendingLinkedCardCount: 0, priorDeferrals: 2 },
      NOW,
    );
    expect(decision).toEqual({ kind: "stalled", reason: "budget_exhausted" });
    expect(
      reviewWaitRecheckMs({ kind: "waiting", reason: "reviewer_comment" }),
    ).toBe(REVIEW_WAIT_RECHECK_MS);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("readReviewWaitEvidence (GRE-97)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-wait-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "GS Agentic Manager",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Keystone",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "GRE-80",
      status: "in_review",
      priority: "medium",
    });
    return { companyId, reviewerAgentId, issueId };
  }

  async function addIssue(companyId: string, status: string, parentId: string | null = null) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "check", status, priority: "medium", parentId });
    return id;
  }

  async function addCard(
    companyId: string,
    issueId: string,
    status = "pending",
    addresseeAgentId: string | null = null,
  ) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId,
      issueId,
      kind: "request_confirmation",
      status,
      addresseeAgentId,
      payload: { version: 1, prompt: "OK to merge?" } as never,
    });
    return id;
  }

  async function spendCommentBudget(companyId: string, issueId: string, reviewerAgentId: string) {
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: reviewerAgentId,
      body: "No change to the hold. John's OK is not given yet; the card on GRE-264 is pending.",
      createdAt: minutesAgo(1),
    });
    await db.insert(activityLog).values(
      Array.from({ length: REVIEW_WAIT_COMMENT_ONLY_MAX_DEFERRALS }, () => ({
        companyId,
        actorType: "system",
        actorId: "recovery",
        action: "issue.monitor_scheduled",
        entityType: "issue",
        entityId: issueId,
        details: { source: REVIEW_WAIT_ACTIVITY_SOURCE },
        createdAt: minutesAgo(10),
      })),
    );
  }

  // GRE-290, 2026-09-29 23:42: GRE-262 (in_review, Keystone) waited only on
  // John's approval card on its sibling GRE-264. The comment-only budget ran
  // out and the watchdog blocked GRE-262 "for the board".
  it("GRE-262/GRE-264: a pending card on a sibling keeps the review waiting past the comment budget", async () => {
    const { companyId, reviewerAgentId, issueId } = await seed();
    const parentId = await addIssue(companyId, "in_progress");
    await db.update(issues).set({ parentId }).where(eq(issues.id, issueId));
    const siblingId = await addIssue(companyId, "in_review", parentId); // GRE-264
    await spendCommentBudget(companyId, issueId, reviewerAgentId);

    // Before the card: the normal rule blocks (the 23:42 behaviour).
    expect(await isReviewerWaitingOnCheck(db, { companyId, issueId, reviewerAgentId, now: NOW })).toBe(false);

    const cardId = await addCard(companyId, siblingId);
    const evidence = await readReviewWaitEvidence(db, { companyId, issueId, reviewerAgentId, now: NOW });
    expect(evidence.pendingLinkedCardCount).toBe(1);
    expect(await isReviewerWaitingOnCheck(db, { companyId, issueId, reviewerAgentId, now: NOW })).toBe(true);

    // John answers the card: the normal rules apply again.
    await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, cardId));
    expect(await isReviewerWaitingOnCheck(db, { companyId, issueId, reviewerAgentId, now: NOW })).toBe(false);
  });

  it("counts a pending card on the parent, a child, a blocker or the issue itself", async () => {
    const { companyId, reviewerAgentId, issueId } = await seed();
    const parentId = await addIssue(companyId, "in_progress");
    await db.update(issues).set({ parentId }).where(eq(issues.id, issueId));
    const childId = await addIssue(companyId, "done", issueId);
    const blockerId = await addIssue(companyId, "todo");
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });

    for (const linkedId of [parentId, childId, blockerId, issueId]) {
      const cardId = await addCard(companyId, linkedId);
      const evidence = await readReviewWaitEvidence(db, { companyId, issueId, reviewerAgentId, now: NOW });
      expect(evidence.pendingLinkedCardCount).toBe(1);
      await db.update(issueThreadInteractions).set({ status: "expired" }).where(eq(issueThreadInteractions.id, cardId));
    }
    const evidence = await readReviewWaitEvidence(db, { companyId, issueId, reviewerAgentId, now: NOW });
    expect(evidence.pendingLinkedCardCount).toBe(0);
  });

  it("ignores cards on unlinked issues and cards addressed to an agent", async () => {
    const { companyId, reviewerAgentId, issueId } = await seed();
    const unrelatedId = await addIssue(companyId, "in_review");
    await addCard(companyId, unrelatedId);
    await addCard(companyId, issueId, "pending", reviewerAgentId);

    const evidence = await readReviewWaitEvidence(db, { companyId, issueId, reviewerAgentId, now: NOW });
    expect(evidence.pendingLinkedCardCount).toBe(0);
  });

  // GRE-80, 2026-09-28 07:57: Keystone commented that it waits on CI and on
  // Flint's check GRE-88 (a child issue, in progress).
  it("GRE-80: reviewer comment 'waiting on CI' plus an in-progress child check issue is waiting", async () => {
    const { companyId, reviewerAgentId, issueId } = await seed();
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: reviewerAgentId,
      body: "Waiting on CI and on Flint's check (GRE-88).",
      createdAt: minutesAgo(1),
    });
    await addIssue(companyId, "in_progress", issueId);

    const evidence = await readReviewWaitEvidence(db, { companyId, issueId, reviewerAgentId, now: NOW });
    expect(evidence).toMatchObject({ activeCheckIssueCount: 1, priorDeferrals: 0 });
    expect(evidence.latestReviewerCommentAt?.toISOString()).toBe(minutesAgo(1).toISOString());
    expect(await isReviewerWaitingOnCheck(db, { companyId, issueId, reviewerAgentId, now: NOW })).toBe(true);
  });

  it("counts an in-progress issue that blocks the reviewed issue as a check", async () => {
    const { companyId, reviewerAgentId, issueId } = await seed();
    const blockerId = await addIssue(companyId, "in_progress");
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });

    expect(await isReviewerWaitingOnCheck(db, { companyId, issueId, reviewerAgentId, now: NOW })).toBe(true);
  });

  it("real stall: no reviewer comment, no active check, a done child and an old comment", async () => {
    const { companyId, reviewerAgentId, issueId } = await seed();
    await addIssue(companyId, "done", issueId);
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: reviewerAgentId,
      body: "Looking.",
      createdAt: minutesAgo(120),
    });

    expect(await isReviewerWaitingOnCheck(db, { companyId, issueId, reviewerAgentId, now: NOW })).toBe(false);
  });

  // GRE-204: the heartbeat posts each finished run's summary as a comment by
  // the reviewer. That is the run's output, not the reviewer saying it waits.
  it("does not count the run summary the heartbeat posted as reviewer activity", async () => {
    const { companyId, reviewerAgentId, issueId } = await seed();
    const runId = randomUUID();
    const summaryCommentId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "succeeded",
      resultJson: {
        presentationDecision: {
          commentAction: "create",
          commentId: summaryCommentId,
          reasonCodes: ["resolved_response_materialized"],
        },
      },
    });
    await db.insert(issueComments).values({
      id: summaryCommentId,
      companyId,
      issueId,
      authorAgentId: reviewerAgentId,
      createdByRunId: runId,
      body: "Reviewed the diff.",
      createdAt: minutesAgo(1),
    });

    const evidence = await readReviewWaitEvidence(db, { companyId, issueId, reviewerAgentId, now: NOW });
    expect(evidence.latestReviewerCommentAt).toBeNull();
    expect(await isReviewerWaitingOnCheck(db, { companyId, issueId, reviewerAgentId, now: NOW })).toBe(false);

    // A comment the reviewer posted itself in the same run still counts.
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: reviewerAgentId,
      createdByRunId: runId,
      body: "Waiting on CI.",
      createdAt: minutesAgo(2),
    });
    expect(await isReviewerWaitingOnCheck(db, { companyId, issueId, reviewerAgentId, now: NOW })).toBe(true);
  });

  it("stops waiting once the deferral budget is spent", async () => {
    const { companyId, reviewerAgentId, issueId } = await seed();
    await addIssue(companyId, "in_progress", issueId);
    await db.insert(activityLog).values(
      Array.from({ length: REVIEW_WAIT_MAX_DEFERRALS }, () => ({
        companyId,
        actorType: "system",
        actorId: "recovery",
        action: "issue.monitor_scheduled",
        entityType: "issue",
        entityId: issueId,
        details: { source: REVIEW_WAIT_ACTIVITY_SOURCE },
        createdAt: minutesAgo(10),
      })),
    );

    expect(await isReviewerWaitingOnCheck(db, { companyId, issueId, reviewerAgentId, now: NOW })).toBe(false);
  });

  // GRE-218: a reviewer comment with no check issue gets 2 deferrals, not 8.
  it("stops a comment-only wait after 2 deferrals", async () => {
    const { companyId, reviewerAgentId, issueId } = await seed();
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: reviewerAgentId,
      body: "Waiting on CI.",
      createdAt: minutesAgo(1),
    });
    const deferral = () => ({
      companyId,
      actorType: "system",
      actorId: "recovery",
      action: "issue.monitor_scheduled",
      entityType: "issue",
      entityId: issueId,
      details: { source: REVIEW_WAIT_ACTIVITY_SOURCE },
      createdAt: minutesAgo(10),
    });

    await db.insert(activityLog).values([deferral()]);
    expect(await isReviewerWaitingOnCheck(db, { companyId, issueId, reviewerAgentId, now: NOW })).toBe(true);

    await db.insert(activityLog).values([deferral()]);
    expect(await isReviewerWaitingOnCheck(db, { companyId, issueId, reviewerAgentId, now: NOW })).toBe(false);
  });
});
