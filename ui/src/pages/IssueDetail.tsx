
import { agentChatDraft } from "@/lib/agent-chat-draft";
import {
  PaperclipIcon,
  ChevronRight,
  EyeOff,
  MessageSquare,
  Activity as ActivityIcon,
  ListTree,
} from "lucide-react";
import {
  useState,
  useMemo,
  useRef,
  useCallback,
  useEffect,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { useParams, useNavigate, useNavigationType, useLocation, Link } from "@/lib/router";
import {
  useQueryClient,
} from "@tanstack/react-query";
import { canBoardManageRuntime, readRecoveryReconcileWorkspaceId } from "../lib/recovery-reconcile";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useToastActions } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import {
  readIssueDetailLocationState,
  readIssueDetailHeaderSeed,
  rememberIssueDetailLocationState,
  createIssueDetailPath,
  withIssueDetailHeaderSeed,
} from "../lib/issueDetailBreadcrumb";
import {
  type OptimisticIssueComment,
} from "../lib/optimistic-issue-comments";
import { cn } from "../lib/utils";
import type { IssueChatComposerHandle } from "../components/IssueChatThread";
import { IssueRelatedWorkPanel } from "../components/IssueRelatedWorkPanel";
import {
  isWaitingOnMonitor,
} from "../components/IssueMonitorBanner";
import { ExternallyConnectedTaskBanner } from "../components/chat/ExternallyConnectedTaskBanner";
import { type IssuePropertiesDocumentDeepLink } from "../components/IssueProperties";
import { type TaskSidePanelProps } from "../components/task-side-panel";
import { TaskTreeControlDialog } from "../components/TaskTreeControls";
import { IssueGalleryContext } from "../context/IssueGalleryContext";
import { IssueWorkspaceCard } from "../components/IssueWorkspaceCard";
import { ImageGalleryModal } from "../components/ImageGalleryModal";
import { FileViewerProvider } from "../context/FileViewerContext";
import { ArtifactFileChip } from "../components/ArtifactFileChip";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { ErrorState } from "../components/ErrorState";
import { PluginSlotOutlet, PluginSlotMount } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  type Agent,
  type Issue,
  type IssueWorkMode,
  type IssueTreeControlMode,
} from "@greatstone/shared";
import {
  useTaskDetailInterfaceMode,
  IssueDetailLoadingState,
} from "./issue-detail/IssueDetailLoading";
import {
  isMarkdownFile,
  extractWorkspaceFileRefFromWorkProduct,
  treeControlPreviewErrorCopy,
} from "./issue-detail/helpers";
import { IssueDetailActivityTab } from "./issue-detail/IssueDetailActivityTab";
import { IssueFileViewer } from "./issue-detail/IssueFileViewer";
import { useIssueMutations } from "./issue-detail/useIssueMutations";
import { useThreadMutations } from "./issue-detail/useThreadMutations";
import { useRecoveryActionHandlers } from "./issue-detail/useRecoveryActionHandlers";
import { useThreadHandlers } from "./issue-detail/useThreadHandlers";
import { useIssueDeepLinks } from "./issue-detail/useIssueDeepLinks";
import { useIssueDetailPageEffects } from "./issue-detail/useIssueDetailPageEffects";
import { IssueDetailHeader } from "./issue-detail/IssueDetailHeader";
import { IssueDetailMobilePropertiesSheet } from "./issue-detail/IssueDetailMobilePropertiesSheet";
import { useIssueDetailDerivedState } from "./issue-detail/useIssueDetailDerivedState";
import { useIssueDetailQueries } from "./issue-detail/useIssueDetailQueries";
import { useIssueAndComments } from "./issue-detail/useIssueAndComments";
import { IssueDetailChatPanel } from "./issue-detail/IssueDetailChatPanel";
import { IssueDetailClassicSections } from "./issue-detail/IssueDetailClassicSections";
export { canBoardResolveRecoveryAction, shouldScrollIssueDetailToTopOnNavigation } from "./issue-detail/helpers";
export type { AttributionActor } from "./issue-detail/IssueAttribution";

// `canBoardManageRuntime` and `readRecoveryReconcileWorkspaceId` moved to `@/lib/recovery-reconcile`
// so the run-page recovery surface can reuse them without importing this page module. Re-exported
// here (from the top-of-file import) to keep existing import sites — and their tests — stable, while
// the imported bindings stay usable within this module.
export { canBoardManageRuntime, readRecoveryReconcileWorkspaceId };

export function IssueDetail({ tasksTab }: { tasksTab?: TaskSidePanelProps["tasksTab"] }) { return <TaskDetailSurface tasksTab={tasksTab} />; }

