import type { issuesApi } from "../../api/issues";
import { DispositionRecoveryProvider } from "../../components/DispositionRecoveryNotice";
import { ExecutionBlockerNotice } from "../../components/ExecutionBlockerNotice";
import { EmailTaskActivity } from "../../components/EmailTaskActivity";
import { queryKeys } from "../../lib/queryKeys";
import { createIssueDetailPath } from "../../lib/issueDetailBreadcrumb";
import type { IssueChatComposerHandle } from "../../components/IssueChatThread";
import { IssueSiblingNavigation } from "../../components/IssueSiblingNavigation";
import type { IssueSiblingNavigation as IssueSiblingNavigationModel } from "../../lib/issue-detail-subissues";
import { hasVisibleMonitorSurface, IssueMonitorComposerStrip } from "../../components/IssueMonitorBanner";
import { TabsContent } from "@/components/ui/tabs";
import {
  ONBOARDING_FIRST_TASK_ORIGIN_KIND,
  type IssueWorkMode,
  type Issue,
  type Agent,
} from "@greatstone/shared";
import { FEEDBACK_TERMS_URL } from "./helpers";
import { IssueDetailChatTab } from "./IssueDetailChatTab";
import { useIssueMutations } from "./useIssueMutations";
import { useThreadMutations } from "./useThreadMutations";
import { useRecoveryActionHandlers } from "./useRecoveryActionHandlers";
import { useThreadHandlers } from "./useThreadHandlers";
import { useIssueDetailDerivedState } from "./useIssueDetailDerivedState";
import { useIssueAndComments } from "./useIssueAndComments";
import type { IssueThreadInteraction, InstanceExperimentalSettingsWithManaged, IssueAttachment, IssueWorkProduct, FeedbackVote, AskUserQuestionsInteraction } from "@greatstone/shared";
import type { CurrentBoardAccess } from "@/api/access";
import type { JSX, RefObject, Dispatch, SetStateAction } from "react";
import type { MentionOption } from "@/components/MarkdownEditor";
import type { IssueExternalObjectsResult } from "@/hooks/useIssueExternalObjects";
import type { UseMutationResult, QueryClient } from "@tanstack/react-query";
import type { IssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import type { Location } from "@/lib/router";
import type { CompanyUserProfile } from "@/lib/company-members";
import type { IssueChatRunFinalizationAction } from "@/components/IssueChatThread";

export type IssueDetailChatPanelProps = {
  taskChatShellEnabled: boolean;
  isMobile: boolean;
  streamlinedTaskDetailEnabled: boolean;
  issue: Issue;
  invalidateIssueDetail: () => void;
  resolvedDetailTab: string;
  agentMap: Map<string, Agent>;
  interactions: IssueThreadInteraction[];
  boardAccess: CurrentBoardAccess | undefined;
  canResolveBoardRecoveryAction: boolean;
  treeControlStateError: Error | null;
  activePauseHold: NonNullable<Awaited<ReturnType<typeof issuesApi.getTreeControlState>>>["activePauseHold"];
  retryDispositionRecovery: ReturnType<typeof useIssueMutations>["retryDispositionRecovery"];
  handleOpenSkill: (skillId: string, name: string) => void;
  taskChatThreadHeader: JSX.Element | undefined;
  instanceExperimentalSettings: InstanceExperimentalSettingsWithManaged | undefined;
  updateIssue: ReturnType<typeof useIssueMutations>["updateIssue"];
  mentionOptions: MentionOption[];
  externalObjectsState: IssueExternalObjectsResult;
  uploadAttachment: UseMutationResult<IssueAttachment, Error, File, unknown>;
  conversation: { agent: Agent; issue: Issue | null; ensureIssue: () => Promise<Issue>; questionsOnly?: boolean } | undefined;
  liveIssueIds: Set<string>;
  handleResolveRecoveryAction: ReturnType<typeof useRecoveryActionHandlers>["handleResolveRecoveryAction"];
  handleReissueIsolatedRecoveryAction: ReturnType<typeof useRecoveryActionHandlers>["handleReissueIsolatedRecoveryAction"];
  reissueIsolatedRecoveryAction: ReturnType<typeof useRecoveryActionHandlers>["reissueIsolatedRecoveryAction"];
  handleReconcileForwardRecoveryAction: () => void;
  handleBreakGlassOverrideRecoveryAction: (reason: string) => void;
  handleQuarantineRestoreRecoveryAction: () => void;
  reconcileRecoveryAction: ReturnType<typeof useRecoveryActionHandlers>["reconcileRecoveryAction"];
  canManageBoardRuntime: boolean;
  legacyRecoverySourceIssue: { identifier: string | null; title: string; href: string; } | null;
  threadComments: ReturnType<typeof useIssueDetailDerivedState>["threadComments"];
  commentsLoading: boolean;
  linkedCommentPending: boolean;
  interactionsLoading: boolean;
  attachmentsLoading: boolean;
  workProductsLoading: boolean;
  commentsError: boolean;
  interactionsError: boolean;
  attachmentsError: boolean;
  workProductsError: boolean;
  refetchComments: ReturnType<typeof useIssueAndComments>["refetchComments"];
  refetchInteractions: ReturnType<typeof useIssueAndComments>["refetchInteractions"];
  refetchAttachments: ReturnType<typeof useIssueAndComments>["refetchAttachments"];
  refetchWorkProducts: ReturnType<typeof useIssueAndComments>["refetchWorkProducts"];
  locallyQueuedCommentRunIds: Map<string, string>;
  workProducts: IssueWorkProduct[] | undefined;
  attachments: IssueAttachment[] | undefined;
  hasOlderComments: boolean;
  commentsLoadingOlder: boolean;
  loadOlderComments: () => void;
  refetchLatestComments: () => Promise<void>;
  commentComposerRef: RefObject<IssueChatComposerHandle | null>;
  checkIssueMonitorNow: UseMutationResult<{ ok: true; }, Error, void, unknown>;
  siblingNavigation: IssueSiblingNavigationModel | null;
  resolvedIssueDetailState: IssueDetailLocationState | null;
  location: Location<any>;
  feedbackVotes: FeedbackVote[] | undefined;
  feedbackDataSharingPreference: "allowed" | "not_allowed" | "prompt";
  currentUserId: string | null;
  userLabelMap: Map<string, string>;
  userProfileMap: Map<string, CompanyUserProfile>;
  conversationAgent: Agent | undefined;
  commentReassignOptions: { id: string; label: string; searchText?: string; }[];
  actualAssigneeValue: string;
  suggestedAssigneeValue: string;
  childIssues: Issue[];
  executeTreeControl: ReturnType<typeof useIssueMutations>["executeTreeControl"];
  canManageTreeControl: boolean;
  setTreeControlMode: Dispatch<SetStateAction<"resume" | "cancel" | "restore">>;
  setTreeControlWakeAgentsOnResume: Dispatch<SetStateAction<boolean>>;
  isAgentOwnedNonTerminalIssue: boolean;
  canShowSubtreeControls: boolean;
  setTreeControlOpen: Dispatch<SetStateAction<boolean>>;
  activePauseHoldRoot: Issue | NonNullable<Issue["ancestors"]>[number] | null;
  composerHint: "This issue's isolated workspace was archived. Your next comment or resume reopens it and rebuilds the worktree." | null;
  queuedCommentReason: "hold" | "active_run";
  handleCommentVote: ReturnType<typeof useThreadHandlers>["handleCommentVote"];
  handleChatAdd: ReturnType<typeof useThreadHandlers>["handleChatAdd"];
  queryClient: QueryClient;
  issueId: string | undefined;
  handleCommentImageUpload: (file: File) => Promise<string>;
  handleCommentAttachImage: (file: File) => Promise<IssueAttachment>;
  handleInterruptQueuedRun: (runId: string | null) => Promise<void>;
  deleteComment: ReturnType<typeof useThreadMutations>["deleteComment"];
  stopResponse: UseMutationResult<void, Error, string, unknown>;
  treeControlScope: "leaf" | "subtree";
  runFinalizationActions: readonly IssueChatRunFinalizationAction[];
  pendingDraftWorkMode: RefObject<"standard" | "ask" | "planning" | "skill_test" | null>;
  setDraftWorkMode: Dispatch<SetStateAction<"standard" | "ask" | "planning" | "skill_test">>;
  handleCancelQueuedComment: (commentId: string) => void;
  interruptQueuedComment: ReturnType<typeof useThreadMutations>["interruptQueuedComment"];
  handleChatImageClick: (src: string) => void;
  handleAcceptInteraction: ReturnType<typeof useThreadHandlers>["handleAcceptInteraction"];
  handleRejectInteraction: ReturnType<typeof useThreadHandlers>["handleRejectInteraction"];
  handleSubmitInteractionAnswers: ReturnType<typeof useThreadHandlers>["handleSubmitInteractionAnswers"];
  handleCancelInteraction: (interaction: AskUserQuestionsInteraction) => Promise<void>;
  handleSkipInteraction: (interaction: IssueThreadInteraction) => Promise<void>;
  handleSubmitInteractionVerdicts: ReturnType<typeof useThreadHandlers>["handleSubmitInteractionVerdicts"];
  canResumeFromBacklog: boolean;
  handleResumeFromBacklog: () => Promise<void>;
  handleResumeAssignee: () => Promise<void>;
  resumeAssigneeAgent: UseMutationResult<void, Error, void, unknown>;
  handleTryAgainNoLiveExecutionPath: () => void;
  resolveRecoveryAction: ReturnType<typeof useIssueMutations>["resolveRecoveryAction"];
  casesChipsEnabled: boolean;
};

export function IssueDetailChatPanel({
  taskChatShellEnabled,
  isMobile,
  streamlinedTaskDetailEnabled,
  issue,
  invalidateIssueDetail,
  resolvedDetailTab,
  agentMap,
  interactions,
  boardAccess,
  canResolveBoardRecoveryAction,
  treeControlStateError,
  activePauseHold,
  retryDispositionRecovery,
  handleOpenSkill,
  taskChatThreadHeader,
  instanceExperimentalSettings,
  updateIssue,
  mentionOptions,
  externalObjectsState,
  uploadAttachment,
  conversation,
  liveIssueIds,
  handleResolveRecoveryAction,
  handleReissueIsolatedRecoveryAction,
  reissueIsolatedRecoveryAction,
  handleReconcileForwardRecoveryAction,
  handleBreakGlassOverrideRecoveryAction,
  handleQuarantineRestoreRecoveryAction,
  reconcileRecoveryAction,
  canManageBoardRuntime,
  legacyRecoverySourceIssue,
  threadComments,
  commentsLoading,
  linkedCommentPending,
  interactionsLoading,
  attachmentsLoading,
  workProductsLoading,
  commentsError,
  interactionsError,
  attachmentsError,
  workProductsError,
  refetchComments,
  refetchInteractions,
  refetchAttachments,
  refetchWorkProducts,
  locallyQueuedCommentRunIds,
  workProducts,
  attachments,
  hasOlderComments,
  commentsLoadingOlder,
  loadOlderComments,
  refetchLatestComments,
  commentComposerRef,
  checkIssueMonitorNow,
  siblingNavigation,
  resolvedIssueDetailState,
  location,
  feedbackVotes,
  feedbackDataSharingPreference,
  currentUserId,
  userLabelMap,
  userProfileMap,
  conversationAgent,
  commentReassignOptions,
  actualAssigneeValue,
  suggestedAssigneeValue,
  childIssues,
  executeTreeControl,
  canManageTreeControl,
  setTreeControlMode,
  setTreeControlWakeAgentsOnResume,
  isAgentOwnedNonTerminalIssue,
  canShowSubtreeControls,
  setTreeControlOpen,
  activePauseHoldRoot,
  composerHint,
  queuedCommentReason,
  handleCommentVote,
  handleChatAdd,
  queryClient,
  issueId,
  handleCommentImageUpload,
  handleCommentAttachImage,
  handleInterruptQueuedRun,
  deleteComment,
  stopResponse,
  treeControlScope,
  runFinalizationActions,
  pendingDraftWorkMode,
  setDraftWorkMode,
  handleCancelQueuedComment,
  interruptQueuedComment,
  handleChatImageClick,
  handleAcceptInteraction,
  handleRejectInteraction,
  handleSubmitInteractionAnswers,
  handleCancelInteraction,
  handleSkipInteraction,
  handleSubmitInteractionVerdicts,
  canResumeFromBacklog,
  handleResumeFromBacklog,
  handleResumeAssignee,
  resumeAssigneeAgent,
  handleTryAgainNoLiveExecutionPath,
  resolveRecoveryAction,
  casesChipsEnabled,
}: IssueDetailChatPanelProps) {
  // A board question chat (GRE-1186) stays in Ask mode and runs under the Strategy Board switch.
  const questionsOnly = Boolean(conversation?.questionsOnly || issue.originKind === "strategy_board_question");
  return (
    <TabsContent
      data-testid="issue-detail-content"
      value="chat"
      className={
        taskChatShellEnabled
          ? isMobile
            ? streamlinedTaskDetailEnabled
              ? undefined
              : "-mx-4"
            : streamlinedTaskDetailEnabled
              ? "flex min-h-0 flex-col"
              : "-mx-4 -mt-4 md:-mx-6 md:-mt-6 flex min-h-0 flex-col"
          : undefined
      }
    >
      {issue.executionBlocker && (
        <ExecutionBlockerNotice companyId={issue.companyId} issueId={issue.id} blocker={issue.executionBlocker} onRetried={invalidateIssueDetail} />
      )}
      {resolvedDetailTab === "chat" ? (
        <DispositionRecoveryProvider value={{
          issue,
          agentMap,
          hasPendingInteraction: interactions.some((interaction) => interaction.status === "pending"),
          unavailableReason: boardAccess && !canResolveBoardRecoveryAction
            ? "You don’t have permission to retry this recovery action."
            : treeControlStateError
            ? "Couldn’t check whether this task is paused. Refresh to try again."
            : activePauseHold
              ? "The task is paused. Resume it before retrying."
              : issue.project?.pausedAt
                ? "The project is paused. Resume it before retrying."
                : null,
          onRetry: (actionId) => retryDispositionRecovery.mutateAsync(actionId).then(() => undefined),
        }}>
        <IssueDetailChatTab
          onOpenSkill={handleOpenSkill}
          threadHeader={<>{taskChatThreadHeader}{instanceExperimentalSettings?.enableChatConnectors && <EmailTaskActivity key={issue.id} companyId={issue.companyId} issueId={issue.id} />}</>}
          issueBrief={
            // Suppress the seeded-description bubble for the onboarding first
            // task: its description is agent instructions, not something the
            // user typed. The user lands on a seeded agent greeting instead.
            taskChatShellEnabled && !issue.conversationAgentId &&
            issue.originKind !== ONBOARDING_FIRST_TASK_ORIGIN_KIND
              ? {
                  description: issue.description ?? "",
                  author: issue.createdByAgentId ? "agent" : "human",
                  authorName: issue.createdByAgentId
                    ? (agentMap.get(issue.createdByAgentId)?.name ??
                      "Agent")
                    : undefined,
                  agent: issue.createdByAgentId ? agentMap.get(issue.createdByAgentId) ?? { id: issue.createdByAgentId } : undefined,
                agentIcon: issue.createdByAgentId
                    ? agentMap.get(issue.createdByAgentId)?.icon
                    : undefined,
                  createdAt: issue.createdAt,
                  onSave: (description) =>
                    updateIssue.mutateAsync({ description }),
                  mentions: mentionOptions,
                  externalReferences: externalObjectsState.isEnabled
                    ? externalObjectsState.markdownReferences
                    : undefined,
                  imageUploadHandler: async (file) => {
                    const attachment =
                      await uploadAttachment.mutateAsync(file);
                    return attachment.contentPath;
                  },
                  onDropFile: async (file) => {
                    await uploadAttachment.mutateAsync(file);
                  },
                }
              : undefined
          }
          issueId={conversation && !conversation.issue ? "" : issue.id}
          companyId={issue.companyId}
          projectId={issue.projectId ?? null}
          issueStatus={issue.status}
          issueAssigneeAgentId={issue.assigneeAgentId}
          issueWorkMode={issue.workMode ?? "standard"}
          executionRunId={issue.executionRunId ?? null}
          blockedBy={issue.blockedBy ?? []}
          liveIssueIds={liveIssueIds}
          blockerAttention={issue.blockerAttention ?? null}
          successfulRunHandoff={issue.successfulRunHandoff ?? null}
          scheduledRetry={issue.scheduledRetry ?? null}
          recoveryAction={issue.activeRecoveryAction ?? null}
          onResolveRecoveryAction={handleResolveRecoveryAction}
          onReissueIsolatedRecoveryAction={
            handleReissueIsolatedRecoveryAction
          }
          reissueIsolatedRecoveryActionPending={
            reissueIsolatedRecoveryAction.isPending
          }
          onReconcileForwardRecoveryAction={
            handleReconcileForwardRecoveryAction
          }
          onBreakGlassOverrideRecoveryAction={
            handleBreakGlassOverrideRecoveryAction
          }
          onQuarantineRestoreRecoveryAction={
            handleQuarantineRestoreRecoveryAction
          }
          quarantineRestoreRecoveryActionPending={
            reconcileRecoveryAction.isPending
          }
          canBreakGlassRecoveryAction={canManageBoardRuntime}
          reconcileRecoveryActionPending={
            reconcileRecoveryAction.isPending
          }
          canFalsePositiveRecoveryAction={canResolveBoardRecoveryAction}
          legacyRecoverySourceIssue={legacyRecoverySourceIssue}
          comments={threadComments}
          commentsInitialLoading={commentsLoading}
          initialHistoryPending={
            linkedCommentPending ||
            interactionsLoading ||
            attachmentsLoading ||
            workProductsLoading
          }
          initialHistoryError={
            commentsError ||
            interactionsError ||
            attachmentsError ||
            workProductsError
          }
          onRetryInitialHistory={() => {
            void refetchComments();
            void refetchInteractions();
            void refetchAttachments();
            void refetchWorkProducts();
          }}
          locallyQueuedCommentRunIds={locallyQueuedCommentRunIds}
          interactions={interactions}
          documents={issue.documentSummaries ?? []}
          workProducts={workProducts ?? []}
          attachments={attachments ?? []}
          hasOlderComments={hasOlderComments}
          commentsLoadingOlder={commentsLoadingOlder}
          onLoadOlderComments={loadOlderComments}
          onRefreshLatestComments={refetchLatestComments}
          composerRef={commentComposerRef}
          composerAccessory={
            hasVisibleMonitorSurface(issue) ? (
              <IssueMonitorComposerStrip
                issue={issue}
                onCheckNow={() => checkIssueMonitorNow.mutate()}
                checkingNow={checkIssueMonitorNow.isPending}
              />
            ) : null
          }
          footer={
            !taskChatShellEnabled && siblingNavigation ? (
              <IssueSiblingNavigation
                navigation={siblingNavigation}
                linkState={resolvedIssueDetailState ?? location.state}
              />
            ) : null
          }
          feedbackVotes={feedbackVotes}
          feedbackDataSharingPreference={feedbackDataSharingPreference}
          feedbackTermsUrl={FEEDBACK_TERMS_URL}
          agentMap={agentMap}
          currentUserId={currentUserId}
          userLabelMap={userLabelMap}
          userProfileMap={userProfileMap}
          draftKey={conversationAgent ? `paperclip:agent-chat-draft:${issue.companyId}:${currentUserId}:${conversationAgent.id}` : `paperclip:issue-comment-draft:${issue.id}`}
          reassignOptions={commentReassignOptions}
          currentAssigneeValue={actualAssigneeValue}
          suggestedAssigneeValue={suggestedAssigneeValue}
          mentions={mentionOptions}
          conversationMode={!!issue.conversationAgentId}
          composerPause={activePauseHold ? {
            scope: activePauseHold.isRoot && childIssues.length === 0 ? "leaf" : "subtree",
            pending: executeTreeControl.isPending && executeTreeControl.variables?.mode === "resume",
            onResume: activePauseHold.isRoot && canManageTreeControl ? () => {
              executeTreeControl.reset();
              setTreeControlMode("resume");
              setTreeControlWakeAgentsOnResume(isAgentOwnedNonTerminalIssue || canShowSubtreeControls);
              setTreeControlOpen(true);
            } : undefined,
            resumeHref: !activePauseHold.isRoot ? createIssueDetailPath(activePauseHoldRoot?.identifier ?? activePauseHold.rootIssueId) : undefined,
          } : null}
          composerDisabledReason={issue.conversationAgentId && !questionsOnly && !instanceExperimentalSettings?.enableAgentChat ? "Agent Chat is disabled in Experimental settings." : treeControlStateError ? "Couldn’t check whether this task is paused. Refresh to try again." : null}
          composerHint={composerHint}
          queuedCommentReason={queuedCommentReason}
          onVote={handleCommentVote}
          onAdd={handleChatAdd}
          onReviewConversation={async () => {
            await Promise.all([
              refetchComments({ throwOnError: true }),
              queryClient.refetchQueries(
                { queryKey: queryKeys.issues.attachments(issueId!) },
                { throwOnError: true },
              ),
            ]);
          }}
          onImageUpload={handleCommentImageUpload}
          onAttachImage={handleCommentAttachImage}
          onInterruptQueued={handleInterruptQueuedRun}
          onDeleteComment={(commentId) =>
            deleteComment
              .mutateAsync({ commentId })
              .then(() => undefined)
          }
          onStopResponse={canManageTreeControl
            ? (runId) => stopResponse.mutateAsync(runId)
            : undefined}
          stopResponsePending={stopResponse.isPending}
          pauseWorkPending={
            executeTreeControl.isPending &&
            executeTreeControl.variables?.mode === "pause"
          }
          pauseWorkScope={treeControlScope}
          onPauseWorkRun={
            canManageTreeControl
              ? (runId, feedback) =>
                  executeTreeControl
                    .mutateAsync({
                      mode: "pause",
                      feedback,
                      runId,
                      scope: treeControlScope,
                    })
                    .then(() => undefined)
              : undefined
          }
          runFinalizationActions={runFinalizationActions}
          questionsOnly={questionsOnly}
          onWorkModeChange={questionsOnly ? undefined : (nextMode) => {
            const currentMode: IssueWorkMode =
              issue.workMode ?? "standard";
            if (currentMode === nextMode) return;
            if (conversation && (!conversation.issue || pendingDraftWorkMode.current !== null)) { pendingDraftWorkMode.current = nextMode; setDraftWorkMode(nextMode); return; }
            return updateIssue
              .mutateAsync({ workMode: nextMode })
              .then(() => undefined);
          }}
          onCancelQueued={handleCancelQueuedComment}
          interruptingQueuedRunId={
            interruptQueuedComment.isPending
              ? (interruptQueuedComment.variables ?? null)
              : null
          }
          pausingWorkRunId={
            executeTreeControl.isPending &&
            executeTreeControl.variables?.mode === "pause"
              ? (executeTreeControl.variables?.runId ?? null)
              : null
          }
          onImageClick={handleChatImageClick}
          onAcceptInteraction={handleAcceptInteraction}
          onRejectInteraction={handleRejectInteraction}
          onSubmitInteractionAnswers={handleSubmitInteractionAnswers}
          onCancelInteraction={handleCancelInteraction}
          onSkipInteraction={handleSkipInteraction}
          onSubmitInteractionVerdicts={handleSubmitInteractionVerdicts}
          assigneeUserId={issue.assigneeUserId ?? null}
          onResumeFromBacklog={
            canResumeFromBacklog ? handleResumeFromBacklog : undefined
          }
          resumeFromBacklogPending={
            updateIssue.isPending &&
            updateIssue.variables?.status === "todo"
          }
          onResumeAssignee={
            issue.assigneeAgentId ? handleResumeAssignee : undefined
          }
          resumeAssigneePending={resumeAssigneeAgent.isPending}
          onTryAgainNoLiveExecutionPath={
            issue.status === "blocked" && issue.activeRecoveryAction
              ? handleTryAgainNoLiveExecutionPath
              : undefined
          }
          tryAgainNoLiveExecutionPathPending={
            resolveRecoveryAction.isPending &&
            resolveRecoveryAction.variables?.sourceIssueStatus ===
              "todo"
          }
          externalReferences={
            externalObjectsState.isEnabled
              ? externalObjectsState.markdownReferences
              : undefined
          }
          linkCaseReferences={casesChipsEnabled}
        />
        </DispositionRecoveryProvider>
      ) : null}
    </TabsContent>
  );
}
