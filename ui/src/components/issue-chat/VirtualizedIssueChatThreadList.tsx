import type { ThreadMessage } from "@assistant-ui/react";
import {
  useRef,
  useState,
  useEffect,
  forwardRef,
  useLayoutEffect,
  useCallback,
  useImperativeHandle,
  memo,
} from "react";
import type { FeedbackVoteValue } from "@greatstone/shared";
import { formatDateTime } from "../../lib/utils";
import { Trash2 } from "lucide-react";
import {
  issueChatMessageCustom,
  issueChatMessageKind,
  issueChatMessageDeletedAt,
  issueChatMessageActiveVote,
  issueChatMessageRunIsActive,
  issueChatMessageRunIsStopping,
  issueChatMessageQueuedRunIsInterrupting,
} from "./helpers";
import { IssueChatUserMessage } from "./IssueChatUserMessage";
import { IssueChatAssistantMessage } from "./IssueChatAssistantMessage";
import { IssueChatSystemMessage } from "./IssueChatSystemMessage";

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

export interface VirtualizedIssueChatThreadListHandle {
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

export function issueChatMessageAnchorId(message: ThreadMessage): string | null {
  const custom = message.metadata.custom as { anchorId?: unknown } | undefined;
  return typeof custom?.anchorId === "string" ? custom.anchorId : null;
}

export function findMessageAnchorIndex(
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

export const VirtualizedIssueChatThreadList = forwardRef<
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

export const IssueChatMessageRow = memo(function IssueChatMessageRow({
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
