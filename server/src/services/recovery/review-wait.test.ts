import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  REVIEW_WAIT_ACTIVITY_SOURCE,
  REVIEW_WAIT_ACTIVITY_WINDOW_MS,
  REVIEW_WAIT_MAX_DEFERRALS,
  decideReviewWait,
  isReviewerWaitingOnCheck,
  readReviewWaitEvidence,
} from "./review-wait.js";

const NOW = new Date("2026-09-28T07:57:19Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60 * 1000);

describe("decideReviewWait (GRE-97)", () => {
  it("waits when the reviewer commented within N = 30 minutes", () => {
    expect(
      decideReviewWait({ latestReviewerCommentAt: minutesAgo(2), activeCheckIssueCount: 0, priorDeferrals: 0 }, NOW),
    ).toEqual({ kind: "waiting", reason: "reviewer_comment" });
  });

  it("waits when a check issue is being worked, even with an old comment", () => {
    expect(
      decideReviewWait({ latestReviewerCommentAt: minutesAgo(600), activeCheckIssueCount: 1, priorDeferrals: 0 }, NOW),
    ).toEqual({ kind: "waiting", reason: "active_check_issue" });
  });

  it("is a stall with no recent comment and no check", () => {
    expect(
      decideReviewWait(
        {
          latestReviewerCommentAt: new Date(NOW.getTime() - REVIEW_WAIT_ACTIVITY_WINDOW_MS - 1),
          activeCheckIssueCount: 0,
          priorDeferrals: 0,
        },
        NOW,
      ),
    ).toEqual({ kind: "stalled", reason: "no_activity" });
  });

  it("is a stall once the deferral budget is spent", () => {
    expect(
      decideReviewWait(
        { latestReviewerCommentAt: minutesAgo(1), activeCheckIssueCount: 1, priorDeferrals: REVIEW_WAIT_MAX_DEFERRALS },
        NOW,
      ),
    ).toEqual({ kind: "stalled", reason: "budget_exhausted" });
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
    await db.delete(activityLog);
    await db.delete(issueComments);
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
});
