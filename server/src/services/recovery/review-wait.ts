import { and, count, desc, eq, gte, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { activityLog, heartbeatRuns, issueComments, issueRelations, issues, issueThreadInteractions } from "@greatstone/db";

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
/**
 * Budget when the only evidence is a reviewer comment (GRE-218). Agents comment
 * on every run, so a comment alone is weak evidence; a real CI wait ends within
 * about an hour. A wait on a check issue keeps REVIEW_WAIT_MAX_DEFERRALS.
 */
export const REVIEW_WAIT_COMMENT_ONLY_MAX_DEFERRALS = 2;
export const REVIEW_WAIT_BUDGET_WINDOW_MS = 12 * 60 * 60 * 1000;
/**
 * Recheck interval while a board card on a linked issue is pending (GRE-290).
 * The board owns that wait and answering the card is its wake path, so the
 * reviewer is only checked on now and then, not every 30 minutes.
 */
export const REVIEW_WAIT_PENDING_CARD_RECHECK_MS = 2 * 60 * 60 * 1000;

export const REVIEW_WAIT_MONITOR_SERVICE_NAME = "Review wait";
/** `details.source` of the `issue.monitor_scheduled` activity a deferral writes; the budget counts these. */
export const REVIEW_WAIT_ACTIVITY_SOURCE = "recovery.review_wait";

/** Issue statuses that mean a child or blocker check is being worked. */
const ACTIVE_CHECK_STATUSES = ["in_progress", "in_review"] as const;

export type ReviewWaitEvidence = {
  latestReviewerCommentAt: Date | null;
  activeCheckIssueCount: number;
  /** Pending board cards on this issue or a linked one (parent, sibling, child, blocker). */
  pendingLinkedCardCount: number;
  priorDeferrals: number;
};

export type ReviewWaitDecision =
  | { kind: "waiting"; reason: "reviewer_comment" | "active_check_issue" | "pending_linked_card" }
  | { kind: "stalled"; reason: "no_activity" | "budget_exhausted" };

/**
 * Decides whether a review stage whose retry ended without a decision is
 * waiting (wake the reviewer later) or stalled (block). A run alone is not
 * activity: the run that just ended always "ran recently". The reviewer's
 * own comment, or a check issue being worked, is.
 */
export function decideReviewWait(evidence: ReviewWaitEvidence, now: Date): ReviewWaitDecision {
  // GRE-290: GRE-262 and GRE-263 waited only on John's card on sibling
  // GRE-264, and were blocked "for the board" when the comment budget ran out.
  // A pending board card has an owner (the board) and a wake path (the
  // answer), so it is a live wait with no deferral budget. Once the card is
  // answered or expires the count drops and the rules below apply again.
  if (evidence.pendingLinkedCardCount > 0) return { kind: "waiting", reason: "pending_linked_card" };
  const commentedRecently =
    evidence.latestReviewerCommentAt !== null &&
    now.getTime() - evidence.latestReviewerCommentAt.getTime() <= REVIEW_WAIT_ACTIVITY_WINDOW_MS;
  const hasActiveCheck = evidence.activeCheckIssueCount > 0;
  if (!commentedRecently && !hasActiveCheck) return { kind: "stalled", reason: "no_activity" };
  const maxDeferrals = hasActiveCheck ? REVIEW_WAIT_MAX_DEFERRALS : REVIEW_WAIT_COMMENT_ONLY_MAX_DEFERRALS;
  if (evidence.priorDeferrals >= maxDeferrals) return { kind: "stalled", reason: "budget_exhausted" };
  return { kind: "waiting", reason: hasActiveCheck ? "active_check_issue" : "reviewer_comment" };
}

export async function readReviewWaitEvidence(
  db: Db,
  input: { companyId: string; issueId: string; reviewerAgentId: string; now: Date },
): Promise<ReviewWaitEvidence> {
  // The run summary the heartbeat posts for a finished run is authored as the
  // reviewer, but it is the run's own output, not the reviewer saying it waits
  // (GRE-204). Counting it made every review retry that ended without a
  // decision look like a wait, so the retry never blocked. The run's
  // `presentationDecision` names the comment the heartbeat materialized.
  const latestComment = await db
    .select({ createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorAgentId, input.reviewerAgentId),
        isNull(issueComments.deletedAt),
        notExists(
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.id, issueComments.createdByRunId),
                sql`${heartbeatRuns.resultJson} -> 'presentationDecision' ->> 'commentId' = ${issueComments.id}::text`,
                sql`${heartbeatRuns.resultJson} -> 'presentationDecision' -> 'reasonCodes' @> '["resolved_response_materialized"]'::jsonb`,
              ),
            ),
        ),
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

  // A pending card addressed to the board or a user (not to an agent) on this
  // issue, its parent, a sibling, a child, or a blocker (GRE-290).
  const parentId = db
    .select({ id: issues.parentId })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  const linkedIssueIds = db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        isNull(issues.hiddenAt),
        or(
          eq(issues.id, input.issueId),
          inArray(issues.id, parentId),
          inArray(issues.parentId, parentId),
          eq(issues.parentId, input.issueId),
          inArray(issues.id, blockerIds),
        ),
      ),
    );
  const pendingLinkedCards = await db
    .select({ value: count() })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.status, "pending"),
        isNull(issueThreadInteractions.addresseeAgentId),
        inArray(issueThreadInteractions.issueId, linkedIssueIds),
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
    pendingLinkedCardCount: pendingLinkedCards,
    priorDeferrals,
  };
}

/** How long to wait before the reviewer is woken again for this decision. */
export function reviewWaitRecheckMs(decision: ReviewWaitDecision): number {
  return decision.kind === "waiting" && decision.reason === "pending_linked_card"
    ? REVIEW_WAIT_PENDING_CARD_RECHECK_MS
    : REVIEW_WAIT_RECHECK_MS;
}

export async function isReviewerWaitingOnCheck(
  db: Db,
  input: { companyId: string; issueId: string; reviewerAgentId: string; now: Date },
): Promise<boolean> {
  return decideReviewWait(await readReviewWaitEvidence(db, input), input.now).kind === "waiting";
}
