import { AgentAvatar } from "@/components/AgentAvatar";
import { TaskChatPausedTakeover } from "./task-chat/TaskChatPausedTakeover";
import { type ThreadMessage, AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  useRef,
  useState,
  useEffect,
  forwardRef,
  useLayoutEffect,
  useCallback,
  useImperativeHandle,
  memo,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLocation, Link } from "@/lib/router";
import { type FeedbackVoteValue, type IssueWorkMode, buildAgentMentionHref } from "@greatstone/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import { usePaperclipIssueRuntime } from "../hooks/usePaperclipIssueRuntime";
import {
  loadDraft,
  type ComposerDraftSubmission,
  loadDraftSubmission,
  saveDraft,
  saveDraftSubmission,
  loadDraftAttachments,
  saveDraftAttachments,
  settleDraftSubmission,
  clearDraftSubmission,
  clearDraft,
} from "../lib/composer-draft";
import { CommentSubmissionUnknownError } from "../lib/comment-submit-result";
import {
  buildIssueChatMessages,
  type StableThreadMessageCacheEntry,
  stabilizeThreadMessages,
} from "../lib/issue-chat-messages";
import { isLiveIssueRun } from "../lib/liveIssueIds";
import { resolveIssueChatTranscriptRuns } from "../lib/issueChatTranscriptRuns";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { type MarkdownEditorRef, MarkdownEditor } from "./MarkdownEditor";
import { InlineEntitySelector } from "./InlineEntitySelector";
import {
  type HandoffChipResolvers,
  ComposerMentionCoach,
  ComposerHandoffPreviewRow,
} from "./interrupt-handoff/InterruptHandoffViews";
import {
  type HandoffAgentMention,
  extractAgentMentionIds,
  findPlainAgentNameCandidate,
  computeComposerHandoffPreview,
} from "../lib/interrupt-handoff";
import { restoreSubmittedCommentDraft } from "../lib/comment-submit-draft";
import {
  captureComposerViewportSnapshot,
  restoreComposerViewportSnapshot,
  shouldPreserveComposerViewport,
} from "../lib/issue-chat-scroll";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { SystemNotice } from "./SystemNotice";
import { useComposerStop } from "@/hooks/useComposerStop";
import { formatDateTime, cn } from "../lib/utils";
import {
  workModeMetaList,
  workModeMetaFor,
  nextWorkMode,
  titleForPendingWorkMode,
} from "../lib/work-mode-meta";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Trash2,
  PaperclipIcon,
  Loader2,
  Check,
  AlertTriangle,
  X,
  ChevronDown,
  Square,
} from "lucide-react";
import { IssueBlockedNotice } from "./IssueBlockedNotice";
import { IssueAssignedBacklogNotice } from "./IssueAssignedBacklogNotice";
import { IssueRecoveryActionCard } from "./IssueRecoveryActionCard";
import {
  issueChatMessageCustom,
  issueChatMessageKind,
  issueChatMessageDeletedAt,
  issueChatMessageActiveVote,
  issueChatMessageRunIsActive,
  issueChatMessageRunIsStopping,
  issueChatMessageQueuedRunIsInterrupting,
  isUnassignedReassignValue,
  parseReassignment,
  shouldImplicitlyReopenComment,
  hasFilePayload,
  formatAttachmentSize,
  shouldRenderComposerHandoffPreview,
  toIsoString,
  issueChatMessageIsDeleted,
  useStableEvent,
} from "./issue-chat/helpers";
import { IssueChatUserMessage } from "./issue-chat/IssueChatUserMessage";
import { IssueChatAssistantMessage } from "./issue-chat/IssueChatAssistantMessage";
import { IssueChatSystemMessage } from "./issue-chat/IssueChatSystemMessage";
import type { IssueChatComposerHandle, IssueChatComposerProps, IssueChatThreadProps } from "./issue-chat/types";
import { type IssueChatMessageContext, IssueChatCtx } from "./issue-chat/IssueChatContext";
import { IssueChatErrorBoundary, IssueAssigneePausedNotice } from "./issue-chat/IssueChatFallback";
export type { IssueChatRunFinalizationAction } from "./issue-chat/IssueChatContext";
export { resolveAssistantMessageFoldedState, canStopIssueChatRun, shouldRenderComposerHandoffPreview, resolveIssueChatHumanAuthor } from "./issue-chat/helpers";
export type { IssueChatComposerHandle } from "./issue-chat/types";
export { IssueAssigneePausedNotice } from "./issue-chat/IssueChatFallback";
export { SuccessfulRunHandoffCommentCallout } from "./issue-chat/IssueChatParts";

const DRAFT_DEBOUNCE_MS = 800;
const COMPOSER_FOCUS_SCROLL_PADDING_PX = 96;
const SUBMIT_SCROLL_RESERVE_VH = 0.4;

type ComposerAttachmentItem = {
  id: string;
  attachmentId?: string;
  name: string;
  size: number;
  status: "uploading" | "attached" | "error";
  inline: boolean;
  contentPath?: string;
  error?: string;
};

// Above ~150 merged rows the direct render path forces React to mount and
// re-render hundreds of Markdown bodies, feedback controls, and avatars on
// unrelated parent updates. Above this threshold we switch to a windowed
// render path so only visible rows plus overscan stay mounted.
export const VIRTUALIZED_THREAD_ROW_THRESHOLD = 150;
const VIRTUALIZED_THREAD_OVERSCAN = 6;
// Rough "average row" estimate. The virtualizer measures real heights as
// rows mount, so this only affects offscreen rows it has not seen yet.
const VIRTUALIZED_THREAD_ROW_ESTIMATE_PX = 220;
const VIRTUALIZED_THREAD_GAP_FULL_PX = 16;
const VIRTUALIZED_THREAD_GAP_EMBEDDED_PX = 12;

interface VirtualizedIssueChatThreadListProps {
  messages: readonly ThreadMessage[];
  feedbackVoteByTargetId: ReadonlyMap<string, FeedbackVoteValue>;
  activeRunIds: ReadonlySet<string>;
  stoppingRunId?: string | null;
  interruptingQueuedRunId?: string | null;
  variant: "full" | "embedded";
}

interface VirtualizedIssueChatThreadListHandle {
  scrollToIndex: (
    index: number,
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: ScrollBehavior;
    },
  ) => void;
  scrollToLatest: (options?: { behavior?: ScrollBehavior }) => void;
  measure: () => void;
}

function issueChatMessageAnchorId(message: ThreadMessage): string | null {
  const custom = message.metadata.custom as { anchorId?: unknown } | undefined;
  return typeof custom?.anchorId === "string" ? custom.anchorId : null;
}

function findMessageAnchorIndex(
  messages: readonly ThreadMessage[],
  anchorId: string,
): number {
  return messages.findIndex(
    (message) => issueChatMessageAnchorId(message) === anchorId,
  );
}

export function findLatestCommentMessageIndex(
  messages: readonly ThreadMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const anchorId = issueChatMessageAnchorId(messages[index]);
    if (anchorId && anchorId.startsWith("comment-")) return index;
  }
  return -1;
}

type VirtualizedVisibleAnchorSnapshot = {
  anchorId: string;
  index: number;
  viewportTop: number;
};

type VirtualizedScrollMode =
  { kind: "window" } | { kind: "element"; element: HTMLElement };

type SimpleVirtualItem = {
  index: number;
  key: React.Key;
  start: number;
  size: number;
};

export function getVirtualizedMeasurementScrollAdjustment(args: {
  itemStart: number;
  previousSize: number;
  nextSize: number;
  viewportStart: number;
}) {
  const { itemStart, previousSize, nextSize, viewportStart } = args;
  const previousEnd = itemStart + previousSize;
  if (previousEnd > viewportStart) return 0;
  return nextSize - previousSize;
}

function useIssueThreadVirtualizer({
  count,
  estimateSize,
  overscan,
  scrollMargin,
  gap,
  getItemKey,
  mode,
}: {
  count: number;
  estimateSize: () => number;
  overscan: number;
  scrollMargin: number;
  gap: number;
  getItemKey: (index: number) => React.Key;
  mode: VirtualizedScrollMode;
}) {
  const measuredSizeByKeyRef = useRef(new Map<React.Key, number>());
  const [, rerender] = useState(0);
  const estimatedSize = estimateSize();

  const itemStarts: number[] = [];
  const itemSizes: number[] = [];
  let nextStart = scrollMargin;
  for (let index = 0; index < count; index += 1) {
    const key = getItemKey(index);
    const size = measuredSizeByKeyRef.current.get(key) ?? estimatedSize;
    itemStarts.push(nextStart);
    itemSizes.push(size);
    nextStart += size + gap;
  }
  const totalSize = Math.max(0, nextStart - scrollMargin - gap);

  const viewportHeight = () =>
    mode.kind === "window" ? window.innerHeight : mode.element.clientHeight;
  const scrollOffset = () =>
    mode.kind === "window" ? window.scrollY : mode.element.scrollTop;
  const maxScrollOffset = () => {
    const targetScrollHeight =
      mode.kind === "window"
        ? document.documentElement.scrollHeight
        : mode.element.scrollHeight;
    return Math.max(
      0,
      Math.max(targetScrollHeight, totalSize) - viewportHeight(),
    );
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const target: Window | HTMLElement =
      mode.kind === "window" ? window : mode.element;
    const update = () => rerender((value) => value + 1);
    target.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      target.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [mode]);

  const rawStart = Math.max(scrollMargin, scrollOffset());
  const rawEnd = rawStart + viewportHeight();
  let visibleStartIndex = 0;
  while (
    visibleStartIndex < count - 1 &&
    itemStarts[visibleStartIndex] + itemSizes[visibleStartIndex] < rawStart
  ) {
    visibleStartIndex += 1;
  }
  let visibleEndIndex = visibleStartIndex;
  while (visibleEndIndex < count - 1 && itemStarts[visibleEndIndex] <= rawEnd) {
    visibleEndIndex += 1;
  }
  const startIndex = Math.max(0, visibleStartIndex - overscan);
  const endIndex = Math.min(count - 1, visibleEndIndex + overscan);
  const virtualItems: SimpleVirtualItem[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    virtualItems.push({
      index,
      key: getItemKey(index),
      start: itemStarts[index] ?? scrollMargin,
      size: itemSizes[index] ?? estimatedSize,
    });
  }

  const scrollToIndex = (
    index: number,
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: ScrollBehavior;
    },
  ) => {
    const clampedIndex = Math.max(0, Math.min(index, count - 1));
    const targetMax = maxScrollOffset();
    let top = itemStarts[clampedIndex] ?? scrollMargin;
    if (options?.align === "center") {
      top =
        top -
        viewportHeight() / 2 +
        (itemSizes[clampedIndex] ?? estimatedSize) / 2;
    } else if (options?.align === "end") {
      top = top + (itemSizes[clampedIndex] ?? estimatedSize) - viewportHeight();
    }
    top = Math.max(0, Math.min(top, targetMax));
    if (mode.kind === "window") {
      window.scrollTo({ top, behavior: options?.behavior });
    } else {
      mode.element.scrollTo({ top, behavior: options?.behavior });
    }
    rerender((value) => value + 1);
  };

  return {
    getVirtualItems: () => virtualItems,
    getTotalSize: () => totalSize,
    scrollToIndex,
    measure: () => undefined,
    measureElement: (element?: HTMLElement | null) => {
      if (!element) return;
      const index = Number(element.dataset.index);
      if (!Number.isInteger(index) || index < 0 || index >= count) return;
      const measuredSize =
        element.getBoundingClientRect().height || element.offsetHeight;
      if (!Number.isFinite(measuredSize) || measuredSize <= 0) return;
      const key = getItemKey(index);
      const previousSize =
        measuredSizeByKeyRef.current.get(key) ?? estimatedSize;
      if (Math.abs(previousSize - measuredSize) < 1) return;
      const scrollAdjustment = getVirtualizedMeasurementScrollAdjustment({
        itemStart: itemStarts[index] ?? scrollMargin,
        previousSize,
        nextSize: measuredSize,
        viewportStart: Math.max(scrollMargin, scrollOffset()),
      });
      measuredSizeByKeyRef.current.set(key, measuredSize);
      if (Math.abs(scrollAdjustment) >= 1) {
        if (mode.kind === "window") {
          window.scrollBy({ top: scrollAdjustment, behavior: "auto" });
        } else {
          mode.element.scrollBy({ top: scrollAdjustment, behavior: "auto" });
        }
      }
      rerender((value) => value + 1);
    },
  };
}

