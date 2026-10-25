import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Eye, MessageSquarePlus } from "lucide-react";
import type { WebsitePage, WebsitePageComment, WebsiteRevision } from "@greatstone/shared";
import { issuesApi } from "../../api/issues";
import { websiteModuleApi } from "../../api/website";
import { queryKeys } from "../../lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, issueUrl, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "../EmptyState";
import { ErrorState, errorStateMessage } from "../ErrorState";
import { MarkdownBody } from "../MarkdownBody";

// Comments for the agents (GRE-2350). Each open comment is a change request
// task on the page (click to change or Ask an agent), numbered oldest first.
// The thread is the task's own comments; resolve closes the task. There is no
// second comment store: the task and comment APIs are the record.

/** Comments refresh while the drawer is open, so the agent's replies show up. */
const REFRESH_MS = 20_000;

const WIDTH_NAMES: Record<string, string> = { laptop: "Laptop", tablet: "Tablet", phone: "Phone" };

/** Where the comment points: the block's name, or the whole page. */
export function websiteCommentTarget(comment: Pick<WebsitePageComment, "blockId" | "blockLabel" | "blockType">) {
  if (!comment.blockId) return "Whole page";
  return comment.blockLabel || comment.blockType || "A block";
}

/** The page's draft saves an agent made after the comment: the change it came back with. */
export function websiteCommentChanges(comment: Pick<WebsitePageComment, "createdAt">, revisions: readonly WebsiteRevision[]) {
  const since = Date.parse(comment.createdAt);
  return revisions.filter((revision) => revision.createdByAgentId && Date.parse(revision.createdAt) > since);
}

/** The small numbered pin a comment shows as. */
export function CommentPin({ number, className }: { number: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full rounded-bl-none bg-primary text-[11px] font-semibold text-primary-foreground",
        className,
      )}
    >
      {number}
    </span>
  );
}

export function useWebsitePageComments(companyId: string, siteId: string, pageId: string | null, refresh = false) {
  return useQuery({
    queryKey: queryKeys.website.pageComments(companyId, siteId, pageId ?? ""),
    queryFn: () => websiteModuleApi.pageComments(companyId, siteId, pageId!),
    enabled: Boolean(pageId),
    refetchInterval: refresh ? REFRESH_MS : false,
  });
}

