import { ExternalLink, GitPullRequest, Link2 } from "lucide-react";
import type { Agent, AttentionItem, AttentionItemDetail } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { relativeTime } from "../lib/utils";

type ReviewDetail = Extract<AttentionItemDetail, { kind: "review" }>;

function reviewDetail(item: AttentionItem): ReviewDetail | null {
  const detail = item.detail as AttentionItemDetail | null;
  return detail?.kind === "review" ? detail : null;
}

/**
 * Who the review card names as the person who did the work. Falls back to a
 * neutral phrase so a card with an unknown or human assignee still reads.
 */
export function reviewAssigneeName(item: AttentionItem, agentMap?: Map<string, Agent>): string | null {
  const agentId = item.subject.metadata?.assigneeAgentId;
  if (typeof agentId === "string") return agentMap?.get(agentId)?.name ?? null;
  return null;
}

const SECTION_LABEL = "text-xs font-medium text-muted-foreground";

/**
 * The context a stalled review card needs so it can be decided in place
 * (GRE-1421): what was done (assignee, last update, work product) and what the
 * operator must decide. The choices themselves live in StalledReviewActions.
 */
export function ReviewDecisionSummary({
  item,
  agentMap,
}: {
  item: AttentionItem;
  agentMap?: Map<string, Agent>;
}) {
  const detail = reviewDetail(item);
  const assignee = reviewAssigneeName(item, agentMap);
  const lastUpdate = detail?.lastUpdate ?? null;
  const workProduct = detail?.workProduct ?? null;
  const author = lastUpdate?.authorAgentId ? agentMap?.get(lastUpdate.authorAgentId)?.name ?? null : null;
  const threadHref = item.subject.href
    ? lastUpdate
      ? `${item.subject.href}#comment-${lastUpdate.commentId}`
      : item.subject.href
    : null;

  return (
    <div className="flex flex-col gap-3" data-testid="review-decision-summary">
      <section className="flex flex-col gap-1.5">
        <h4 className={SECTION_LABEL}>What was done</h4>
        <p className="text-sm text-foreground">
          {assignee ? `${assignee} worked on this task and sent it for review.` : "This task was sent for review."}
        </p>
        {lastUpdate ? (
          <figure className="flex flex-col gap-1 border-l-2 border-border pl-3" data-testid="review-last-update">
            <figcaption className="text-xs text-muted-foreground">
              Last update{author ? ` from ${author}` : ""} · {relativeTime(lastUpdate.createdAt)}
            </figcaption>
            <blockquote className="line-clamp-4 text-sm text-foreground">{lastUpdate.excerpt}</blockquote>
          </figure>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="review-no-update">
            The agent did not write a summary.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {workProduct && (
            <a
              href={workProduct.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline"
              data-testid="review-work-product"
            >
              {workProduct.type === "pull_request" ? (
                <GitPullRequest className="h-3.5 w-3.5 shrink-0" aria-hidden />
              ) : (
                <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 truncate">
                {workProduct.type === "pull_request" ? "Pull request" : "Result"}: {workProduct.title}
              </span>
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
            </a>
          )}
          {threadHref && (
            <Link
              to={threadHref}
              disableIssueQuicklook
              className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              Read the full thread
            </Link>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-1">
        <h4 className={SECTION_LABEL}>What you must decide</h4>
        <p className="text-sm text-foreground" data-testid="review-ask">
          {assignee ? `${assignee} says this work is finished.` : "The assignee says this work is finished."} No
          reviewer is set, so the task waits for you. Check the result, then approve it or say what to change.
        </p>
      </section>
    </div>
  );
}
