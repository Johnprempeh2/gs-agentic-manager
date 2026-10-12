import { AgentAvatar } from "@/components/AgentAvatar";
import type { ThreadMessage } from "@assistant-ui/react";
import { useContext, useState, useEffect } from "react";
import { Link } from "@/lib/router";
import type { FeedbackVoteValue, FeedbackDataSharingPreference } from "@greatstone/shared";
import { useOptionalToastActions } from "../../context/ToastContext";
import { copyTextToClipboard } from "../../lib/clipboard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { formatDateTime, cn } from "../../lib/utils";
import { liveBlueBadge } from "../../lib/status-colors";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  Check,
  Copy,
  MoreHorizontal,
  PauseCircle,
  Square,
  Search,
  ChevronDown,
  Loader2,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { SourceTrustBadge } from "../SourceTrustBadge";
import { CommentAttributionChip } from "../CommentAttributionChip";
import { resolveCommentAttribution } from "../../lib/comment-attribution";
import { IssueChatCtx, AGENT_COMMENT_BUBBLE_WIDTH_CLASS } from "./IssueChatContext";
import {
  isSourceTrustMetadata,
  resolveAssistantMessageFoldedState,
  commentDateLabel,
  initialsForName,
} from "./helpers";
import {
  getThreadMessageCopyText,
  IssueChatAssistantParts,
  IssueChatLiveRunStatusLine,
} from "./IssueChatParts";

