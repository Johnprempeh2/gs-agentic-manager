import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareText, Pencil, Send, Trash2, X } from "lucide-react";
import { deliverablesApi, type DeliverableComment } from "@/api/deliverables";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { DELIVERABLE_IFRAME_SANDBOX } from "./DeliverableDocument";

/**
 * Comments on a deliverable version (GRE-982). The document shows in review
 * mode: the server adds a small script to the HTML that tells us what the
 * reader selects and draws numbered markers we ask for. We talk to it only by
 * postMessage, and send it quotes and numbers, never the notes themselves.
 */

export type ReviewSelection = {
  quote: string;
  prefix: string | null;
  suffix: string | null;
  textStart: number | null;
};

type FrameMessage =
  | { gsamReview: 1; type: "ready" }
  | { gsamReview: 1; type: "selection"; quote: string | null; prefix?: string; suffix?: string; textStart?: number }
  | { gsamReview: 1; type: "focus"; id: string };

function readFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.gsamReview !== 1 || typeof message.type !== "string") return null;
  return message as FrameMessage;
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";
}

/** State shared by the review frame and the comments panel. */
export function useDeliverableReview(companyId: string, deliverableId: string, enabled = true) {
  const queryClient = useQueryClient();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Counts "ready" messages, so markers are drawn again whenever the frame reloads.
  const [frameLoads, setFrameLoads] = useState(0);
  const [selection, setSelection] = useState<ReviewSelection | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const queryKey = queryKeys.deliverables.comments(companyId, deliverableId);

  const commentsQuery = useQuery({
    queryKey,
    queryFn: () => deliverablesApi.listComments(companyId, deliverableId),
    enabled,
  });
  const comments = useMemo(() => commentsQuery.data?.comments ?? [], [commentsQuery.data]);

  useEffect(() => {
    setFrameLoads(0);
    setSelection(null);
    setActiveId(null);
  }, [deliverableId]);

  const postToFrame = useCallback((message: Record<string, unknown>) => {
    // The frame is an opaque-origin sandbox, so "*" is the only target that
    // reaches it; nothing private is in these messages.
    frameRef.current?.contentWindow?.postMessage({ gsamReview: 1, ...message }, "*");
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const message = readFrameMessage(event.data);
      if (!message) return;
      if (message.type === "ready") setFrameLoads((count) => count + 1);
      else if (message.type === "focus") setActiveId(message.id);
      else if (message.type === "selection") {
        const quote = typeof message.quote === "string" ? message.quote.trim() : "";
        setSelection(quote
          ? {
            quote,
            prefix: typeof message.prefix === "string" ? message.prefix : null,
            suffix: typeof message.suffix === "string" ? message.suffix : null,
            textStart: typeof message.textStart === "number" ? message.textStart : null,
          }
          : null);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (frameLoads === 0) return;
    postToFrame({
      type: "marks",
      marks: comments.map((comment, index) => ({
        id: comment.id,
        n: index + 1,
        quote: comment.quote,
        prefix: comment.prefix,
        suffix: comment.suffix,
        textStart: comment.textStart,
        sent: comment.status === "sent",
        active: comment.id === activeId,
      })),
    });
  }, [frameLoads, comments, activeId, postToFrame]);

  const focusComment = useCallback((id: string) => {
    setActiveId(id);
    postToFrame({ type: "scrollTo", id });
  }, [postToFrame]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    postToFrame({ type: "clearSelection" });
  }, [postToFrame]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: (input: ReviewSelection & { body: string }) => deliverablesApi.createComment(companyId, deliverableId, input),
    onSuccess: () => {
      clearSelection();
      void invalidate();
    },
  });
  const update = useMutation({
    mutationFn: (input: { id: string; body: string }) => deliverablesApi.updateComment(companyId, deliverableId, input.id, input.body),
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deliverablesApi.deleteComment(companyId, deliverableId, id),
    onSuccess: () => void invalidate(),
  });
  const send = useMutation({
    mutationFn: () => deliverablesApi.sendComments(companyId, deliverableId),
    onSettled: () => void invalidate(),
  });

  // Another version or deliverable: drop the last send result and errors.
  const resets = [create.reset, update.reset, remove.reset, send.reset];
  useEffect(() => {
    for (const reset of resets) reset();
  }, [deliverableId]);

  return {
    frameRef,
    reviewSrc: deliverablesApi.reviewContentPath(companyId, deliverableId),
    commentsQuery,
    comments,
    selection,
    activeId,
    focusComment,
    clearSelection,
    create,
    update,
    remove,
    send,
  };
}

