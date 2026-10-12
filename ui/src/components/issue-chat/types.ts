import type { TaskComposerPause } from "../task-chat/TaskChatPausedTakeover";
import type { ReactNode, Ref } from "react";
import type {
  IssueAttachment,
  Agent,
  IssueWorkMode,
  IssueDocumentSummary,
  IssueWorkProduct,
  FeedbackVote,
  FeedbackDataSharingPreference,
  IssueRelationIssueSummary,
  IssueBlockerAttention,
  SuccessfulRunHandoffState,
  IssueScheduledRetry,
  IssueRecoveryAction,
  FeedbackVoteValue,
  IssueQueuedCommentQueue,
} from "@greatstone/shared";
import type { LiveRunForIssue, ActiveRunForIssue } from "../../api/heartbeats";
import type { IssueChatComment, IssueChatLinkedRun, IssueChatTranscriptEntry } from "../../lib/issue-chat-messages";
import type {
  IssueThreadInteraction,
  SuggestTasksInteraction,
  RequestConfirmationInteraction,
  RequestCheckboxConfirmationInteraction,
  AskUserQuestionsInteraction,
  AskUserQuestionsAnswer,
  RequestItemVerdictsInteraction,
  RequestItemVerdictValue,
} from "../../lib/issue-thread-interactions";
import type { IssueTimelineEvent, IssueWorkModeChange } from "../../lib/issue-timeline-events";
import type { MarkdownExternalReferenceMap } from "../MarkdownBody";
import type { TaskChatIssueBrief } from "../task-chat/TaskChatDescriptionBubble";
import type { MentionOption } from "../MarkdownEditor";
import type { InlineEntityOption } from "../InlineEntitySelector";
import type { CompanyUserProfile } from "../../lib/company-members";
import type { RecoveryResolveOutcome, RecoveryReissueRequest } from "../IssueRecoveryActionCard";
import type { CommentReassignment } from "./helpers";
import type { IssueChatRunFinalizationAction } from "./IssueChatContext";

export interface IssueChatComposerHandle {
  focus: () => void;
  restoreDraft: (submittedBody: string) => void;
}

export interface IssueChatComposerProps {
  onSend: IssueChatThreadProps["onAdd"];
  confirmedSubmissionIds: ReadonlySet<string>;
  onReviewConversation?: () => Promise<void>;
  onStop?: () => Promise<void>;
  stopPending?: boolean;
  stopScope?: "leaf" | "subtree";
  onImageUpload?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<IssueAttachment | void>;
  draftKey?: string;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  agentMap?: Map<string, Agent>;
  /** Whether an agent run is currently in flight, so the composer can preview an interrupt. */
  hasActiveRun?: boolean;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  composerPause?: TaskComposerPause | null;
  composerDisabledReason?: string | null;
  composerHint?: string | null;
  issueStatus?: string;
  issueWorkMode?: IssueWorkMode;
  onWorkModeChange?: (workMode: IssueWorkMode) => Promise<void> | void;
}