export function IssueChatAssistantMessage({
  message,
  activeVote,
  isRunActive,
  isStoppingRun,
}: {
  message: ThreadMessage;
  activeVote: FeedbackVoteValue | null;
  isRunActive: boolean;
  isStoppingRun: boolean;
}) {
  const {
    feedbackDataSharingPreference,
    feedbackTermsUrl,
    onVote,
    agentMap,
    onStopRun,
    stopRunLabel = "Stop run",
    stoppingRunLabel = "Stopping...",
    stopRunVariant = "stop",
    runFinalizationActions = [],
    userLabelMap,
    issueAssigneeAgentId,
  } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const authorName =
    typeof custom.authorName === "string"
      ? custom.authorName
      : typeof custom.runAgentName === "string"
        ? custom.runAgentName
        : "Agent";
  const authorAgentId =
    typeof custom.authorAgentId === "string" ? custom.authorAgentId : null;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runStatus =
    typeof custom.runStatus === "string" ? custom.runStatus : null;
  const agentId = authorAgentId ?? runAgentId;
  const agentIcon = agentId ? agentMap?.get(agentId)?.icon : undefined;
  const commentId =
    typeof custom.commentId === "string" ? custom.commentId : null;
  const sourceTrust = isSourceTrustMetadata(custom.sourceTrust)
    ? custom.sourceTrust
    : null;
  const attribution = resolveCommentAttribution({
    authorAgentId,
    onBehalfOfUserId:
      typeof custom.onBehalfOfUserId === "string"
        ? custom.onBehalfOfUserId
        : null,
    issueAssigneeAgentId,
    resolveUserLabel: (userId) => userLabelMap?.get(userId),
  });
  const notices = Array.isArray(custom.notices)
    ? custom.notices.filter(
        (notice): notice is string =>
          typeof notice === "string" && notice.length > 0,
      )
    : [];
  const waitingText =
    typeof custom.waitingText === "string" ? custom.waitingText : "";
  const isRunning =
    message.role === "assistant" && message.status?.type === "running";
  const runHref =
    runId && runAgentId ? `/agents/${runAgentId}/runs/${runId}` : null;
  const canStopRun =
    Boolean(runId) &&
    (isRunActive || runStatus === "queued" || runStatus === "running");
  const chainOfThoughtLabel =
    typeof custom.chainOfThoughtLabel === "string"
      ? custom.chainOfThoughtLabel
      : null;
  const hasCoT = message.content.some(
    (p) => p.type === "reasoning" || p.type === "tool-call",
  );
  const deleted = Boolean(custom.deletedAt);
  const isFoldable = !isRunning && !!chainOfThoughtLabel;
  const [folded, setFolded] = useState(isFoldable);
  const [prevFoldKey, setPrevFoldKey] = useState({
    messageId: message.id,
    isFoldable,
  });
  const [copied, setCopied] = useState(false);
  const toastActions = useOptionalToastActions();
  const copyText = deleted ? "" : getThreadMessageCopyText(message);

  // Derive fold state synchronously during render (not in useEffect) so the
  // browser never paints the un-folded intermediate state — prevents the
  // visible "jump" when loading a page with already-folded work sections.
  if (
    message.id !== prevFoldKey.messageId ||
    isFoldable !== prevFoldKey.isFoldable
  ) {
    const nextFolded = resolveAssistantMessageFoldedState({
      messageId: message.id,
      currentFolded: folded,
      isFoldable,
      previousMessageId: prevFoldKey.messageId,
      previousIsFoldable: prevFoldKey.isFoldable,
    });
    setPrevFoldKey({ messageId: message.id, isFoldable });
    if (nextFolded !== folded) {
      setFolded(nextFolded);
    }
  }

  const handleVote = async (
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => {
    if (!commentId || !onVote) return;
    await onVote(commentId, vote, options);
  };

  const followUpRequested = custom.followUpRequested === true;

  const kind = typeof custom.kind === "string" ? custom.kind : null;
  const hasCommentText = message.content.some(
    (part) =>
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0,
  );
  // A genuine posted agent comment (kind "comment" with real text) renders in a
  // left-aligned neutral bubble — the mirror of the human blue bubble. Run
  // activity (chain-of-thought, tool calls, waiting shimmer, "worked N min")
  // keeps the existing flat / metadata treatment (PAP-95 rev 6).
  const isGenuineComment =
    kind === "comment" &&
    !!commentId &&
    !isRunning &&
    (hasCommentText || deleted);

  const agentAvatar = <AgentAvatar agent={agentId ? agentMap?.get(agentId) ?? { id: agentId, name: authorName } : { name: authorName }} size={32} />;

  const messageActionBar = (
    <div className="mt-2 flex items-center gap-1">
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Copy message"
        aria-label="Copy message"
        onClick={() => {
          void copyTextToClipboard(copyText)
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
      {commentId && onVote ? (
        <IssueChatFeedbackButtons
          activeVote={activeVote}
          sharingPreference={feedbackDataSharingPreference}
          termsUrl={feedbackTermsUrl ?? null}
          onVote={handleVote}
        />
      ) : null}
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            title="More actions"
            aria-label="More actions"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              void copyTextToClipboard(copyText).catch((error) => {
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
            <Copy className="mr-2 h-3.5 w-3.5" />
            Copy message
          </DropdownMenuItem>
          {canStopRun && onStopRun && runId ? (
            <DropdownMenuItem
              disabled={isStoppingRun}
              className={cn(
                stopRunVariant === "pause"
                  ? "text-amber-700 focus:text-amber-800 dark:text-amber-300 dark:focus:text-amber-200"
                  : "text-red-700 focus:text-red-800 dark:text-red-300 dark:focus:text-red-200",
              )}
              onSelect={() => {
                void onStopRun(runId);
              }}
            >
              {stopRunVariant === "pause" ? (
                <PauseCircle className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Square className="mr-2 h-3.5 w-3.5 fill-current" />
              )}
              {isStoppingRun ? stoppingRunLabel : stopRunLabel}
            </DropdownMenuItem>
          ) : null}
          {runHref ? (
            <DropdownMenuItem asChild>
              <Link to={runHref} target="_blank" rel="noreferrer noopener">
                <Search className="mr-2 h-3.5 w-3.5" />
                View run
              </Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  // Genuine agent comment → neutral left-aligned bubble (mirror of the human
  // blue bubble in IssueChatUserMessage). See PAP-95 rev 6.
  if (isGenuineComment) {
    return (
      <div id={anchorId}>
        <div className="group flex flex-col items-start py-1.5">
          {/* Icon + name together in a header ABOVE the bubble (PAP-95 rev 7). */}
          <div className="mb-1 flex items-center gap-1.5 px-1">
            <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
              {agentId ? (
                <AgentAvatar agent={agentId ? agentMap?.get(agentId) ?? { id: agentId } : undefined} size={16} />
              ) : (
                <Avatar size="sm" className="size-5">
                  <AvatarFallback className="text-(length:--text-nano)">
                    {initialsForName(authorName)}
                  </AvatarFallback>
                </Avatar>
              )}
            </span>
            <span className="text-sm font-medium text-foreground">
              {authorName}
            </span>
            {/* Reads as "Fable · for Dotta" beside the author name (the open cross-task write design (attribution)). */}
            {attribution ? (
              <CommentAttributionChip
                agentName={authorName}
                userName={attribution.userName}
              />
            ) : null}
            <SourceTrustBadge
              sourceTrust={sourceTrust}
              artifactLabel="comment"
            />
            {followUpRequested ? (
              <Badge
                variant="outline"
                className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)"
              >
                Follow-up
              </Badge>
            ) : null}
          </div>
          {/* Canonical conference-room agent bubble (BoardChat.tsx:712). */}
          <div
            className={cn(
              "min-w-0 break-words px-3 py-2 text-sm overflow-x-auto overflow-y-visible [border-radius:14px_14px_14px_4px]",
              AGENT_COMMENT_BUBBLE_WIDTH_CLASS,
              deleted
                ? "border border-border bg-muted/50 text-muted-foreground"
                : "border border-border bg-card text-foreground",
            )}
          >
            {deleted ? (
              <div className="text-sm italic text-muted-foreground">
                Comment deleted
              </div>
            ) : (
              <div className="min-w-0 max-w-full space-y-3">
                <IssueChatAssistantParts message={message} hasCoT={false} />
                {notices.length > 0 ? (
                  <div className="space-y-2">
                    {notices.map((notice, index) => (
                      <div
                        key={`${message.id}:notice:${index}`}
                        className="rounded-sm border border-border/60 bg-accent/20 px-3 py-2 text-sm text-muted-foreground"
                      >
                        {notice}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
          {!deleted ? messageActionBar : null}
        </div>
      </div>
    );
  }

  return (
    <div id={anchorId}>
      <div className="flex items-start gap-2.5 py-1.5">
        {agentAvatar}

        <div className="min-w-0 flex-1">
          {isFoldable ? (
            <button
              type="button"
              className="group flex w-full items-center gap-2 py-0.5 text-left"
              onClick={() => setFolded((v) => !v)}
            >
              <span className="text-sm font-medium text-foreground">
                {authorName}
              </span>
              <SourceTrustBadge
                sourceTrust={sourceTrust}
                artifactLabel="comment"
              />
              <span className="text-xs text-subtle-foreground">
                {chainOfThoughtLabel?.toLowerCase()}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                {message.createdAt ? (
                  <span className="text-(length:--text-micro) text-subtle-foreground">
                    {commentDateLabel(message.createdAt)}
                  </span>
                ) : null}
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 text-subtle-foreground transition-transform",
                    !folded && "rotate-180",
                  )}
                />
              </span>
            </button>
          ) : (
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {authorName}
              </span>
              <SourceTrustBadge
                sourceTrust={sourceTrust}
                artifactLabel="comment"
              />
              {followUpRequested ? (
                <Badge
                  variant="outline"
                  className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)"
                >
                  Follow-up
                </Badge>
              ) : null}
              {isRunning ? (
                // Running chip shares the liveness-blue badge recipe with the
                // issue header's "Live" badge (one live/running blue).
                <Badge
                  variant="outline"
                  className={cn(
                    "text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow)",
                    liveBlueBadge,
                  )}
                >
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Running
                </Badge>
              ) : null}
            </div>
          )}

          {deleted ? (
            <div className="rounded-sm bg-muted/40 px-3 py-2 text-sm italic text-muted-foreground">
              Comment deleted
            </div>
          ) : !folded ? (
            <>
              <div className="space-y-3">
                <IssueChatAssistantParts message={message} hasCoT={hasCoT} />
                {message.content.length === 0 && waitingText ? (
                  <div className="rounded-lg px-1 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground/80">
                        {agentId ? (
                          <AgentAvatar agent={agentId ? agentMap?.get(agentId) ?? { id: agentId } : undefined} size={16} />
                        ) : (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                        )}
                        <span className="shimmer-text">{waitingText}</span>
                      </span>
                    </div>
                    <IssueChatLiveRunStatusLine
                      custom={custom}
                      active={isRunning}
                      className="pl-6"
                    />
                  </div>
                ) : null}
                {notices.length > 0 ? (
                  <div className="space-y-2">
                    {notices.map((notice, index) => (
                      <div
                        key={`${message.id}:notice:${index}`}
                        className="rounded-sm border border-border/60 bg-accent/20 px-3 py-2 text-sm text-muted-foreground"
                      >
                        {notice}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {messageActionBar}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function IssueChatFeedbackButtons({
  activeVote,
  sharingPreference = "prompt",
  termsUrl,
  onVote,
}: {
  activeVote: FeedbackVoteValue | null;
  sharingPreference: FeedbackDataSharingPreference;
  termsUrl: string | null;
  onVote: (
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const [optimisticVote, setOptimisticVote] =
    useState<FeedbackVoteValue | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [downvoteReason, setDownvoteReason] = useState("");
  const [pendingSharingDialog, setPendingSharingDialog] = useState<{
    vote: FeedbackVoteValue;
    reason?: string;
  } | null>(null);
  const visibleVote = optimisticVote ?? activeVote ?? null;

  useEffect(() => {
    if (optimisticVote && activeVote === optimisticVote)
      setOptimisticVote(null);
  }, [activeVote, optimisticVote]);

  async function doVote(
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) {
    setIsSaving(true);
    try {
      await onVote(vote, options);
    } catch {
      setOptimisticVote(null);
    } finally {
      setIsSaving(false);
    }
  }

  function handleVote(vote: FeedbackVoteValue, reason?: string) {
    setOptimisticVote(vote);
    if (sharingPreference === "prompt") {
      setPendingSharingDialog({ vote, ...(reason ? { reason } : {}) });
      return;
    }
    const allowSharing = sharingPreference === "allowed";
    void doVote(vote, {
      ...(allowSharing ? { allowSharing: true } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  function handleThumbsUp() {
    handleVote("up");
  }

  function handleThumbsDown() {
    setOptimisticVote("down");
    setReasonOpen(true);
    // Submit the initial down vote right away
    handleVote("down");
  }

  function handleSubmitReason() {
    if (!downvoteReason.trim()) return;
    // Re-submit with reason attached
    if (sharingPreference === "prompt") {
      setPendingSharingDialog({ vote: "down", reason: downvoteReason });
    } else {
      const allowSharing = sharingPreference === "allowed";
      void doVote("down", {
        ...(allowSharing ? { allowSharing: true } : {}),
        reason: downvoteReason,
      });
    }
    setReasonOpen(false);
    setDownvoteReason("");
  }

  return (
    <>
      <button
        type="button"
        disabled={isSaving}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
          visibleVote === "up"
            ? "text-green-600 dark:text-green-400"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        title="Helpful"
        aria-label="Helpful"
        onClick={handleThumbsUp}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <Popover open={reasonOpen} onOpenChange={setReasonOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isSaving}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              visibleVote === "down"
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            title="Needs work"
            aria-label="Needs work"
            onClick={handleThumbsDown}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 p-3">
          <div className="mb-2 text-sm font-medium">
            What could have been better?
          </div>
          <Textarea
            value={downvoteReason}
            onChange={(event) => setDownvoteReason(event.target.value)}
            placeholder="Add a short note"
            className="min-h-20 resize-y bg-background text-sm"
            disabled={isSaving}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isSaving}
              onClick={() => {
                setReasonOpen(false);
                setDownvoteReason("");
              }}
            >
              Dismiss
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isSaving || !downvoteReason.trim()}
              onClick={handleSubmitReason}
            >
              {isSaving ? "Saving..." : "Save note"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog
        open={Boolean(pendingSharingDialog)}
        onOpenChange={(open) => {
          if (!open && !isSaving) {
            setPendingSharingDialog(null);
            setOptimisticVote(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your feedback sharing preference</DialogTitle>
            <DialogDescription>
              Choose whether AI outputs you vote on can be shared outside this server.
              This answer becomes the default for future thumbs up and thumbs
              down votes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>This vote is always saved locally.</p>
            <p>
              Choose{" "}
              <span className="font-medium text-foreground">Always allow</span>{" "}
              to share this vote and future voted AI outputs. Choose{" "}
              <span className="font-medium text-foreground">Don't allow</span>{" "}
              to keep this vote and future votes local.
            </p>
            <p>You can change this later in Settings &gt; General.</p>
            {termsUrl ? (
              <a
                href={termsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-foreground underline underline-offset-4"
              >
                Read our terms of service
              </a>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={!pendingSharingDialog || isSaving}
              onClick={() => {
                if (!pendingSharingDialog) return;
                void doVote(
                  pendingSharingDialog.vote,
                  pendingSharingDialog.reason
                    ? { reason: pendingSharingDialog.reason }
                    : undefined,
                ).then(() => setPendingSharingDialog(null));
              }}
            >
              {isSaving ? "Saving..." : "Don't allow"}
            </Button>
            <Button
              type="button"
              disabled={!pendingSharingDialog || isSaving}
              onClick={() => {
                if (!pendingSharingDialog) return;
                void doVote(pendingSharingDialog.vote, {
                  allowSharing: true,
                  ...(pendingSharingDialog.reason
                    ? { reason: pendingSharingDialog.reason }
                    : {}),
                }).then(() => setPendingSharingDialog(null));
              }}
            >
              {isSaving ? "Saving..." : "Always allow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
