import { and, count, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { activityLog, issueComments, issueRelations, issues } from "@greatstone/db";

// A reviewer that is waiting on CI or on another agent's check is not a
// stalled review (GRE-97). On GRE-80 the reviewer commented "waiting on CI and
// Flint's check (GRE-88)" and the release path still moved the issue to
// `blocked`. These rules decide when a review stage is waiting rather than
// stalled, and bound how long the watchdog keeps waking the reviewer.

/** N: a reviewer comment on the issue within this window counts as activity. */
export const REVIEW_WAIT_ACTIVITY_WINDOW_MS = 30 * 60 * 1000;
/** How long the watchdog waits before it wakes the reviewer again. */
export const REVIEW_WAIT_RECHECK_MS = 30 * 60 * 1000;
/** Retry budget: at most this many deferrals per issue in the budget window, then block as before. */
export const REVIEW_WAIT_MAX_DEFERRALS = 8;
export const REVIEW_WAIT_BUDGET_WINDOW_MS = 12 * 60 * 60 * 1000;

export const REVIEW_WAIT_MONITOR_SERVICE_NAME = "Review wait";
/** `details.source` of the `issue.monitor_scheduled` activity a deferral writes; the budget counts these. */
export const REVIEW_WAIT_ACTIVITY_SOURCE = "recovery.review_wait";

/** Issue statuses that mean a child or blocker check is being worked. */
const ACTIVE_CHECK_STATUSES = ["in_progress", "in_review"] as const;

export type ReviewWaitEvidence = {
  latestReviewerCommentAt: Date | null;
  activeCheckIssueCount: number;
  priorDeferrals: number;
};

export type ReviewWaitDecision =
  | { kind: "waiting"; reason: "reviewer_comment" | "active_check_issue" }
  | { kind: "stalled"; reason: "no_activity" | "budget_exhausted" };

/**
 * Decides whether a review stage whose retry ended without a decision is
 * waiting (wake the reviewer later) or stalled (block). A run alone is not
 * activity: the run that just ended always "ran recently". The reviewer's
 * own comment, or a check issue being worked, is.
 */
export function decideReviewWait(evidence: ReviewWaitEvidence, now: Date): ReviewWaitDecision {
  const commentedRecently =
    evidence.latestReviewerCommentAt !== null &&
    now.getTime() - evidence.latestReviewerCommentAt.getTime() <= REVIEW_WAIT_ACTIVITY_WINDOW_MS;
  const hasActiveCheck = evidence.activeCheckIssueCount > 0;
  if (!commentedRecently && !hasActiveCheck) return { kind: "stalled", reason: "no_activity" };
  if (evidence.priorDeferrals >= REVIEW_WAIT_MAX_DEFERRALS) return { kind: "stalled", reason: "budget_exhausted" };
  return { kind: "waiting", reason: hasActiveCheck ? "active_check_issue" : "reviewer_comment" };
}

export async function readReviewWaitEvidence(
  db: Db,
  input: { companyId: string; issueId: string; reviewerAgentId: string; now: Date },
): Promise<ReviewWaitEvidence> {
  const latestComment = await db
    .select({ createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorAgentId, input.reviewerAgentId),
        isNull(issueComments.deletedAt),
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // A child issue (GRE-88 under GRE-80) or an issue that blocks this one,
  // being worked right now.
  const blockerIds = db
    .select({ id: issueRelations.issueId })
    .from(issueRelations)
    .where(
      and(
        eq(issueRelations.companyId, input.companyId),
        eq(issueRelations.relatedIssueId, input.issueId),
        eq(issueRelations.type, "blocks"),
      ),
    );
  const activeChecks = await db
    .select({ value: count() })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        inArray(issues.status, [...ACTIVE_CHECK_STATUSES]),
        isNull(issues.hiddenAt),
        or(eq(issues.parentId, input.issueId), inArray(issues.id, blockerIds)),
      ),
    )
    .then((rows) => Number(rows[0]?.value ?? 0));

  const priorDeferrals = await db
    .select({ value: count() })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        eq(activityLog.action, "issue.monitor_scheduled"),
        sql`${activityLog.details} ->> 'source' = ${REVIEW_WAIT_ACTIVITY_SOURCE}`,
        gte(activityLog.createdAt, new Date(input.now.getTime() - REVIEW_WAIT_BUDGET_WINDOW_MS)),
      ),
    )
    .then((rows) => Number(rows[0]?.value ?? 0));

  return {
    latestReviewerCommentAt: latestComment?.createdAt ?? null,
    activeCheckIssueCount: activeChecks,
    priorDeferrals,
  };
}

export async function isReviewerWaitingOnCheck(
  db: Db,
  input: { companyId: string; issueId: string; reviewerAgentId: string; now: Date },
): Promise<boolean> {
  return decideReviewWait(await readReviewWaitEvidence(db, input), input.now).kind === "waiting";
}
