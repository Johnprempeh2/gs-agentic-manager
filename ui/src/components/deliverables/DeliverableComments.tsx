import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MessageSquareText, Pencil, Send, SquareDashed, SquareDashedMousePointer, Trash2, X } from "lucide-react";
import { deliverablesApi, type DeliverableComment, type DeliverableCommentLocator } from "@/api/deliverables";
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
 *
 * Since GRE-1223 the reader can also pick an element (an image, chart, table
 * or block) or draw an area, in pick mode or with Alt/Option held. The frame
 * then sends a readable label and a locator instead of a text quote.
 */

export type ReviewSelection =
  | {
    kind: "text";
    quote: string;
    prefix: string | null;
    suffix: string | null;
    textStart: number | null;
  }
  | {
    kind: "element" | "region";
    quote: string;
    locator: DeliverableCommentLocator;
  };

type FrameMessage =
  | { gsamReview: 1; type: "ready" }
  | {
    gsamReview: 1;
    type: "selection";
    kind?: string;
    quote: string | null;
    prefix?: string;
    suffix?: string;
    textStart?: number;
    locator?: unknown;
  }
  | { gsamReview: 1; type: "focus"; id: string }
  | { gsamReview: 1; type: "pickCancel" };

function readFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.gsamReview !== 1 || typeof message.type !== "string") return null;
  return message as FrameMessage;
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The locator the frame sent, or null when it is not one. The server checks it again. */
function readLocator(value: unknown, region: boolean): DeliverableCommentLocator | null {
  if (!value || typeof value !== "object") return null;
  const locator = value as Record<string, unknown>;
  if (typeof locator.path !== "string" || !locator.path || typeof locator.tag !== "string" || !locator.tag) return null;
  let box: DeliverableCommentLocator["box"] = null;
  if (region) {
    const raw = locator.box && typeof locator.box === "object" ? locator.box as Record<string, unknown> : {};
    const [x, y, width, height] = [finite(raw.x), finite(raw.y), finite(raw.width), finite(raw.height)];
    if (x === null || y === null || width === null || height === null) return null;
    box = { x, y, width, height };
  }
  return {
    path: locator.path,
    tag: locator.tag,
    label: typeof locator.label === "string" ? locator.label : null,
    box,
  };
}

function readSelection(message: Extract<FrameMessage, { type: "selection" }>): ReviewSelection | null {
  const quote = typeof message.quote === "string" ? message.quote.trim() : "";
  if (!quote) return null;
  if (message.kind === "element" || message.kind === "region") {
    const locator = readLocator(message.locator, message.kind === "region");
    return locator ? { kind: message.kind, quote, locator } : null;
  }
  return {
    kind: "text",
    quote,
    prefix: typeof message.prefix === "string" ? message.prefix : null,
    suffix: typeof message.suffix === "string" ? message.suffix : null,
    textStart: typeof message.textStart === "number" ? message.textStart : null,
  };
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
  // Pick mode: a click in the document picks an element, a drag draws an area.
  const [picking, setPicking] = useState(false);
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
    setPicking(false);
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
      else if (message.type === "pickCancel") setPicking(false);
      else if (message.type === "selection") {
        const next = readSelection(message);
        setSelection(next);
        // One pick at a time: once something is picked, the note comes next.
        if (next && next.kind !== "text") setPicking(false);
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
        kind: comment.anchorKind,
        locator: comment.locator,
        quote: comment.quote,
        prefix: comment.prefix,
        suffix: comment.suffix,
        textStart: comment.textStart,
        sent: comment.status === "sent",
        active: comment.id === activeId,
      })),
    });
  }, [frameLoads, comments, activeId, postToFrame]);

  useEffect(() => {
    if (frameLoads === 0) return;
    postToFrame({ type: "pickMode", on: picking });
  }, [frameLoads, picking, postToFrame]);

  // Esc while picking stops picking; it must not also close the preview.
  useEffect(() => {
    if (!picking) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPicking(false);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [picking]);

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
    mutationFn: ({ body, selection: picked }: { selection: ReviewSelection; body: string }) =>
      deliverablesApi.createComment(companyId, deliverableId, picked.kind === "text"
        ? { quote: picked.quote, prefix: picked.prefix, suffix: picked.suffix, textStart: picked.textStart, body }
        : { anchorKind: picked.kind, quote: picked.quote, locator: picked.locator, body }),
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
    picking,
    setPicking,
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

/** The quoted passage, or the label of a picked element or area. */
function AnchorLabel({ kind, quote, className }: { kind: DeliverableComment["anchorKind"]; quote: string; className?: string }) {
  if (kind === "text") {
    return (
      <span className={cn("line-clamp-3 border-l-2 pl-2 text-xs italic text-muted-foreground", className)}>
        {quote}
      </span>
    );
  }
  return (
    <span className={cn("flex min-w-0 items-start gap-1.5 border-l-2 pl-2 text-xs text-muted-foreground", className)}>
      <SquareDashed className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="line-clamp-2">{quote}</span>
    </span>
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
        <span className="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-micro font-semibold text-primary-foreground">
          {number}
        </span>
        <AnchorLabel kind={comment.anchorKind} quote={comment.quote} className="border-border" />
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
  const { selection, comments, commentsQuery, picking } = review;
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
            review.create.mutate({ selection, body });
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <AnchorLabel kind={selection.kind} quote={selection.quote} className="border-primary/60" />
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancel comment" onClick={review.clearSelection}>
              <X />
            </Button>
          </div>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={selection.kind === "text" ? "Your note on this passage" : `Your note on this ${selection.kind === "region" ? "area" : "element"}`}
            aria-label={selection.kind === "text"
              ? "Comment on the selected text"
              : selection.kind === "region" ? "Comment on the picked area" : "Comment on the picked element"}
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!note.trim() || review.create.isPending}>
            Add comment
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground" role="status">
            {picking
              ? "Click an image, chart, table or block, or drag a box over an area. Press Esc to stop."
              : "Select text in the document to comment on it. Or pick an image, chart, table or area."}
          </p>
          <Button
            type="button"
            size="sm"
            variant={picking ? "default" : "outline"}
            aria-pressed={picking}
            onClick={() => review.setPicking(!picking)}
            data-testid="deliverable-comments-pick"
            className="self-start"
          >
            <SquareDashedMousePointer /> {picking ? "Stop picking" : "Pick element or area"}
          </Button>
          {!picking ? (
            <p className="hidden text-xs text-muted-foreground sm:block">Tip: hold Alt (Option on a Mac) and click or drag in the document.</p>
          ) : null}
        </div>
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

      {drafts.length > 0 || review.send.isPending ? (
        <div className="mt-auto flex flex-col gap-1.5 border-t border-border pt-3">
          <Button
            size="sm"
            onClick={() => review.send.mutate()}
            disabled={review.send.isPending}
            data-testid="deliverable-comments-send"
          >
            <Send /> {drafts.length > 1 ? `Send ${drafts.length} comments` : "Send comments"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Posts all drafts as one comment on the task and asks its agent to revise.
          </p>
        </div>
      ) : sentResult ? (
        <p className="mt-auto flex items-center gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground" role="status">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          {sentResult.woken
            ? "Sent. The task's agent will revise the deliverable."
            : "Posted on the task. No agent was woken; assign one on the task."}
        </p>
      ) : null}
    </section>
  );
}
