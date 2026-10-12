import { ExternalLink, GitPullRequest, Link2 } from "lucide-react";
import type { Agent, AttentionItem, AttentionItemDetail } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { relativeTime } from "../lib/utils";

type ReviewDetail = Extract<AttentionItemDetail, { kind: "review" }>;

/** The review context the feed attached to a row, if it is a review row. */
export function reviewDetailOf(item: AttentionItem): ReviewDetail | null {
  const detail = item.detail as AttentionItemDetail | null;
  return detail?.kind === "review" ? detail : null;
}

/**
 * Who the review card names as the person who did the work. Null when the
 * assignee is unknown or not an agent, so the copy can fall back to a neutral phrase.
 */
export function reviewAssigneeName(item: AttentionItem, agentMap?: Map<string, Agent>): string | null {
  const agentId = item.subject.metadata?.assigneeAgentId;
  if (typeof agentId === "string") return agentMap?.get(agentId)?.name ?? null;
  return null;
}

const SECTION_LABEL = "text-xs font-medium text-muted-foreground";

/**
 * What the agent handed over for review (GRE-1421): its newest comment, the
 * work product to check, and a link to the full thread. Shared by the
 * /decisions card and the attention row.
 */
export function ReviewWorkEvidence({
  item,
  agentMap,
  knownAgent,
}: {
  item: AttentionItem;
  agentMap?: Map<string, Agent>;
  /** An agent the surface already names (the card's waiting agent), for when agentMap has not loaded. */
  knownAgent?: { id: string; name: string } | null;
}) {
  const detail = reviewDetailOf(item);
  const lastUpdate = detail?.lastUpdate ?? null;
  const workProduct = detail?.workProduct ?? null;
  const authorId = lastUpdate?.authorAgentId ?? null;
  const author = authorId
    ? agentMap?.get(authorId)?.name ?? (knownAgent?.id === authorId ? knownAgent.name : null)
    : null;
  const href = item.subject.href;
  const threadHref = href ? (lastUpdate ? `${href}#comment-${lastUpdate.commentId}` : href) : null;

  return (
    <section className="flex flex-col gap-1.5" aria-label="What was done" data-testid="review-work-evidence">
      <h4 className={SECTION_LABEL}>What was done</h4>
      {lastUpdate ? (
        <figure className="flex flex-col gap-1 border-l-2 border-border pl-3" data-testid="review-last-update">
          <figcaption className="text-xs text-muted-foreground">
            Last update{author ? ` from ${author}` : ""} · {relativeTime(lastUpdate.createdAt)}
          </figcaption>
          <blockquote className="line-clamp-4 text-sm text-foreground">{lastUpdate.excerpt}</blockquote>
        </figure>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="review-no-update">
          The agent did not write a summary. Read the thread to see the work.
        </p>
      )}
      {workProduct || threadHref ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {workProduct && (
            <a
              href={workProduct.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 max-w-full items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline"
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
      ) : null}
    </section>
  );
}

/**
 * The context a stalled review row needs so it can be decided in place
 * (GRE-1421): what was done and what the operator must decide. The choices
 * themselves live in StalledReviewActions.
 */
export function ReviewDecisionSummary({
  item,
  agentMap,
}: {
  item: AttentionItem;
  agentMap?: Map<string, Agent>;
}) {
  const assignee = reviewAssigneeName(item, agentMap);
  return (
    <div className="flex flex-col gap-3" data-testid="review-decision-summary">
      <ReviewWorkEvidence item={item} agentMap={agentMap} />
      <section className="flex flex-col gap-1">
        <h4 className={SECTION_LABEL}>What you must decide</h4>
        <p className="text-sm text-foreground" data-testid="review-ask">
          {assignee ? `${assignee} says the work is finished.` : "The assignee says the work is finished."} No reviewer
          is set, so the task waits for you. Check the result, then approve it or say what to change.
        </p>
      </section>
    </div>
  );
}
