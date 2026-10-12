import type { ThreadMessage } from "@assistant-ui/react";
import { useContext, useState } from "react";
import { useOptionalToastActions } from "../../context/ToastContext";
import { copyTextToClipboard } from "../../lib/clipboard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn, formatDateTime } from "../../lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Check, Copy, Trash2 } from "lucide-react";
import { SourceTrustBadge } from "../SourceTrustBadge";
import { IssueChatCtx } from "./IssueChatContext";
import {
  isSourceTrustMetadata,
  isIssueCommentMetadata,
  resolveIssueChatHumanAuthor,
  initialsForName,
  commentDateLabel,
} from "./helpers";
import { IssueChatTextParts } from "./IssueChatParts";

export function IssueChatUserMessage({
  message,
  isInterruptingQueuedRun,
}: {
  message: ThreadMessage;
  isInterruptingQueuedRun: boolean;
}) {
  const {
    onInterruptQueued,
    onCancelQueued,
    onDeleteComment,
    currentUserId,
    userProfileMap,
  } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const commentId =
    typeof custom.commentId === "string" ? custom.commentId : message.id;
  const authorName =
    typeof custom.authorName === "string" ? custom.authorName : null;
  const authorUserId =
    typeof custom.authorUserId === "string" ? custom.authorUserId : null;
  const queued =
    custom.queueState === "queued" || custom.clientStatus === "queued";
  const sourceTrust = isSourceTrustMetadata(custom.sourceTrust)
    ? custom.sourceTrust
    : null;
  const followUpRequested = custom.followUpRequested === true;
  const sentFromIMessage = isIssueCommentMetadata(custom.commentMetadata) &&
    custom.commentMetadata.sourceChannel === "imessage-photon";
  const queueReason =
    typeof custom.queueReason === "string" ? custom.queueReason : null;
  const queueBadgeLabel =
    queueReason === "hold" ? "\u23f8 Deferred wake" : "Queued";
  const pending = custom.clientStatus === "pending";
  const deleted = Boolean(custom.deletedAt);
  const queueTargetRunId =
    typeof custom.queueTargetRunId === "string"
      ? custom.queueTargetRunId
      : null;
  const [copied, setCopied] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const toastActions = useOptionalToastActions();
  const {
    isCurrentUser,
    authorName: resolvedAuthorName,
    avatarUrl,
  } = resolveIssueChatHumanAuthor({
    authorName,
    authorUserId,
    currentUserId,
    userProfileMap,
  });
  const authorAvatar = (
    <Avatar size="sm" className="shrink-0">
      {avatarUrl ? (
        <AvatarImage src={avatarUrl} alt={resolvedAuthorName} />
      ) : null}
      <AvatarFallback>{initialsForName(resolvedAuthorName)}</AvatarFallback>
    </Avatar>
  );
  const canDeleteComment = Boolean(
    onDeleteComment && isCurrentUser && !queued && !pending && !deleted,
  );
  const handleDeleteComment = () => {
    if (!canDeleteComment) return;
    setDeleteDialogOpen(true);
  };
  const confirmDeleteComment = () => {
    if (!canDeleteComment) return;
    setDeleteDialogOpen(false);
    void onDeleteComment?.(commentId);
  };
  const messageBody = (
    <div
      className={cn(
        "flex min-w-0 max-w-(--pct-85) flex-col",
        isCurrentUser && "items-end",
      )}
    >
      <div
        className={cn(
          "mb-1 flex items-center gap-2 px-1",
          isCurrentUser ? "justify-end" : "justify-start",
        )}
      >
        <span className="text-sm font-medium text-foreground">
          {resolvedAuthorName}
        </span>
        <SourceTrustBadge sourceTrust={sourceTrust} artifactLabel="comment" />
        {followUpRequested ? (
          <Badge
            variant="outline"
            className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)"
          >
            Follow-up
          </Badge>
        ) : null}
      </div>
      <div
        className={cn(
          "min-w-0 max-w-full overflow-hidden break-all rounded-2xl px-4 py-2.5",
          // Tail-hugging corner: flatten the bottom corner nearest the avatar so
          // the bubble points at it (bottom-right for the right-aligned human).
          isCurrentUser ? "rounded-br-(--rad-4)" : "rounded-bl-(--rad-4)",
          queued
            ? "bg-amber-50/80 dark:bg-amber-500/10"
            : deleted
              ? "bg-muted/50 text-muted-foreground"
              : isCurrentUser
                ? // Liveness blue (--liveness-blue, decoupled from --status-task-in_progress
                  // in DECISION-SHEET.md A6) for the human's own messages (PAP-95 rev 5).
                  // Greatstone: the human's own messages are the emerald stone.
                  "gs-human-bubble"
                : "bg-muted",
          pending && "opacity-80",
        )}
      >
        {queued ? (
          <div className="mb-1.5 flex items-center gap-2">
            <Badge
              variant="outline"
              className="border-amber-400/60 bg-amber-100/70 text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-amber-800 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-200"
            >
              {queueBadgeLabel}
            </Badge>
            {onInterruptQueued ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 border-red-300 px-2 text-(length:--text-micro) text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
                disabled={isInterruptingQueuedRun}
                onClick={() => void onInterruptQueued(queueTargetRunId)}
              >
                {isInterruptingQueuedRun ? "Interrupting..." : "Interrupt"}
              </Button>
            ) : null}
            {onCancelQueued ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 border-amber-300 px-2 text-(length:--text-micro) text-amber-900 hover:bg-amber-100/80 hover:text-amber-950 dark:border-amber-500/40 dark:text-amber-100 dark:hover:bg-amber-500/10"
                onClick={() => onCancelQueued(commentId)}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
        {deleted ? (
          <div className="text-sm italic text-muted-foreground">
            Comment deleted
          </div>
        ) : (
          <div className="min-w-0 max-w-full space-y-3">
            <IssueChatTextParts
              message={message}
              onAccent={isCurrentUser && !queued}
            />
          </div>
        )}
      </div>

      {sentFromIMessage && !deleted ? (
        <div className="mt-1 px-1 text-xs text-muted-foreground">
          Sent from iMessage
        </div>
      ) : null}
      {pending ? (
        <div
          className={cn(
            "mt-1 flex px-1 text-(length:--text-micro) text-muted-foreground",
            isCurrentUser ? "justify-end" : "justify-start",
          )}
        >
          Sending...
        </div>
      ) : (
        <div
          className={cn(
            "mt-1 flex items-center gap-1.5 px-1 opacity-0 transition-opacity group-hover:opacity-100",
            isCurrentUser ? "justify-end" : "justify-start",
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={anchorId ? `#${anchorId}` : undefined}
                className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
              >
                {message.createdAt ? commentDateLabel(message.createdAt) : ""}
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {message.createdAt ? formatDateTime(message.createdAt) : ""}
            </TooltipContent>
          </Tooltip>
          {!deleted ? (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              title="Copy message"
              aria-label="Copy message"
              onClick={() => {
                const text = message.content
                  .filter(
                    (p): p is { type: "text"; text: string } =>
                      p.type === "text",
                  )
                  .map((p) => p.text)
                  .join("\n\n");
                void copyTextToClipboard(text)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })
                  .catch((error) => {
                    toastActions?.pushToast({
                      title: "Copy failed",
                      body:
                        error instanceof Error
                          ? error.message
                          : "Unable to copy message",
                      tone: "error",
                    });
                  });
              }}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          {canDeleteComment ? (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-destructive"
              title="Delete comment"
              aria-label="Delete comment"
              onClick={handleDeleteComment}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );

  return (
    <>
      <div id={anchorId}>
        <div
          className={cn(
            "group flex items-end gap-2",
            isCurrentUser && "justify-end",
          )}
        >
          {isCurrentUser ? (
            <>
              {messageBody}
              {authorAvatar}
            </>
          ) : (
            <>
              {authorAvatar}
              {messageBody}
            </>
          )}
        </div>
      </div>
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete comment?</DialogTitle>
            <DialogDescription>
              This will replace the comment with a deleted-comment marker.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDeleteComment}>
              Delete comment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