// The chat thread renders inside `<main id="main-content">` on the real issue
// page (overflow-auto on desktop), but lives at document scope on mobile (main
// is overflow-visible) and in the auth-free perf fixture. Walk the DOM to find
// the actual scroll container so the virtualizer binds to the right offset
// source — otherwise it stays anchored at offset 0 forever and the visible
// chat area renders blank past the first viewport (PAP-2660).
function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  if (!el || typeof window === "undefined") return null;
  let current: HTMLElement | null = el.parentElement;
  while (
    current &&
    current !== document.body &&
    current !== document.documentElement
  ) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "overlay"
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

const VirtualizedIssueChatThreadList = forwardRef<
  VirtualizedIssueChatThreadListHandle,
  VirtualizedIssueChatThreadListProps
>(function VirtualizedIssueChatThreadList(props, ref) {
  const probeRef = useRef<HTMLDivElement | null>(null);
  // Default to window scroll on first render so the imperative handle is
  // available immediately for hash-target / submit-scroll effects. After mount
  // we probe the DOM and remount via key={modeKey} if the actual scroll
  // container is an element ancestor (e.g. desktop <main id="main-content">).
  const [mode, setMode] = useState<VirtualizedScrollMode>({ kind: "window" });

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const detect = () => {
      const probe = probeRef.current;
      if (!probe) return;
      const container = findScrollContainer(probe);
      setMode((prev) => {
        if (container === null) {
          return prev.kind === "window" ? prev : { kind: "window" };
        }
        if (prev.kind === "element" && prev.element === container) return prev;
        return { kind: "element", element: container };
      });
    };
    detect();
    window.addEventListener("resize", detect);
    return () => {
      window.removeEventListener("resize", detect);
    };
  }, []);

  return (
    <VirtualizedIssueChatThreadListInner
      key={mode.kind === "window" ? "window" : "element"}
      ref={ref}
      probeRef={probeRef}
      mode={mode}
      {...props}
    />
  );
});

interface VirtualizedIssueChatThreadListInnerProps extends VirtualizedIssueChatThreadListProps {
  mode: VirtualizedScrollMode;
  probeRef: React.MutableRefObject<HTMLDivElement | null>;
}

const VirtualizedIssueChatThreadListInner = forwardRef<
  VirtualizedIssueChatThreadListHandle,
  VirtualizedIssueChatThreadListInnerProps
