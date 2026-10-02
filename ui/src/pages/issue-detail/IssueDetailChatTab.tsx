import type { TaskComposerPause } from "../../components/task-chat/TaskChatPausedTakeover";
import { EmailThreadProvider } from "../../components/EmailMessageCard";
import { TaskChatScrollNavigation } from "@/components/task-chat/scroll-navigation";
import {
  type Ref,
  type ReactNode,
  memo,
  useMemo,
  useState,
  useEffect,
  useCallback,
} from "react";
import { useLocation, useNavigationType } from "@/lib/router";
import { useQueryClient, useQuery, useMutation, type InfiniteData } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import { issuesApi } from "../../api/issues";
import { activityApi, type RunForIssue } from "../../api/activity";
import { heartbeatsApi, type LiveRunForIssue, type ActiveRunForIssue } from "../../api/heartbeats";
import { agentsApi } from "../../api/agents";
import { useToastActions } from "../../context/ToastContext";
import { extractIssueTimelineEvents, extractIssueWorkModeChanges } from "../../lib/issue-timeline-events";
import { queryKeys } from "../../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../../lib/query-placeholder-data";
import { normalizeIssueQueuedCommentQueue, mergePendingIssueQueuedComments } from "../../lib/issue-queued-comment-queue";
import { taskPollInterval, resolveIssueActiveRun } from "../../lib/issueActiveRun";
import { usePageVisibility } from "../../lib/page-visibility";
import {
  applyLocalQueuedIssueCommentState,
  isQueuedIssueComment,
  removeIssueCommentFromPages,
} from "../../lib/optimistic-issue-comments";
import {
  type IssueChatComposerHandle,
  type IssueChatRunFinalizationAction,
  IssueChatThread,
} from "../../components/IssueChatThread";
import { TaskChatThread } from "../../components/TaskChatThread";
import type { TaskChatIssueBrief } from "../../components/task-chat/TaskChatDescriptionBubble";
import type { MarkdownExternalReferenceMap } from "../../components/MarkdownBody";
import type { MentionOption } from "../../components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { buildAnsweredQuestionsDeliveryText } from "../../lib/issue-thread-interactions";
import type {
  Issue,
  IssueWorkMode,
  IssueThreadInteraction,
  IssueDocumentSummary,
  IssueWorkProduct,
  IssueAttachment,
  FeedbackVote,
  Agent,
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  RequestItemVerdictsInteraction,
  RequestItemVerdictValue,
  ActivityEvent,
  IssueComment,
} from "@greatstone/shared";
import {
  type IssueDetailComment,
  type CommentReassignment,
  type ActionableIssueThreadInteraction,
  resolveInterruptibleIssueRun,
  isPlanConfirmationInteraction,
  buildPlanDecisionResponseText,
} from "./helpers";
import { useTaskDetailInterfaceMode, IssueChatSkeleton } from "./IssueDetailLoading";