/** One controller and surface for both task URLs and agent conversations. */
export function TaskDetailSurface({ conversation, tasksTab }: { tasksTab?: TaskSidePanelProps["tasksTab"]; conversation?: {
  agent: Agent; issue: Issue | null; ensureIssue: () => Promise<Issue>;
} }) {
  const { issueId: routeIssueId, companyPrefix } = useParams<{ issueId: string; companyPrefix: string }>();
  const issueId = conversation ? conversation.issue?.id : routeIssueId;
  const [draftWorkMode, setDraftWorkMode] = useState<IssueWorkMode>("standard");
  const draftIssue = useMemo(() => conversation ? agentChatDraft(conversation.agent, draftWorkMode) : undefined, [conversation?.agent, draftWorkMode]);
  const pendingDraftWorkMode = useRef<IssueWorkMode | null>(null);
  const { companies, selectedCompanyId } = useCompany();
  // Classic Task Interface remains the sole task-chat-vs-pre-chat switch from
  // master. Streamlined UI only layers the new task-detail presentation onto
  // master's default task-chat shell.
  const {
    classicTaskInterfaceEnabled,
    taskChatShellEnabled,
    streamlinedTaskDetailEnabled,
    streamlinedUiEnabled,
    loaded: taskInterfaceSettingsLoaded,
  } = useTaskDetailInterfaceMode(!!conversation);
  // Chat-style: the page wrapper spans the full center pane so the thread's
  // scroll viewport (and its scrollbar) reaches the properties-pane border;
  // every non-thread section re-centers itself at the 60rem shell cap instead.
  const shellSectionClass = taskChatShellEnabled
    ? "mx-auto w-full max-w-(--tc-shell-max-w)"
    : undefined;
  const { openNewIssue } = useDialogActions();
  const {
    openPanel,
    closePanel,
    panelVisible,
    setPanelVisible,
    requestPanelMaximize,
    clearPanelMaximizeRequest,
  } = usePanel();
  const {
    setBreadcrumbs,
    setBreadcrumbToolbar,
    setBreadcrumbPanelControl,
    setMobileToolbar,
  } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const location = useLocation();
  const { pushToast } = useToastActions();
  const { isMobile } = useSidebar();
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [artifactsOpenRequest, setArtifactsOpenRequest] = useState<{
    issueId: string;
    requestId: number;
    handled?: boolean;
  } | null>(null);
  const [openSkill, setOpenSkill] = useState<{ id: string; name: string } | null>(null);
  const handleSkillOpened = useCallback((skillId: string) => {
    setOpenSkill((current) => current?.id === skillId ? null : current);
  }, []);
  const [documentDeepLink, setDocumentDeepLink] = useState<
    (IssuePropertiesDocumentDeepLink & { issueId: string }) | null
  >(null);
  const [fileViewerPromptOpen, setFileViewerPromptOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("chat");
  // Redesign: the center tab strip is hidden, so chat is the only surface —
  // deep links that would switch tabs (e.g. #document- hashes) stay on chat.
  const resolvedDetailTab = taskChatShellEnabled ? "chat" : detailTab;
  const [handoffFocusSignal, setHandoffFocusSignal] = useState(0);
  const [pendingApprovalAction, setPendingApprovalAction] = useState<{
    approvalId: string;
    action: "approve" | "reject";
  } | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [treeControlOpen, setTreeControlOpen] = useState(false);
  const [treeControlWakeWarning, setTreeControlWakeWarning] = useState<
    string | null
  >(null);
  const [treeControlMode, setTreeControlMode] =
    useState<Exclude<IssueTreeControlMode, "pause">>("resume");
  const [treeControlWakeAgentsOnResume, setTreeControlWakeAgentsOnResume] =
    useState(false);
  const [optimisticComments, setOptimisticComments] = useState<
    OptimisticIssueComment[]
  >([]);
  const [locallyQueuedCommentRunIds, setLocallyQueuedCommentRunIds] = useState<
    Map<string, string>
  >(() => new Map());
  const [pendingCommentComposerFocusKey, setPendingCommentComposerFocusKey] =
    useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastMarkedReadIssueIdRef = useRef<string | null>(null);
  const lastScrollIssueIdRef = useRef<string | undefined>(undefined);
  const commentComposerRef = useRef<IssueChatComposerHandle | null>(null);
  const cancelledQueuedOptimisticCommentIdsRef = useRef(new Set<string>());
  const commentRenderKeys = useRef(new Map<string, string>());
  const resolvedIssueDetailState = useMemo(
    () =>
      readIssueDetailLocationState(issueId, location.state, location.search),
    [issueId, location.state, location.search],
  );
  const relationIssueLinkState = useMemo(() => {
    const sourceState = resolvedIssueDetailState ?? location.state;
    if (!streamlinedTaskDetailEnabled) return sourceState;
    if (typeof sourceState !== "object" || sourceState === null)
      return sourceState;
    return {
      ...sourceState,
      // The inbox `y` shortcut is intentionally armed only for the selected
      // inbox row. Preserve the origin/breadcrumb when opening a related task,
      // but do not let that one-row archive affordance leak to the relation.
      issueDetailInboxQuickArchiveArmed: false,
    };
  }, [location.state, resolvedIssueDetailState, streamlinedTaskDetailEnabled]);
  const preferInboxHistoryBack = useMemo(
    () =>
      readIssueDetailLocationState(null, location.state)?.issueDetailSource ===
      "inbox",
    [location.state],
  );
  const issueHeaderSeed = useMemo(
    () =>
      readIssueDetailHeaderSeed(location.state) ??
      readIssueDetailHeaderSeed(resolvedIssueDetailState),
    [location.state, resolvedIssueDetailState],
  );

  const {
    isLoading,
    error,
    refetch,
    issue,
    resolveWritableIssueId,
    loadedIssue,
    loadedIssueCompany,
    taskRouteReady,
    resolvedCompanyId,
    externalObjectsState,
    closedIsolatedWorkspaceReopenPending,
    commentsLoading,
    commentsError,
    commentsLoadingOlder,
    hasOlderComments,
    fetchOlderComments,
    refetchComments,
    comments,
    linkedCommentPending,
    shouldPrefetchOlderComments,
    interactions,
    interactionsLoading,
    interactionsError,
    refetchInteractions,
    attachments,
    attachmentsLoading,
    attachmentsError,
    refetchAttachments,
    workProducts,
    workProductsLoading,
    workProductsError,
    refetchWorkProducts,
  } = useIssueAndComments({
    queryClient,
    issueId,
    issueHeaderSeed,
    conversation,
    draftIssue,
    pendingDraftWorkMode,
    companies,
    companyPrefix,
    location,
    selectedCompanyId,
    detailTab,
  });

  // Run state is keyed by the task's UUID, as the chat tab and run ledger key
  // it. Keying it by the route identifier as well fetched and polled the same
  // task twice.
  const {
    runStateIssueId,
    resolvedHasActiveRun,
    hasLiveRuns,
    sourceBreadcrumb,
    childIssuesLoading,
    childIssuesError,
    refetchChildIssues,
    rawChildIssues,
    createdTasksQuery,
    siblingIssuesLoading,
    siblingIssuesError,
    rawSiblingIssues,
    companyLiveRuns,
    agents,
    companyMembers,
    mentionIssues,
    session,
    sessionResolved,
    projects,
    currentUserId,
    boardAccess,
    canManageTreeControl,
    canResolveBoardRecoveryAction,
    canManageBoardRuntime,
    feedbackVotes,
    instanceExperimentalSettings,
    keyboardShortcutsEnabled,
    casesChipsEnabled,
    feedbackDataSharingPreference,
    showPlanDecompositionsSection,
    fileViewerEnabled,
    orderedProjects,
    issuePluginTabItems,
    activePluginTab,
    treeControlPreview,
    treeControlPreviewLoading,
    treeControlPreviewError,
    refetchTreeControlPreview,
    treeControlState,
    treeControlStateError,
    activeRootPauseHolds,
    activeCancelHolds,
  } = useIssueDetailQueries({
    issueId,
    issue,
    locallyQueuedCommentRunIds,
    setLocallyQueuedCommentRunIds,
    location,
    resolvedCompanyId,
    streamlinedTaskDetailEnabled,
    tasksTab,
    selectedCompanyId,
    streamlinedUiEnabled,
    detailTab,
    treeControlMode,
    treeControlOpen,
  });

  const {
    agentMap,
    userProfileMap,
    userLabelMap,
    mentionOptions,
    resolvedProject,
    childIssues,
    resolvedTasksTab,
    liveIssueIds,
    issuePanelKey,
    panelIssue,
    panelChildIssues,
    setPanelBeforePlanOverrideIssueId,
    suppressPanelUntilPlan,
    openTaskSidePanel,
    handleOpenSkill,
    handleArtifactsOpened,
    toggleTaskSidePanel,
    showRichSubIssuesSection,
    siblingNavigation,
    openNewSubIssue,
    commentReassignOptions,
    actualAssigneeValue,
    suggestedAssigneeValue,
    threadComments,
    breadcrumbTitle,
    breadcrumbIdentifier,
    breadcrumbStatusKey,
    breadcrumbStatusLeading,
  } = useIssueDetailDerivedState({
    agents,
    companyMembers,
    orderedProjects,
    mentionIssues,
    issue,
    rawChildIssues,
    tasksTab,
    streamlinedTaskDetailEnabled,
    createdTasksQuery,
    childIssuesError,
    resolvedIssueDetailState,
    location,
    projects,
    childIssuesLoading,
    refetchChildIssues,
    companyLiveRuns,
    taskChatShellEnabled,
    setPanelVisible,
    setOpenSkill,
    isMobile,
    setMobilePropsOpen,
    setDocumentDeepLink,
    setArtifactsOpenRequest,
    attachments,
    workProducts,
    panelVisible,
    siblingIssuesLoading,
    siblingIssuesError,
    rawSiblingIssues,
    openNewIssue,
    currentUserId,
    comments,
    optimisticComments,
    commentRenderKeys,
    issueId,
    issueHeaderSeed,
  });
  const {
    issueCacheRefs,
    invalidateIssueDetail,
    invalidateIssueThreadLazily,
    invalidateIssueRunState,
    invalidateIssueDocumentAnnotationState,
    removeCommentFromCache,
    clearCommentHashIfCurrent,
    upsertCommentInCache,
    restoreQueuedCommentDraft,
    invalidateIssueCollections,
    undoInboxArchive,
    upsertInteractionInCache,
    markIssueRead,
    updateIssue,
    resolveRecoveryAction,
    retryDispositionRecovery,
    executeTreeControl,
    stopResponse,
    stopAndFinalizeRun,
    handleIssuePropertiesUpdate,
    handleChildIssueUpdate,
    subTasksTree,
    checkIssueMonitorNow,
  } = useIssueMutations({
    issueId,
    issue,
    queryClient,
    location,
    commentComposerRef,
    selectedCompanyId,
    pushToast,
    streamlinedUiEnabled,
    sessionResolved,
    currentUserId,
    runStateIssueId,
    setTreeControlWakeWarning,
    treeControlState,
    setTreeControlOpen,
    setTreeControlWakeAgentsOnResume,
    resolvedCompanyId,
    taskChatShellEnabled,
    streamlinedTaskDetailEnabled,
    showRichSubIssuesSection,
    childIssues,
    childIssuesLoading,
    agents,
    projects,
    liveIssueIds,
    resolvedIssueDetailState,
  });

  const {
    approvalDecision,
    addComment,
    reauthDialog,
    acceptInteraction,
    rejectInteraction,
    answerInteraction,
    submitInteractionVerdicts,
    cancelInteraction,
    skipInteraction,
    addCommentAndReassign,
    interruptQueuedComment,
    deleteComment,
    handleCancelQueuedComment,
    feedbackVoteMutation,
    uploadAttachment,
    importMarkdownDocument,
    deleteAttachment,
    archiveFromInbox,
  } = useThreadMutations({
    setPendingApprovalAction,
    invalidateIssueDetail,
    queryClient,
    issueId,
    invalidateIssueCollections,
    resolvedCompanyId,
    pushToast,
    issue,
    currentUserId,
    resolveWritableIssueId,
    runStateIssueId,
    setOptimisticComments,
    cancelledQueuedOptimisticCommentIdsRef,
    invalidateIssueThreadLazily,
    setLocallyQueuedCommentRunIds,
    commentRenderKeys,
    streamlinedUiEnabled,
    sessionResolved,
    issueCacheRefs,
    invalidateIssueRunState,
    upsertInteractionInCache,
    removeCommentFromCache,
    restoreQueuedCommentDraft,
    upsertCommentInCache,
    clearCommentHashIfCurrent,
    invalidateIssueDocumentAnnotationState,
    conversation,
    loadedIssue,
    setAttachmentError,
    selectedCompanyId,
    navigate,
    sourceBreadcrumb,
    undoInboxArchive,
  });

  const {
    conversationAgent,
    isFromInbox,
    mediaGalleryItems,
    openIssueGallery,
    handleChatImageClick,
  } = useIssueDetailPageEffects({
    conversation,
    agents,
    issue,
    setBreadcrumbs,
    sourceBreadcrumb,
    breadcrumbTitle,
    breadcrumbIdentifier,
    breadcrumbStatusLeading,
    breadcrumbStatusKey,
    hasLiveRuns,
    streamlinedTaskDetailEnabled,
    taskChatShellEnabled,
    setBreadcrumbPanelControl,
    panelVisible,
    suppressPanelUntilPlan,
    toggleTaskSidePanel,
    isMobile,
    setBreadcrumbToolbar,
    openTaskSidePanel,
    resolvedIssueDetailState,
    lastScrollIssueIdRef,
    issueId,
    navigationType,
    loadedIssue,
    location,
    loadedIssueCompany,
    companyPrefix,
    navigate,
    lastMarkedReadIssueIdRef,
    markIssueRead,
    attachments,
    workProducts,
    setGalleryIndex,
    setGalleryOpen,
    panelIssue,
    closePanel,
    panelChildIssues,
    relationIssueLinkState,
    openNewSubIssue,
    handleIssuePropertiesUpdate,
    resolvedHasActiveRun,
    externalObjectsState,
    checkIssueMonitorNow,
    documentDeepLink,
    openSkill,
    handleSkillOpened,
    openPanel,
    currentUserId,
    fileViewerEnabled,
    resolvedTasksTab,
    artifactsOpenRequest,
    handleArtifactsOpened,
    issuePanelKey,
    keyboardShortcutsEnabled,
    archiveFromInbox,
    setDetailTab,
    setPendingCommentComposerFocusKey,
    setFileViewerPromptOpen,
  });

  // One maximize request per issue + `viewer=full` hash: routing re-runs
  // whenever a callback dependency changes identity, and re-requesting then
  // would re-maximize a pane the user deliberately restored. The key carries
  // the issue param so navigating to another issue with an identical hash
  // still maximizes the destination pane.
  useIssueDeepLinks({
    setDocumentDeepLink,
    setDetailTab,
    setHandoffFocusSignal,
    taskInterfaceSettingsLoaded,
    taskChatShellEnabled,
    isMobile,
    setMobilePropsOpen,
    suppressPanelUntilPlan,
    issue,
    setPanelBeforePlanOverrideIssueId,
    setPanelVisible,
    issueId,
    requestPanelMaximize,
    location,
    clearPanelMaximizeRequest,
    workProducts,
    attachments,
  });

  useEffect(() => {
    if (pendingCommentComposerFocusKey === 0) return;
    if (detailTab !== "chat") return;
    commentComposerRef.current?.focus();
  }, [detailTab, pendingCommentComposerFocusKey]);

  useEffect(() => {
    if (!fileViewerEnabled) return;
    const handleOpenFileViewer = () => {
      setFileViewerPromptOpen(true);
    };
    window.addEventListener(
      "paperclip:open-file-viewer",
      handleOpenFileViewer as EventListener,
    );
    return () => {
      window.removeEventListener(
        "paperclip:open-file-viewer",
        handleOpenFileViewer as EventListener,
      );
    };
  }, [fileViewerEnabled]);

  const {
    attachmentList,
    copyIssueToClipboard,
    archivePending,
    canArchiveFromInbox,
    attachmentsInitialLoading,
    loadOlderComments,
    refetchLatestComments,
    handleCommentVote,
    handleChatAdd,
    handleCommentImageUpload,
    handleCommentAttachImage,
    handleInterruptQueuedRun,
    runFinalizationActions,
    handleAcceptInteraction,
    handleRejectInteraction,
    handleSubmitInteractionAnswers,
    handleCancelInteraction,
    handleSkipInteraction,
    handleSubmitInteractionVerdicts,
    canResumeFromBacklog,
    handleResumeFromBacklog,
  } = useThreadHandlers({
    workProducts,
    attachments,
    issue,
    setCopied,
    pushToast,
    archiveFromInbox,
    setMobilePropsOpen,
    updateIssue,
    navigate,
    sourceBreadcrumb,
    isMobile,
    isFromInbox,
    setMobileToolbar,
    streamlinedUiEnabled,
    preferInboxHistoryBack,
    attachmentsLoading,
    fetchOlderComments,
    refetchComments,
    issueId,
    queryClient,
    shouldPrefetchOlderComments,
    linkedCommentPending,
    hasOlderComments,
    commentsLoadingOlder,
    feedbackVoteMutation,
    feedbackDataSharingPreference,
    addCommentAndReassign,
    addComment,
    uploadAttachment,
    interruptQueuedComment,
    stopAndFinalizeRun,
    acceptInteraction,
    rejectInteraction,
    answerInteraction,
    cancelInteraction,
    skipInteraction,
    submitInteractionVerdicts,
  });
  // Resume a paused assignee agent straight from the thread notice: a paused
  // assignee silently drops every assignment wake, so the fix belongs next to
  // the explanation.
  const {
    resumeAssigneeAgent,
    handleResumeAssignee,
    handleResolveRecoveryAction,
    handleTryAgainNoLiveExecutionPath,
    reissueIsolatedRecoveryAction,
    handleReissueIsolatedRecoveryAction,
    reconcileRecoveryAction,
    handleReconcileForwardRecoveryAction,
    handleBreakGlassOverrideRecoveryAction,
    handleQuarantineRestoreRecoveryAction,
  } = useRecoveryActionHandlers({
    issue,
    queryClient,
    resolveRecoveryAction,
    invalidateIssueCollections,
    pushToast,
    navigate,
    invalidateIssueDetail,
  });

  const treePreviewAffectedIssues = useMemo(
    () =>
      (treeControlPreview?.issues ?? []).filter(
        (candidate) => !candidate.skipped,
      ),
    [treeControlPreview],
  );
  const activePauseHold = treeControlState?.activePauseHold ?? null;
  const activeRootPauseHoldsForDisplay = useMemo(
    () => (activePauseHold?.isRoot === true ? activeRootPauseHolds : []),
    [activePauseHold?.isRoot, activeRootPauseHolds],
  );
  const heldIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const hold of activeRootPauseHoldsForDisplay) {
      for (const member of hold.members ?? []) {
        if (member.skipped) continue;
        ids.add(member.issueId);
      }
    }
    return ids;
  }, [activeRootPauseHoldsForDisplay]);
  const mutedChildIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const child of childIssues) {
      if (heldIssueIds.has(child.id)) ids.add(child.id);
    }
    return ids;
  }, [childIssues, heldIssueIds]);
  const childPauseBadgeById = useMemo(() => {
    const badges = new Map<string, string>();
    for (const child of childIssues) {
      if (!heldIssueIds.has(child.id)) continue;
      badges.set(child.id, "Paused");
    }
    return badges;
  }, [childIssues, heldIssueIds]);
  const activePauseHoldRoot = useMemo(() => {
    if (!activePauseHold) return null;
    if (activePauseHold.rootIssueId === issue?.id) return issue ?? null;
    return (
      issue?.ancestors?.find(
        (ancestor) => ancestor.id === activePauseHold.rootIssueId,
      ) ?? null
    );
  }, [activePauseHold, issue]);

  if (isLoading)
    return <IssueDetailLoadingState headerSeed={issueHeaderSeed} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!issue) return null;
  // Do not expose a file chooser on the outgoing UUID/company/interface
  // branch: its input can be detached before the chosen file is returned.
  // Keep the existing metadata/header skeleton until the canonical view owns
  // the interaction; comments may then load without another route-key change.
  if (!taskRouteReady || !taskInterfaceSettingsLoaded)
    return (
      <IssueDetailLoadingState
        headerSeed={
          loadedIssue
            ? readIssueDetailHeaderSeed(
                withIssueDetailHeaderSeed(null, loadedIssue),
              )
            : issueHeaderSeed
        }
      />
    );

  // Ancestors are returned oldest-first from the server (root at end, immediate parent at start)
  const ancestors = issue.ancestors ?? [];
  const legacyRecoverySourceIssue = (() => {
    if (
      issue.originKind !== "stranded_issue_recovery" &&
      issue.originKind !== "stale_active_run_evaluation"
    ) {
      return null;
    }
    const parent = ancestors.length > 0 ? ancestors[0] : null;
    if (!parent) return null;
    const ref = parent.identifier ?? parent.id;
    return {
      identifier: parent.identifier ?? null,
      title: parent.title ?? null,
      href: createIssueDetailPath(ref),
    };
  })();
  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const files = evt.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleAttachmentDrop = async (evt: DragEvent<HTMLDivElement>) => {
    evt.preventDefault();
    setAttachmentDragActive(false);
    const files = evt.dataTransfer.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
  };

  const hasAttachments = attachmentList.length > 0;
  const canShowSubtreeControls = canManageTreeControl && childIssues.length > 0;
  const canResumeSubtree =
    canShowSubtreeControls && activePauseHold?.isRoot === true;
  const canRestoreSubtree =
    canShowSubtreeControls && activeCancelHolds.length > 0;
  const isTerminalIssue =
    issue.status === "done" || issue.status === "cancelled";
  const isAgentOwnedNonTerminalIssue =
    Boolean(issue.assigneeAgentId) && !isTerminalIssue;
  const canPauseLeafWork =
    canManageTreeControl &&
    childIssues.length === 0 &&
    !activePauseHold &&
    !isTerminalIssue;
  const canResumeLeafWork =
    canManageTreeControl &&
    childIssues.length === 0 &&
    activePauseHold?.isRoot === true;
  const treeControlScope: "leaf" | "subtree" =
    childIssues.length === 0 ? "leaf" : "subtree";
  const previewAffectedIssueCount = treePreviewAffectedIssues.length;
  const previewAffectedAgentCount =
    treeControlPreview?.totals.affectedAgents ?? 0;
  const reopenComposerHint = closedIsolatedWorkspaceReopenPending
    ? "This issue's isolated workspace was archived. Your next comment or resume reopens it and rebuilds the worktree."
    : null;
  const composerHint = activePauseHold ? null : reopenComposerHint;
  const queuedCommentReason: "hold" | "active_run" | "other" = activePauseHold
    ? "hold"
    : "active_run";
  const canApplyTreeControl =
    Boolean(treeControlPreview) &&
    !treeControlPreviewLoading &&
    !treeControlPreviewError;
  const attachmentUploadButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFilePicked}
        multiple
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={
          uploadAttachment.isPending || importMarkdownDocument.isPending
        }
        className={cn(
          "shadow-none",
          attachmentDragActive && "border-primary bg-primary/5",
        )}
      >
        <PaperclipIcon className="h-3.5 w-3.5 mr-1.5" />
        {uploadAttachment.isPending || importMarkdownDocument.isPending ? (
          "Uploading..."
        ) : (
          <>
            <span className="hidden sm:inline">Upload attachment</span>
            <span className="sm:hidden">Upload</span>
          </>
        )}
      </Button>
    </>
  );

  // Task Chat Redesign ("not sticky" header): the parent breadcrumb, the
  // title/badge block, and the plugin toolbars render INSIDE the thread's
  // scroll viewport, so they scroll away with the messages and the composer
  // stays near the viewport bottom. Flag OFF renders the same nodes in the
  // page flow, in their original order relative to the alert banners.
  const ancestorsNav =
    !streamlinedTaskDetailEnabled && ancestors.length > 0 ? (
      <nav
        className={cn(
          "flex items-center gap-1 text-xs text-muted-foreground flex-wrap",
          shellSectionClass,
        )}
      >
        {[...ancestors].reverse().map((ancestor, i) => (
          <span key={ancestor.id} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
            <Link
              to={createIssueDetailPath(ancestor.identifier ?? ancestor.id)}
              state={resolvedIssueDetailState ?? location.state}
              onClickCapture={() =>
                rememberIssueDetailLocationState(
                  ancestor.identifier ?? ancestor.id,
                  resolvedIssueDetailState ?? location.state,
                  location.search,
                )
              }
              className="hover:text-foreground transition-colors truncate max-w-(--sz-200px)"
              title={ancestor.title}
            >
              {ancestor.title}
            </Link>
          </span>
        ))}
        <ChevronRight className="h-3 w-3 shrink-0" />
        <span className="text-muted-foreground truncate max-w-(--sz-200px)">
          {issue.title}
        </span>
      </nav>
    ) : null;

  const issueStatusControl = (
    <StatusIcon
      status={issue.status} externalConversationState={issue.externalConversationState}
      waiting={isWaitingOnMonitor(issue)}
      size="lg"
      blockerAttention={issue.blockerAttention}
      onChange={(status) => updateIssue.mutate({ status })}
    />
  );

  const issueHeaderBlock = issue.conversationAgentId ? null : (
    <IssueDetailHeader
      streamlinedTaskDetailEnabled={streamlinedTaskDetailEnabled}
      shellSectionClass={shellSectionClass}
      issueStatusControl={issueStatusControl}
      issue={issue}
      updateIssue={updateIssue}
      hasLiveRuns={hasLiveRuns}
      taskChatShellEnabled={taskChatShellEnabled}
      resolvedProject={resolvedProject}
      agentMap={agentMap}
      userProfileMap={userProfileMap}
      userLabelMap={userLabelMap}
      isMobile={isMobile}
      isFromInbox={isFromInbox}
      copyIssueToClipboard={copyIssueToClipboard}
      copied={copied}
      setMobilePropsOpen={setMobilePropsOpen}
      canArchiveFromInbox={canArchiveFromInbox}
      archivePending={archivePending}
      archiveFromInbox={archiveFromInbox}
      isTerminalIssue={isTerminalIssue}
      fileViewerEnabled={fileViewerEnabled}
      setFileViewerPromptOpen={setFileViewerPromptOpen}
      panelVisible={panelVisible}
      suppressPanelUntilPlan={suppressPanelUntilPlan}
      openTaskSidePanel={openTaskSidePanel}
      moreOpen={moreOpen}
      setMoreOpen={setMoreOpen}
      openNewSubIssue={openNewSubIssue}
      treeControlScope={treeControlScope}
      canPauseLeafWork={canPauseLeafWork}
      canShowSubtreeControls={canShowSubtreeControls}
      activePauseHold={activePauseHold}
      canResumeLeafWork={canResumeLeafWork}
      canResumeSubtree={canResumeSubtree}
      canRestoreSubtree={canRestoreSubtree}
      executeTreeControl={executeTreeControl}
      setTreeControlMode={setTreeControlMode}
      setTreeControlWakeAgentsOnResume={setTreeControlWakeAgentsOnResume}
      isAgentOwnedNonTerminalIssue={isAgentOwnedNonTerminalIssue}
      setTreeControlOpen={setTreeControlOpen}
      navigate={navigate}
      subTasksTree={subTasksTree}
      resolvedDetailTab={resolvedDetailTab}
      checkIssueMonitorNow={checkIssueMonitorNow}
      mentionOptions={mentionOptions}
      externalObjectsState={externalObjectsState}
      uploadAttachment={uploadAttachment}
    />
  );

  const pluginOutletsBlock = (
    <>
      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className={cn("flex flex-wrap gap-2", shellSectionClass)}
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className={cn("flex flex-wrap gap-2", shellSectionClass)}
        itemClassName="inline-flex"
      />

      <PluginSlotOutlet
        slotTypes={["taskDetailView"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className={cn("space-y-3", shellSectionClass)}
        itemClassName="rounded-lg border border-border p-3"
        missingBehavior="placeholder"
      />
    </>
  );

  const taskChatThreadHeader = taskChatShellEnabled ? (
    <>
      {ancestorsNav}
      {issueHeaderBlock}
      {pluginOutletsBlock}
    </>
  ) : undefined;

  return (
    <FileViewerProvider issueId={conversation && !conversation.issue ? "" : issue.id} enabled={fileViewerEnabled}>
      <IssueGalleryContext.Provider value={openIssueGallery}>
        <div
          data-task-chat-shell={taskChatShellEnabled ? "" : undefined}
          className={
            taskChatShellEnabled
              ? isMobile
                ? // Mobile shell scrolls the DOCUMENT (main is overflow-visible,
                  // auto height) — the thread renders in normal flow (PAP-360).
                  "flex w-full flex-col gap-6"
                : // Fill main exactly so the outer page never scrolls — the
                  // thread's own viewport is the only scroll surface.
                  // Keep status banners close to the transcript. A full section
                  // gap here shortens the pinned message viewport enough to
                  // leave its first visible bubble sliced at the top edge.
                  "flex h-full min-h-0 w-full flex-col gap-3"
              : "max-w-3xl space-y-6"
          }
        >
          {/* Parent chain breadcrumb (redesign: rendered inside the thread viewport) */}
          {taskChatShellEnabled ? null : ancestorsNav}

          <ExternallyConnectedTaskBanner
            key={issue.id}
            attachments={attachments ?? []}
            companyId={issue.companyId}
            issueId={issue.id}
            issueCacheRefs={issueCacheRefs}
          />

          {issue.status === "in_review" && issue.externalConversationState === "waiting" && (
            <p role="status" className="text-sm text-muted-foreground">Reply sent. Send a message to continue.</p>
          )}

          {issue.hiddenAt && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive",
                shellSectionClass,
                taskChatShellEnabled && (isMobile ? "mt-4" : "mt-3"),
              )}
            >
              <EyeOff className="h-4 w-4 shrink-0" />
              This task is hidden
            </div>
          )}
          {treeControlWakeWarning ? (
            <p
              role="alert"
              className={cn("text-sm text-muted-foreground", shellSectionClass)}
            >
              {treeControlWakeWarning}
            </p>
          ) : null}
          {executeTreeControl.error &&
            !treeControlOpen &&
            executeTreeControl.variables?.feedback !== "composer" && (
              <p
                role="alert"
                className={cn("text-sm text-destructive", shellSectionClass)}
              >
                {executeTreeControl.error.message}
              </p>
            )}

          {taskChatShellEnabled ? null : issueHeaderBlock}

          {taskChatShellEnabled ? null : pluginOutletsBlock}

          <IssueDetailClassicSections
            taskChatShellEnabled={taskChatShellEnabled}
            showRichSubIssuesSection={showRichSubIssuesSection}
            childIssues={childIssues}
            childIssuesLoading={childIssuesLoading}
            agents={agents}
            projects={projects}
            liveIssueIds={liveIssueIds}
            mutedChildIssueIds={mutedChildIssueIds}
            childPauseBadgeById={childPauseBadgeById}
            issue={issue}
            resolvedIssueDetailState={resolvedIssueDetailState}
            location={location}
            currentUserId={currentUserId}
            handleChildIssueUpdate={handleChildIssueUpdate}
            openNewSubIssue={openNewSubIssue}
            showPlanDecompositionsSection={showPlanDecompositionsSection}
            agentMap={agentMap}
            session={session}
            feedbackVotes={feedbackVotes}
            feedbackDataSharingPreference={feedbackDataSharingPreference}
            mentionOptions={mentionOptions}
            externalObjectsState={externalObjectsState}
            uploadAttachment={uploadAttachment}
            feedbackVoteMutation={feedbackVoteMutation}
            hasAttachments={hasAttachments}
            attachmentUploadButton={attachmentUploadButton}
            userProfileMap={userProfileMap}
            workProducts={workProducts}
            mediaGalleryItems={mediaGalleryItems}
            setGalleryIndex={setGalleryIndex}
            setGalleryOpen={setGalleryOpen}
            attachmentsInitialLoading={attachmentsInitialLoading}
            attachmentList={attachmentList}
            attachmentError={attachmentError}
            attachmentDragActive={attachmentDragActive}
            deleteAttachment={deleteAttachment}
            setAttachmentDragActive={setAttachmentDragActive}
            handleAttachmentDrop={handleAttachmentDrop}
          />

          <ImageGalleryModal
            items={mediaGalleryItems}
            initialIndex={galleryIndex}
            open={galleryOpen}
            onOpenChange={setGalleryOpen}
          />

          {taskChatShellEnabled ? null : (
            <IssueWorkspaceCard
              issue={issue}
              project={resolvedProject}
              onUpdate={(data) => updateIssue.mutate(data)}
              onBrowseFiles={
                fileViewerEnabled
                  ? () => setFileViewerPromptOpen(true)
                  : undefined
              }
              onOpenFileByPath={
                fileViewerEnabled
                  ? () => setFileViewerPromptOpen(true)
                  : undefined
              }
            />
          )}

          {!taskChatShellEnabled &&
            fileViewerEnabled &&
            issue.workProducts &&
            issue.workProducts.length > 0 &&
            (() => {
              const workProductsWithFileRefs = issue.workProducts
                .map((product) => ({
                  product,
                  fileRef: extractWorkspaceFileRefFromWorkProduct(product),
                }))
                .filter(({ fileRef }) => fileRef !== null);

              if (workProductsWithFileRefs.length === 0) return null;

              return (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium text-muted-foreground">
                      Artifacts
                    </h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {workProductsWithFileRefs.map(({ product, fileRef }) => (
                      <ArtifactFileChip
                        key={product.id}
                        workspaceFileRef={fileRef!}
                        title={product.title}
                      />
                    ))}
                  </div>
                </div>
              );
            })()}

          {taskChatShellEnabled ? null : (
            <Separator className={shellSectionClass} />
          )}

          <Tabs
            value={resolvedDetailTab}
            onValueChange={setDetailTab}
            className={
              taskChatShellEnabled
                ? isMobile
                  ? undefined
                  : "min-h-0 flex-1"
                : "space-y-3"
            }
          >
            {/* Redesign: the chat IS the page — the Chat/Activity/Related-work tab
            strip is hidden and the thread renders as the only surface. */}
            {taskChatShellEnabled ? null : (
              <TabsList
                variant="line"
                className={cn("w-full justify-start gap-1", shellSectionClass)}
              >
                <TabsTrigger value="chat" className="gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Chat
                </TabsTrigger>
                <TabsTrigger value="activity" className="gap-1.5">
                  <ActivityIcon className="h-3.5 w-3.5" />
                  Activity
                </TabsTrigger>
                <TabsTrigger value="related-work" className="gap-1.5">
                  <ListTree className="h-3.5 w-3.5" />
                  Related work
                </TabsTrigger>
                {issuePluginTabItems.map((item) => (
                  <TabsTrigger key={item.value} value={item.value}>
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            )}

            {/* The chat shell keeps the page's responsive 16px/24px gutters so
            thread content and the composer do not touch either sidebar. */}
            <IssueDetailChatPanel
              taskChatShellEnabled={taskChatShellEnabled}
              isMobile={isMobile}
              streamlinedTaskDetailEnabled={streamlinedTaskDetailEnabled}
              issue={issue}
              invalidateIssueDetail={invalidateIssueDetail}
              resolvedDetailTab={resolvedDetailTab}
              agentMap={agentMap}
              interactions={interactions}
              boardAccess={boardAccess}
              canResolveBoardRecoveryAction={canResolveBoardRecoveryAction}
              treeControlStateError={treeControlStateError}
              activePauseHold={activePauseHold}
              retryDispositionRecovery={retryDispositionRecovery}
              handleOpenSkill={handleOpenSkill}
              taskChatThreadHeader={taskChatThreadHeader}
              instanceExperimentalSettings={instanceExperimentalSettings}
              updateIssue={updateIssue}
              mentionOptions={mentionOptions}
              externalObjectsState={externalObjectsState}
              uploadAttachment={uploadAttachment}
              conversation={conversation}
              liveIssueIds={liveIssueIds}
              handleResolveRecoveryAction={handleResolveRecoveryAction}
              handleReissueIsolatedRecoveryAction={handleReissueIsolatedRecoveryAction}
              reissueIsolatedRecoveryAction={reissueIsolatedRecoveryAction}
              handleReconcileForwardRecoveryAction={handleReconcileForwardRecoveryAction}
              handleBreakGlassOverrideRecoveryAction={handleBreakGlassOverrideRecoveryAction}
              handleQuarantineRestoreRecoveryAction={handleQuarantineRestoreRecoveryAction}
              reconcileRecoveryAction={reconcileRecoveryAction}
              canManageBoardRuntime={canManageBoardRuntime}
              legacyRecoverySourceIssue={legacyRecoverySourceIssue}
              threadComments={threadComments}
              commentsLoading={commentsLoading}
              linkedCommentPending={linkedCommentPending}
              interactionsLoading={interactionsLoading}
              attachmentsLoading={attachmentsLoading}
              workProductsLoading={workProductsLoading}
              commentsError={commentsError}
              interactionsError={interactionsError}
              attachmentsError={attachmentsError}
              workProductsError={workProductsError}
              refetchComments={refetchComments}
              refetchInteractions={refetchInteractions}
              refetchAttachments={refetchAttachments}
              refetchWorkProducts={refetchWorkProducts}
              locallyQueuedCommentRunIds={locallyQueuedCommentRunIds}
              workProducts={workProducts}
              attachments={attachments}
              hasOlderComments={hasOlderComments}
              commentsLoadingOlder={commentsLoadingOlder}
              loadOlderComments={loadOlderComments}
              refetchLatestComments={refetchLatestComments}
              commentComposerRef={commentComposerRef}
              checkIssueMonitorNow={checkIssueMonitorNow}
              siblingNavigation={siblingNavigation}
              resolvedIssueDetailState={resolvedIssueDetailState}
              location={location}
              feedbackVotes={feedbackVotes}
              feedbackDataSharingPreference={feedbackDataSharingPreference}
              currentUserId={currentUserId}
              userLabelMap={userLabelMap}
              userProfileMap={userProfileMap}
              conversationAgent={conversationAgent}
              commentReassignOptions={commentReassignOptions}
              actualAssigneeValue={actualAssigneeValue}
              suggestedAssigneeValue={suggestedAssigneeValue}
              childIssues={childIssues}
              executeTreeControl={executeTreeControl}
              canManageTreeControl={canManageTreeControl}
              setTreeControlMode={setTreeControlMode}
              setTreeControlWakeAgentsOnResume={setTreeControlWakeAgentsOnResume}
              isAgentOwnedNonTerminalIssue={isAgentOwnedNonTerminalIssue}
              canShowSubtreeControls={canShowSubtreeControls}
              setTreeControlOpen={setTreeControlOpen}
              activePauseHoldRoot={activePauseHoldRoot}
              composerHint={composerHint}
              queuedCommentReason={queuedCommentReason}
              handleCommentVote={handleCommentVote}
              handleChatAdd={handleChatAdd}
              queryClient={queryClient}
              issueId={issueId}
              handleCommentImageUpload={handleCommentImageUpload}
              handleCommentAttachImage={handleCommentAttachImage}
              handleInterruptQueuedRun={handleInterruptQueuedRun}
              deleteComment={deleteComment}
              stopResponse={stopResponse}
              treeControlScope={treeControlScope}
              runFinalizationActions={runFinalizationActions}
              pendingDraftWorkMode={pendingDraftWorkMode}
              setDraftWorkMode={setDraftWorkMode}
              handleCancelQueuedComment={handleCancelQueuedComment}
              interruptQueuedComment={interruptQueuedComment}
              handleChatImageClick={handleChatImageClick}
              handleAcceptInteraction={handleAcceptInteraction}
              handleRejectInteraction={handleRejectInteraction}
              handleSubmitInteractionAnswers={handleSubmitInteractionAnswers}
              handleCancelInteraction={handleCancelInteraction}
              handleSkipInteraction={handleSkipInteraction}
              handleSubmitInteractionVerdicts={handleSubmitInteractionVerdicts}
              canResumeFromBacklog={canResumeFromBacklog}
              handleResumeFromBacklog={handleResumeFromBacklog}
              handleResumeAssignee={handleResumeAssignee}
              resumeAssigneeAgent={resumeAssigneeAgent}
              handleTryAgainNoLiveExecutionPath={handleTryAgainNoLiveExecutionPath}
              resolveRecoveryAction={resolveRecoveryAction}
              casesChipsEnabled={casesChipsEnabled}
            />

            <TabsContent value="activity" className={shellSectionClass}>
              {detailTab === "activity" ? (
                <IssueDetailActivityTab
                  issue={issue}
                  issueId={issue.id}
                  companyId={issue.companyId}
                  issueStatus={issue.status}
                  childIssues={childIssues}
                  agentMap={agentMap}
                  hasLiveRuns={hasLiveRuns}
                  currentUserId={currentUserId}
                  userProfileMap={userProfileMap}
                  pendingApprovalAction={pendingApprovalAction}
                  handoffFocusSignal={handoffFocusSignal}
                  onApprovalAction={(approvalId, action) => {
                    approvalDecision.mutate({ approvalId, action });
                  }}
                  externalReferences={
                    externalObjectsState.isEnabled
                      ? externalObjectsState.markdownReferences
                      : undefined
                  }
                />
              ) : null}
            </TabsContent>

            <TabsContent value="related-work" className={shellSectionClass}>
              <IssueRelatedWorkPanel
                relatedWork={issue.relatedWork}
                externalObjectsEnabled={externalObjectsState.isEnabled}
                externalObjects={
                  externalObjectsState.isEnabled
                    ? externalObjectsState.groups
                    : undefined
                }
                externalObjectsLoading={
                  externalObjectsState.isEnabled
                    ? externalObjectsState.isLoading
                    : undefined
                }
                externalObjectsError={
                  externalObjectsState.isEnabled
                    ? externalObjectsState.isError
                    : undefined
                }
                onRetryExternalObjects={
                  externalObjectsState.isEnabled
                    ? externalObjectsState.refetch
                    : undefined
                }
              />
            </TabsContent>

            {activePluginTab && (
              <TabsContent
                value={activePluginTab.value}
                className={shellSectionClass}
              >
                <PluginSlotMount
                  slot={activePluginTab.slot}
                  context={{
                    companyId: issue.companyId,
                    projectId: issue.projectId ?? null,
                    entityId: issue.id,
                    entityType: "issue",
                  }}
                  missingBehavior="placeholder"
                />
              </TabsContent>
            )}
          </Tabs>

          <TaskTreeControlDialog
            open={treeControlOpen}
            onOpenChange={(open) => {
              setTreeControlOpen(open);
              if (!open) executeTreeControl.reset();
            }}
            mode={treeControlMode}
            scope={treeControlScope}
            affectedCount={previewAffectedIssueCount}
            affectedAgentCount={previewAffectedAgentCount}
            loading={treeControlPreviewLoading}
            error={
              treeControlPreviewError
                ? treeControlPreviewErrorCopy(treeControlPreviewError)
                : executeTreeControl.error?.message
            }
            pending={executeTreeControl.isPending}
            valid={canApplyTreeControl}
            wakeAgents={treeControlWakeAgentsOnResume}
            onWakeAgentsChange={(wake) => {
              executeTreeControl.reset();
              setTreeControlWakeAgentsOnResume(wake);
            }}
            onRetry={() => {
              executeTreeControl.reset();
              void refetchTreeControlPreview();
            }}
            onApply={() =>
              executeTreeControl.mutate({
                mode: treeControlMode,
                scope: treeControlScope,
                wakeAgents: treeControlWakeAgentsOnResume,
              })
            }
          />

          {/* Mobile properties drawer */}
          <IssueDetailMobilePropertiesSheet
            mobilePropsOpen={mobilePropsOpen}
            setMobilePropsOpen={setMobilePropsOpen}
            taskChatShellEnabled={taskChatShellEnabled}
            documentDeepLink={documentDeepLink}
            issue={issue}
            currentUserId={currentUserId}
            childIssues={childIssues}
            streamlinedTaskDetailEnabled={streamlinedTaskDetailEnabled}
            relationIssueLinkState={relationIssueLinkState}
            openNewSubIssue={openNewSubIssue}
            updateIssue={updateIssue}
            resolvedHasActiveRun={resolvedHasActiveRun}
            externalObjectsState={externalObjectsState}
            checkIssueMonitorNow={checkIssueMonitorNow}
            fileViewerEnabled={fileViewerEnabled}
            resolvedTasksTab={resolvedTasksTab}
            isMobile={isMobile}
            artifactsOpenRequest={artifactsOpenRequest}
            handleArtifactsOpened={handleArtifactsOpened}
            openSkill={openSkill}
            handleSkillOpened={handleSkillOpened}
          />
          {fileViewerEnabled ? (
            <IssueFileViewer
              issueId={issue.id}
              companyId={issue.companyId}
              promptOpen={fileViewerPromptOpen}
              onPromptOpenChange={setFileViewerPromptOpen}
              useSidePanel={taskChatShellEnabled}
            />
          ) : null}
          <ScrollToBottom />
          {reauthDialog}
        </div>
      </IssueGalleryContext.Provider>
    </FileViewerProvider>
  );
}