>(function VirtualizedIssueChatThreadListInner(
  {
    messages,
    feedbackVoteByTargetId,
    activeRunIds,
    stoppingRunId,
    interruptingQueuedRunId,
    variant,
    mode,
    probeRef,
  },
  ref,
) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const pendingPrependAnchorRef =
    useRef<VirtualizedVisibleAnchorSnapshot | null>(null);

  const setRefs = useCallback(
    (element: HTMLDivElement | null) => {
      parentRef.current = element;
      probeRef.current = element;
    },
    [probeRef],
  );

  useLayoutEffect(() => {
    const element = parentRef.current;
    if (!element || typeof window === "undefined") return;
    const update = () => {
      if (!parentRef.current) return;
      const rect = parentRef.current.getBoundingClientRect();
      const offset =
        mode.kind === "window"
          ? rect.top + window.scrollY
          : rect.top -
            mode.element.getBoundingClientRect().top +
            mode.element.scrollTop;
      setScrollMargin((previous) =>
        Math.abs(previous - offset) < 0.5 ? previous : offset,
      );
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, [mode]);

  const gap =
    variant === "embedded"
      ? VIRTUALIZED_THREAD_GAP_EMBEDDED_PX
      : VIRTUALIZED_THREAD_GAP_FULL_PX;

  const virtualizer = useIssueThreadVirtualizer({
    count: messages.length,
    estimateSize: () => VIRTUALIZED_THREAD_ROW_ESTIMATE_PX,
    overscan: VIRTUALIZED_THREAD_OVERSCAN,
    scrollMargin,
    gap,
    getItemKey: (index) => messages[index]?.id ?? index,
    mode,
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index, options) => {
        if (index < 0 || index >= messages.length) return;
        virtualizer.scrollToIndex(index, {
          align: options?.align ?? "center",
          behavior: options?.behavior ?? "smooth",
        });
      },
      scrollToLatest: (options) => {
        if (messages.length === 0) return;
        virtualizer.scrollToIndex(messages.length - 1, {
          align: "end",
          behavior: options?.behavior ?? "smooth",
        });
      },
      measure: () => {
        virtualizer.measure();
      },
    }),
    [messages.length, virtualizer],
  );

  useLayoutEffect(() => {
    return () => {
      const element = parentRef.current;
      if (!element || typeof window === "undefined") return;
      const rows = Array.from(
        element.querySelectorAll<HTMLElement>("[data-anchor-id][data-index]"),
      );
      const visibleRow = rows.find(
        (row) => row.getBoundingClientRect().bottom >= 0,
      );
      if (!visibleRow) return;
      const anchorId = visibleRow.dataset.anchorId;
      const index = Number(visibleRow.dataset.index);
      if (!anchorId || !Number.isFinite(index)) return;
      pendingPrependAnchorRef.current = {
        anchorId,
        index,
        viewportTop: visibleRow.getBoundingClientRect().top,
      };
    };
  }, [messages]);

  useLayoutEffect(() => {
    const pendingAnchor = pendingPrependAnchorRef.current;
    pendingPrependAnchorRef.current = null;
    virtualizer.measure();
    if (!pendingAnchor || typeof window === "undefined") return;
    const nextIndex = findMessageAnchorIndex(messages, pendingAnchor.anchorId);
    if (nextIndex <= pendingAnchor.index) return;

    virtualizer.scrollToIndex(nextIndex, { align: "start", behavior: "auto" });
    requestAnimationFrame(() => {
      const element = document.getElementById(pendingAnchor.anchorId);
      if (!element) return;
      const delta =
        element.getBoundingClientRect().top - pendingAnchor.viewportTop;
      if (Math.abs(delta) > 1) {
        if (mode.kind === "window") {
          window.scrollBy({ top: delta, behavior: "auto" });
        } else {
          mode.element.scrollBy({ top: delta, behavior: "auto" });
        }
      }
      virtualizer.measure();
    });
  }, [messages, virtualizer, mode]);

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <div
      ref={setRefs}
      data-testid="issue-chat-thread-virtualizer"
      data-virtual-count={messages.length}
      style={{ position: "relative", width: "100%", height: totalSize }}
    >
      {virtualItems.map((virtualItem) => {
        const message = messages[virtualItem.index];
        if (!message) return null;
        const anchorId = issueChatMessageAnchorId(message);
        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            data-anchor-id={anchorId ?? undefined}
            data-testid="issue-chat-thread-virtual-row"
            ref={(element) => {
              if (element) virtualizer.measureElement(element);
            }}
            onLoadCapture={(event) => {
              virtualizer.measureElement(event.currentTarget);
            }}
            onClickCapture={(event) => {
              const row = event.currentTarget;
              requestAnimationFrame(() => {
                virtualizer.measureElement(row);
              });
            }}
            onTransitionEndCapture={(event) => {
              virtualizer.measureElement(event.currentTarget);
            }}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${virtualItem.start - scrollMargin}px)`,
            }}
          >
            <IssueChatMessageRow
              message={message}
              feedbackVoteByTargetId={feedbackVoteByTargetId}
              activeRunIds={activeRunIds}
              stoppingRunId={stoppingRunId}
              interruptingQueuedRunId={interruptingQueuedRunId}
            />
          </div>
        );
      })}
    </div>
  );
});

interface IssueChatMessageRowProps {
  message: ThreadMessage;
  feedbackVoteByTargetId: ReadonlyMap<string, FeedbackVoteValue>;
  activeRunIds: ReadonlySet<string>;
  stoppingRunId?: string | null;
  interruptingQueuedRunId?: string | null;
}

function IssueChatDeletedComment({
  message,
  deletedAt,
}: {
  message: ThreadMessage;
  deletedAt: string;
}) {
  const custom = issueChatMessageCustom(message);
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const authorName =
    typeof custom.authorName === "string" ? custom.authorName : "Comment";
  const deletedDate = new Date(deletedAt);
  const deletedDateLabel = Number.isNaN(deletedDate.getTime())
    ? ""
    : formatDateTime(deletedDate);

  return (
    <div id={anchorId} className="flex items-start gap-2.5 py-1.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
        <Trash2 className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground/80">{authorName}</span>
        <span> deleted this comment</span>
        {deletedDateLabel ? (
          <span className="text-xs"> · {deletedDateLabel}</span>
        ) : null}
      </div>
    </div>
  );
}

const IssueChatMessageRow = memo(function IssueChatMessageRow({
  message,
  feedbackVoteByTargetId,
  activeRunIds,
  stoppingRunId,
  interruptingQueuedRunId,
}: IssueChatMessageRowProps) {
  const kind = issueChatMessageKind(message);
  const deletedAt = issueChatMessageDeletedAt(message);
  const activeVote = issueChatMessageActiveVote(
    message,
    feedbackVoteByTargetId,
  );
  const isRunActive = issueChatMessageRunIsActive(message, activeRunIds);
  const isStoppingRun = issueChatMessageRunIsStopping(message, stoppingRunId);
  const isInterruptingQueuedRun = issueChatMessageQueuedRunIsInterrupting(
    message,
    interruptingQueuedRunId,
  );
  const renderedMessage = deletedAt ? (
    <IssueChatDeletedComment message={message} deletedAt={deletedAt} />
  ) : message.role === "user" ? (
    <IssueChatUserMessage
      message={message}
      isInterruptingQueuedRun={isInterruptingQueuedRun}
    />
  ) : message.role === "assistant" ? (
    <IssueChatAssistantMessage
      message={message}
      activeVote={activeVote}
      isRunActive={isRunActive}
      isStoppingRun={isStoppingRun}
    />
  ) : (
    <IssueChatSystemMessage message={message} />
  );

  return (
    <div
      data-testid="issue-chat-message-row"
      data-message-role={message.role}
      data-message-kind={kind}
    >
      {renderedMessage}
    </div>
  );
}, areIssueChatMessageRowPropsEqual);

function areIssueChatMessageRowPropsEqual(
  prev: IssueChatMessageRowProps,
  next: IssueChatMessageRowProps,
) {
  if (prev.message !== next.message) return false;
  if (
    issueChatMessageActiveVote(prev.message, prev.feedbackVoteByTargetId) !==
    issueChatMessageActiveVote(next.message, next.feedbackVoteByTargetId)
  )
    return false;
  if (
    issueChatMessageRunIsActive(prev.message, prev.activeRunIds) !==
    issueChatMessageRunIsActive(next.message, next.activeRunIds)
  )
    return false;
  if (
    issueChatMessageRunIsStopping(prev.message, prev.stoppingRunId) !==
    issueChatMessageRunIsStopping(next.message, next.stoppingRunId)
  )
    return false;
  if (
    issueChatMessageQueuedRunIsInterrupting(
      prev.message,
      prev.interruptingQueuedRunId,
    ) !==
    issueChatMessageQueuedRunIsInterrupting(
      next.message,
      next.interruptingQueuedRunId,
    )
  )
    return false;
  return true;
}

const IssueChatComposer = forwardRef<
  IssueChatComposerHandle,
  IssueChatComposerProps
>(function IssueChatComposer(
  {
    onSend,
    confirmedSubmissionIds,
    onReviewConversation,
    onStop,
    stopPending,
    stopScope = "leaf",
    onImageUpload,
    onAttachImage,
    draftKey,
    enableReassign = false,
    reassignOptions = [],
    currentAssigneeValue = "",
    suggestedAssigneeValue,
    mentions = [],
    agentMap,
    hasActiveRun = false,
    currentUserId = null,
    userLabelMap = null,
    composerPause = null,
    composerDisabledReason = null,
    composerHint = null,
    issueStatus,
    issueWorkMode,
    onWorkModeChange,
  },
  forwardedRef,
) {
  const stopControl = useComposerStop(onStop, stopPending);
  // Initialize before StrictMode's mount cleanup can flush an empty value over
  // the stored draft. The effect below handles subsequent task-key changes.
  const [body, setBody] = useState(() => (draftKey ? loadDraft(draftKey) : ""));
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState(false);
  const [uncertainSubmission, setUncertainSubmission] =
    useState<ComposerDraftSubmission | null>(() =>
      draftKey ? loadDraftSubmission(draftKey) : null,
    );
  const mountedTaskKey = useRef(draftKey);
  useEffect(() => {
    mountedTaskKey.current = draftKey;
    setUncertainSubmission(draftKey ? loadDraftSubmission(draftKey) : null);
    return () => {
      mountedTaskKey.current = undefined;
    };
  }, [draftKey]);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const pendingDraftRef = useRef<{
    draftKey: string;
    attemptId: string;
    submittedBody: string;
    submittedAttachmentIds: string[];
  } | null>(null);
  function changeBody(update: string | ((current: string) => string)) {
    const value = typeof update === "function" ? update(bodyRef.current) : update;
    bodyRef.current = value;
    setBody(value);
    const pending = pendingDraftRef.current;
    if (!pending || pending.draftKey !== draftKey ||
        loadDraftSubmission(pending.draftKey)?.attemptId !== pending.attemptId) return;
    // Persist the next draft while delivery is pending, before navigation or a
    // lost response can turn the original submission into an uncertain one.
    saveDraft(pending.draftKey,
      value ? `${pending.submittedBody}\n\n${value}` : pending.submittedBody,
      pending.attemptId);
    saveDraftSubmission(pending.draftKey, {
      attemptId: pending.attemptId, reviewed: false,
      nextDraftOffset: pending.submittedBody.length + (value ? 2 : 0),
      submittedAttachmentIds: pending.submittedAttachmentIds,
    });
  }
  const submittingRef = useRef(submitting);
  submittingRef.current = submitting;
  const [attaching, setAttaching] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [composerAttachments, setComposerAttachmentState] = useState<
    ComposerAttachmentItem[]
  >(() =>
    draftKey
      ? loadDraftAttachments(draftKey).map((item) => ({
          ...item,
          size: item.size ?? 0,
          id: `receipt:${item.attachmentId}`,
          status: "attached",
        }))
      : [],
  );
  const composerAttachmentsRef = useRef(composerAttachments);
  function setComposerAttachments(
    update:
      | ComposerAttachmentItem[]
      | ((previous: ComposerAttachmentItem[]) => ComposerAttachmentItem[]),
  ) {
    const next =
      typeof update === "function"
        ? update(composerAttachmentsRef.current)
        : update;
    composerAttachmentsRef.current = next;
    setComposerAttachmentState(next);
    const pending = pendingDraftRef.current;
    if (pending && pending.draftKey === draftKey) {
      saveDraftAttachments(pending.draftKey, next
        .filter(item => item.status === "attached" && item.attachmentId)
        .map(item => ({ ...item, inline: item.inline === true })), pending.attemptId);
    }
  }
  const dragDepthRef = useRef(0);
  const effectiveSuggestedAssigneeValue =
    suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(
    effectiveSuggestedAssigneeValue,
  );
  const [noAssigneeDialogOpen, setNoAssigneeDialogOpen] = useState(false);
  const [dismissedCoachToken, setDismissedCoachToken] = useState<string | null>(
    null,
  );
  const resolvedIssueWorkMode: IssueWorkMode = issueWorkMode ?? "standard";
  const [pendingWorkMode, setPendingWorkMode] = useState<IssueWorkMode>(
    resolvedIssueWorkMode,
  );
  const [workModeMenuOpen, setWorkModeMenuOpen] = useState(false);
  const canToggleWorkMode = typeof onWorkModeChange === "function";
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const reassignTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusAssigneeOnDialogCloseRef = useRef(false);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canAcceptFiles =
    !uncertainSubmission && Boolean(onImageUpload || onAttachImage);
  const uploadUnsettled =
    attaching || composerAttachments.some((item) => item.status !== "attached");
  const attachedFiles = composerAttachments.filter(
    (item) => item.status === "attached" && !item.inline && item.contentPath,
  );

  function queueViewportRestore(
    snapshot: ReturnType<typeof captureComposerViewportSnapshot>,
  ) {
    if (!snapshot) return;
    requestAnimationFrame(() => {
      restoreComposerViewportSnapshot(snapshot, composerContainerRef.current);
    });
  }

  function focusComposer() {
    if (typeof composerContainerRef.current?.scrollIntoView === "function") {
      composerContainerRef.current.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
    requestAnimationFrame(() => {
      window.scrollBy({
        top: COMPOSER_FOCUS_SCROLL_PADDING_PX,
        behavior: "smooth",
      });
      editorRef.current?.focus();
    });
  }

  useEffect(() => {
    if (!draftKey) return;
    setBody(loadDraft(draftKey));
    setComposerAttachments(
      loadDraftAttachments(draftKey).map((item) => ({
        ...item,
        size: item.size ?? 0,
        id: `receipt:${item.attachmentId}`,
        status: "attached",
      })),
    );
  }, [draftKey]);

  // A server receipt for this exact request settles a restored submission.
  // Text equality is not delivery proof: users may intentionally repeat text.
  useEffect(() => {
    if (!uncertainSubmission || !confirmedSubmissionIds.has(uncertainSubmission.attemptId)) return;
    const nextDraft = uncertainSubmission.nextDraftOffset === undefined
      ? "" : bodyRef.current.slice(uncertainSubmission.nextDraftOffset);
    if (draftKey) settleDraftSubmission(draftKey, uncertainSubmission.attemptId, nextDraft);
    setUncertainSubmission(null);
    setBody(nextDraft);
    bodyRef.current = nextDraft;
    const submittedIds = uncertainSubmission.submittedAttachmentIds;
    setComposerAttachments(current => submittedIds
      ? current.filter(item => !item.attachmentId || !submittedIds.includes(item.attachmentId))
      : []);
  }, [confirmedSubmissionIds, draftKey, uncertainSubmission]);

  useEffect(() => {
    if (
      !draftKey ||
      submitting ||
      composerAttachments !== composerAttachmentsRef.current
    )
      return;
    saveDraftAttachments(
      draftKey,
      composerAttachments.filter(
        (item) => item.status === "attached" && item.attachmentId,
      ),
    );
  }, [composerAttachments, draftKey, submitting]);

  useEffect(() => {
    if (!draftKey || submitting) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey, submitting]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (draftKey && !submittingRef.current)
        saveDraft(draftKey, bodyRef.current);
    };
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    const flushDraft = () => {
      if (!submittingRef.current) saveDraft(draftKey, bodyRef.current);
    };
    window.addEventListener("beforeunload", flushDraft);
    return () => window.removeEventListener("beforeunload", flushDraft);
  }, [draftKey]);

  useEffect(() => {
    setReassignTarget(effectiveSuggestedAssigneeValue);
  }, [effectiveSuggestedAssigneeValue]);

  useEffect(() => {
    setPendingWorkMode(resolvedIssueWorkMode);
  }, [resolvedIssueWorkMode]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: focusComposer,
      restoreDraft: (submittedBody: string) => {
        setBody((current) =>
          restoreSubmittedCommentDraft({
            currentBody: current,
            submittedBody,
          }),
        );
        focusComposer();
      },
    }),
    [],
  );

  const showStop =
    !submitting &&
    !attaching &&
    body.trim().length === 0 &&
    composerAttachments.length === 0 &&
    Boolean(onStop || stopControl.stopping);

  async function handleSubmit() {
    if (composerPause) return;
    const trimmed = body.trim();
    if (
      (!trimmed && attachedFiles.length === 0) ||
      submitting ||
      uploadUnsettled ||
      uncertainSubmission
    )
      return;

    const composerHasAssigneePicker =
      enableReassign && reassignOptions.length > 0;
    if (
      composerHasAssigneePicker &&
      isUnassignedReassignValue(reassignTarget)
    ) {
      setNoAssigneeDialogOpen(true);
      return;
    }

    await submitComment();
  }

  async function submitComment() {
    if (composerPause) return;
    const trimmed = body.trim();
    if (
      (!trimmed && attachedFiles.length === 0) ||
      submitting ||
      uploadUnsettled ||
      uncertainSubmission
    )
      return;

    const hasReassignment =
      enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment
      ? (parseReassignment(reassignTarget) ?? undefined)
      : undefined;
    const reopen = shouldImplicitlyReopenComment(
      issueStatus,
      hasReassignment ? reassignTarget : currentAssigneeValue,
    )
      ? true
      : undefined;
    const submittedBody = [
      trimmed,
      ...attachedFiles.map(
        (item) =>
          `[${item.name.replace(/[[\]]/g, "\\$&")}](${item.contentPath})`,
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
    const submittedAttachmentKeys = new Set(
      composerAttachments.map((item) => item.id),
    );
    const attachmentIds = [
      ...new Set(
        composerAttachments
          .filter(
            (item) =>
              item.status === "attached" &&
              item.attachmentId &&
              (!item.inline ||
                (item.contentPath && trimmed.includes(item.contentPath))),
          )
          .map((item) => item.attachmentId!),
      ),
    ];
    const viewportSnapshot = captureComposerViewportSnapshot(
      composerContainerRef.current,
    );

    const workModeChanged = pendingWorkMode !== resolvedIssueWorkMode;
    if (draftKey) saveDraft(draftKey, trimmed);
    setSubmitting(true);
    bodyRef.current = "";
    setBody("");
    let attemptId: string | null = null;
    try {
      if (workModeChanged && onWorkModeChange) {
        await onWorkModeChange(pendingWorkMode);
      }
      const retained = draftKey ? loadDraftSubmission(draftKey) : null;
      if (retained) {
        setUncertainSubmission(retained);
        setBody(trimmed);
        return;
      }
      attemptId = crypto.randomUUID();
      if (draftKey) {
        saveDraft(draftKey, trimmed);
        saveDraftSubmission(draftKey, { attemptId, reviewed: false });
        pendingDraftRef.current = { draftKey, attemptId, submittedBody: trimmed, submittedAttachmentIds: attachmentIds };
        changeBody(bodyRef.current);
      }
      // assistant-ui thread.append is fire-and-forget. Await the actual Board
      // mutation; it already owns optimistic echo and durable error handling.
      const sendPromise = onSend(
        submittedBody, reopen, reassignment,
        attachmentIds.length ? attachmentIds : undefined, attemptId,
      );
      queueViewportRestore(viewportSnapshot);
      await sendPromise;
      // Settle the captured task even if the user navigated away. The exact
      // attempt guard preserves any newer submission in this or another tab.
      if (draftKey) settleDraftSubmission(draftKey, attemptId,
        mountedTaskKey.current === draftKey ? bodyRef.current : undefined);
      if (mountedTaskKey.current !== draftKey) return;
      setComposerAttachments((current) =>
        current.filter((item) => !submittedAttachmentKeys.has(item.id)),
      );
      setReassignTarget(effectiveSuggestedAssigneeValue);
    } catch (error) {
      if (mountedTaskKey.current !== draftKey) return;
      const nextDraft = bodyRef.current;
      if (attemptId && error instanceof CommentSubmissionUnknownError) {
        const uncertain = {
          attemptId, reviewed: false,
          nextDraftOffset: trimmed.length + (nextDraft ? 2 : 0),
          submittedAttachmentIds: attachmentIds,
        };
        setUncertainSubmission(uncertain);
        if (draftKey && loadDraftSubmission(draftKey)?.attemptId === attemptId)
          saveDraftSubmission(draftKey, uncertain);
      } else if (draftKey && attemptId)
        clearDraftSubmission(draftKey, attemptId);
      const restoredBody = nextDraft ? `${trimmed}\n\n${nextDraft}` : trimmed;
      if (draftKey) saveDraft(draftKey, restoredBody, attemptId ?? undefined);
      setBody(restoredBody);
    } finally {
      if (pendingDraftRef.current?.attemptId === attemptId) pendingDraftRef.current = null;
      setSubmitting(false);
      queueViewportRestore(viewportSnapshot);
    }
  }

  async function attachFile(
    file: File,
    insertInline = true,
  ): Promise<string | undefined> {
    const attachmentId = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
    const inline = file.type.startsWith("image/");
    setComposerAttachments((prev) => [
      ...prev,
      {
        id: attachmentId,
        name: file.name,
        size: file.size,
        status: "uploading",
        inline,
      },
    ]);

    try {
      if (!onAttachImage && onImageUpload && inline) {
        const url = await onImageUpload(file);
        if (
          !composerAttachmentsRef.current.some(
            (item) => item.id === attachmentId,
          )
        )
          return undefined;
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        if (insertInline)
          changeBody((prev) => (prev ? `${prev}\n\n${markdown}` : markdown));
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? { ...item, status: "attached", contentPath: url }
              : item,
          ),
        );
        return url;
      } else if (onAttachImage) {
        const attachment = await onAttachImage(file);
        if (!attachment?.contentPath)
          throw new Error("Upload did not return a file URL");
        if (
          !composerAttachmentsRef.current.some(
            (item) => item.id === attachmentId,
          )
        )
          return undefined;
        if (inline && insertInline) {
          const markdown = `![${file.name.replace(/[[\]]/g, "\\$&")}](${attachment.contentPath})`;
          changeBody((prev) => (prev ? `${prev}\n\n${markdown}` : markdown));
        }
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? {
                  ...item,
                  status: "attached",
                  attachmentId: attachment.id,
                  contentPath: attachment?.contentPath,
                  name: attachment?.originalFilename ?? item.name,
                }
              : item,
          ),
        );
        return attachment.contentPath;
      } else {
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? {
                  ...item,
                  status: "error",
                  error: "This file type cannot be attached here",
                }
              : item,
          ),
        );
      }
    } catch (err) {
      setComposerAttachments((prev) =>
        prev.map((item) =>
          item.id === attachmentId
            ? {
                ...item,
                status: "error",
                error: err instanceof Error ? err.message : "Upload failed",
              }
            : item,
        ),
      );
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      await attachFile(file);
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  async function handleDroppedFiles(files: FileList | null | undefined) {
    if (!files || files.length === 0) return;
    setAttaching(true);
    try {
      for (const file of Array.from(files)) {
        await attachFile(file);
      }
    } finally {
      setAttaching(false);
    }
  }

  function resetDragState() {
    dragDepthRef.current = 0;
    setIsDragOver(false);
  }

  function handleFileDragEnter(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleFileDragOver(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.dataTransfer.dropEffect = "copy";
  }

  function handleFileDragLeave(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }

  function handleFileDrop(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    resetDragState();
    void handleDroppedFiles(evt.dataTransfer?.files);
  }

  const canSubmit =
    !submitting &&
    !uploadUnsettled &&
    !uncertainSubmission &&
    (!!body.trim() || attachedFiles.length > 0);

  // Interrupt-handoff clarity (PAP-10669): preview what this comment will durably
  // do, and coach plain agent names toward real mentions.
  const agentMentionOptions = useMemo<HandoffAgentMention[]>(
    () =>
      mentions
        .filter((m) => (m.kind ?? "agent") === "agent" && (m.agentId ?? m.id))
        .map((m) => ({
          agentId: m.agentId ?? m.id.replace(/^agent:/, ""),
          name: m.name,
        })),
    [mentions],
  );
  const handoffResolvers = useMemo<HandoffChipResolvers>(
    () => ({
      agentMap,
      currentUserId,
      resolveUserLabel: (userId: string) =>
        formatAssigneeUserLabel(userId, null, userLabelMap),
    }),
    [agentMap, currentUserId, userLabelMap],
  );
  const mentionedAgentIds = useMemo(() => extractAgentMentionIds(body), [body]);
  const plainNameCandidate = useMemo(
    () =>
      mentionedAgentIds.length > 0
        ? null
        : findPlainAgentNameCandidate(body, agentMentionOptions),
    [body, mentionedAgentIds, agentMentionOptions],
  );
  const handoffPreview = useMemo(
    () =>
      computeComposerHandoffPreview({
        reassignTarget,
        currentAssigneeValue,
        hasActiveRun,
        bodyHasAgentMention: mentionedAgentIds.length > 0,
        mentionedAgentId: mentionedAgentIds[0] ?? null,
        plainNameCandidate,
      }),
    [
      reassignTarget,
      currentAssigneeValue,
      hasActiveRun,
      mentionedAgentIds,
      plainNameCandidate,
    ],
  );
  const coachVisible = Boolean(
    plainNameCandidate &&
    plainNameCandidate.matchedText !== dismissedCoachToken,
  );
  const coachAgentName = plainNameCandidate
    ? (agentMap?.get(plainNameCandidate.agentId)?.name ??
      plainNameCandidate.matchedText)
    : "";

  function insertCoachMention() {
    if (!plainNameCandidate) return;
    const option = mentions.find(
      (m) =>
        (m.agentId ?? m.id.replace(/^agent:/, "")) ===
        plainNameCandidate.agentId,
    );
    const agentId = plainNameCandidate.agentId;
    const name = option?.name ?? plainNameCandidate.matchedText;
    const markdown = `[@${name}](${buildAgentMentionHref(agentId, option?.agentIcon ?? null)}) `;
    // Replace the first bare occurrence of the matched token (outside links).
    const tokenRe = new RegExp(
      `(?<![\\w@/])${plainNameCandidate.matchedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`,
      "i",
    );
    changeBody((current) => {
      if (tokenRe.test(current))
        return current.replace(tokenRe, markdown.trimEnd());
      return current ? `${current} ${markdown}` : markdown;
    });
    setDismissedCoachToken(plainNameCandidate.matchedText);
  }

  if (composerPause) {
    return <TaskChatPausedTakeover {...composerPause} hasDraft={Boolean(body.trim() || attachedFiles.length)} />;
  }

  if (composerDisabledReason) {
    return (
      <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
        {composerDisabledReason}
      </div>
    );
  }

  const workModeOptions = workModeMetaList();
  const pendingWorkModeMeta = workModeMetaFor(pendingWorkMode);
  const PendingWorkModeIcon = pendingWorkModeMeta.icon;

  function handleComposerKeyDown(evt: ReactKeyboardEvent<HTMLDivElement>) {
    // Match the period via both `code` and `key`: iOS Safari with a hardware
    // keyboard often leaves `code` empty for cmd-period, so relying on it alone
    // lets the event fall through and triggers Safari's default cancel/dismiss
    // (which closes the view). Catching `key === "."` keeps the shortcut working
    // on iOS while preserving desktop behavior.
    const isPeriod = evt.code === "Period" || evt.key === ".";
    if (!(evt.metaKey || evt.ctrlKey) || !isPeriod) return;
    evt.preventDefault();
    setPendingWorkMode((current) => nextWorkMode(current));
  }

  return (
    <div
      ref={composerContainerRef}
      data-testid="issue-chat-composer"
      data-pending-work-mode={pendingWorkMode}
      className={cn(
        "relative rounded-md border border-border/70 bg-background/95 p-(--sz-15px) shadow-(--shadow-extract-4) backdrop-blur transition-(--tp-border-color-background-color-box-shadow) duration-150 supports-[backdrop-filter]:bg-background/85 dark:shadow-(--shadow-extract-5)",
        pendingWorkModeMeta.classes.container,
        isDragOver &&
          "border-primary/45 bg-background shadow-(--shadow-extract-7)",
      )}
      onKeyDownCapture={handleComposerKeyDown}
      onDragEnterCapture={handleFileDragEnter}
      onDragOverCapture={handleFileDragOver}
      onDragLeaveCapture={handleFileDragLeave}
      onDropCapture={handleFileDrop}
    >
      {isDragOver && canAcceptFiles ? (
        <div
          data-testid="issue-chat-composer-drop-overlay"
          className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-sm border border-dashed border-primary/55 bg-background/75 px-4 py-3 text-center shadow-sm backdrop-blur-(--blur-2px) dark:bg-background/65"
        >
          <div className="flex max-w-md items-center gap-3 rounded-md bg-background/80 px-3 py-2 text-left shadow-sm ring-1 ring-border/60">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <PaperclipIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                Drop to upload
              </div>
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Images insert into the reply. Other files are added to this
                task.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {uncertainSubmission ? (
        <div
          role="alert"
          className="mb-3 space-y-2 rounded-md border border-border bg-muted p-3 text-sm"
        >
          <p>
            We couldn’t confirm whether this comment was saved. It may already
            be in the conversation. Review it before starting another draft.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              setReviewError(false);
              try {
                if (!onReviewConversation)
                  throw new Error("Review unavailable");
                await onReviewConversation();
                if (mountedTaskKey.current !== draftKey) return;
                const reviewed = { ...uncertainSubmission, reviewed: true };
                setUncertainSubmission(reviewed);
                if (
                  draftKey &&
                  loadDraftSubmission(draftKey)?.attemptId ===
                    reviewed.attemptId
                )
                  saveDraftSubmission(draftKey, reviewed);
              } catch {
                setReviewError(true);
              }
            }}
          >
            Review conversation
          </Button>
          {reviewError ? (
            <p>Couldn’t refresh the conversation. Try reviewing it again.</p>
          ) : null}
          {uncertainSubmission.reviewed ? (
            <>
              <p>
                Discarding this draft does not remove any saved comment or
                uploaded file.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (draftKey)
                    clearDraft(draftKey, uncertainSubmission.attemptId);
                  bodyRef.current = "";
                  setBody("");
                  setComposerAttachments([]);
                  setUncertainSubmission(null);
                }}
              >
                Discard draft and start new
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <MarkdownEditor
        ref={editorRef}
        readOnly={!!uncertainSubmission}
        value={body}
        onChange={changeBody}
        placeholder="Reply"
        mentions={mentions}
        onSubmit={handleSubmit}
        imageUploadHandler={
          canAcceptFiles
            ? async (file) => {
                const url = await attachFile(file, false);
                if (!url) throw new Error("Upload did not return a file URL");
                return url;
              }
            : undefined
        }
        fileDropTarget="parent"
        bordered={false}
        contentClassName="max-h-(--sz-28dvh) overflow-y-auto pr-1 pb-2 text-sm scrollbar-auto-hide"
      />

      {coachVisible && plainNameCandidate ? (
        <div className="mt-2">
          <ComposerMentionCoach
            candidate={plainNameCandidate}
            agentDisplayName={coachAgentName}
            onInsert={insertCoachMention}
            onDismiss={() =>
              setDismissedCoachToken(plainNameCandidate.matchedText)
            }
          />
        </div>
      ) : null}

      {composerHint ? (
        <div className="inline-flex items-center rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-(length:--text-micro) text-muted-foreground">
          {composerHint}
        </div>
      ) : null}

      {composerAttachments.length > 0 ? (
        <div
          data-testid="issue-chat-composer-attachments"
          className="mb-3 mt-2 space-y-1.5 rounded-md border border-dashed border-border/80 bg-muted/20 p-2"
        >
          {composerAttachments.map((attachment) => {
            const sizeLabel = formatAttachmentSize(attachment.size);
            const statusLabel =
              attachment.status === "uploading"
                ? "Uploading to task"
                : attachment.status === "error"
                  ? (attachment.error ?? "Upload failed")
                  : attachment.inline
                    ? "Inserted inline"
                    : "Attached to task";
            return (
              <div
                key={attachment.id}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-xs",
                  attachment.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-background/70 text-muted-foreground",
                )}
              >
                {attachment.status === "uploading" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : attachment.status === "attached" ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {attachment.name}
                </span>
                {sizeLabel ? (
                  <span className="shrink-0 text-muted-foreground">
                    {sizeLabel}
                  </span>
                ) : null}
                <span className="shrink-0 text-muted-foreground">
                  {statusLabel}
                </span>
                {!attachment.inline || attachment.status !== "attached" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${attachment.name}`}
                    disabled={!!uncertainSubmission}
                    onClick={() =>
                      setComposerAttachments((current) =>
                        current.filter((item) => item.id !== attachment.id),
                      )
                    }
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {shouldRenderComposerHandoffPreview(body, handoffPreview) ? (
        <div className="my-2">
          <ComposerHandoffPreviewRow
            preview={handoffPreview}
            resolvers={handoffResolvers}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="mr-auto flex items-center gap-2">
          {canAcceptFiles ? (
            <>
              <input
                ref={attachInputRef}
                type="file"
                className="hidden"
                onChange={handleAttachFile}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => attachInputRef.current?.click()}
                disabled={attaching}
                title="Attach file"
              >
                <PaperclipIcon className="h-4 w-4" />
              </Button>
            </>
          ) : null}
          {canToggleWorkMode ? (
            <Popover open={workModeMenuOpen} onOpenChange={setWorkModeMenuOpen}>
              <PopoverTrigger asChild>
                {/* Single persistent mode chip (PAP-95b mockup rev 5): yellow in
                    planning, neutral in standard, caret opens the switch menu. */}
                <button
                  type="button"
                  data-testid="issue-chat-composer-work-mode-toggle"
                  data-pending-work-mode={pendingWorkMode}
                  aria-haspopup="menu"
                  aria-expanded={workModeMenuOpen}
                  aria-pressed={pendingWorkMode !== "standard"}
                  aria-keyshortcuts="Meta+Period Control+Period"
                  title={titleForPendingWorkMode(pendingWorkMode)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-(length:--text-micro) font-semibold transition-colors",
                    pendingWorkModeMeta.classes.chip,
                  )}
                >
                  <PendingWorkModeIcon className="h-3.5 w-3.5" aria-hidden />
                  <span>{pendingWorkModeMeta.label}</span>
                  <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-44 p-1"
                align="start"
                data-testid="issue-chat-composer-work-mode-menu"
              >
                {workModeOptions.map((option) => {
                  const Icon = option.icon;
                  const active = option.value === pendingWorkMode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-testid={`issue-chat-composer-work-mode-menu-${option.value}`}
                      data-pending-work-mode={pendingWorkMode}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                        active && "bg-accent",
                        option.classes.menuItem,
                      )}
                      onClick={() => {
                        setPendingWorkMode(option.value);
                        setWorkModeMenuOpen(false);
                      }}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>{option.label}</span>
                      {active ? (
                        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      ) : null}
                    </button>
                  );
                })}
                <div className="mt-1 border-t px-2 py-1.5 text-(length:--text-nano) text-muted-foreground">
                  Cmd/Ctrl+. cycles modes
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>

        {enableReassign && reassignOptions.length > 0 ? (
          <InlineEntitySelector
            ref={reassignTriggerRef}
            value={reassignTarget}
            options={reassignOptions}
            placeholder="Responsible"
            noneLabel="No responsible"
            searchPlaceholder="Search responsible..."
            emptyMessage="No responsible found."
            onChange={setReassignTarget}
            className="h-8 text-xs"
            renderTriggerValue={(option) => {
              if (!option)
                return (
                  <span className="text-muted-foreground">Responsible</span>
                );
              const agentId = option.id.startsWith("agent:")
                ? option.id.slice("agent:".length)
                : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentAvatar agent={agent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
            renderOption={(option) => {
              if (!option.id)
                return <span className="truncate">{option.label}</span>;
              const agentId = option.id.startsWith("agent:")
                ? option.id.slice("agent:".length)
                : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentAvatar agent={agent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        ) : null}

        {showStop ? (
          <Button
            size="icon-sm"
            disabled={stopControl.stopping}
            onClick={() => void stopControl.stop()}
            aria-label={stopControl.stopping ? "Stopping…" : "Stop"}
            title="Stop response"
          >
            {stopControl.stopping ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Square className="h-4 w-4 fill-current" aria-hidden />
            )}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {submitting ? "Posting..." : "Send"}
          </Button>
        )}
      </div>

      {stopControl.error ? (
        <p role="alert" className="text-xs text-destructive">
          {stopControl.error}
        </p>
      ) : null}

      {/* No-assignee warning modal (PAP-128 C): replaces the old press-Send-again toast. */}
      <AlertDialog
        open={noAssigneeDialogOpen}
        onOpenChange={setNoAssigneeDialogOpen}
      >
        <AlertDialogContent
          data-testid="issue-chat-no-assignee-dialog"
          onCloseAutoFocus={(event) => {
            if (!focusAssigneeOnDialogCloseRef.current) return;
            event.preventDefault();
            focusAssigneeOnDialogCloseRef.current = false;
            reassignTriggerRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>No responsible selected</AlertDialogTitle>
            <AlertDialogDescription>
              This comment will be posted without an assignee, so no agent will
              be woken to act on it. Go back to pick a responsible, or send
              anyway.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="issue-chat-no-assignee-go-back"
              onClick={() => {
                focusAssigneeOnDialogCloseRef.current = true;
              }}
            >
              Go back
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="issue-chat-no-assignee-send-anyway"
              onClick={() => {
                void submitComment();
              }}
            >
              Send anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});

export function IssueChatThread({
  comments,
  interactions = [],
  feedbackVotes = [],
  feedbackDataSharingPreference = "prompt",
  feedbackTermsUrl = null,
  linkedRuns = [],
  timelineEvents = [],
  liveRuns = [],
  activeRun = null,
  issueId = null,
  blockedBy = [],
  liveIssueIds,
  blockerAttention = null,
  successfulRunHandoff = null,
  scheduledRetry = null,
  recoveryAction = null,
  onResolveRecoveryAction,
  onReissueIsolatedRecoveryAction,
  reissueIsolatedRecoveryActionPending = false,
  onReconcileForwardRecoveryAction,
  onBreakGlassOverrideRecoveryAction,
  onQuarantineRestoreRecoveryAction,
  quarantineRestoreRecoveryActionPending = false,
  canBreakGlassRecoveryAction = false,
  reconcileRecoveryActionPending = false,
  canFalsePositiveRecoveryAction = false,
  legacyRecoverySourceIssue = null,
  companyId,
  projectId,
  issueStatus,
  issueAssigneeAgentId = null,
  agentMap,
  currentUserId,
  userLabelMap,
  userProfileMap,
  onVote,
  onAdd,
  onReviewConversation,
  onCancelRun,
  stopPending,
  stopScope,
  onStopRun,
  stopRunLabel,
  stoppingRunLabel,
  stopRunVariant,
  runFinalizationActions,
  imageUploadHandler,
  onAttachImage,
  draftKey,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions = [],
  composerPause = null,
  composerDisabledReason = null,
  composerHint = null,
  showComposer = true,
  showJumpToLatest,
  autoScrollToLatestOnInitialLoad = false,
  autoScrollToHashOnInitialLoad = false,
  emptyMessage,
  footer,
  variant = "full",
  enableLiveTranscriptPolling = true,
  transcriptsByRunId,
  hasOutputForRun: hasOutputForRunOverride,
  includeSucceededRunsWithoutOutput = false,
  onInterruptQueued,
  onCancelQueued,
  onDeleteComment,
  interruptingQueuedRunId = null,
  stoppingRunId = null,
  onImageClick,
  onAcceptInteraction,
  onRejectInteraction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  onSubmitInteractionVerdicts,
  composerRef,
  composerAccessory,
  issueWorkMode,
  onWorkModeChange,
  onRefreshLatestComments,
  assigneeUserId = null,
  onResumeFromBacklog,
  resumeFromBacklogPending = false,
  onResumeAssignee,
  resumeAssigneePending = false,
  onTryAgainNoLiveExecutionPath: _onTryAgainNoLiveExecutionPath,
  tryAgainNoLiveExecutionPathPending: _tryAgainNoLiveExecutionPathPending,
  onRetryFailedRun: _onRetryFailedRun,
  retryFailedRunId: _retryFailedRunId,
  externalReferences,
  linkCaseReferences = false,
}: IssueChatThreadProps) {
  const location = useLocation();
  const lastScrolledHashRef = useRef<string | null>(null);
  const didInitialHashScrollDecisionRef = useRef(false);
  const virtualizedThreadRef =
    useRef<VirtualizedIssueChatThreadListHandle | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const composerViewportAnchorRef = useRef<HTMLDivElement | null>(null);
  const composerViewportSnapshotRef =
    useRef<ReturnType<typeof captureComposerViewportSnapshot>>(null);
  const preserveComposerViewportRef = useRef(false);
  const pendingSubmitScrollRef = useRef(false);
  const lastUserMessageIdRef = useRef<string | null>(null);
  const didInitialLatestScrollRef = useRef(false);
  const spacerBaselineAnchorRef = useRef<string | null>(null);
  const spacerInitialReserveRef = useRef(0);
  const latestSettleTimeoutsRef = useRef<number[]>([]);
  const latestSettleCleanupRef = useRef<(() => void) | null>(null);
  const [bottomSpacerHeight, setBottomSpacerHeight] = useState(0);
  const displayLiveRuns = useMemo(() => {
    const deduped = new Map<string, LiveRunForIssue>();
    for (const run of liveRuns) {
      if (!isLiveIssueRun(run, issueStatus)) continue;
      deduped.set(run.id, run);
    }
    if (activeRun && isLiveIssueRun(activeRun, issueStatus)) {
      deduped.set(activeRun.id, {
        id: activeRun.id,
        status: activeRun.status,
        invocationSource: activeRun.invocationSource,
        triggerDetail: activeRun.triggerDetail,
        contextCommentId: activeRun.contextCommentId,
        contextWakeCommentId: activeRun.contextWakeCommentId,
        startedAt: toIsoString(activeRun.startedAt),
        finishedAt: toIsoString(activeRun.finishedAt),
        createdAt: toIsoString(activeRun.createdAt) ?? new Date().toISOString(),
        agentId: activeRun.agentId,
        agentName: activeRun.agentName,
        adapterType: activeRun.adapterType,
        logBytes: activeRun.logBytes,
        lastOutputBytes: activeRun.lastOutputBytes,
        issueId: activeRun.issueId,
        livenessState: activeRun.livenessState,
        livenessReason: activeRun.livenessReason,
        continuationAttempt: activeRun.continuationAttempt,
        lastUsefulActionAt: toIsoString(activeRun.lastUsefulActionAt),
        nextAction: activeRun.nextAction,
        outputSilence: activeRun.outputSilence,
        currentStatusMessage: activeRun.currentStatusMessage ?? null,
        currentStatusUpdatedAt: toIsoString(activeRun.currentStatusUpdatedAt),
        currentToolName: activeRun.currentToolName ?? null,
        lastAssistantSnippet: activeRun.lastAssistantSnippet ?? null,
        lastEventAt: toIsoString(activeRun.lastEventAt),
      });
    }
    return [...deduped.values()].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [activeRun, issueStatus, liveRuns]);
  const transcriptRuns = useMemo(() => {
    return resolveIssueChatTranscriptRuns({
      linkedRuns,
      liveRuns: displayLiveRuns,
      activeRun,
    });
  }, [activeRun, displayLiveRuns, linkedRuns]);
  const activeRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of displayLiveRuns) {
      if (run.status === "queued" || run.status === "running") {
        ids.add(run.id);
      }
    }
    return ids;
  }, [displayLiveRuns]);
  const hasActiveRun = useMemo(
    () => displayLiveRuns.some((run) => run.status === "running"),
    [displayLiveRuns],
  );
  // Real-time view of the handoff: a run that starts after the issue payload
  // was fetched must quiet the missing-disposition warnings without waiting
  // for a refetch to update `hasLiveContinuation`.
  const successfulRunHandoffWithLiveness = useMemo(() => {
    if (!successfulRunHandoff || successfulRunHandoff.hasLiveContinuation) {
      return successfulRunHandoff ?? null;
    }
    const liveNow =
      activeRunIds.size > 0 || Boolean(issueId && liveIssueIds?.has(issueId));
    return liveNow
      ? { ...successfulRunHandoff, hasLiveContinuation: true }
      : successfulRunHandoff;
  }, [successfulRunHandoff, activeRunIds, issueId, liveIssueIds]);
  const clearLatestSettleTimeouts = useCallback(() => {
    for (const timeout of latestSettleTimeoutsRef.current) {
      window.clearTimeout(timeout);
    }
    latestSettleTimeoutsRef.current = [];
    latestSettleCleanupRef.current?.();
    latestSettleCleanupRef.current = null;
  }, []);

  useEffect(() => clearLatestSettleTimeouts, [clearLatestSettleTimeouts]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: enableLiveTranscriptPolling ? transcriptRuns : [],
    companyId,
  });
  const resolvedTranscriptByRun = transcriptsByRunId ?? transcriptByRun;
  const resolvedHasOutputForRun = hasOutputForRunOverride ?? hasOutputForRun;
  const rawMessages = useMemo(
    () =>
      buildIssueChatMessages({
        comments,
        interactions,
        timelineEvents,
        linkedRuns,
        liveRuns,
        activeRun,
        transcriptsByRunId: resolvedTranscriptByRun,
        hasOutputForRun: resolvedHasOutputForRun,
        includeSucceededRunsWithoutOutput,
        companyId,
        projectId,
        agentMap,
        currentUserId,
        userLabelMap,
        issueStatus,
      }),
    [
      comments,
      interactions,
      timelineEvents,
      linkedRuns,
      liveRuns,
      activeRun,
      resolvedTranscriptByRun,
      resolvedHasOutputForRun,
      includeSucceededRunsWithoutOutput,
      companyId,
      projectId,
      agentMap,
      currentUserId,
      userLabelMap,
      issueStatus,
    ],
  );
  const stableMessagesRef = useRef<readonly ThreadMessage[]>([]);
  const stableMessageCacheRef = useRef<
    Map<string, StableThreadMessageCacheEntry>
  >(new Map());
  const messages = useMemo(() => {
    const stabilized = stabilizeThreadMessages(
      rawMessages,
      stableMessagesRef.current,
      stableMessageCacheRef.current,
    );
    stableMessagesRef.current = stabilized.messages;
    stableMessageCacheRef.current = stabilized.cache;
    return stabilized.messages;
  }, [rawMessages]);
  const latestMessagesRef = useRef<readonly ThreadMessage[]>(messages);
  latestMessagesRef.current = messages;

  const isRunning = displayLiveRuns.some(
    (run) => run.status === "queued" || run.status === "running",
  );
  const unresolvedBlockers = useMemo(
    () =>
      blockedBy.filter(
        (blocker) =>
          blocker.status !== "done" && blocker.status !== "cancelled",
      ),
    [blockedBy],
  );
  const assignedAgent = useMemo(() => {
    if (!currentAssigneeValue.startsWith("agent:")) return null;
    const assigneeAgentId = currentAssigneeValue.slice("agent:".length);
    return agentMap?.get(assigneeAgentId) ?? null;
  }, [agentMap, currentAssigneeValue]);
  const feedbackVoteByTargetId = useMemo(() => {
    const map = new Map<string, FeedbackVoteValue>();
    for (const feedbackVote of feedbackVotes) {
      if (feedbackVote.targetType !== "issue_comment") continue;
      map.set(feedbackVote.targetId, feedbackVote.vote);
    }
    return map;
  }, [feedbackVotes]);
  const useVirtualizedThread =
    messages.length >= VIRTUALIZED_THREAD_ROW_THRESHOLD;
  const messageAnchorIndex = useMemo(() => {
    const map = new Map<string, number>();
    messages.forEach((message, index) => {
      const anchorId = issueChatMessageAnchorId(message);
      if (anchorId) map.set(anchorId, index);
    });
    return map;
  }, [messages]);

  function scrollToThreadAnchor(
    anchorId: string,
    options?: {
      align?: "start" | "center" | "end" | "auto";
      behavior?: ScrollBehavior;
    },
    messageSnapshot: readonly ThreadMessage[] = messages,
  ) {
    const snapshotUsesVirtualizer =
      messageSnapshot.length >= VIRTUALIZED_THREAD_ROW_THRESHOLD;
    const virtualIndex =
      messageSnapshot === messages
        ? messageAnchorIndex.get(anchorId)
        : findMessageAnchorIndex(messageSnapshot, anchorId);
    if (
      snapshotUsesVirtualizer &&
      virtualIndex !== undefined &&
      virtualIndex >= 0
    ) {
      if (!virtualizedThreadRef.current) return false;
      virtualizedThreadRef.current.scrollToIndex(virtualIndex, {
        align: options?.align ?? "center",
        behavior: options?.behavior ?? "smooth",
      });
      return true;
    }

    const element = document.getElementById(anchorId);
    if (!element) return false;
    element.scrollIntoView({
      behavior: options?.behavior ?? "smooth",
      block:
        options?.align === "start"
          ? "start"
          : options?.align === "end"
            ? "end"
            : "center",
    });
    return true;
  }

  const sendComposerComment = useCallback<IssueChatThreadProps["onAdd"]>(
    (body, reopen, reassignment, attachmentIds, clientRequestId) => {
      pendingSubmitScrollRef.current = true;
      return onAdd(body, reopen, reassignment, attachmentIds, clientRequestId);
    },
    [onAdd],
  );
  const runtime = usePaperclipIssueRuntime({
    messages,
    isRunning,
    onSend: ({ body, reopen, reassignment, attachmentIds }) =>
      sendComposerComment(body, reopen, reassignment, attachmentIds),
    onCancel: onCancelRun,
  });

  useEffect(() => {
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const lastUserId = lastUserMessage?.id ?? null;

    if (
      pendingSubmitScrollRef.current &&
      lastUserId &&
      lastUserId !== lastUserMessageIdRef.current
    ) {
      pendingSubmitScrollRef.current = false;
      const custom = lastUserMessage?.metadata.custom as
        { anchorId?: unknown } | undefined;
      const anchorId =
        typeof custom?.anchorId === "string" ? custom.anchorId : null;
      if (anchorId) {
        const reserve = Math.round(
          window.innerHeight * SUBMIT_SCROLL_RESERVE_VH,
        );
        spacerBaselineAnchorRef.current = anchorId;
        spacerInitialReserveRef.current = reserve;
        setBottomSpacerHeight(reserve);
        requestAnimationFrame(() => {
          scrollToThreadAnchor(anchorId, {
            align: "start",
            behavior: "smooth",
          });
        });
      }
    }

    lastUserMessageIdRef.current = lastUserId;
  }, [messageAnchorIndex, messages, useVirtualizedThread]);

  useLayoutEffect(() => {
    const anchorId = spacerBaselineAnchorRef.current;
    if (!anchorId || spacerInitialReserveRef.current <= 0) return;
    const userEl = document.getElementById(anchorId);
    const bottomEl = bottomAnchorRef.current;
    if (!userEl || !bottomEl) return;
    const contentBelow = Math.max(
      0,
      bottomEl.getBoundingClientRect().top -
        userEl.getBoundingClientRect().bottom,
    );
    const next = Math.max(0, spacerInitialReserveRef.current - contentBelow);
    setBottomSpacerHeight((prev) => (prev === next ? prev : next));
    if (next === 0) {
      spacerBaselineAnchorRef.current = null;
      spacerInitialReserveRef.current = 0;
    }
  }, [messages]);
  useLayoutEffect(() => {
    const composerElement = composerViewportAnchorRef.current;
    if (preserveComposerViewportRef.current) {
      restoreComposerViewportSnapshot(
        composerViewportSnapshotRef.current,
        composerElement,
      );
    }

    composerViewportSnapshotRef.current =
      captureComposerViewportSnapshot(composerElement);
    preserveComposerViewportRef.current =
      shouldPreserveComposerViewport(composerElement);
  }, [messages]);

  useEffect(() => {
    const hash =
      location.hash ||
      (typeof window !== "undefined" ? window.location.hash : "");
    const isThreadHash =
      hash.startsWith("#comment-") ||
      hash.startsWith("#activity-") ||
      hash.startsWith("#run-") ||
      hash.startsWith("#interaction-");
    if (messages.length === 0) return;
    if (!isThreadHash) {
      if (!didInitialHashScrollDecisionRef.current) {
        didInitialHashScrollDecisionRef.current = true;
      }
      return;
    }
    if (lastScrolledHashRef.current === hash) return;
    const targetId = hash.slice(1);
    if (targetId.startsWith("comment-")) {
      const targetMessage = messages.find(
        (message) => issueChatMessageAnchorId(message) === targetId,
      );
      if (targetMessage && issueChatMessageIsDeleted(targetMessage)) {
        didInitialHashScrollDecisionRef.current = true;
        lastScrolledHashRef.current = hash;
        if (typeof window !== "undefined") {
          window.history.replaceState(
            null,
            "",
            `${location.pathname}${location.search}`,
          );
        }
        return;
      }
    }
    if (!didInitialHashScrollDecisionRef.current) {
      didInitialHashScrollDecisionRef.current = true;
      if (!autoScrollToHashOnInitialLoad) {
        lastScrolledHashRef.current = hash;
        return;
      }
    }
    let cancelled = false;
    const attemptScroll = (finalAttempt = false) => {
      if (cancelled || lastScrolledHashRef.current === hash) return;
      const didScroll = scrollToThreadAnchor(targetId, {
        align: "center",
        behavior: "smooth",
      });
      if (!didScroll) return;
      if (
        finalAttempt ||
        !useVirtualizedThread ||
        document.getElementById(targetId)
      ) {
        lastScrolledHashRef.current = hash;
      }
    };

    attemptScroll();
    const frame = requestAnimationFrame(() => attemptScroll());
    const timeout = window.setTimeout(() => attemptScroll(true), 250);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [
    autoScrollToHashOnInitialLoad,
    location.hash,
    messageAnchorIndex,
    messages,
    useVirtualizedThread,
  ]);

  // Optional legacy behavior: callers may explicitly request landing on the
  // latest comment. The shared default stays off so ordinary page loads keep
  // the user's initial viewport stable.
  useEffect(() => {
    if (didInitialLatestScrollRef.current) return;
    if (!autoScrollToLatestOnInitialLoad) return;
    if (variant !== "full") return;
    if (messages.length === 0) return;
    const hash =
      location.hash ||
      (typeof window !== "undefined" ? window.location.hash : "");
    if (
      hash.startsWith("#comment-") ||
      hash.startsWith("#activity-") ||
      hash.startsWith("#run-") ||
      hash.startsWith("#interaction-")
    ) {
      didInitialLatestScrollRef.current = true;
      return;
    }
    didInitialLatestScrollRef.current = true;
    // Defer a frame so the virtualizer/DOM has mounted its initial rows before
    // we resolve and scroll to the latest comment's anchor.
    const frame = requestAnimationFrame(() =>
      scrollToLatestCommentWithSettle(latestMessagesRef.current),
    );
    return () => cancelAnimationFrame(frame);
  }, [autoScrollToLatestOnInitialLoad, messages, variant, location.hash]);

  function jumpToLatestFallback() {
    if (useVirtualizedThread) {
      virtualizedThreadRef.current?.scrollToLatest({ behavior: "smooth" });
      return;
    }
    bottomAnchorRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }

  // Lands on the latest `comment-*` row and then drives the scroll the rest
  // of the way home as the virtualizer's per-row measurements arrive.
  //
  // The virtualizer estimates 220px for unmeasured rows. On long threads
  // with tall markdown comments (PAP-2536 et al.), totalSize is hugely
  // underestimated until rows render and get measured. A single scroll
  // lands above the actual bottom; rendered rows then expand, the layout
  // grows, and the user has to keep clicking Jump-to-latest to walk closer
  // to the real bottom. The convergence loop below issues `scrollIntoView`
  // on the latest comment element on every tick until the DOM bottom of
  // that element is at the scroll container's bottom (or scroll position
  // and content height stop changing).
  function scrollToLatestCommentWithSettle(
    messageSnapshot: readonly ThreadMessage[] = latestMessagesRef.current,
  ) {
    const latestCommentIndex = findLatestCommentMessageIndex(messageSnapshot);
    if (latestCommentIndex < 0) {
      jumpToLatestFallback();
      return;
    }
    const latestCommentAnchor = issueChatMessageAnchorId(
      messageSnapshot[latestCommentIndex],
    );
    if (!latestCommentAnchor) {
      jumpToLatestFallback();
      return;
    }

    const initial = scrollToThreadAnchor(
      latestCommentAnchor,
      { align: "end", behavior: "smooth" },
      messageSnapshot,
    );
    if (!initial) {
      jumpToLatestFallback();
      return;
    }

    if (typeof window === "undefined") return;

    const startedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const MAX_DURATION_MS = 4000;
    const TICK_MS = 80;
    const TOLERANCE_PX = 4;

    clearLatestSettleTimeouts();
    const resolveScrollContainer = (): HTMLElement | null =>
      document.getElementById("main-content") as HTMLElement | null;
    const cancelTarget = resolveScrollContainer() ?? window;

    let lastScrollTop = -1;
    let lastScrollHeight = -1;
    let stableTicks = 0;
    let cancelled = false;

    const cancel = () => {
      cancelled = true;
    };

    const cleanup = () => {
      cancelTarget.removeEventListener("wheel", cancel);
      cancelTarget.removeEventListener("touchstart", cancel);
    };

    cancelTarget.addEventListener("wheel", cancel, {
      once: true,
      passive: true,
    });
    cancelTarget.addEventListener("touchstart", cancel, {
      once: true,
      passive: true,
    });
    latestSettleCleanupRef.current = cleanup;

    const finish = () => {
      cleanup();
      latestSettleCleanupRef.current = null;
      for (const timeout of latestSettleTimeoutsRef.current) {
        window.clearTimeout(timeout);
      }
      latestSettleTimeoutsRef.current = [];
    };

    const scheduleTick = (delay: number) => {
      const timeout = window.setTimeout(() => {
        latestSettleTimeoutsRef.current =
          latestSettleTimeoutsRef.current.filter((entry) => entry !== timeout);
        tick();
      }, delay);
      latestSettleTimeoutsRef.current.push(timeout);
    };

    const tick = () => {
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      if (cancelled || now - startedAt > MAX_DURATION_MS) {
        finish();
        return;
      }

      if (typeof document === "undefined") {
        finish();
        return;
      }

      const el = document.getElementById(latestCommentAnchor);
      if (!el) {
        // Row hasn't been rendered into the virtualizer's buffer yet — nudge
        // the offset (instant) so it gets mounted, then keep settling.
        virtualizedThreadRef.current?.scrollToIndex(latestCommentIndex, {
          align: "end",
          behavior: "auto",
        });
        scheduleTick(TICK_MS);
        return;
      }

      const container = resolveScrollContainer();
      const containerBottom = container
        ? container.getBoundingClientRect().bottom
        : window.innerHeight;
      const elBottom = el.getBoundingClientRect().bottom;
      const offBottom = elBottom - containerBottom;

      if (Math.abs(offBottom) > TOLERANCE_PX) {
        el.scrollIntoView({ behavior: "smooth", block: "end" });
      }

      const currentScrollTop = container?.scrollTop ?? window.scrollY;
      const currentScrollHeight =
        container?.scrollHeight ?? document.documentElement.scrollHeight;
      const scrollStable = Math.abs(currentScrollTop - lastScrollTop) < 1;
      const heightStable = currentScrollHeight === lastScrollHeight;
      const atBottom = Math.abs(offBottom) <= TOLERANCE_PX;
      if (scrollStable && heightStable && atBottom) {
        stableTicks += 1;
        if (stableTicks >= 3) {
          finish();
          return;
        }
      } else {
        stableTicks = 0;
      }
      lastScrollTop = currentScrollTop;
      lastScrollHeight = currentScrollHeight;
      scheduleTick(TICK_MS);
    };

    // Hold the first iteration off for one frame so the initial smooth
    // scroll has begun (and the virtualizer has rendered the buffer around
    // the target) before we start settling.
    scheduleTick(120);
  }

  function handleJumpToLatest() {
    if (onRefreshLatestComments) {
      // Refetching the comments query (page 0 first) brings any comment that
      // arrived after the initial load — including ones live updates may
      // have missed during reconnects — into the loaded set before we
      // resolve the latest target. Otherwise we'd land on the latest
      // *loaded* comment but not the absolute newest. (PAP-2672 follow-up.)
      const refreshed = onRefreshLatestComments();
      if (
        refreshed &&
        typeof (refreshed as Promise<unknown>).then === "function"
      ) {
        (refreshed as Promise<unknown>).then(
          () => scrollToLatestCommentWithSettle(latestMessagesRef.current),
          () => scrollToLatestCommentWithSettle(latestMessagesRef.current),
        );
        return;
      }
    }
    scrollToLatestCommentWithSettle(latestMessagesRef.current);
  }

  const stableOnVote = useStableEvent(onVote);
  const stableOnStopRun = useStableEvent(onStopRun);
  const stableOnInterruptQueued = useStableEvent(onInterruptQueued);
  const stableOnCancelQueued = useStableEvent(onCancelQueued);
  const stableOnDeleteComment = useStableEvent(onDeleteComment);
  const stableOnImageClick = useStableEvent(onImageClick);
  const stableOnAcceptInteraction = useStableEvent(onAcceptInteraction);
  const stableOnRejectInteraction = useStableEvent(onRejectInteraction);
  const stableOnSubmitInteractionAnswers = useStableEvent(
    onSubmitInteractionAnswers,
  );
  const stableOnCancelInteraction = useStableEvent(onCancelInteraction);
  const stableOnSubmitInteractionVerdicts = useStableEvent(
    onSubmitInteractionVerdicts,
  );
  const stableOnUploadImage = useStableEvent(imageUploadHandler);

  const chatCtx = useMemo<IssueChatMessageContext>(
    () => ({
      feedbackDataSharingPreference,
      feedbackTermsUrl,
      agentMap,
      currentUserId,
      userLabelMap,
      userProfileMap,
      onVote: stableOnVote,
      onStopRun: stableOnStopRun,
      stopRunLabel,
      stoppingRunLabel,
      stopRunVariant,
      runFinalizationActions,
      onInterruptQueued: composerPause ? undefined : stableOnInterruptQueued,
      onCancelQueued: composerPause ? undefined : stableOnCancelQueued,
      onDeleteComment: stableOnDeleteComment,
      onImageClick: stableOnImageClick,
      onAcceptInteraction: stableOnAcceptInteraction,
      onRejectInteraction: stableOnRejectInteraction,
      onSubmitInteractionAnswers: stableOnSubmitInteractionAnswers,
      onCancelInteraction: stableOnCancelInteraction,
      onSubmitInteractionVerdicts: stableOnSubmitInteractionVerdicts,
      onUploadImage: stableOnUploadImage,
      issueStatus,
      issueAssigneeAgentId,
      successfulRunHandoff: successfulRunHandoffWithLiveness,
      externalReferences,
      linkCaseReferences,
    }),
    [
      feedbackDataSharingPreference,
      feedbackTermsUrl,
      agentMap,
      currentUserId,
      userLabelMap,
      userProfileMap,
      stableOnVote,
      stableOnStopRun,
      stopRunLabel,
      stoppingRunLabel,
      stopRunVariant,
      runFinalizationActions,
      composerPause,
      stableOnInterruptQueued,
      stableOnCancelQueued,
      stableOnDeleteComment,
      stableOnImageClick,
      stableOnAcceptInteraction,
      stableOnRejectInteraction,
      stableOnSubmitInteractionAnswers,
      stableOnCancelInteraction,
      stableOnSubmitInteractionVerdicts,
      stableOnUploadImage,
      issueStatus,
      issueAssigneeAgentId,
      successfulRunHandoffWithLiveness,
      externalReferences,
      linkCaseReferences,
    ],
  );

  const resolvedShowJumpToLatest = showJumpToLatest ?? variant === "full";
  const resolvedEmptyMessage =
    emptyMessage ??
    (variant === "embedded"
      ? "No run output yet."
      : "This task conversation is empty. Start with a message below.");
  const previousErrorBoundaryMessagesRef = useRef<
    readonly ThreadMessage[] | null
  >(null);
  const errorBoundaryResetVersionRef = useRef(0);
  if (previousErrorBoundaryMessagesRef.current !== messages) {
    previousErrorBoundaryMessagesRef.current = messages;
    errorBoundaryResetVersionRef.current += 1;
  }
  const errorBoundaryResetKey = String(errorBoundaryResetVersionRef.current);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <IssueChatCtx.Provider value={chatCtx}>
        <div className={cn(variant === "embedded" ? "space-y-3" : "space-y-4")}>
          {resolvedShowJumpToLatest ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleJumpToLatest}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Jump to latest
              </button>
            </div>
          ) : null}

          <IssueChatErrorBoundary
            resetKey={errorBoundaryResetKey}
            messages={messages}
            emptyMessage={resolvedEmptyMessage}
            variant={variant}
            externalReferences={externalReferences}
          >
            <div data-testid="thread-root">
              <div
                data-testid="thread-viewport"
                className={variant === "embedded" ? "space-y-3" : "space-y-4"}
              >
                {messages.length === 0 ? (
                  <Card
                    className={cn(
                      "block shadow-none text-center text-sm text-muted-foreground",
                      variant === "embedded"
                        ? "border-dashed border-border/70 bg-background/60 px-4 py-6"
                        : "border-dashed px-6 py-10",
                    )}
                  >
                    {resolvedEmptyMessage}
                  </Card>
                ) : messages.length >= VIRTUALIZED_THREAD_ROW_THRESHOLD ? (
                  <VirtualizedIssueChatThreadList
                    ref={virtualizedThreadRef}
                    messages={messages}
                    feedbackVoteByTargetId={feedbackVoteByTargetId}
                    activeRunIds={activeRunIds}
                    stoppingRunId={stoppingRunId}
                    interruptingQueuedRunId={interruptingQueuedRunId}
                    variant={variant}
                  />
                ) : (
                  // Keep transcript rendering independent from assistant-ui's
                  // index-scoped message providers; live transcripts can shrink
                  // or regroup while the runtime still holds stale indices.
                  messages.map((message) => (
                    <IssueChatMessageRow
                      key={message.id}
                      message={message}
                      feedbackVoteByTargetId={feedbackVoteByTargetId}
                      activeRunIds={activeRunIds}
                      stoppingRunId={stoppingRunId}
                      interruptingQueuedRunId={interruptingQueuedRunId}
                    />
                  ))
                )}
                {showComposer ? (
                  <div
                    data-testid="issue-chat-thread-notices"
                    className="space-y-2"
                  >
                    <IssueAssignedBacklogNotice
                      issueStatus={issueStatus ?? ""}
                      assigneeAgent={assignedAgent}
                      assigneeUserId={assigneeUserId}
                      onResume={onResumeFromBacklog}
                      resuming={resumeFromBacklogPending}
                    />
                    {recoveryAction ? (
                      <IssueRecoveryActionCard
                        action={recoveryAction}
                        agentMap={agentMap}
                        scheduledRetry={scheduledRetry}
                        onResolve={onResolveRecoveryAction}
                        onReissueIsolated={onReissueIsolatedRecoveryAction}
                        reissuePending={reissueIsolatedRecoveryActionPending}
                        onReconcileForward={onReconcileForwardRecoveryAction}
                        onBreakGlassOverride={
                          onBreakGlassOverrideRecoveryAction
                        }
                        onQuarantineRestore={onQuarantineRestoreRecoveryAction}
                        quarantineRestorePending={
                          quarantineRestoreRecoveryActionPending
                        }
                        canBreakGlass={canBreakGlassRecoveryAction}
                        reconcilePending={reconcileRecoveryActionPending}
                        canFalsePositive={canFalsePositiveRecoveryAction}
                      />
                    ) : null}
                    {legacyRecoverySourceIssue ? (
                      <SystemNotice
                        tone="info"
                        label="Legacy recovery task"
                        body={
                          <span>
                            Legacy recovery task. Newer recovery actions live on
                            the source task
                            {legacyRecoverySourceIssue.identifier ? (
                              <>
                                {": "}
                                <Link
                                  to={legacyRecoverySourceIssue.href}
                                  className="underline-offset-2 hover:underline"
                                >
                                  {legacyRecoverySourceIssue.identifier}
                                  {legacyRecoverySourceIssue.title ? (
                                    <span className="text-muted-foreground">
                                      {" "}
                                      ({legacyRecoverySourceIssue.title})
                                    </span>
                                  ) : null}
                                </Link>
                              </>
                            ) : (
                              "."
                            )}
                          </span>
                        }
                      />
                    ) : null}
                    <IssueBlockedNotice
                      issueId={issueId}
                      issueStatus={issueStatus}
                      blockers={unresolvedBlockers}
                      allBlockers={blockedBy}
                      liveIssueIds={liveIssueIds}
                      blockerAttention={blockerAttention}
                      successfulRunHandoff={
                        recoveryAction ? null : successfulRunHandoffWithLiveness
                      }
                      scheduledRetry={scheduledRetry}
                      agentName={
                        successfulRunHandoff?.assigneeAgentId
                          ? (agentMap?.get(successfulRunHandoff.assigneeAgentId)
                              ?.name ?? null)
                          : null
                      }
                    />
                    <IssueAssigneePausedNotice
                      agent={assignedAgent}
                      onResume={onResumeAssignee}
                      resuming={resumeAssigneePending}
                    />
                  </div>
                ) : (
                  // Read-only viewers still need to see why nothing is running.
                  <div
                    data-testid="issue-chat-thread-notices"
                    className="space-y-2"
                  >
                    <IssueAssigneePausedNotice
                      agent={assignedAgent}
                      onResume={onResumeAssignee}
                      resuming={resumeAssigneePending}
                    />
                  </div>
                )}
                {footer ? (
                  <div data-testid="issue-chat-thread-footer">{footer}</div>
                ) : null}
                <div ref={bottomAnchorRef} />
                {showComposer ? (
                  <div
                    aria-hidden
                    data-testid="issue-chat-bottom-spacer"
                    style={{ height: bottomSpacerHeight }}
                  />
                ) : null}
              </div>
            </div>
          </IssueChatErrorBoundary>

          {showComposer && composerAccessory ? (
            <div data-testid="issue-chat-composer-accessory" className="mb-2">
              {composerAccessory}
            </div>
          ) : null}

          {showComposer ? (
            <div
              ref={composerViewportAnchorRef}
              data-testid="issue-chat-composer-dock"
              className="sticky bottom-(--sz-calc-8) z-20 space-y-2 bg-gradient-to-t from-background via-background/95 to-background/0 pt-6"
            >
              <IssueChatComposer
                ref={composerRef}
                onSend={sendComposerComment}
                onReviewConversation={onReviewConversation}
                onImageUpload={imageUploadHandler}
                onAttachImage={onAttachImage}
                draftKey={draftKey}
                confirmedSubmissionIds={new Set(comments.filter((comment) =>
                  comment.authorUserId === currentUserId && comment.clientRequestId &&
                  !("clientStatus" in comment && comment.clientStatus)
                ).map((comment) => comment.clientRequestId!))}
                enableReassign={enableReassign}
                reassignOptions={reassignOptions}
                currentAssigneeValue={currentAssigneeValue}
                suggestedAssigneeValue={suggestedAssigneeValue}
                mentions={mentions}
                agentMap={agentMap}
                hasActiveRun={!!hasActiveRun}
                onStop={hasActiveRun ? onCancelRun : undefined}
                stopPending={stopPending}
                stopScope={stopScope}
                currentUserId={currentUserId}
                userLabelMap={userLabelMap}
                composerPause={composerPause}
                composerDisabledReason={composerDisabledReason}
                composerHint={composerHint}
                issueStatus={issueStatus}
                issueWorkMode={issueWorkMode}
                onWorkModeChange={onWorkModeChange}
              />
            </div>
          ) : null}
        </div>
      </IssueChatCtx.Provider>
    </AssistantRuntimeProvider>
  );
}
