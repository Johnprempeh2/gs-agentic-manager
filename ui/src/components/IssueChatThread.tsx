import { type ThreadMessage, AssistantRuntimeProvider } from "@assistant-ui/react";
import { useRef, useState, useMemo, useCallback, useEffect, useLayoutEffect } from "react";
import { useLocation, Link } from "@/lib/router";
import type { FeedbackVoteValue } from "@greatstone/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import { usePaperclipIssueRuntime } from "../hooks/usePaperclipIssueRuntime";
import {
  buildIssueChatMessages,
  type StableThreadMessageCacheEntry,
  stabilizeThreadMessages,
} from "../lib/issue-chat-messages";
import { isLiveIssueRun } from "../lib/liveIssueIds";
import { resolveIssueChatTranscriptRuns } from "../lib/issueChatTranscriptRuns";
import { Card } from "@/components/ui/card";
import {
  captureComposerViewportSnapshot,
  restoreComposerViewportSnapshot,
  shouldPreserveComposerViewport,
} from "../lib/issue-chat-scroll";
import { SystemNotice } from "./SystemNotice";
import { cn } from "../lib/utils";
import { IssueBlockedNotice } from "./IssueBlockedNotice";
import { IssueAssignedBacklogNotice } from "./IssueAssignedBacklogNotice";
import { IssueRecoveryActionCard } from "./IssueRecoveryActionCard";
import type { IssueChatThreadProps } from "./issue-chat/types";
import {
  type VirtualizedIssueChatThreadListHandle,
  VIRTUALIZED_THREAD_ROW_THRESHOLD,
  issueChatMessageAnchorId,
  findMessageAnchorIndex,
  findLatestCommentMessageIndex,
  VirtualizedIssueChatThreadList,
  IssueChatMessageRow,
} from "./issue-chat/VirtualizedIssueChatThreadList";
import { toIsoString, issueChatMessageIsDeleted, useStableEvent } from "./issue-chat/helpers";
import { SUBMIT_SCROLL_RESERVE_VH, IssueChatComposer } from "./issue-chat/IssueChatComposer";
import { type IssueChatMessageContext, IssueChatCtx } from "./issue-chat/IssueChatContext";
import { IssueChatErrorBoundary, IssueAssigneePausedNotice } from "./issue-chat/IssueChatFallback";
export type { IssueChatRunFinalizationAction } from "./issue-chat/IssueChatContext";
export { resolveAssistantMessageFoldedState, canStopIssueChatRun, shouldRenderComposerHandoffPreview, resolveIssueChatHumanAuthor } from "./issue-chat/helpers";
export type { IssueChatComposerHandle } from "./issue-chat/types";
export { IssueAssigneePausedNotice } from "./issue-chat/IssueChatFallback";
export { SuccessfulRunHandoffCommentCallout } from "./issue-chat/IssueChatParts";
export { VIRTUALIZED_THREAD_ROW_THRESHOLD, findLatestCommentMessageIndex, getVirtualizedMeasurementScrollAdjustment } from "./issue-chat/VirtualizedIssueChatThreadList";

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
