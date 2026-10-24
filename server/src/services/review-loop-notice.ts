import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents } from "@greatstone/db";
import {
  buildAgentMentionHref,
  buildUserMentionHref,
  type IssueExecutionStagePrincipal,
} from "@greatstone/shared";
import { LEGACY_BOARD_USER_ID } from "./board-identity.js";
import type { ReviewLoopNotice } from "./issue-execution-policy.js";
import { principalName } from "./review-override.js";

/**
 * Who hears that an author and an agent reviewer are looping (GRE-2164).
 * Work a person created, or a person is writing, goes to that person. Agent
 * work goes to the agent the author reports to, not to the board; only an
 * author with no live manager falls back to the responsible person.
 */
export type ReviewLoopNoticeRecipient =
  | { type: "agent"; agentId: string }
  | { type: "user"; userId: string };

type NoticeIssue = {
  companyId: string;
  createdByUserId?: string | null;
  responsibleUserId?: string | null;
};

function realUserId(userId: string | null | undefined) {
  const trimmed = userId?.trim();
  return trimmed && trimmed !== LEGACY_BOARD_USER_ID ? trimmed : null;
}

export async function resolveReviewLoopNoticeRecipient(
  db: Pick<Db, "select">,
  issue: NoticeIssue,
  author: IssueExecutionStagePrincipal,
): Promise<ReviewLoopNoticeRecipient | null> {
  const person = (): ReviewLoopNoticeRecipient | null => {
    const userId =
      realUserId(issue.responsibleUserId) ??
      realUserId(issue.createdByUserId) ??
      (author.type === "user" ? realUserId(author.userId) : null);
    return userId ? { type: "user", userId } : null;
  };
  if (issue.createdByUserId || author.type === "user" || !author.agentId) return person();

  const [authorRow] = await db
    .select({ reportsTo: agents.reportsTo })
    .from(agents)
    .where(and(eq(agents.id, author.agentId), eq(agents.companyId, issue.companyId)))
    .limit(1);
  const managerId = authorRow?.reportsTo ?? null;
  if (managerId && managerId !== author.agentId) {
    const [manager] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(
        eq(agents.id, managerId),
        eq(agents.companyId, issue.companyId),
        ne(agents.status, "terminated"),
      ))
      .limit(1);
    if (manager) return { type: "agent", agentId: manager.id };
  }
  return person();
}

export function reviewLoopNoticeText(input: {
  rounds: number;
  reviewerName: string;
  authorName: string;
  recipientMention: string;
}) {
  return [
    `${input.recipientMention}: ${input.reviewerName} has asked ${input.authorName} for changes ${input.rounds} times in a row on this review.`,
    `The review stays with ${input.reviewerName} and nothing waits on you. Check whether they are stuck, and step in if they are.`,
  ].join(" ");
}

/** The notice comment and who it is for, or null when nobody can take it. */
export async function prepareReviewLoopNotice(
  db: Pick<Db, "select">,
  issue: NoticeIssue,
  notice: ReviewLoopNotice,
): Promise<{ recipient: ReviewLoopNoticeRecipient; body: string } | null> {
  const recipient = await resolveReviewLoopNoticeRecipient(db, issue, notice.author);
  if (!recipient) return null;
  const recipientPrincipal: IssueExecutionStagePrincipal = recipient.type === "agent"
    ? { type: "agent", agentId: recipient.agentId, userId: null }
    : { type: "user", agentId: null, userId: recipient.userId };
  const [reviewerName, authorName, recipientName] = await Promise.all([
    principalName(db, notice.reviewer),
    principalName(db, notice.author),
    principalName(db, recipientPrincipal),
  ]);
  const href = recipient.type === "agent"
    ? buildAgentMentionHref(recipient.agentId)
    : buildUserMentionHref(recipient.userId);
  return {
    recipient,
    body: reviewLoopNoticeText({
      rounds: notice.rounds,
      reviewerName,
      authorName,
      recipientMention: `[${recipientName}](${href})`,
    }),
  };
}