export function WebsiteCommentsPanel({
  companyId,
  siteId,
  page,
  onAsk,
  onPreviewChange,
}: {
  companyId: string;
  siteId: string;
  page: WebsitePage;
  /** Opens Ask an agent for the selected block, or the whole page. */
  onAsk: () => void;
  /** Shows the page's latest draft in the editor's preview. */
  onPreviewChange: () => void;
}) {
  const comments = useWebsitePageComments(companyId, siteId, page.id, true);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = comments.data?.find((comment) => comment.issueId === openId) ?? null;

  if (open) {
    return (
      <CommentThread
        companyId={companyId}
        siteId={siteId}
        page={page}
        comment={open}
        onBack={() => setOpenId(null)}
        onPreviewChange={onPreviewChange}
      />
    );
  }

  return (
    <section className="min-w-0 space-y-3" aria-label="Open comments" data-testid="website-comments">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Open comments on {page.title}. The website agent answers each one.</p>
        <Button type="button" size="xs" variant="outline" onClick={onAsk}>
          <MessageSquarePlus />
          Ask an agent
        </Button>
      </div>
      {comments.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading comments</p>
      ) : comments.error ? (
        <ErrorState error={comments.error} onRetry={() => void comments.refetch()} />
      ) : !comments.data?.length ? (
        <EmptyState
          icon={MessageSquarePlus}
          title="No open comments"
          message="Select a block, or nothing for the whole page, and use Ask an agent to ask for a change."
        />
      ) : (
        <ol className="space-y-2">
          {comments.data.map((comment) => (
            <li key={comment.issueId}>
              <button
                type="button"
                onClick={() => setOpenId(comment.issueId)}
                className="flex w-full min-w-0 items-start gap-2 rounded-md border border-border p-2.5 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="website-comment-item"
              >
                <CommentPin number={comment.number} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 break-words text-sm">{comment.request}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {websiteCommentTarget(comment)} · {comment.identifier ?? "Task"} · {relativeTime(comment.createdAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CommentThread({
  companyId,
  siteId,
  page,
  comment,
  onBack,
  onPreviewChange,
}: {
  companyId: string;
  siteId: string;
  page: WebsitePage;
  comment: WebsitePageComment;
  onBack: () => void;
  onPreviewChange: () => void;
}) {
  const queryClient = useQueryClient();
  const [reply, setReply] = useState("");
  // Its own key under the task's comments: the task page keeps paged data at the bare key, and still refreshes this one.
  const repliesKey = [...queryKeys.issues.comments(comment.issueId), "website-comment"] as const;
  const replies = useQuery({
    queryKey: repliesKey,
    queryFn: () => issuesApi.listComments(comment.issueId, { order: "asc" }),
    refetchInterval: REFRESH_MS,
  });
  const revisions = useQuery({
    queryKey: queryKeys.website.revisions(companyId, siteId, page.id),
    queryFn: () => websiteModuleApi.revisions(companyId, siteId, page.id),
    refetchInterval: REFRESH_MS,
  });
  const changes = websiteCommentChanges(comment, revisions.data ?? []);
  const latest = changes[0] ?? null;

  const send = useMutation({
    mutationFn: () => issuesApi.addComment(comment.issueId, reply.trim()),
    onSuccess: () => {
      setReply("");
      void queryClient.invalidateQueries({ queryKey: repliesKey });
    },
  });
  const resolve = useMutation({
    mutationFn: () => issuesApi.update(comment.issueId, { status: "done", comment: "Marked resolved in the website editor." }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.pageComments(companyId, siteId, page.id) });
      onBack();
    },
  });

  return (
    <section className="min-w-0 space-y-4" aria-label={`Comment ${comment.number}`} data-testid="website-comment-thread">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="All comments" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <CommentPin number={comment.number} />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{websiteCommentTarget(comment)}</p>
        <Link
          to={issueUrl({ id: comment.issueId, identifier: comment.identifier })}
          className="shrink-0 text-xs text-muted-foreground underline underline-offset-2"
        >
          {comment.identifier ?? "Open task"}
        </Link>
      </div>

      <div className="space-y-1">
        <blockquote className="whitespace-pre-wrap break-words border-l-2 border-primary/50 pl-3 text-sm" data-testid="website-comment-request">
          {comment.request}
        </blockquote>
        <p className="text-xs text-muted-foreground">
          You, {relativeTime(comment.createdAt)}
          {comment.width && WIDTH_NAMES[comment.width] ? ` · seen at ${WIDTH_NAMES[comment.width]} width` : ""}
        </p>
      </div>

      <div className="space-y-2" data-testid="website-comment-change">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">The change</h3>
        {latest ? (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5">
            <p className="text-sm">
              The agent saved draft {latest.revisionNumber} {relativeTime(latest.createdAt)}
              {latest.changeSummary ? `: ${latest.changeSummary}` : "."}
            </p>
            <Button type="button" size="xs" variant="outline" onClick={onPreviewChange}>
              <Eye />
              Preview the change
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No draft change yet. The agent's draft shows here when it saves one.</p>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Replies</h3>
        {replies.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading replies</p>
        ) : replies.error ? (
          <ErrorState error={replies.error} onRetry={() => void replies.refetch()} />
        ) : !replies.data?.length ? (
          <p className="text-sm text-muted-foreground">No replies yet.</p>
        ) : (
          <ol className="space-y-2" data-testid="website-comment-replies">
            {replies.data.map((entry) => (
              <li key={entry.id} className="space-y-0.5 rounded-md border border-border p-2.5">
                <p className="text-xs text-muted-foreground">
                  {entry.authorAgentId ? "Agent" : "Person"}, {relativeTime(entry.createdAt)}
                </p>
                <MarkdownBody className="text-sm">{entry.body}</MarkdownBody>
              </li>
            ))}
          </ol>
        )}
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (reply.trim()) send.mutate();
          }}
        >
          <Textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            maxLength={4000}
            rows={2}
            aria-label="Reply to the agent"
            placeholder="Reply to the agent"
          />
          {send.error ? (
            <p role="alert" className="text-sm text-status-danger-foreground">The reply was not sent: {errorStateMessage(send.error)}</p>
          ) : null}
          <Button type="submit" size="sm" variant="outline" disabled={!reply.trim() || send.isPending}>
            {send.isPending ? "Sending" : "Reply"}
          </Button>
        </form>
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        {resolve.error ? (
          <p role="alert" className="text-sm text-status-danger-foreground">Not resolved: {errorStateMessage(resolve.error)}</p>
        ) : null}
        <Button type="button" size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate()}>
          <CheckCircle2 />
          {resolve.isPending ? "Resolving" : "Mark resolved"}
        </Button>
        <p className="text-xs text-muted-foreground">Resolving closes the task. Nothing is published.</p>
      </div>
    </section>
  );
}
