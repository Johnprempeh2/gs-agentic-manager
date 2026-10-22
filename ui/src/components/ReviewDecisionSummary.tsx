import { CircleAlert, ExternalLink, GitPullRequest, Link2, MessagesSquare } from "lucide-react";
import type { Agent, AttentionItem, AttentionItemDetail } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
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
 * work product to check, and a button to the full thread. With no summary a
 * warning sits above the decision so Approve is not the easy default. Shared by the
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
          <figcaption className="text-xs text-muted-foreground" data-update-kind={lastUpdate.kind}>
            {/* A hand-off says what was done; otherwise it is only the newest note. */}
            {lastUpdate.kind === "handoff" ? "Summary" : "Latest agent update"}
            {author ? ` from ${author}` : ""} · {relativeTime(lastUpdate.createdAt)}
          </figcaption>
          <blockquote className="line-clamp-4 text-sm text-foreground">{lastUpdate.excerpt}</blockquote>
        </figure>
      ) : (
        // No summary: warn before Approve, so the evidence is checked first (GRE-1919).
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning-soft px-3 py-2 text-sm text-foreground"
          data-testid="review-no-update"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warning-foreground" aria-hidden="true" />
          <span>No summary from the agent. Check the work before you approve.</span>
        </p>
      )}
      {workProduct || threadHref ? (
        <div className="flex flex-wrap items-center gap-2">
          {threadHref && (
            <Button asChild variant="outline" size="sm">
              <Link
                to={threadHref}
                disableIssueQuicklook
                onClick={(e) => e.stopPropagation()}
                data-testid="review-thread-link"
              >
                <MessagesSquare aria-hidden />
                Read the thread
              </Link>
            </Button>
          )}
          {workProduct && (
            <Button asChild variant="outline" size="sm" className="min-w-0 max-w-full">
              <a href={workProduct.url} target="_blank" rel="noreferrer" data-testid="review-work-product">
                {workProduct.type === "pull_request" ? <GitPullRequest aria-hidden /> : <Link2 aria-hidden />}
                <span className="min-w-0 truncate">
                  {workProduct.type === "pull_request" ? "Pull request" : "Result"}: {workProduct.title}
                </span>
                <ExternalLink className="size-3" aria-hidden />
              </a>
            </Button>
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