export interface IssueChatThreadProps {
  comments: IssueChatComment[];
  interactions?: IssueThreadInteraction[];
  /** App-authoritative resources interleaved by the default task thread. */
  documents?: IssueDocumentSummary[];
  workProducts?: IssueWorkProduct[];
  attachments?: IssueAttachment[];
  feedbackVotes?: FeedbackVote[];
  feedbackDataSharingPreference?: FeedbackDataSharingPreference;
  feedbackTermsUrl?: string | null;
  linkedRuns?: IssueChatLinkedRun[];
  timelineEvents?: IssueTimelineEvent[];
  /**
   * Work-mode switch history from the activity feed. Only the chat-style
   * TaskChatThread consumes this to tag each agent reply with the mode its
   * request ran under; this thread — the classic task view behind
   * enableClassicTaskInterface — ignores it.
   */
  workModeChanges?: IssueWorkModeChange[];
  liveRuns?: LiveRunForIssue[];
  activeRun?: ActiveRunForIssue | null;
  issueId?: string | null;
  blockedBy?: IssueRelationIssueSummary[];
  /** Company-wide set of issue ids with a live (queued/running) run. */
  liveIssueIds?: ReadonlySet<string>;
  blockerAttention?: IssueBlockerAttention | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  scheduledRetry?: IssueScheduledRetry | null;
  recoveryAction?: IssueRecoveryAction | null;
  onResolveRecoveryAction?: (outcome: RecoveryResolveOutcome) => void;
  onReissueIsolatedRecoveryAction?: (request: RecoveryReissueRequest) => void;
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
  assigneeUserId?: string | null;
  /** Current assignee agent, used to mark cross-issue agent comments (the open cross-task write design (attribution)). */
  issueAssigneeAgentId?: string | null;
  onResumeFromBacklog?: () => Promise<void> | void;
  resumeFromBacklogPending?: boolean;
  /** Resume a paused assignee agent so runs can start again. */
  onResumeAssignee?: () => Promise<void> | void;
  resumeAssigneePending?: boolean;
  /** Requeues a blocked task after its no-live-execution-path recovery notice. */
  onTryAgainNoLiveExecutionPath?: () => Promise<void> | void;
  tryAgainNoLiveExecutionPathPending?: boolean;
  /** Starts a fresh on-demand run for the selected failed run. */
  onRetryFailedRun?: (runId: string) => Promise<void> | void;
  retryFailedRunId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
  issueStatus?: string;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
  onVote?: (
    commentId: string,
    vote: FeedbackVoteValue,
    options?: { allowSharing?: boolean; reason?: string },
  ) => Promise<void>;
  onAdd: (
    body: string,
    reopen?: boolean,
    reassignment?: CommentReassignment,
    attachmentIds?: string[],
    clientRequestId?: string,
  ) => Promise<void>;
  onReviewConversation?: () => Promise<void>;
  onCancelRun?: () => Promise<void>;
  stopPending?: boolean;
  stopScope?: "leaf" | "subtree";
  onStopRun?: (runId: string) => Promise<void>;
  stopRunLabel?: string;
  stoppingRunLabel?: string;
  stopRunVariant?: "stop" | "pause";
  runFinalizationActions?: readonly IssueChatRunFinalizationAction[];
  imageUploadHandler?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<IssueAttachment | void>;
  draftKey?: string;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  composerPause?: TaskComposerPause | null;
  composerDisabledReason?: string | null;
  composerHint?: string | null;
  onWorkModeChange?: (workMode: IssueWorkMode) => Promise<void> | void;
  showComposer?: boolean;
  showJumpToLatest?: boolean;
  autoScrollToLatestOnInitialLoad?: boolean;
  autoScrollToHashOnInitialLoad?: boolean;
  emptyMessage?: string;
  footer?: ReactNode;
  /**
   * Issue header content (title row, badges, plugin toolbars) rendered INSIDE
   * the thread's scroll viewport so it scrolls away with the messages. Only
   * the chat-style TaskChatThread consumes this; this thread ignores it — its
   * header stays in the page flow.
   */
  threadHeader?: ReactNode;
  /**
   * The task description rendered as the requester's first chat bubble
   * (PAP-375). Only the chat-style TaskChatThread consumes it; this thread
   * ignores it — its description stays in the page header via InlineEditor.
   */
  issueBrief?: TaskChatIssueBrief;
  variant?: "full" | "embedded";
  enableLiveTranscriptPolling?: boolean;
  transcriptsByRunId?: ReadonlyMap<string, readonly IssueChatTranscriptEntry[]>;
  hasOutputForRun?: (runId: string) => boolean;
  includeSucceededRunsWithoutOutput?: boolean;
  onInterruptQueued?: (runId: string | null) => Promise<void>;
  onCancelQueued?: (commentId: string) => void;
  /** Authoritative PRP queue. The classic thread intentionally ignores it. */
  queuedCommentQueue?: IssueQueuedCommentQueue | null;
  onEditQueuedComment?: (
    commentId: string,
    body: string,
    revision: string,
  ) => Promise<void>;
  onReorderQueuedComments?: (
    orderedCommentIds: string[],
    revision: string,
  ) => Promise<void>;
  onSteerQueuedComment?: (commentId: string, revision: string) => Promise<void>;
  onDiscardQueuedComment?: (
    commentId: string,
    revision: string,
  ) => Promise<void>;
  onDeleteComment?: (commentId: string) => Promise<void> | void;
  interruptingQueuedRunId?: string | null;
  stoppingRunId?: string | null;
  onImageClick?: (src: string) => void;
  onAcceptInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    selectedClientKeys?: string[],
    selectedOptionIds?: string[],
    rememberAction?: boolean,
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  onCancelInteraction?: (
    interaction: AskUserQuestionsInteraction,
  ) => Promise<void> | void;
  /** New task-view composer takeover action. The classic thread does not render it. */
  onSkipInteraction?: (
    interaction: IssueThreadInteraction,
  ) => Promise<void> | void;
  onSubmitInteractionVerdicts?: (
    interaction: RequestItemVerdictsInteraction,
    verdicts: {
      id: string;
      verdict: RequestItemVerdictValue;
      reason?: string;
    }[],
  ) => Promise<void> | void;
  composerRef?: Ref<IssueChatComposerHandle>;
  /** Optional node rendered inline directly above the sticky composer dock (e.g. the monitor strip). */
  composerAccessory?: ReactNode;
  issueWorkMode?: IssueWorkMode;
  /**
   * Hook for the parent to refetch comments when the user explicitly asks
   * to jump to the latest comment. Used to make sure the absolute newest
   * comment is in the loaded set before we scroll to it.
   */
  onRefreshLatestComments?: () => Promise<unknown> | void;
  externalReferences?: MarkdownExternalReferenceMap;
  /** Linkify `PAP-C7` case chips in comment bodies (experimental Cases flag). */
  linkCaseReferences?: boolean;
}