type IssueDetailChatTabProps = {
  onOpenSkill?: (skillId: string, name: string) => void;
  issueId: string;
  companyId: string;
  projectId: string | null;
  issueStatus: Issue["status"];
  /** Marks cross-issue agent comments in the thread (the open cross-task write design (attribution)). */
  issueAssigneeAgentId: Issue["assigneeAgentId"];
  issueWorkMode: IssueWorkMode;
  executionRunId: string | null;
  blockedBy: Issue["blockedBy"];
  liveIssueIds: ReadonlySet<string>;
  blockerAttention: Issue["blockerAttention"] | null;
  successfulRunHandoff: Issue["successfulRunHandoff"] | null;
  scheduledRetry: Issue["scheduledRetry"] | null;
  recoveryAction: Issue["activeRecoveryAction"];
  onResolveRecoveryAction?: (
    outcome: import("../../components/IssueRecoveryActionCard").RecoveryResolveOutcome,
  ) => void;
  onReissueIsolatedRecoveryAction?: (
    request: import("../../components/IssueRecoveryActionCard").RecoveryReissueRequest,
  ) => void;
  reissueIsolatedRecoveryActionPending?: boolean;
  onReconcileForwardRecoveryAction?: () => void;
  onBreakGlassOverrideRecoveryAction?: (reason: string) => void;
  onQuarantineRestoreRecoveryAction?: () => void;
  quarantineRestoreRecoveryActionPending?: boolean;
  canBreakGlassRecoveryAction?: boolean;
  reconcileRecoveryActionPending?: boolean;
  canFalsePositiveRecoveryAction?: boolean;
  legacyRecoverySourceIssue?: {
    identifier: string | null;
    href: string;
    title?: string | null;
  } | null;
  comments: IssueDetailComment[];
  commentsInitialLoading?: boolean;
  initialHistoryPending?: boolean;
  initialHistoryError?: boolean;
  onRetryInitialHistory?: () => void;
  locallyQueuedCommentRunIds: ReadonlyMap<string, string>;
  interactions: IssueThreadInteraction[];
  documents: IssueDocumentSummary[];
  workProducts: IssueWorkProduct[];
  attachments: IssueAttachment[];
  hasOlderComments: boolean;
  commentsLoadingOlder: boolean;
  onLoadOlderComments: () => void;
  onRefreshLatestComments: () => Promise<unknown> | void;
  onWorkModeChange?: (workMode: IssueWorkMode) => Promise<void> | void;
  composerRef: Ref<IssueChatComposerHandle>;
  /** Optional node rendered inline directly above the reply composer (e.g. the monitor strip). */
  composerAccessory?: ReactNode;
  /**
   * Issue header (title row, badges, plugin toolbars) that the chat-style
   * thread renders inside its scroll viewport so it scrolls away with the
   * messages. Ignored by the classic thread (flag: enableClassicTaskInterface).
   */
  threadHeader?: ReactNode;
  /**
   * The task description rendered as the requester's first chat bubble in the
   * chat-style thread (PAP-375). Ignored by the classic thread.
   */
  issueBrief?: TaskChatIssueBrief;
  footer?: ReactNode;
  feedbackVotes?: FeedbackVote[];
  feedbackDataSharingPreference: "allowed" | "not_allowed" | "prompt";
  feedbackTermsUrl: string | null;
  agentMap: Map<string, Agent>;
  currentUserId: string | null;
  userLabelMap: ReadonlyMap<string, string> | null;
  userProfileMap: ReadonlyMap<
    string,
    import("../../lib/company-members").CompanyUserProfile
  > | null;
  draftKey: string;
  reassignOptions: Array<{ id: string; label: string; searchText?: string }>;
  currentAssigneeValue: string;
  suggestedAssigneeValue: string;
  mentions: MentionOption[];
  conversationMode?: boolean;
  composerPause?: TaskComposerPause | null;
  composerDisabledReason: string | null;
  composerHint: string | null;
  queuedCommentReason: "hold" | "active_run" | "other";
  onVote: (
    commentId: string,
    vote: "up" | "down",
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onAdd: (
    body: string,
    reopen?: boolean,
    reassignment?: CommentReassignment,
    attachmentIds?: string[],
    clientRequestId?: string,
  ) => Promise<void>;
  onReviewConversation: () => Promise<void>;
  onImageUpload: (file: File) => Promise<string>;
  onAttachImage: (file: File) => Promise<IssueAttachment | void>;
  onInterruptQueued: (runId: string | null) => Promise<void>;
  onDeleteComment?: (commentId: string) => Promise<void> | void;
  onPauseWorkRun?: (runId: string, feedback?: "composer") => Promise<void>;
  onStopResponse?: (runId: string) => Promise<void>;
  stopResponsePending?: boolean;
  pauseWorkPending?: boolean;
  pauseWorkScope?: "leaf" | "subtree";
  runFinalizationActions?: readonly IssueChatRunFinalizationAction[];
  onCancelQueued: (commentId: string) => void;
  interruptingQueuedRunId: string | null;
  pausingWorkRunId: string | null;
  onImageClick: (src: string) => void;
  onAcceptInteraction: (
    interaction: ActionableIssueThreadInteraction,
    selectedClientKeys?: string[],
    selectedOptionIds?: string[],
    rememberAction?: boolean,
  ) => Promise<void>;
  onRejectInteraction: (
    interaction: ActionableIssueThreadInteraction,
    reason?: string,
  ) => Promise<void>;
  onSubmitInteractionAnswers: (
    interaction: IssueThreadInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void>;
  onCancelInteraction: (
    interaction: AskUserQuestionsInteraction,
  ) => Promise<void>;
  onSkipInteraction: (interaction: IssueThreadInteraction) => Promise<void>;
  onSubmitInteractionVerdicts: (
    interaction: RequestItemVerdictsInteraction,
    verdicts: {
      id: string;
      verdict: RequestItemVerdictValue;
      reason?: string;
    }[],
  ) => Promise<void>;
  assigneeUserId: string | null;
  onResumeFromBacklog?: () => Promise<void> | void;
  resumeFromBacklogPending?: boolean;
  onResumeAssignee?: () => Promise<void> | void;
  resumeAssigneePending?: boolean;
  onTryAgainNoLiveExecutionPath?: () => Promise<void> | void;
  tryAgainNoLiveExecutionPathPending?: boolean;
  externalReferences?: MarkdownExternalReferenceMap;
  linkCaseReferences?: boolean;
};

export const IssueDetailChatTab = memo(function IssueDetailChatTab({
  onOpenSkill,
  issueId,
  companyId,
  projectId,
  issueWorkMode,
  issueStatus,
  issueAssigneeAgentId,
  executionRunId,
  blockedBy,
  liveIssueIds,
  blockerAttention,
  successfulRunHandoff,
  scheduledRetry,
  recoveryAction,
  onResolveRecoveryAction,
  onReissueIsolatedRecoveryAction,
  reissueIsolatedRecoveryActionPending,
  onReconcileForwardRecoveryAction,
  onBreakGlassOverrideRecoveryAction,
  onQuarantineRestoreRecoveryAction,
  quarantineRestoreRecoveryActionPending,
  canBreakGlassRecoveryAction,
  reconcileRecoveryActionPending,
  canFalsePositiveRecoveryAction,
  legacyRecoverySourceIssue,
  comments,
  commentsInitialLoading = false,
  initialHistoryPending = false,
  initialHistoryError = false,
  onRetryInitialHistory,
  locallyQueuedCommentRunIds,
  interactions,
  documents,
  workProducts,
  attachments,
  hasOlderComments,
  commentsLoadingOlder,
  onLoadOlderComments,
  onRefreshLatestComments,
  onWorkModeChange,
  composerRef,
  composerAccessory,
  threadHeader,
  issueBrief,
  footer,
  feedbackVotes,
  feedbackDataSharingPreference,
  feedbackTermsUrl,
  agentMap,
  currentUserId,
  userLabelMap,
  userProfileMap,
  draftKey,
  reassignOptions,
  currentAssigneeValue,
  suggestedAssigneeValue,
  mentions,
  conversationMode,
  composerPause,
  composerDisabledReason,
  composerHint,
  queuedCommentReason,
  onVote,
  onAdd,
  onReviewConversation,
  onImageUpload,
  onAttachImage,
  onInterruptQueued,
  onDeleteComment,
  onPauseWorkRun,
  onStopResponse,
  stopResponsePending,
  pauseWorkPending,
  pauseWorkScope,
  runFinalizationActions,
  onCancelQueued,
  interruptingQueuedRunId,
  pausingWorkRunId,
  onImageClick,
  onAcceptInteraction,
  onRejectInteraction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  onSkipInteraction,
  onSubmitInteractionVerdicts,
  assigneeUserId,
  onResumeFromBacklog,
  resumeFromBacklogPending,
  onResumeAssignee,
  resumeAssigneePending,
  onTryAgainNoLiveExecutionPath,
  tryAgainNoLiveExecutionPathPending,
  externalReferences,
  linkCaseReferences,
}: IssueDetailChatTabProps) {
  // Preserve master's Classic Task Interface seam: Streamlined UI changes the
  // TaskChatThread presentation but never swaps it for IssueChatThread.
  const { classicTaskInterfaceEnabled, streamlinedTaskDetailEnabled } =
    useTaskDetailInterfaceMode(!!conversationMode);
  const ThreadComponent = classicTaskInterfaceEnabled
    ? IssueChatThread
    : TaskChatThread;
  const queryClient = useQueryClient();
  const scrollLocation = useLocation();
  const scrollNavigationType = useNavigationType();
  const { pushToast } = useToastActions();
  const {
    data: activity,
    isPending: activityPending,
    isError: activityError,
    refetch: refetchActivity,
  } = useQuery({
    queryKey: queryKeys.issues.activity(issueId),
    queryFn: () => activityApi.forIssue(issueId),
    enabled: !!issueId,
    placeholderData: keepPreviousDataForSameQueryTail<ActivityEvent[]>(issueId),
  });
  // Both endpoints return only queued or running runs, so their data is the
  // liveness signal. The page's slow probe (TaskDetailSurface) notices a run
  // starting; these follow it at 1 s only while it is live.
  const { visible: pageVisible } = usePageVisibility();
  const {
    data: liveRuns,
    isFetched: liveRunsFetched,
    isError: liveRunsError,
    refetch: refetchLiveRuns,
  } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: (query) =>
      taskPollInterval(
        { issueStatus, live: (query.state.data?.length ?? 0) > 0, visible: pageVisible },
        1000,
      ),
    placeholderData:
      keepPreviousDataForSameQueryTail<LiveRunForIssue[]>(issueId),
  });
  const resolvedLiveRuns = liveRuns ?? [];
  const liveRunCount = resolvedLiveRuns.length;
  const activeRunQueryEnabled =
    !!executionRunId || issueStatus === "in_progress";
  const {
    data: activeRun = null,
    isFetched: activeRunFetched,
    isError: activeRunError,
    refetch: refetchActiveRun,
  } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: activeRunQueryEnabled,
    refetchInterval: (query) =>
      taskPollInterval(
        { issueStatus, live: liveRunCount === 0 && query.state.data != null, visible: pageVisible },
        1000,
      ),
    placeholderData: keepPreviousDataForSameQueryTail<ActiveRunForIssue | null>(
      issueId,
    ),
  });
  const resolvedActiveRun = useMemo(
    () =>
      resolveIssueActiveRun({ status: issueStatus, executionRunId }, activeRun, liveRuns),
    [activeRun, executionRunId, issueStatus, liveRuns],
  );
  const assigneeUsesPaperclipRunner = Boolean(
    issueAssigneeAgentId &&
    agentMap.get(issueAssigneeAgentId)?.adapterType === "paperclip_runner",
  );
  const liveRuntimeRun =
    resolvedActiveRun ??
    resolvedLiveRuns.find(
      (run) => run.status === "running" || run.status === "queued",
    ) ??
    null;
  // Do not briefly select queue behavior from the current assignee while the
  // authoritative active-run lookup is still loading. The active runtime owns
  // the protocol: native GS Agentic Manager turns can steer in place, while legacy
  // adapters expose the same composer queue with an interrupt fallback.
  const runtimeSelectionKnown =
    liveRunsFetched && (!activeRunQueryEnabled || activeRunFetched);
  const queuedCommentQueueEnabled =
    !classicTaskInterfaceEnabled &&
    runtimeSelectionKnown &&
    Boolean(liveRuntimeRun || issueAssigneeAgentId);
  const { data: authoritativeQueuedCommentQueue } = useQuery({
    queryKey: queryKeys.issues.queuedComments(issueId),
    queryFn: async () =>
      normalizeIssueQueuedCommentQueue(
        await issuesApi.getQueuedComments(issueId),
        issueId,
      ),
    enabled: queuedCommentQueueEnabled,
    refetchInterval: (query) => queuedCommentQueueEnabled &&
      (liveRuntimeRun || query.state.data?.entries.length) ? 1000 : false,
  });
  const [consumedQueuedCommentIds, setConsumedQueuedCommentIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [discardedQueuedCommentIds, setDiscardedQueuedCommentIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [localSteeringPlacements, setLocalSteeringPlacements] = useState<
    ReadonlyMap<
      string,
      { targetRunId: string; anchorAt: string; sequence: number }
    >
  >(() => new Map());
  useEffect(() => {
    setConsumedQueuedCommentIds(new Set());
    setDiscardedQueuedCommentIds(new Set());
  }, [issueId]);
  useEffect(() => {
    setLocalSteeringPlacements(new Map());
  }, [issueId]);
  const hasLiveRuns = liveRunCount > 0 || !!resolvedActiveRun;
  const {
    data: linkedRuns,
    isPending: linkedRunsPending,
    isError: linkedRunsError,
    refetch: refetchLinkedRuns,
  } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    enabled: !!issueId,
    refetchInterval: taskPollInterval(
      { issueStatus, live: hasLiveRuns, visible: pageVisible },
      1000,
    ),
    placeholderData: keepPreviousDataForSameQueryTail<RunForIssue[]>(issueId),
  });
  const resolvedActivity = activity ?? [];
  const resolvedLinkedRuns = linkedRuns ?? [];
  const retryFailedRun = useMutation({
    mutationFn: async (runId: string) => {
      const failedRun = resolvedLinkedRuns.find((run) => run.runId === runId);
      if (!failedRun) throw new Error("Failed run is no longer available.");
      return agentsApi.retryFailedRun(
        failedRun.agentId,
        failedRun.runId,
        companyId,
      );
    },
    onSuccess: (result) => {
      if (!result.runId) {
        pushToast({
          title: "Retry queued",
          body: "The exact request will retry when this task is ready.",
          tone: "success",
        });
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.runs(issueId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.liveRuns(issueId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.activeRun(issueId),
      });
    },
    onError: (error) => {
      pushToast({
        title: "Run retry failed",
        body: error instanceof Error ? error.message : "Unable to retry run",
        tone: "error",
      });
    },
  });

  const interruptibleIssueRun = useMemo(
    () => resolveInterruptibleIssueRun(resolvedActiveRun, resolvedLiveRuns),
    [resolvedActiveRun, resolvedLiveRuns],
  );
  const liveRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of resolvedLiveRuns) ids.add(run.id);
    if (resolvedActiveRun) ids.add(resolvedActiveRun.id);
    return ids;
  }, [resolvedActiveRun, resolvedLiveRuns]);
  const timelineRuns = useMemo(() => {
    const historicalRuns =
      liveRunIds.size === 0
        ? resolvedLinkedRuns
        : resolvedLinkedRuns.filter((run) => !liveRunIds.has(run.runId));
    return historicalRuns.map((run) => ({
      ...run,
      adapterType: run.adapterType,
      hasStoredOutput: (run.logBytes ?? 0) > 0,
    }));
  }, [liveRunIds, resolvedLinkedRuns]);
  const commentsWithRunMeta = useMemo<IssueDetailComment[]>(() => {
    const activeRunStartedAt =
      interruptibleIssueRun?.startedAt ??
      interruptibleIssueRun?.createdAt ??
      null;
    const runMetaByCommentId = new Map<
      string,
      {
        runId: string;
        runAgentId: string | null;
        interruptedRunId: string | null;
      }
    >();
    const followUpCommentIds = new Set<string>();
    const agentIdByRunId = new Map<string, string>();
    const inputPlacementByCommentId = new Map<
      string,
      {
        runId: string;
        anchorAt: string;
        sequence: number;
        anchorMs: number;
        kind: "run_start" | "steer";
      }
    >();

    for (const run of resolvedLinkedRuns) {
      agentIdByRunId.set(run.runId, run.agentId);
      const batchedIds = Array.isArray(run.wakeCommentIds)
        ? run.wakeCommentIds.filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          )
        : [];
      const fallbackId =
        typeof run.wakeCommentId === "string" && run.wakeCommentId.length > 0
          ? run.wakeCommentId
          : typeof run.contextCommentId === "string" &&
              run.contextCommentId.length > 0
            ? run.contextCommentId
            : null;
      const inputIds =
        batchedIds.length > 0 ? batchedIds : fallbackId ? [fallbackId] : [];
      const anchorAt = run.startedAt ?? run.createdAt;
      const anchorMs = new Date(anchorAt).getTime();
      inputIds.forEach((commentId, sequence) => {
        const existing = inputPlacementByCommentId.get(commentId);
        if (existing && existing.anchorMs <= anchorMs) return;
        inputPlacementByCommentId.set(commentId, {
          runId: run.runId,
          anchorAt,
          sequence,
          anchorMs,
          kind: "run_start",
        });
      });
    }
    // Same-turn steering has a durable PRP acknowledgement and a matching
    // activity fact keyed by commentId/targetRunId. Its acknowledgement time,
    // not the comment submission time, is the causal conversation slot. Use
    // only the first acknowledgement; an idempotent replay emits a diagnostic
    // activity row with duplicate=true but must not move the message later.
    const steeringEvents = resolvedActivity
      .filter((evt) => evt.action === "issue.queued_comment_steered")
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
    const steeringSequenceByRunId = new Map<string, number>();
    for (const evt of steeringEvents) {
      const details = evt.details ?? {};
      if (details["duplicate"] === true) continue;
      const commentId =
        typeof details["commentId"] === "string" ? details["commentId"] : null;
      const targetRunId =
        typeof details["targetRunId"] === "string"
          ? details["targetRunId"]
          : null;
      if (!commentId || !targetRunId) continue;
      const anchorAt =
        evt.createdAt instanceof Date
          ? evt.createdAt.toISOString()
          : evt.createdAt;
      const anchorMs = new Date(anchorAt).getTime();
      if (!Number.isFinite(anchorMs)) continue;
      const sequence = steeringSequenceByRunId.get(targetRunId) ?? 0;
      steeringSequenceByRunId.set(targetRunId, sequence + 1);
      inputPlacementByCommentId.set(commentId, {
        runId: targetRunId,
        anchorAt,
        sequence,
        anchorMs,
        kind: "steer",
      });
    }
    for (const [commentId, placement] of localSteeringPlacements) {
      if (inputPlacementByCommentId.has(commentId)) continue;
      inputPlacementByCommentId.set(commentId, {
        runId: placement.targetRunId,
        anchorAt: placement.anchorAt,
        sequence: placement.sequence,
        anchorMs: new Date(placement.anchorAt).getTime(),
        kind: "steer",
      });
    }
    for (const evt of resolvedActivity) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId =
        typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      const interruptedRunId =
        typeof details["interruptedRunId"] === "string"
          ? details["interruptedRunId"]
          : null;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
        interruptedRunId,
      });
    }
    for (const evt of resolvedActivity) {
      if (evt.action !== "issue.comment_added") continue;
      const details = evt.details ?? {};
      const commentId =
        typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId) continue;
      if (
        details["followUpRequested"] === true ||
        details["resumeIntent"] === true
      ) {
        followUpCommentIds.add(commentId);
      }
    }

    const projectedComments = comments.map((comment) => {
      const activityMeta = runMetaByCommentId.get(comment.id);
      // Internal run finalization can persist a reply without a separate
      // comment_added activity row. Its durable authoring run is stronger
      // evidence than activity projection, and lets the transcript's chosen
      // completion comment own the answer after a refresh.
      const authoredRunId =
        comment.authorType === "agent" && comment.authorAgentId
          ? comment.createdByRunId
          : null;
      const meta = authoredRunId
        ? {
            runId: authoredRunId,
            runAgentId: comment.authorAgentId,
            interruptedRunId:
              activityMeta?.runId === authoredRunId
                ? activityMeta.interruptedRunId
                : null,
          }
        : activityMeta;
      const inputPlacement = inputPlacementByCommentId.get(comment.id);
      const submittedAtMs = new Date(comment.createdAt).getTime();
      // Older activity rows may predate the explicit followUpRequested flag.
      // A run-start input is a provable queued follow-up only when it was
      // submitted during a completed run for this issue and the same agent,
      // before the target run consumed it. Merely overlapping any linked run
      // is not enough: issue activity can link otherwise unrelated runs.
      const targetRun =
        inputPlacement?.kind === "run_start"
          ? resolvedLinkedRuns.find((run) => run.runId === inputPlacement.runId)
          : undefined;
      const targetStartedAtMs = targetRun
        ? new Date(targetRun.startedAt ?? targetRun.createdAt).getTime()
        : Number.NaN;
      const submittedDuringSourceRun = Boolean(
        targetRun?.contextIssueId === issueId &&
        Number.isFinite(targetStartedAtMs) &&
        Number.isFinite(submittedAtMs) &&
        resolvedLinkedRuns.some((run) => {
          if (
            run.runId === targetRun.runId ||
            run.agentId !== targetRun.agentId ||
            run.contextIssueId !== issueId ||
            !run.finishedAt
          ) {
            return false;
          }
          const startedAtMs = new Date(
            run.startedAt ?? run.createdAt,
          ).getTime();
          const finishedAtMs = new Date(run.finishedAt).getTime();
          return (
            Number.isFinite(startedAtMs) &&
            Number.isFinite(finishedAtMs) &&
            startedAtMs <= submittedAtMs &&
            submittedAtMs <= finishedAtMs &&
            finishedAtMs <= targetStartedAtMs
          );
        }),
      );
      const nextComment: IssueDetailComment = {
        ...comment,
        ...(meta ?? {}),
        ...(inputPlacement
          ? {
              consumedByRunId: inputPlacement.runId,
              ...(inputPlacement.kind === "steer"
                ? { steeredIntoRunId: inputPlacement.runId }
                : {}),
              conversationAnchorAt: inputPlacement.anchorAt,
              conversationAnchorSequence: inputPlacement.sequence,
            }
          : {}),
      };
      if (followUpCommentIds.has(comment.id) || submittedDuringSourceRun) {
        nextComment.followUpRequested = true;
      }
      const queuedTargetRunId =
        locallyQueuedCommentRunIds.get(comment.id) ??
        nextComment.queueTargetRunId ??
        null;
      if (inputPlacement?.kind === "steer") {
        return nextComment;
      }
      const locallyQueuedComment = applyLocalQueuedIssueCommentState(
        nextComment,
        {
          queuedTargetRunId,
          targetRunIsLive: queuedTargetRunId
            ? liveRunIds.has(queuedTargetRunId)
            : false,
          runningRunId: interruptibleIssueRun?.id ?? null,
        },
      );
      if (locallyQueuedComment !== nextComment) {
        return locallyQueuedComment;
      }
      // A queued target is fixed when the message is submitted. If that run
      // settles while the request is still in flight, do not rebind the
      // message's Interrupt action to an unrelated run that became live later.
      if (queuedTargetRunId) {
        return nextComment;
      }
      if (
        isQueuedIssueComment({
          comment: nextComment,
          activeRunStartedAt,
          activeRunAgentId: interruptibleIssueRun?.agentId ?? null,
          activeRunCommentId: interruptibleIssueRun?.contextCommentId ?? null,
          activeRunWakeCommentId:
            interruptibleIssueRun?.contextWakeCommentId ?? null,
          runId: meta?.runId ?? nextComment.runId ?? null,
          interruptedRunId:
            meta?.interruptedRunId ?? nextComment.interruptedRunId ?? null,
        })
      ) {
        return {
          ...nextComment,
          queueState: "queued" as const,
          queueTargetRunId: interruptibleIssueRun?.id ?? null,
          queueReason: queuedCommentReason,
        };
      }
      return nextComment;
    });
    const questionDeliveryByInteractionId = new Map<
      string,
      { targetRunId: string; deliveryMode: string | null }
    >();
    for (const event of resolvedActivity) {
      if (event.action !== "issue.question_response_delivered") continue;
      const details = event.details ?? {};
      const interactionId =
        typeof details["interactionId"] === "string"
          ? details["interactionId"]
          : null;
      const targetRunId =
        typeof details["targetRunId"] === "string"
          ? details["targetRunId"]
          : null;
      if (
        !interactionId ||
        !targetRunId ||
        questionDeliveryByInteractionId.has(interactionId)
      ) {
        continue;
      }
      questionDeliveryByInteractionId.set(interactionId, {
        targetRunId,
        deliveryMode:
          typeof details["deliveryMode"] === "string"
            ? details["deliveryMode"]
            : null,
      });
    }
    const responseComments = classicTaskInterfaceEnabled
      ? []
      : interactions.flatMap((interaction): IssueDetailComment[] => {
          const answeredQuestions =
            interaction.kind === "ask_user_questions" &&
            interaction.status === "answered";
          const resolvedPlanDecision =
            isPlanConfirmationInteraction(interaction) &&
            (interaction.status === "accepted" ||
              interaction.status === "rejected");
          if (
            (!answeredQuestions && !resolvedPlanDecision) ||
            !interaction.resolvedAt
          ) {
            return [];
          }
          const resolvedAt =
            interaction.resolvedAt instanceof Date
              ? interaction.resolvedAt
              : new Date(interaction.resolvedAt);
          if (Number.isNaN(resolvedAt.getTime())) return [];
          const delivery = answeredQuestions
            ? (questionDeliveryByInteractionId.get(interaction.id) ?? null)
            : null;
          const queuedTargetRunId =
            interaction.sourceRunId &&
            interruptibleIssueRun?.id === interaction.sourceRunId &&
            interruptibleIssueRun.adapterType !== "paperclip_runner"
              ? interaction.sourceRunId
              : null;
          const body =
            interaction.kind === "ask_user_questions"
              ? buildAnsweredQuestionsDeliveryText(interaction)
              : isPlanConfirmationInteraction(interaction)
                ? buildPlanDecisionResponseText(interaction)
                : "";
          return [
            {
              id: `interaction-response:${interaction.id}`,
              companyId: interaction.companyId,
              issueId: interaction.issueId,
              authorType: interaction.resolvedByAgentId ? "agent" : "user",
              authorAgentId: interaction.resolvedByAgentId ?? null,
              authorUserId: interaction.resolvedByUserId ?? null,
              createdByRunId: interaction.resolvedByRunId ?? null,
              body,
              presentation: null,
              metadata: null,
              createdAt: resolvedAt,
              updatedAt: resolvedAt,
              consumedByRunId: delivery?.targetRunId ?? null,
              ...(delivery?.deliveryMode === "steered"
                ? { steeredIntoRunId: delivery.targetRunId }
                : {}),
              conversationAnchorAt: resolvedAt,
              conversationAnchorSequence: 0,
              ...(queuedTargetRunId
                ? {
                    queueState: "queued" as const,
                    queueTargetRunId: queuedTargetRunId,
                    queueReason: queuedCommentReason,
                  }
                : {}),
            },
          ];
        });
    return [...projectedComments, ...responseComments];
  }, [
    comments,
    classicTaskInterfaceEnabled,
    interactions,
    liveRunIds,
    localSteeringPlacements,
    locallyQueuedCommentRunIds,
    queuedCommentReason,
    resolvedActivity,
    resolvedLinkedRuns,
    interruptibleIssueRun,
  ]);
  const effectiveQueuedCommentQueue = useMemo(() => {
    if (!queuedCommentQueueEnabled) return null;
    const visibleAuthoritativeQueue = authoritativeQueuedCommentQueue
      ? {
          ...authoritativeQueuedCommentQueue,
          entries: authoritativeQueuedCommentQueue.entries.filter(
            (entry) =>
              !consumedQueuedCommentIds.has(entry.comment.id) &&
              !discardedQueuedCommentIds.has(entry.comment.id),
          ),
        }
      : null;
    const pendingComments = commentsWithRunMeta.flatMap((comment) => {
      if (
        consumedQueuedCommentIds.has(comment.id) ||
        discardedQueuedCommentIds.has(comment.id) ||
        comment.steeredIntoRunId
      ) {
        return [];
      }
      const targetRunId =
        locallyQueuedCommentRunIds.get(comment.id) ??
        ("clientStatus" in comment && comment.clientStatus === "queued"
          ? (comment.queueTargetRunId ?? null)
          : comment.queueState === "queued"
            ? (comment.queueTargetRunId ?? null)
            : null);
      return targetRunId ? [{ comment, targetRunId }] : [];
    });
    const fallbackProtocol =
      liveRuntimeRun?.runtimeMode === "native" &&
      liveRuntimeRun.adapterType === "paperclip_runner"
        ? "paperclip_runner_v1"
        : "legacy";
    return mergePendingIssueQueuedComments({
      issueId,
      authoritativeQueue: visibleAuthoritativeQueue,
      pendingComments,
      fallbackProtocol,
    });
  }, [
    authoritativeQueuedCommentQueue,
    commentsWithRunMeta,
    consumedQueuedCommentIds,
    discardedQueuedCommentIds,
    issueId,
    liveRuntimeRun,
    locallyQueuedCommentRunIds,
    queuedCommentQueueEnabled,
  ]);
  const commentsForThread = useMemo(
    () =>
      commentsWithRunMeta.flatMap((comment) => {
        if (discardedQueuedCommentIds.has(comment.id)) return [];
        if (!consumedQueuedCommentIds.has(comment.id)) return [comment];
        return [
          {
            ...comment,
            clientStatus: undefined,
            queueState: undefined,
            queueTargetRunId: null,
            queueReason: undefined,
          },
        ];
      }),
    [commentsWithRunMeta, consumedQueuedCommentIds, discardedQueuedCommentIds],
  );

  const storeQueuedCommentQueue = useCallback(
    (value: unknown) => {
      const queue = normalizeIssueQueuedCommentQueue(value, issueId);
      queryClient.setQueryData(queryKeys.issues.queuedComments(issueId), queue);
      return queue;
    },
    [issueId, queryClient],
  );

  const refreshQueueAfterConflict = useCallback(
    async (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.issues.queuedComments(issueId),
        });
      }
      throw error;
    },
    [issueId, queryClient],
  );

  const editQueuedComment = useCallback(
    async (commentId: string, body: string, revision: string) => {
      const queueId = effectiveQueuedCommentQueue?.queueId;
      if (!queueId)
        throw new Error(
          "The queued message is awaiting server acknowledgement.",
        );
      try {
        storeQueuedCommentQueue(
          await issuesApi.editQueuedComment(issueId, commentId, {
            body,
            queueId,
            revision,
          }),
        );
        await queryClient.invalidateQueries({
          queryKey: queryKeys.issues.comments(issueId),
        });
      } catch (error) {
        await refreshQueueAfterConflict(error);
      }
    },
    [
      effectiveQueuedCommentQueue?.queueId,
      issueId,
      queryClient,
      refreshQueueAfterConflict,
      storeQueuedCommentQueue,
    ],
  );

  const reorderQueuedComments = useCallback(
    async (orderedCommentIds: string[], revision: string) => {
      const queueId = effectiveQueuedCommentQueue?.queueId;
      if (!queueId)
        throw new Error(
          "The queued messages are awaiting server acknowledgement.",
        );
      try {
        storeQueuedCommentQueue(
          await issuesApi.reorderQueuedComments(issueId, {
            orderedCommentIds,
            queueId,
            revision,
          }),
        );
      } catch (error) {
        await refreshQueueAfterConflict(error);
      }
    },
    [
      effectiveQueuedCommentQueue?.queueId,
      issueId,
      refreshQueueAfterConflict,
      storeQueuedCommentQueue,
    ],
  );

  const steerQueuedComment = useCallback(
    async (commentId: string, revision: string) => {
      const queueId = effectiveQueuedCommentQueue?.queueId;
      const targetRunId = effectiveQueuedCommentQueue?.targetRunId;
      if (!queueId || !targetRunId)
        throw new Error(
          "The queued message no longer has an active run target.",
        );
      try {
        const nextQueue = await issuesApi.steerQueuedComment(
          issueId,
          commentId,
          {
            queueId,
            targetRunId,
            revision,
          },
        );
        // Keep the queue component mounted until the server accepts steering:
        // its pending/error state must survive a rejected last-row action.
        const anchorAt = new Date().toISOString();
        setLocalSteeringPlacements((current) => {
          const next = new Map(current);
          const sequence = [...current.values()].filter(
            (placement) => placement.targetRunId === targetRunId,
          ).length;
          next.set(commentId, { targetRunId, anchorAt, sequence });
          return next;
        });
        setConsumedQueuedCommentIds((current) => new Set(current).add(commentId));
        // The local steering placement already promoted the message into the
        // active turn. Refresh its durable acknowledgement before publishing
        // the returned queue so the local and server anchors hand off without a
        // bubble-to-queue-to-bubble jump.
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.comments(issueId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.activity(issueId),
          }),
        ]);
        storeQueuedCommentQueue(nextQueue);
      } catch (error) {
        setConsumedQueuedCommentIds((current) => {
          const next = new Set(current);
          next.delete(commentId);
          return next;
        });
        setLocalSteeringPlacements((current) => {
          const next = new Map(current);
          next.delete(commentId);
          return next;
        });
        await refreshQueueAfterConflict(error);
      }
    },
    [
      effectiveQueuedCommentQueue?.queueId,
      effectiveQueuedCommentQueue?.targetRunId,
      issueId,
      queryClient,
      refreshQueueAfterConflict,
      storeQueuedCommentQueue,
    ],
  );

  const discardQueuedComment = useCallback(
    async (commentId: string, revision: string) => {
      const queueId = effectiveQueuedCommentQueue?.queueId;
      if (!queueId)
        throw new Error(
          "The queued message is awaiting server acknowledgement.",
        );
      try {
        storeQueuedCommentQueue(
          await issuesApi.discardQueuedComment(issueId, commentId, {
            queueId,
            revision,
          }),
        );
        setDiscardedQueuedCommentIds((current) =>
          new Set(current).add(commentId),
        );
        // Discard deletes the persisted issue comment. Remove the cached copy
        // in the same commit as the queue update so it cannot briefly return as
        // a normal user bubble when the now-empty queue loses its queueId.
        queryClient.setQueryData<
          InfiniteData<IssueComment[], string | null> | undefined
        >(queryKeys.issues.comments(issueId), (current) =>
          current
            ? {
                ...current,
                pages: removeIssueCommentFromPages(current.pages, commentId),
              }
            : current,
        );
        await queryClient.invalidateQueries({
          queryKey: queryKeys.issues.comments(issueId),
        });
      } catch (error) {
        const responseBody =
          error instanceof ApiError &&
          typeof error.body === "object" &&
          error.body !== null
            ? (error.body as { code?: unknown; details?: unknown })
            : null;
        const details =
          responseBody &&
          typeof responseBody.details === "object" &&
          responseBody.details !== null
            ? (responseBody.details as { code?: unknown })
            : null;
        const code =
          typeof details?.code === "string"
            ? details.code
            : typeof responseBody?.code === "string"
              ? responseBody.code
              : null;
        if (code === "queued_comment_already_dispatching") {
          pushToast({
            title: "Message is already being sent",
            body: "The continuation started before the discard was confirmed, so GS Agentic Manager could not unsend it.",
            tone: "error",
            ttlMs: 15_000,
            dedupeKey: `queued-comment-already-dispatching:${issueId}:${commentId}`,
          });
        }
        await refreshQueueAfterConflict(error);
      }
    },
    [
      effectiveQueuedCommentQueue?.queueId,
      issueId,
      pushToast,
      queryClient,
      refreshQueueAfterConflict,
      storeQueuedCommentQueue,
    ],
  );

  const timelineEvents = useMemo(
    () => extractIssueTimelineEvents(resolvedActivity),
    [resolvedActivity],
  );
  const workModeChanges = useMemo(
    () => extractIssueWorkModeChanges(resolvedActivity),
    [resolvedActivity],
  );

  const loadOlderButton = hasOlderComments ? (
    <div className="flex justify-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={commentsLoadingOlder}
        onClick={onLoadOlderComments}
      >
        {commentsLoadingOlder
          ? "Loading earlier comments..."
          : "Load earlier comments"}
      </Button>
    </div>
  ) : null;

  return (
    <div
      className={
        classicTaskInterfaceEnabled
          ? "space-y-3"
          : "flex min-h-0 flex-1 flex-col"
      }
    >
      {/* Chat-style: the button rides inside the thread's scroll viewport with
          the header so nothing sits above the thread in the page flow. */}
      {classicTaskInterfaceEnabled ? loadOlderButton : null}
      {classicTaskInterfaceEnabled &&
      commentsInitialLoading &&
      commentsWithRunMeta.length === 0 &&
      interactions.length === 0 ? (
        <IssueChatSkeleton />
      ) : (
        <TaskChatScrollNavigation.Provider
          value={{
            key: scrollLocation.key,
            restore: scrollNavigationType === "POP",
            hash: scrollLocation.hash,
          }}
        >
          <EmailThreadProvider
            companyId={companyId}
            issueId={issueId}
            refetchInterval={taskPollInterval(
              { issueStatus, live: hasLiveRuns, visible: pageVisible },
              3000,
              30_000,
            )}
          >
          <ThreadComponent
            key={conversationMode ? draftKey : issueId}
            {...(!classicTaskInterfaceEnabled
              ? { creationActivity: resolvedActivity, initialCommentsPending: commentsInitialLoading }
              : {})}
            onOpenSkill={onOpenSkill}
            initialHistoryPending={!!issueId && (
              initialHistoryPending ||
              commentsInitialLoading ||
              activityPending ||
              linkedRunsPending ||
              !runtimeSelectionKnown)
            }
            initialHistoryError={
              initialHistoryError ||
              activityError ||
              linkedRunsError ||
              liveRunsError ||
              (activeRunQueryEnabled && activeRunError)
            }
            onRetryInitialHistory={() => {
              onRetryInitialHistory?.();
              void refetchActivity();
              void refetchLinkedRuns();
              void refetchLiveRuns();
              if (activeRunQueryEnabled) void refetchActiveRun();
            }}
            composerRef={composerRef}
            composerAccessory={composerAccessory}
            threadHeader={
              !classicTaskInterfaceEnabled &&
              (threadHeader || loadOlderButton) ? (
                <>
                  {threadHeader}
                  {loadOlderButton}
                </>
              ) : null
            }
            issueBrief={issueBrief}
            comments={commentsForThread}
            interactions={interactions}
            documents={documents}
            workProducts={workProducts}
            attachments={attachments}
            feedbackVotes={feedbackVotes}
            feedbackDataSharingPreference={feedbackDataSharingPreference}
            feedbackTermsUrl={feedbackTermsUrl}
            linkedRuns={timelineRuns}
            onRetryFailedRun={(runId) =>
              retryFailedRun.mutateAsync(runId).then(() => undefined)
            }
            retryFailedRunId={
              retryFailedRun.isPending ? retryFailedRun.variables : null
            }
            timelineEvents={timelineEvents}
            workModeChanges={workModeChanges}
            liveRuns={resolvedLiveRuns}
            activeRun={resolvedActiveRun}
            issueId={issueId}
            blockedBy={blockedBy ?? []}
            liveIssueIds={liveIssueIds}
            blockerAttention={blockerAttention}
            successfulRunHandoff={successfulRunHandoff}
            scheduledRetry={scheduledRetry}
            recoveryAction={recoveryAction ?? null}
            onResolveRecoveryAction={onResolveRecoveryAction}
            onReissueIsolatedRecoveryAction={onReissueIsolatedRecoveryAction}
            reissueIsolatedRecoveryActionPending={
              reissueIsolatedRecoveryActionPending
            }
            onReconcileForwardRecoveryAction={onReconcileForwardRecoveryAction}
            onBreakGlassOverrideRecoveryAction={
              onBreakGlassOverrideRecoveryAction
            }
            onQuarantineRestoreRecoveryAction={
              onQuarantineRestoreRecoveryAction
            }
            quarantineRestoreRecoveryActionPending={
              quarantineRestoreRecoveryActionPending
            }
            canBreakGlassRecoveryAction={canBreakGlassRecoveryAction}
            reconcileRecoveryActionPending={reconcileRecoveryActionPending}
            canFalsePositiveRecoveryAction={canFalsePositiveRecoveryAction}
            legacyRecoverySourceIssue={legacyRecoverySourceIssue ?? null}
            companyId={companyId}
            projectId={projectId}
            issueStatus={issueStatus}
            issueAssigneeAgentId={issueAssigneeAgentId}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            userProfileMap={userProfileMap}
            draftKey={draftKey}
            conversationMode={conversationMode}
            enableReassign={!conversationMode}
            reassignOptions={reassignOptions}
            currentAssigneeValue={currentAssigneeValue}
            suggestedAssigneeValue={suggestedAssigneeValue}
            mentions={mentions}
            composerPause={composerPause}
            composerDisabledReason={composerDisabledReason}
            composerHint={composerHint}
            onVote={onVote}
            onAdd={onAdd}
            onReviewConversation={onReviewConversation}
            imageUploadHandler={onImageUpload}
            onAttachImage={onAttachImage}
            onInterruptQueued={onInterruptQueued}
            queuedCommentQueue={effectiveQueuedCommentQueue}
            onEditQueuedComment={editQueuedComment}
            onReorderQueuedComments={reorderQueuedComments}
            onSteerQueuedComment={steerQueuedComment}
            onDiscardQueuedComment={discardQueuedComment}
            onDeleteComment={onDeleteComment}
            onCancelQueued={onCancelQueued}
            interruptingQueuedRunId={interruptingQueuedRunId}
            stoppingRunId={
              pauseWorkPending
                ? (pausingWorkRunId ?? interruptibleIssueRun?.id ?? null)
                : pausingWorkRunId
            }
            onStopRun={
              onPauseWorkRun
                ? (runId) => onPauseWorkRun(runId).catch(() => undefined)
                : undefined
            }
            stopRunLabel="Pause work"
            stoppingRunLabel="Pausing..."
            stopRunVariant="pause"
            runFinalizationActions={runFinalizationActions}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
            onSubmitInteractionAnswers={(interaction, answers) =>
              onSubmitInteractionAnswers(interaction, answers)
            }
            onCancelInteraction={onCancelInteraction}
            onSkipInteraction={onSkipInteraction}
            onSubmitInteractionVerdicts={onSubmitInteractionVerdicts}
            issueWorkMode={issueWorkMode}
            onWorkModeChange={onWorkModeChange}
            stopPending={stopResponsePending}
            onCancelRun={
              interruptibleIssueRun && onStopResponse
                ? () => onStopResponse(interruptibleIssueRun.id)
                : undefined
            }
            onImageClick={onImageClick}
            onRefreshLatestComments={onRefreshLatestComments}
            assigneeUserId={assigneeUserId}
            onResumeFromBacklog={onResumeFromBacklog}
            resumeFromBacklogPending={resumeFromBacklogPending}
            onResumeAssignee={onResumeAssignee}
            resumeAssigneePending={resumeAssigneePending}
            onTryAgainNoLiveExecutionPath={onTryAgainNoLiveExecutionPath}
            tryAgainNoLiveExecutionPathPending={
              tryAgainNoLiveExecutionPathPending
            }
            footer={footer}
            externalReferences={externalReferences}
            linkCaseReferences={linkCaseReferences}
          />
          </EmailThreadProvider>
        </TaskChatScrollNavigation.Provider>
      )}
    </div>
  );
});