export type DeliverableReviewState = ReturnType<typeof useDeliverableReview>;

export function DeliverableReviewFrame({ review, title }: { review: DeliverableReviewState; title: string }) {
  return (
    <iframe
      key={review.reviewSrc}
      ref={review.frameRef}
      title={`${title} (comment mode)`}
      src={review.reviewSrc}
      sandbox={DELIVERABLE_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      data-testid="deliverable-review-frame"
      className="h-full w-full border-0 bg-white"
    />
  );
}

function CommentItem({
  comment,
  number,
  active,
  review,
}: {
  comment: DeliverableComment;
  number: number;
  active: boolean;
  review: DeliverableReviewState;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const isDraft = comment.status === "draft";
  const busy = review.update.isPending || review.remove.isPending;

  function save() {
    const body = draft.trim();
    if (!body) return;
    review.update.mutate({ id: comment.id, body }, { onSuccess: () => setEditing(false) });
  }

  return (
    <li
      data-testid="deliverable-comment"
      data-status={comment.status}
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border p-3 transition-colors",
        active && "border-primary/60 bg-accent/40",
      )}
    >
      <button
        type="button"
        onClick={() => review.focusComment(comment.id)}
        className="flex items-start gap-2 text-left"
        aria-label={`Show comment ${number} in the document`}
      >
        <span className="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground">
          {number}
        </span>
        <span className="line-clamp-3 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
          {comment.quote}
        </span>
      </button>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={`Edit comment ${number}`}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setDraft(comment.body); setEditing(false); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={!draft.trim() || busy}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm text-foreground">{comment.body}</p>
      )}
      <div className="flex items-center justify-between gap-2">
        {isDraft ? <Badge variant="outline">Draft</Badge> : <Badge variant="secondary">Sent</Badge>}
        {isDraft && !editing ? (
          <div className="flex gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit comment ${number}`}
              onClick={() => { setDraft(comment.body); setEditing(true); }}
              disabled={busy}
            >
              <Pencil />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete comment ${number}`}
              onClick={() => review.remove.mutate(comment.id)}
              disabled={busy}
            >
              <Trash2 />
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function DeliverableCommentsPanel({ review }: { review: DeliverableReviewState }) {
  const [note, setNote] = useState("");
  const { selection, comments, commentsQuery } = review;
  const drafts = comments.filter((comment) => comment.status === "draft");
  const sentResult = review.send.data;

  useEffect(() => {
    if (!selection) setNote("");
  }, [selection]);

  const error = review.create.error ?? review.update.error ?? review.remove.error ?? review.send.error;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label="Comments" data-testid="deliverable-comments-panel">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" /> Comments
        </h3>
        <span className="text-xs text-muted-foreground">
          {drafts.length > 0 ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"}` : null}
        </span>
      </div>

      {selection ? (
        <form
          className="flex flex-col gap-2 rounded-md border border-primary/40 bg-accent/30 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const body = note.trim();
            if (!body) return;
            review.create.mutate({ ...selection, body });
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="line-clamp-3 border-l-2 border-primary/60 pl-2 text-xs italic text-muted-foreground">
              {selection.quote}
            </span>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancel comment" onClick={review.clearSelection}>
              <X />
            </Button>
          </div>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Your note on this passage"
            aria-label="Comment on the selected text"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!note.trim() || review.create.isPending}>
            Add comment
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Select text in the document to comment on it.
        </p>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">{errorMessage(error)}</p>
      ) : null}

      {commentsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading comments…</p>
      ) : commentsQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">Could not load comments. {errorMessage(commentsQuery.error)}</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments on this version yet.</p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Comments on this version">
          {comments.map((comment, index) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              number={index + 1}
              active={comment.id === review.activeId}
              review={review}
            />
          ))}
        </ol>
      )}

      <div className="mt-auto flex flex-col gap-1.5 border-t border-border pt-3">
        <Button
          size="sm"
          onClick={() => review.send.mutate()}
          disabled={drafts.length === 0 || review.send.isPending}
          data-testid="deliverable-comments-send"
        >
          <Send /> {drafts.length > 1 ? `Send ${drafts.length} comments` : "Send comments"}
        </Button>
        {sentResult && !review.send.isPending ? (
          <p className="text-xs text-muted-foreground" role="status">
            {sentResult.woken
              ? "Sent. The task's agent will revise the deliverable."
              : "Posted on the task. No agent was woken; assign one on the task."}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Posts all drafts as one comment on the task and asks its agent to revise.
          </p>
        )}
      </div>
    </section>
  );
}
