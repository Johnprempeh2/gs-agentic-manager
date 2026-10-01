import { useUserPreferences } from "../hooks/useUserPreferences";
import { DispositionRecoveryProvider } from "../components/DispositionRecoveryNotice";
import { useReauth, ReauthCancelledError } from "@/components/ReauthDialog";
import { clearLegacyChatMessageRequests } from "@/lib/chat-message-request";
import { agentChatDraft } from "@/lib/agent-chat-draft";
import { isBlockedDependentsHandoffCancelled } from "@/lib/blocked-dependents-handoff";
import {
  Settings as ChatSettings,
  PaperclipIcon,
  ChevronRight,
  Repeat,
  ScanEye,
  Flag,
  Check,
  Copy,
  SlidersHorizontal,
  Archive,
  FileCode2,
  MoreHorizontal,
  Plus,
  EyeOff,
  MessageSquare,
  Activity as ActivityIcon,
  ListTree,
} from "lucide-react";
import { agentDetailHref } from "./agent-detail-navigation";
import { deriveInitials } from "@/components/Identity";
import { ExecutionBlockerNotice } from "../components/ExecutionBlockerNotice";
import { TaskDetailTasksPanel } from "@/components/task-detail/TaskDetailTasksPanel";
import { EmailTaskActivity } from "../components/EmailTaskActivity";
import {
  useState,
  useMemo,
  useRef,
  useCallback,
  useLayoutEffect,
  useEffect,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { useParams, useNavigate, useNavigationType, useLocation, Link } from "@/lib/router";
import {
  useQueryClient,
  useQuery,
  useInfiniteQuery,
  type InfiniteData,
  useMutation,
} from "@tanstack/react-query";
import { useSharedPollingQuery, usePublishSharedQueryData } from "@/hooks/useSharedPolling";
import { issuesApi } from "../api/issues";
import { CommentSubmissionUnknownError } from "../lib/comment-submit-result";
import { approvalsApi } from "../api/approvals";
import { type LiveRunForIssue, heartbeatsApi, type ActiveRunForIssue } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { accessApi } from "../api/access";
import { canBoardManageRuntime, readRecoveryReconcileWorkspaceId } from "../lib/recovery-reconcile";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useToastActions } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { assigneeValueFromSelection, suggestedCommentAssigneeValue } from "../lib/assignees";
import {
  buildCompanyUserProfileMap,
  buildCompanyUserLabelMap,
  buildMarkdownMentionOptions,
  buildCompanyUserInlineOptions,
  isAgentTaskTarget,
} from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../lib/query-placeholder-data";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import {
  readIssueDetailLocationState,
  readIssueDetailHeaderSeed,
  hasLegacyIssueDetailQuery,
  readIssueDetailBreadcrumb,
  rememberIssueDetailLocationState,
  createIssueDetailPath,
  withIssueDetailHeaderSeed,
} from "../lib/issueDetailBreadcrumb";
import { taskPollInterval, shouldTrackIssueActiveRun } from "../lib/issueActiveRun";
import { usePageVisibility } from "../lib/page-visibility";
import { getIssueDetailQueryOptions } from "../lib/issueDetailCache";
import {
  beginIssueDetailNavigation,
  reportIssueDetailWebVitals,
  scheduleIssueDetailPaintMeasure,
  ISSUE_DETAIL_HEADER_PAINT_MARK,
  ISSUE_DETAIL_HEADER_MEASURE,
  ISSUE_DETAIL_CONTENT_PAINT_MARK,
  ISSUE_DETAIL_CONTENT_MEASURE,
} from "../lib/issue-detail-performance";
import {
  type InboxIssueCacheSnapshot,
  cancelInboxIssueQueries,
  clearLocalInboxArchive,
  restoreIssueToInboxCaches,
  beginLocalInboxArchive,
  removeIssueFromInboxCaches,
  boundLocalInboxArchive,
  invalidateInboxIssueQueries,
  snapshotInboxIssueCaches,
  getIssuePresenceInActiveInboxCaches,
  confirmLocalInboxArchive,
} from "../lib/inboxArchiveCache";
import {
  resolveInboxQuickArchiveKeyAction,
  hasBlockingShortcutDialog,
  resolveIssueDetailGoKeyAction,
} from "../lib/keyboardShortcuts";
import {
  type OptimisticIssueComment,
  ISSUE_COMMENT_PAGE_SIZE,
  getNextIssueCommentPageParam,
  flattenIssueCommentPages,
  shouldAutoloadOlderIssueComments,
  mergeIssueComments,
  removeIssueCommentFromPages,
  upsertIssueCommentInPages,
  matchesIssueRef,
  applyOptimisticIssueFieldUpdate,
  applyOptimisticIssueFieldUpdateToCollection,
  createOptimisticIssueComment,
  applyOptimisticIssueCommentUpdate,
  takeOptimisticIssueComment,
  loadRemainingIssueCommentPages,
} from "../lib/optimistic-issue-comments";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { recordRecentTask } from "../lib/recent-tasks";
import { cn } from "../lib/utils";
import { liveBlueBadge } from "../lib/status-colors";
import { ProjectTile } from "../components/ProjectTile";
import { InlineEditor } from "../components/InlineEditor";
import type { IssueChatComposerHandle, IssueChatRunFinalizationAction } from "../components/IssueChatThread";
import { workModeMetaFor } from "../lib/work-mode-meta";
import { IssueAttachmentsSection } from "../components/IssueAttachmentsSection";
import { IssueDocumentsSection } from "../components/IssueDocumentsSection";
import { IssuePlanDecompositionsSection } from "../components/IssuePlanDecompositionsSection";
import { IssueOutputSection } from "../components/issue-output/IssueOutputSection";
import { isImageAttachment, isVideoAttachment } from "../lib/issue-attachments";
import {
  getIssueOutputs,
  isImageLikeOutput,
  isVideoLikeOutput,
  getPromotedOutputAttachmentIds,
} from "../lib/issue-output";
import { IssueSiblingNavigation } from "../components/IssueSiblingNavigation";
import { IssuesList } from "../components/IssuesList";
import { IssueRelatedWorkPanel } from "../components/IssueRelatedWorkPanel";
import {
  isWaitingOnMonitor,
  IssueMonitorBanner,
  hasVisibleMonitorSurface,
  IssueMonitorComposerStrip,
} from "../components/IssueMonitorBanner";
import { NotNowButton } from "../components/decisions-feed/NotNowButton";
import { TabledBanner } from "../components/decisions-feed/TabledBanner";
import { ExternallyConnectedTaskBanner } from "../components/chat/ExternallyConnectedTaskBanner";
import { type IssuePropertiesDocumentDeepLink, IssueProperties } from "../components/IssueProperties";
import { type TaskSidePanelProps, TaskSidePanel } from "../components/task-side-panel";
import { SidePanelToggleButton } from "../components/side-panel";
import { TaskTreeControlMenuItems, TaskTreeControlDialog } from "../components/TaskTreeControls";
import { waitForStoppedRuns } from "../lib/wait-for-stopped-runs";
import { useIssueExternalObjects } from "../hooks/useIssueExternalObjects";
import { IssueGalleryContext } from "../context/IssueGalleryContext";
import { useIssuePlanDocument } from "../hooks/useIssuePlanDocument";
import { useTaskArtifactArrival } from "../hooks/useTaskArtifactArrival";
import { IssueWorkspaceCard } from "../components/IssueWorkspaceCard";
import type { MentionOption } from "../components/MarkdownEditor";
import { type GalleryMediaItem, ImageGalleryModal } from "../components/ImageGalleryModal";
import { FileViewerProvider } from "../context/FileViewerContext";
import { ArtifactFileChip } from "../components/ArtifactFileChip";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { usePluginSlots, PluginSlotOutlet, PluginSlotMount } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { copyTextToClipboard } from "../lib/clipboard";
import { buildIssuePropertiesPanelKey } from "../lib/issue-properties-panel-key";
import { shouldSuppressTaskPanelUntilPlan, openSkillPanelState } from "../lib/task-side-panel-state";
import { buildIssueThreadInteractionSummary } from "../lib/issue-thread-interactions";
import { resolveIssueDocumentDeepLink } from "../lib/issue-document-deep-link";
import { shouldRenderRichSubIssuesSection, buildIssueSiblingNavigation } from "../lib/issue-detail-subissues";
import { filterIssueDescendants } from "../lib/issue-tree";
import { buildSubIssueDefaultsForViewer } from "../lib/subIssueDefaults";
import { hasAssignedBacklogBlocker } from "../lib/issue-blockers";
import { Badge } from "@/components/ui/badge";
import {
  type Agent,
  type Issue,
  type IssueWorkMode,
  type IssueTreeControlMode,
  isClosedIsolatedExecutionWorkspace,
  type IssueComment,
  type IssueThreadInteraction,
  type IssueAttachment,
  type IssueWorkProduct,
  ONBOARDING_FIRST_TASK_ORIGIN_KIND,
  type AskUserQuestionsAnswer,
  type RequestItemVerdictsInteraction,
  type RequestItemVerdictValue,
  type AskUserQuestionsInteraction,
  type FeedbackVote,
} from "@greatstone/shared";
import {
  useTaskDetailInterfaceMode,
  IssueDetailLoadingState,
  IssueSectionSkeleton,
} from "./issue-detail/IssueDetailLoading";
import {
  ISSUE_COMMENT_AUTOLOAD_LIMIT,
  EMPTY_ISSUES,
  canBoardResolveRecoveryAction,
  type ResolveRecoveryActionOutcome,
  createRunCancelledStatusUpdateError,
  didRunCancelBeforeStatusUpdateFail,
  readIssueRunStateFromCache,
  type ActionableIssueThreadInteraction,
  type CommentReassignment,
  mergeOptimisticFeedbackVote,
  fileBaseName,
  slugifyDocumentKey,
  titleizeFilename,
  shouldScrollIssueDetailToTopOnNavigation,
  JUMP_TO_LATEST_MAX_COMMENT_PAGES,
  isMarkdownFile,
  FEEDBACK_TERMS_URL,
  extractWorkspaceFileRefFromWorkProduct,
  treeControlPreviewErrorCopy,
} from "./issue-detail/helpers";
import { InboxMobileToolbar } from "./issue-detail/InboxMobileToolbar";
import { IssueAttributionByline } from "./issue-detail/IssueAttribution";
import { IssueDetailChatTab } from "./issue-detail/IssueDetailChatTab";
import { IssueDetailActivityTab } from "./issue-detail/IssueDetailActivityTab";
import { IssueFileViewer } from "./issue-detail/IssueFileViewer";
import { useIssueMutations } from "./issue-detail/useIssueMutations";
import { useThreadMutations } from "./issue-detail/useThreadMutations";
import { useRecoveryActionHandlers } from "./issue-detail/useRecoveryActionHandlers";
import { useThreadHandlers } from "./issue-detail/useThreadHandlers";
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
    data: queriedIssue,
    isLoading,
    isPlaceholderData,
    error,
  } = useQuery({
    ...getIssueDetailQueryOptions(queryClient, issueId!, {
      placeholderIssue: issueHeaderSeed
        ? {
            id: issueHeaderSeed.id,
            identifier: issueHeaderSeed.identifier,
          }
        : null,
    }),
    enabled: !!issueId,
  });
  const issue = queriedIssue ?? conversation?.issue ?? draftIssue;
  const resolveWritableIssueId = async () => {
    if (!conversation) return issueId!;
    const resolved = await conversation.ensureIssue();
    const requestedMode = pendingDraftWorkMode.current;
    if (requestedMode !== null && requestedMode !== resolved.workMode) {
      await issuesApi.update(resolved.id, { workMode: requestedMode });
    }
    pendingDraftWorkMode.current = null;
    return resolved.id;
  };
  // A cached header seed can paint during navigation, but must not redirect
  // or upload against the previous task while the requested task is loading.
  const loadedIssue =
    !isPlaceholderData &&
    !error &&
    issue &&
    issueId &&
    (issue.id.toLowerCase() === issueId.toLowerCase() ||
      issue.identifier?.toLowerCase() === issueId.toLowerCase())
      ? issue
      : null;
  const loadedIssueCompany = loadedIssue
    ? companies.find((company) => company.id === loadedIssue.companyId)
    : undefined;
  const taskRouteReady = Boolean(conversation || (
    loadedIssue &&
    issueId === (loadedIssue.identifier ?? loadedIssue.id) &&
    (!loadedIssueCompany || companyPrefix === loadedIssueCompany.issuePrefix) &&
    !hasLegacyIssueDetailQuery(location.search)
  ));
  const resolvedCompanyId = issue?.companyId ?? selectedCompanyId;
  const externalObjectsState = useIssueExternalObjects(conversation && !conversation.issue ? null : issue?.id ?? null);
  // A closed isolated workspace no longer blocks the composer. The server reopens
  // the workspace when the next comment or resume arrives, so the composer stays
  // enabled and a hint tells the user what happens.
  const closedIsolatedWorkspaceReopenPending = useMemo(
    () =>
      Boolean(
        issue?.currentExecutionWorkspace &&
        isClosedIsolatedExecutionWorkspace(issue.currentExecutionWorkspace),
      ),
    [issue?.currentExecutionWorkspace],
  );

  const {
    data: commentPages,
    isLoading: commentsLoading,
    isError: commentsError,
    isFetchingNextPage: commentsLoadingOlder,
    hasNextPage: hasOlderComments,
    fetchNextPage: fetchOlderComments,
    refetch: refetchComments,
  } = useInfiniteQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: ({ pageParam }) =>
      issuesApi.listComments(issueId!, {
        order: "desc",
        limit: ISSUE_COMMENT_PAGE_SIZE,
        ...(pageParam ? { after: pageParam } : {}),
      }),
    enabled: !!issueId,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      getNextIssueCommentPageParam(lastPage, ISSUE_COMMENT_PAGE_SIZE),
    placeholderData: keepPreviousDataForSameQueryTail<
      InfiniteData<IssueComment[], string | null>
    >(issueId ?? "pending"),
  });
  const comments = useMemo(
    () => flattenIssueCommentPages(commentPages?.pages),
    [commentPages?.pages],
  );

  useLayoutEffect(() => {
    beginIssueDetailNavigation();
  }, [issueId]);

  useEffect(() => {
    if (!(import.meta.env.DEV || import.meta.env.MODE === "qa")) return;
    return reportIssueDetailWebVitals();
  }, [issueId]);

  useEffect(() => {
    if (!issue) return;
    scheduleIssueDetailPaintMeasure(
      ISSUE_DETAIL_HEADER_PAINT_MARK,
      ISSUE_DETAIL_HEADER_MEASURE,
    );
  }, [issue?.id]);

  useEffect(() => {
    if (!issue || commentsLoading) return;
    scheduleIssueDetailPaintMeasure(
      ISSUE_DETAIL_CONTENT_PAINT_MARK,
      ISSUE_DETAIL_CONTENT_MEASURE,
    );
  }, [commentsLoading, issue?.id]);
  const linkedCommentId = location.hash.startsWith("#comment-")
    ? location.hash.slice("#comment-".length)
    : null;
  const linkedCommentPending = Boolean(
    linkedCommentId &&
    !comments.some((comment) => comment.id === linkedCommentId) &&
    !commentsError &&
    (commentsLoading || hasOlderComments),
  );
  const shouldPrefetchOlderComments = useMemo(
    () =>
      shouldAutoloadOlderIssueComments({
        activeDetailTab: detailTab,
        hasOlderComments: hasOlderComments ?? false,
        loadedCommentCount: comments.length,
        initialPageLoading: commentsLoading,
        olderPageLoading: commentsLoadingOlder,
        autoLoadLimit: ISSUE_COMMENT_AUTOLOAD_LIMIT,
      }),
    [
      comments.length,
      commentsLoading,
      commentsLoadingOlder,
      detailTab,
      hasOlderComments,
    ],
  );
  const {
    data: interactions = [],
    isLoading: interactionsLoading,
    isError: interactionsError,
    refetch: refetchInteractions,
  } = useQuery({
    queryKey: queryKeys.issues.interactions(issueId!),
    queryFn: () => issuesApi.listInteractions(issueId!),
    enabled: !!issueId,
    // A review can be committed between the initial fetch and live-socket
    // subscription. Reconcile even after its originating run has ended.
    refetchInterval: 20_000,
    placeholderData: keepPreviousDataForSameQueryTail<IssueThreadInteraction[]>(
      issueId ?? "pending",
    ),
  });

  const {
    data: attachments,
    isLoading: attachmentsLoading,
    isError: attachmentsError,
    refetch: refetchAttachments,
  } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId!),
    queryFn: () => issuesApi.listAttachments(issueId!),
    enabled: !!issueId,
    placeholderData: keepPreviousDataForSameQueryTail<IssueAttachment[]>(
      issueId ?? "pending",
    ),
  });

  const {
    data: workProducts,
    isLoading: workProductsLoading,
    isError: workProductsError,
    refetch: refetchWorkProducts,
  } = useQuery({
    queryKey: queryKeys.issues.workProducts(issueId!),
    queryFn: () =>
      issuesApi.listWorkProducts(issueId!, {
        // Initial geometry needs stored artifacts, not a network round-trip to
        // GitHub. Enrich PR status after the stored list has painted.
        refreshPullRequests:
          queryClient.getQueryData(queryKeys.issues.workProducts(issueId!)) !==
          undefined,
      }),
    enabled: !!issueId,
    refetchOnMount: "always",
    placeholderData: keepPreviousDataForSameQueryTail<IssueWorkProduct[]>(
      issueId ?? "pending",
    ),
  });

  const enrichedWorkProductsIssue = useRef<string | null>(null);
  useEffect(() => {
    if (
      !issueId ||
      enrichedWorkProductsIssue.current === issueId ||
      !workProducts?.some((product) => product.type === "pull_request")
    )
      return;
    enrichedWorkProductsIssue.current = issueId;
    void refetchWorkProducts();
  }, [issueId, workProducts, refetchWorkProducts]);

  // Run state is keyed by the task's UUID, as the chat tab and run ledger key
  // it. Keying it by the route identifier as well fetched and polled the same
  // task twice.
  const runStateIssueId = issueId ? issue?.id : undefined;
  const { visible: pageVisible } = usePageVisibility();
  const { data: liveRunCount = 0 } = useQuery<LiveRunForIssue[], Error, number>(
    {
      queryKey: queryKeys.issues.liveRuns(runStateIssueId!),
      queryFn: () => heartbeatsApi.liveRunsForIssue(runStateIssueId!),
      enabled: !!runStateIssueId,
      // The page's one idle probe: a run started by an agent other than the
      // assignee carries no issue id on its socket event, so check every 30 s.
      refetchInterval: (query) =>
        taskPollInterval(
          {
            issueStatus: issue?.status,
            live: (query.state.data?.length ?? 0) > 0,
            visible: pageVisible,
          },
          3000,
          30_000,
        ),
      select: (runs) => runs.length,
      placeholderData: keepPreviousDataForSameQueryTail<LiveRunForIssue[]>(
        runStateIssueId ?? "pending",
      ),
    },
  );

  const { data: hasActiveRun = false } = useQuery<
    ActiveRunForIssue | null,
    Error,
    boolean
  >({
    queryKey: queryKeys.issues.activeRun(runStateIssueId!),
    queryFn: () => heartbeatsApi.activeRunForIssue(runStateIssueId!),
    enabled:
      !!runStateIssueId &&
      (!!issue?.executionRunId || issue?.status === "in_progress"),
    refetchInterval: (query) =>
      taskPollInterval(
        {
          issueStatus: issue?.status,
          live: liveRunCount === 0 && query.state.data != null,
          visible: pageVisible,
        },
        3000,
      ),
    select: (run) => !!run,
    placeholderData: keepPreviousDataForSameQueryTail<ActiveRunForIssue | null>(
      runStateIssueId ?? "pending",
    ),
  });
  const resolvedHasActiveRun = issue
    ? shouldTrackIssueActiveRun(issue) && hasActiveRun
    : hasActiveRun;
  const hasLiveRuns = liveRunCount > 0 || resolvedHasActiveRun;
  useEffect(() => {
    if (!hasLiveRuns && locallyQueuedCommentRunIds.size > 0) {
      setLocallyQueuedCommentRunIds(new Map());
    }
  }, [hasLiveRuns, locallyQueuedCommentRunIds.size]);
  const sourceBreadcrumb = useMemo(
    () =>
      readIssueDetailBreadcrumb(issueId, location.state, location.search) ?? {
        label: "Tasks",
        href: "/issues",
      },
    [issueId, location.state, location.search],
  );

  const {
    data: rawChildIssuesData,
    isLoading: childIssuesLoading,
    isError: childIssuesError,
    refetch: refetchChildIssues,
  } = useQuery({
    queryKey:
      issue?.id && resolvedCompanyId
        ? queryKeys.issues.listByDescendantRoot(resolvedCompanyId, issue.id)
        : ["issues", "parent", "pending"],
    queryFn: () =>
      issuesApi.listAll(resolvedCompanyId!, {
        descendantOf: issue!.id,
        includeBlockedBy: true,
      }),
    enabled: !!resolvedCompanyId && !!issue?.id && !issue.id.startsWith("chat:"),
    placeholderData: keepPreviousDataForSameQueryTail<Issue[]>(
      issue?.id ?? "pending",
    ),
  });
  const rawChildIssues: Issue[] = rawChildIssuesData ?? EMPTY_ISSUES;
  const createdTasksQuery = useQuery({
    queryKey: queryKeys.issues.listCreatedFromIssue(
      resolvedCompanyId ?? "pending",
      issue?.id ?? "pending",
    ),
    queryFn: () => issuesApi.listAll(resolvedCompanyId!, {
      createdFromIssueId: issue!.id,
      includeRoutineExecutions: true,
    }),
    enabled: streamlinedTaskDetailEnabled && !!resolvedCompanyId && !!issue?.id && !issue.id.startsWith("chat:") && !tasksTab,
  });

  const {
    data: rawSiblingIssuesData,
    isLoading: siblingIssuesLoading,
    isError: siblingIssuesError,
  } = useQuery({
    queryKey:
      issue?.parentId && resolvedCompanyId
        ? queryKeys.issues.listByParent(resolvedCompanyId, issue.parentId)
        : ["issues", "siblings", "pending"],
    queryFn: () =>
      issuesApi.list(resolvedCompanyId!, {
        parentId: issue!.parentId!,
        includeBlockedBy: true,
      }),
    enabled: !!resolvedCompanyId && !!issue?.parentId,
  });
  const rawSiblingIssues: Issue[] = rawSiblingIssuesData ?? EMPTY_ISSUES;
  const companyLiveRunsQueryKey = resolvedCompanyId
    ? queryKeys.liveRuns(resolvedCompanyId)
    : (["live-runs", "pending"] as const);
  const sharedCompanyLiveRuns = useSharedPollingQuery<LiveRunForIssue[]>({
    companyId: resolvedCompanyId,
    resourceKey: "live-runs",
    queryKey: companyLiveRunsQueryKey,
    enabled: !!resolvedCompanyId,
    // Event-sourced via LiveUpdatesProvider (GitHub issue 9627); no interval poll needed.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: companyLiveRuns, dataUpdatedAt: companyLiveRunsUpdatedAt } =
    useQuery({
      queryKey: companyLiveRunsQueryKey,
      queryFn: () => heartbeatsApi.liveRunsForCompany(resolvedCompanyId!),
      enabled: sharedCompanyLiveRuns.enabled,
      refetchInterval: sharedCompanyLiveRuns.refetchInterval,
      placeholderData: keepPreviousDataForSameQueryTail<LiveRunForIssue[]>(
        resolvedCompanyId ?? "pending",
      ),
    });
  usePublishSharedQueryData(
    sharedCompanyLiveRuns,
    companyLiveRuns,
    companyLiveRunsUpdatedAt,
  );

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  // Bounded pool of recently-updated issues to back the `@task` reference picker.
  // The picker filters this list client-side by identifier/title.
  const { data: mentionIssues = [] } = useQuery({
    queryKey: resolvedCompanyId
      ? queryKeys.issues.mentionPool(resolvedCompanyId)
      : ["issues", "mention-pool", "pending"],
    queryFn: () =>
      issuesApi.list(resolvedCompanyId!, {
        limit: 100,
        sortField: "updated",
        sortDir: "desc",
      }),
    enabled: !!resolvedCompanyId,
    staleTime: 60_000,
    placeholderData: keepPreviousDataForSameQueryTail<Issue[]>(
      resolvedCompanyId ?? "pending",
    ),
  });

  const { data: session, isFetched: sessionResolved } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  useEffect(() => {
    if (!streamlinedUiEnabled || !issue || !sessionResolved) return;
    recordRecentTask(issue, currentUserId);
  }, [issue, currentUserId, sessionResolved, streamlinedUiEnabled]);
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: !!session?.user?.id,
    retry: false,
  });
  const canManageTreeControl = Boolean(
    selectedCompanyId && boardAccess?.companyIds?.includes(selectedCompanyId),
  );
  const canResolveBoardRecoveryAction = canBoardResolveRecoveryAction(
    selectedCompanyId,
    boardAccess,
  );
  // The break-glass override reconcile is `runtime:manage`-gated server-side, not gated on the
  // recovery-resolution permission — so hide its affordance behind the matching client check.
  const canManageBoardRuntime = canBoardManageRuntime(
    selectedCompanyId,
    boardAccess,
  );
  const { data: feedbackVotes } = useQuery({
    queryKey: queryKeys.issues.feedbackVotes(issueId!),
    queryFn: () => issuesApi.listFeedbackVotes(issueId!),
    enabled: !!issueId && !!currentUserId,
  });
  const { data: instanceGeneralSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    enabled: !!issueId,
    retry: false,
  });
  const { data: instanceExperimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: !!issueId,
    retry: false,
  });
  const keyboardShortcutsEnabled = useUserPreferences().data?.keyboardShortcuts === true;
  // Experimental Cases: linkify `PAP-C7` chips in this issue's comment bodies.
  const casesChipsEnabled = instanceExperimentalSettings?.enableCases === true;
  const feedbackDataSharingPreference =
    instanceGeneralSettings?.feedbackDataSharingPreference ?? "prompt";
  const showPlanDecompositionsSection =
    instanceExperimentalSettings?.enableIssuePlanDecompositions === true;
  const fileViewerEnabled =
    instanceExperimentalSettings?.enableExperimentalFileViewer === true;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const { slots: issuePluginDetailSlots } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "issue",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const issuePluginTabItems = useMemo(
    () =>
      issuePluginDetailSlots.map((slot) => ({
        value: `plugin:${slot.pluginKey}:${slot.id}`,
        label: slot.displayName,
        slot,
      })),
    [issuePluginDetailSlots],
  );
  const activePluginTab =
    issuePluginTabItems.find((item) => item.value === detailTab) ?? null;
  const {
    data: treeControlPreview,
    isFetching: treeControlPreviewLoading,
    error: treeControlPreviewError,
    refetch: refetchTreeControlPreview,
  } = useQuery({
    queryKey: [
      "issues",
      "tree-control-preview",
      issueId ?? "pending",
      treeControlMode,
    ],
    queryFn: () =>
      issuesApi.previewTreeControl(issueId!, {
        mode: treeControlMode,
        releasePolicy: {
          strategy: "manual",
        },
      }),
    enabled: treeControlOpen && !!issueId && canManageTreeControl,
    staleTime: 0,
    retry: false,
  });
  const { data: treeControlState, error: treeControlStateError } = useQuery({
    queryKey: ["issues", "tree-control-state", issueId ?? "pending"],
    queryFn: () => issuesApi.getTreeControlState(issueId!),
    enabled: !!issueId,
    retry: false,
  });
  const { data: activeRootPauseHolds = [] } = useQuery({
    queryKey: [
      "issues",
      "tree-holds",
      issueId ?? "pending",
      "active-pause-with-members",
    ],
    queryFn: () =>
      issuesApi.listTreeHolds(issueId!, {
        status: "active",
        mode: "pause",
        includeMembers: true,
      }),
    enabled: !!issueId && treeControlState?.activePauseHold?.isRoot === true,
  });
  const { data: activeCancelHolds = [] } = useQuery({
    queryKey: ["issues", "tree-holds", issueId ?? "pending", "active-cancel"],
    queryFn: () =>
      issuesApi.listTreeHolds(issueId!, {
        status: "active",
        mode: "cancel",
      }),
    enabled: !!issueId && canManageTreeControl,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      projects: orderedProjects,
      members: companyMembers?.users,
      issues: mentionIssues,
    });
  }, [agents, companyMembers?.users, orderedProjects, mentionIssues]);

  const resolvedProject = useMemo(
    () =>
      issue?.projectId
        ? (orderedProjects.find((project) => project.id === issue.projectId) ??
          issue.project ??
          null)
        : null,
    [issue?.project, issue?.projectId, orderedProjects],
  );
  const childIssues = useMemo(() => {
    const descendants = issue?.id
      ? filterIssueDescendants(issue.id, rawChildIssues)
      : rawChildIssues;
    return [...descendants].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [issue?.id, rawChildIssues]);
  const resolvedTasksTab = useMemo(() => {
    if (tasksTab) return tasksTab;
    if (!streamlinedTaskDetailEnabled) return undefined;
    const createdTasks = createdTasksQuery.data ?? EMPTY_ISSUES;
    const hasError = createdTasksQuery.isError || childIssuesError;
    return {
      count: new Set([...(issue?.ancestors ?? []), ...childIssues, ...createdTasks].map((task) => task.id)).size,
      hasError,
      content: (
        <TaskDetailTasksPanel
          ancestors={issue?.ancestors}
          issueLinkState={resolvedIssueDetailState ?? location.state}
          subtasks={childIssues}
          createdTasks={createdTasks}
          projects={projects ?? []}
          isLoading={createdTasksQuery.isLoading || childIssuesLoading}
          hasError={hasError}
          onRetry={() => {
            void createdTasksQuery.refetch();
            void refetchChildIssues();
          }}
        />
      ),
    };
  }, [
    tasksTab,
    issue?.ancestors,
    resolvedIssueDetailState,
    location.state,
    streamlinedTaskDetailEnabled,
    childIssues,
    childIssuesLoading,
    childIssuesError,
    refetchChildIssues,
    projects,
    createdTasksQuery.data,
    createdTasksQuery.isError,
    createdTasksQuery.isLoading,
    createdTasksQuery.refetch,
  ]);
  const liveIssueIds = useMemo(
    () =>
      collectLiveIssueIds(
        companyLiveRuns,
        issue ? [issue, ...childIssues] : childIssues,
      ),
    [childIssues, companyLiveRuns, issue],
  );
  const issuePanelKey = useMemo(
    () => buildIssuePropertiesPanelKey(issue ?? null, childIssues),
    [childIssues, issue],
  );
  const panelIssue = useMemo(() => issue ?? null, [issue?.id, issuePanelKey]);
  const panelChildIssues = useMemo(() => childIssues, [issuePanelKey]);
  // Planning tasks start as chat-only until a plan exists, then reveal the
  // sidebar already on the Plan tab. The onboarding first task keeps the same
  // behavior even if its work mode changes. We gate the panel *mount* (withhold
  // the panel content) rather than flipping the global `panelVisible` preference
  // — that preference persists to localStorage and would leak "hidden" into every
  // other task. The user can still opt in early via the "Show properties" header
  // button, which sets a per-issue override (keyed on the issue id so it resets
  // across navigations).
  const isOnboardingFirstTask =
    taskChatShellEnabled &&
    issue?.originKind === ONBOARDING_FIRST_TASK_ORIGIN_KIND;
  const shouldDeferPanelUntilPlan =
    taskChatShellEnabled &&
    (isOnboardingFirstTask || issue?.workMode === "planning");
  const { data: deferredPanelPlanDoc } = useIssuePlanDocument(
    shouldDeferPanelUntilPlan ? issue?.id : null,
  );
  const [panelBeforePlanOverrideIssueId, setPanelBeforePlanOverrideIssueId] =
    useState<string | null>(null);
  const panelBeforePlanOverride =
    panelBeforePlanOverrideIssueId !== null &&
    panelBeforePlanOverrideIssueId === issue?.id;
  const suppressPanelUntilPlan =
    shouldDeferPanelUntilPlan &&
    shouldSuppressTaskPanelUntilPlan({
      deferredPlanAvailable: Boolean(deferredPanelPlanDoc),
      panelBeforePlanOverride,
    });
  const openTaskSidePanel = useCallback(() => {
    if (suppressPanelUntilPlan && issue?.id) {
      setPanelBeforePlanOverrideIssueId(issue.id);
    }
    setPanelVisible(true);
  }, [issue?.id, setPanelVisible, suppressPanelUntilPlan]);
  const handleOpenSkill = useCallback((skillId: string, name: string) => {
    const next = openSkillPanelState(
      { panelBeforePlanOverrideIssueId },
      { id: skillId, name }, issue?.id ?? null, suppressPanelUntilPlan,
    );
    setOpenSkill(next.skill);
    setPanelBeforePlanOverrideIssueId(next.panelBeforePlanOverrideIssueId);
    setPanelVisible(true);
    if (isMobile) setMobilePropsOpen(true);
  }, [isMobile, issue?.id, panelBeforePlanOverrideIssueId, setPanelVisible, suppressPanelUntilPlan]);
  const revealNewArtifact = useCallback(() => {
    if (!issue?.id) return;
    setDocumentDeepLink(null);
    setArtifactsOpenRequest((previous) => ({
      issueId: issue.id,
      requestId: (previous?.requestId ?? 0) + 1,
    }));
    if (isMobile) setMobilePropsOpen(true);
    else openTaskSidePanel();
  }, [issue?.id, isMobile, openTaskSidePanel]);
  const handleArtifactsOpened = useCallback((requestId: number) => {
    setArtifactsOpenRequest((request) => request?.requestId === requestId
      ? { ...request, handled: true } : request);
  }, []);
  useTaskArtifactArrival({
    issueId: taskChatShellEnabled ? issue?.id : undefined,
    attachments,
    workProducts,
    documents: issue?.documentSummaries,
    onArrival: revealNewArtifact,
  });
  const toggleTaskSidePanel = useCallback(() => {
    if (!panelVisible || suppressPanelUntilPlan) {
      openTaskSidePanel();
      return;
    }
    setPanelVisible(false);
  }, [
    openTaskSidePanel,
    panelVisible,
    setPanelVisible,
    suppressPanelUntilPlan,
  ]);
  const showRichSubIssuesSection = shouldRenderRichSubIssuesSection(
    childIssuesLoading,
    childIssues.length,
  );
  const siblingNavigation = useMemo(
    () =>
      issue &&
      !childIssuesLoading &&
      !siblingIssuesLoading &&
      !siblingIssuesError
        ? buildIssueSiblingNavigation(issue, rawSiblingIssues, childIssues)
        : null,
    [
      childIssues,
      childIssuesLoading,
      issue,
      rawSiblingIssues,
      siblingIssuesError,
      siblingIssuesLoading,
    ],
  );
  const openNewSubIssue = useCallback(() => {
    if (!issue) return;
    openNewIssue(buildSubIssueDefaultsForViewer(issue, currentUserId));
  }, [currentUserId, issue, openNewIssue]);

  const commentReassignOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; searchText?: string }> =
      [];
    options.push(
      ...buildCompanyUserInlineOptions(companyMembers?.users, {
        excludeUserIds: [currentUserId],
      }),
    );
    const activeAgents = [...(agents ?? [])]
      .filter(isAgentTaskTarget)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    if (currentUserId) {
      options.push({ id: `user:${currentUserId}`, label: "Me" });
    }
    return options;
  }, [agents, companyMembers?.users, currentUserId]);

  const actualAssigneeValue = useMemo(
    () => assigneeValueFromSelection(issue ?? {}),
    [issue],
  );

  const suggestedAssigneeValue = useMemo(
    () =>
      suggestedCommentAssigneeValue(
        issue ?? {},
        mergeIssueComments(comments ?? [], optimisticComments),
        currentUserId,
      ),
    [issue, comments, optimisticComments, currentUserId],
  );

  const threadComments = useMemo(
    () =>
      mergeIssueComments(comments ?? [], optimisticComments).map((comment) => {
        if ("clientId" in comment && comment.clientId)
          commentRenderKeys.current.set(comment.id, comment.clientId);
        const clientId = commentRenderKeys.current.get(comment.id);
        return clientId ? { ...comment, clientId } : comment;
      }),
    [comments, optimisticComments],
  );
  const breadcrumbTitle = issue?.title ?? issueId ?? "Task";
  const breadcrumbIdentifier =
    issue?.identifier ?? issueHeaderSeed?.identifier ?? undefined;
  const breadcrumbStatus = issue?.status;
  const breadcrumbBlockerAttention = issue?.blockerAttention;
  // Stable identity for the breadcrumb status glyph. The glyph's shape/colour
  // depend on status (+ covered state), and its accessible label is derived
  // from the blocker counts — so the key signs over the full blockerAttention,
  // not just `state`, to avoid a stale label when counts change.
  const breadcrumbStatusKey = breadcrumbStatus
    ? `${breadcrumbStatus}|${issue?.externalConversationState ?? ""}|${JSON.stringify(breadcrumbBlockerAttention ?? null)}`
    : undefined;
  const breadcrumbStatusLeading = useMemo(
    () =>
      breadcrumbStatus ? (
        <StatusIcon
          status={breadcrumbStatus}
          externalConversationState={issue?.externalConversationState}
          className="size-3"
          blockerAttention={breadcrumbBlockerAttention}
        />
      ) : undefined,
    // `breadcrumbStatusKey` is a complete signature of the inputs below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [breadcrumbStatusKey],
  );
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

  const conversationAgent = conversation?.agent ?? agents?.find(agent => agent.id === issue?.conversationAgentId);
  useEffect(() => {
    if (conversationAgent) {
      setBreadcrumbs([{
        label: conversationAgent.name,
        leading: <Avatar className="size-6 shrink-0"><AvatarFallback>{deriveInitials(conversationAgent.name)}</AvatarFallback></Avatar>,
        leadingKey: `agent:${conversationAgent.id}`,
        trailing: <Button variant="ghost" size="icon-xs" asChild aria-label={`Configure ${conversationAgent.name}`}><Link to={agentDetailHref(conversationAgent.id, "runtime")}><ChatSettings /></Link></Button>,
        trailingKey: `configure:${conversationAgent.id}`,
      }]);
      return;
    }
    setBreadcrumbs([
      sourceBreadcrumb,
      {
        // The status glyph (leading) already conveys in-progress/live state;
        // no redundant 🔵 emoji prefix on the title.
        label: breadcrumbTitle,
        identifier: breadcrumbIdentifier,
        leading: breadcrumbStatusLeading,
        leadingKey: breadcrumbStatusKey,
      },
    ]);
  }, [
    conversationAgent,
    breadcrumbTitle,
    breadcrumbIdentifier,
    hasLiveRuns,
    setBreadcrumbs,
    sourceBreadcrumb.href,
    sourceBreadcrumb.label,
    breadcrumbStatusLeading,
    breadcrumbStatusKey,
  ]);

  useEffect(() => {
    if (!streamlinedTaskDetailEnabled || !taskChatShellEnabled || !issue?.id) {
      setBreadcrumbPanelControl(null);
      return;
    }

    setBreadcrumbPanelControl({
      open: panelVisible && !suppressPanelUntilPlan,
      onToggle: toggleTaskSidePanel,
    });

    return () => setBreadcrumbPanelControl(null);
  }, [
    issue?.id,
    panelVisible,
    setBreadcrumbPanelControl,
    streamlinedTaskDetailEnabled,
    suppressPanelUntilPlan,
    taskChatShellEnabled,
    toggleTaskSidePanel,
  ]);

  useEffect(() => {
    const showTaskPanelLauncher =
      taskChatShellEnabled &&
      !streamlinedTaskDetailEnabled &&
      !isMobile &&
      Boolean(issue?.id) &&
      (!panelVisible || suppressPanelUntilPlan);

    setBreadcrumbToolbar(
      showTaskPanelLauncher ? (
        <TooltipProvider>
          <SidePanelToggleButton
            open={false}
            onToggle={openTaskSidePanel}
            shortcut="]"
            className="shrink-0"
          />
        </TooltipProvider>
      ) : null,
    );

    return () => setBreadcrumbToolbar(null);
  }, [
    isMobile,
    issue?.id,
    openTaskSidePanel,
    panelVisible,
    setBreadcrumbToolbar,
    streamlinedTaskDetailEnabled,
    suppressPanelUntilPlan,
    taskChatShellEnabled,
  ]);

  const isFromInbox = resolvedIssueDetailState?.issueDetailSource === "inbox";

  // Scroll to top on forward navigation (PUSH/REPLACE) so issue doesn't
  // inherit the inbox/issues-list scroll position on mobile.
  useEffect(() => {
    const previousIssueId = lastScrollIssueIdRef.current;
    lastScrollIssueIdRef.current = issueId;
    if (
      !shouldScrollIssueDetailToTopOnNavigation({
        previousIssueId,
        nextIssueId: issueId,
        navigationType,
      })
    )
      return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const main = document.getElementById("main-content");
    if (main) main.scrollTop = 0;
  }, [issueId, navigationType]);

  // Resolve external UUID links and wrong-prefix task links from the loaded
  // task's company, not the organization that happened to be selected first.
  useEffect(() => {
    if (conversation || !loadedIssue) return;
    const nextState = resolvedIssueDetailState ?? location.state;
    const taskCompany = loadedIssueCompany;
    const canonicalRef = loadedIssue.identifier ?? loadedIssue.id;
    const companyMismatch =
      taskCompany && companyPrefix !== taskCompany.issuePrefix;
    const legacyQuery = hasLegacyIssueDetailQuery(location.search);
    if (issueId !== canonicalRef || companyMismatch || legacyQuery) {
      rememberIssueDetailLocationState(
        canonicalRef,
        nextState,
        location.search,
      );
      const taskPath = createIssueDetailPath(canonicalRef);
      navigate(
        {
          pathname: taskCompany
            ? `/${taskCompany.issuePrefix}${taskPath}`
            : taskPath,
          search: legacyQuery ? "" : location.search,
          hash: location.hash,
        },
        {
          replace: true,
          state: nextState,
        },
      );
    }
  }, [
    conversation,
    loadedIssue,
    loadedIssueCompany,
    companyPrefix,
    issueId,
    navigate,
    location.state,
    location.search,
    location.hash,
    resolvedIssueDetailState,
  ]);

  useEffect(() => {
    if (!issueId || !issue?.id) return;
    if (lastMarkedReadIssueIdRef.current === issue.id) return;
    lastMarkedReadIssueIdRef.current = issue.id;
    markIssueRead.mutate(issue.id);
  }, [issue?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const mediaGalleryItems = useMemo<GalleryMediaItem[]>(() => {
    const items: GalleryMediaItem[] = [];
    const seen = new Set<string>();

    const mark = (
      attachmentId: string | null | undefined,
      contentPath: string,
    ) => {
      if (attachmentId) seen.add(`attachment:${attachmentId}`);
      seen.add(`content:${contentPath}`);
    };

    const hasSeen = (
      attachmentId: string | null | undefined,
      contentPath: string,
    ) =>
      Boolean(attachmentId && seen.has(`attachment:${attachmentId}`)) ||
      seen.has(`content:${contentPath}`);

    for (const attachment of attachments ?? []) {
      if (!isImageAttachment(attachment) && !isVideoAttachment(attachment))
        continue;
      items.push(attachment);
      mark(attachment.id, attachment.contentPath);
    }

    for (const item of getIssueOutputs(workProducts).items) {
      const meta = item.metadata;
      if (!meta) continue;
      const isMedia =
        isImageLikeOutput(meta.contentType, meta.originalFilename ?? item.title) ||
        isVideoLikeOutput(meta.contentType, meta.originalFilename);
      if (!isMedia || hasSeen(meta.attachmentId, meta.contentPath)) continue;
      items.push({
        id: `work-product-${item.id}`,
        contentPath: meta.contentPath,
        openPath: meta.openPath,
        downloadPath: meta.downloadPath,
        contentType: meta.contentType,
        originalFilename: meta.originalFilename ?? item.title,
      });
      mark(meta.attachmentId, meta.contentPath);
    }

    return items;
  }, [attachments, workProducts]);

  const openIssueGallery = useCallback(
    (src: string) => {
      // Match content and preview URLs in either relative or absolute form.
      const absoluteUrl = (path: string) => {
        try {
          return new URL(path, window.location.origin).href;
        } catch {
          return path;
        }
      };
      const requestedUrl = absoluteUrl(src);
      let idx = mediaGalleryItems.findIndex(
        (a) =>
          absoluteUrl(a.contentPath) === requestedUrl ||
          (a.openPath && absoluteUrl(a.openPath) === requestedUrl),
      );
      if (idx < 0) {
        // Try matching by asset ID extracted from /api/assets/{assetId}/content URLs
        const assetMatch = src.match(/\/api\/assets\/([^/]+)\/content/);
        if (assetMatch) {
          idx = mediaGalleryItems.findIndex(
            (a) => "assetId" in a && a.assetId === assetMatch[1],
          );
        }
      }
      if (idx >= 0) {
        setGalleryIndex(idx);
        setGalleryOpen(true);
        return true;
      }
      return false;
    },
    [mediaGalleryItems],
  );

  const handleChatImageClick = useCallback(
    (src: string) => {
      if (!openIssueGallery(src)) window.open(src, "_blank");
    },
    [openIssueGallery],
  );

  useLayoutEffect(() => {
    if (!panelIssue || suppressPanelUntilPlan || (conversation && !conversation.issue)) {
      closePanel();
      return;
    }
    const sharedProps = {
      issue: panelIssue,
      childIssues: panelChildIssues,
      issueLinkState: streamlinedTaskDetailEnabled
        ? relationIssueLinkState
        : undefined,
      onAddSubIssue: openNewSubIssue,
      onUpdate: handleIssuePropertiesUpdate,
      hasActiveRun: resolvedHasActiveRun,
      externalObjects: externalObjectsState.isEnabled
        ? externalObjectsState.groups
        : undefined,
      externalObjectsLoading: externalObjectsState.isEnabled
        ? externalObjectsState.isLoading
        : undefined,
      externalObjectsError: externalObjectsState.isEnabled
        ? externalObjectsState.isError
        : undefined,
      onRetryExternalObjects: externalObjectsState.isEnabled
        ? externalObjectsState.refetch
        : undefined,
      onCheckMonitorNow: () => checkIssueMonitorNow.mutate(),
      checkingMonitorNow: checkIssueMonitorNow.isPending,
      documentDeepLink:
        documentDeepLink?.issueId === panelIssue.id ? documentDeepLink : null,
      openSkillId: openSkill?.id ?? null,
      openSkillName: openSkill?.name ?? null,
      onSkillOpened: handleSkillOpened,
    };
    if (taskChatShellEnabled) {
      openPanel(
        <IssueGalleryContext.Provider value={openIssueGallery}>
          <TaskSidePanel
            key={panelIssue.id}
            {...sharedProps}
            accountScope={currentUserId ?? "anonymous"}
            fileTabsEnabled={fileViewerEnabled}
            streamlinedTabs={streamlinedTaskDetailEnabled}
            showSubtasksTab={streamlinedTaskDetailEnabled}
            tasksTab={resolvedTasksTab}
            artifactsOpenRequestId={!isMobile && !artifactsOpenRequest?.handled && artifactsOpenRequest?.issueId === panelIssue.id
              ? artifactsOpenRequest.requestId : undefined}
            onArtifactsOpened={handleArtifactsOpened}
          />
        </IssueGalleryContext.Provider>,
        { contentMode: "full-bleed" },
      );
    } else {
      openPanel(
        <IssueGalleryContext.Provider value={openIssueGallery}>
          <IssueProperties {...sharedProps} />
        </IssueGalleryContext.Provider>,
      );
    }
    return () => closePanel();
  }, [
    closePanel,
    openIssueGallery,
    handleIssuePropertiesUpdate,
    issuePanelKey,
    openNewSubIssue,
    openPanel,
    openSkill,
    handleSkillOpened,
    panelChildIssues,
    panelIssue,
    suppressPanelUntilPlan,
    relationIssueLinkState,
    streamlinedTaskDetailEnabled,
    resolvedHasActiveRun,
    checkIssueMonitorNow.isPending,
    checkIssueMonitorNow.mutate,
    externalObjectsState.isEnabled,
    externalObjectsState.groups,
    externalObjectsState.isLoading,
    externalObjectsState.isError,
    externalObjectsState.refetch,
    documentDeepLink,
    taskChatShellEnabled,
    currentUserId,
    fileViewerEnabled,
    resolvedTasksTab,
    artifactsOpenRequest,
    handleArtifactsOpened,
    isMobile,
  ]);

  const goToInboxShortcutArmedRef = useRef(false);
  const goToInboxShortcutTimeoutRef = useRef<number | null>(null);
  const canQuickArchiveFromInbox =
    keyboardShortcutsEnabled && !issue?.hiddenAt;

  useEffect(() => {
    if (!issue?.id || !canQuickArchiveFromInbox) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveInboxQuickArchiveKeyAction({
        armed: canQuickArchiveFromInbox,
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });

      if (action !== "archive") return;

      event.preventDefault();
      if (!archiveFromInbox.isPending) {
        archiveFromInbox.mutate(issue.id);
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [archiveFromInbox, canQuickArchiveFromInbox, issue?.id]);

  useEffect(() => {
    if (!keyboardShortcutsEnabled) {
      goToInboxShortcutArmedRef.current = false;
      if (goToInboxShortcutTimeoutRef.current !== null) {
        window.clearTimeout(goToInboxShortcutTimeoutRef.current);
        goToInboxShortcutTimeoutRef.current = null;
      }
      return;
    }

    const clearArmTimeout = () => {
      if (goToInboxShortcutTimeoutRef.current !== null) {
        window.clearTimeout(goToInboxShortcutTimeoutRef.current);
        goToInboxShortcutTimeoutRef.current = null;
      }
    };

    const disarm = () => {
      goToInboxShortcutArmedRef.current = false;
      clearArmTimeout();
    };

    const arm = () => {
      goToInboxShortcutArmedRef.current = true;
      clearArmTimeout();
      goToInboxShortcutTimeoutRef.current = window.setTimeout(() => {
        goToInboxShortcutArmedRef.current = false;
        goToInboxShortcutTimeoutRef.current = null;
      }, 1200);
    };

    const handlePointerDown = () => {
      disarm();
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target !== document.body
      ) {
        disarm();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = resolveIssueDetailGoKeyAction({
        armed: goToInboxShortcutArmedRef.current,
        defaultPrevented: event.defaultPrevented,
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target,
        hasOpenDialog: hasBlockingShortcutDialog(document),
      });

      if (action === "ignore") return;
      if (action === "arm") {
        arm();
        return;
      }

      disarm();
      if (action === "navigate_inbox") {
        event.preventDefault();
        event.stopPropagation();
        navigate(
          sourceBreadcrumb.href.startsWith("/inbox")
            ? sourceBreadcrumb.href
            : "/inbox",
        );
        return;
      }
      if (action === "focus_comment") {
        event.preventDefault();
        event.stopPropagation();
        setDetailTab("chat");
        setPendingCommentComposerFocusKey((current) => current + 1);
      }
      if (action === "open_file_viewer") {
        if (!fileViewerEnabled) return;
        event.preventDefault();
        event.stopPropagation();
        setFileViewerPromptOpen(true);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      disarm();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [
    fileViewerEnabled,
    keyboardShortcutsEnabled,
    navigate,
    sourceBreadcrumb.href,
  ]);

  // One maximize request per issue + `viewer=full` hash: routing re-runs
  // whenever a callback dependency changes identity, and re-requesting then
  // would re-maximize a pane the user deliberately restored. The key carries
  // the issue param so navigating to another issue with an identical hash
  // still maximizes the destination pane.
  const lastMaximizeRequestKeyRef = useRef<string | null>(null);
  const routeIssueDocumentDeepLink = useCallback(
    (hash: string) => {
      const route = resolveIssueDocumentDeepLink(hash);
      if (!route) return false;

      if (route.kind === "continuation-summary") {
        setDocumentDeepLink(null);
        setDetailTab("activity");
        setHandoffFocusSignal((current) => current + 1);
        return true;
      }

      // The classic interface owns document links in its center-column
      // Documents section. Do not open its tab-less properties panel.
      if (!taskInterfaceSettingsLoaded || !taskChatShellEnabled) return false;

      if (isMobile) {
        setMobilePropsOpen(true);
      } else {
        if (suppressPanelUntilPlan && issue?.id) {
          setPanelBeforePlanOverrideIssueId(issue.id);
        }
        setPanelVisible(true);
        // `viewer=full` (LOOA-2181): external links (Slack approval cards)
        // land with the pane maximized. Mobile uses the sheet, which is
        // already full-screen, so the request is desktop-only.
        if (route.maximize) {
          const requestKey = `${issueId ?? ""}::${hash}`;
          if (lastMaximizeRequestKeyRef.current !== requestKey) {
            lastMaximizeRequestKeyRef.current = requestKey;
            requestPanelMaximize();
          }
        }
      }
      const targetIssueId = issue?.id ?? issueId ?? "";
      setDocumentDeepLink((current) => ({
        issueId: targetIssueId,
        tab: route.tab,
        documentKey: route.documentKey,
        requestId:
          current?.issueId === targetIssueId ? current.requestId + 1 : 1,
      }));
      return true;
    },
    [
      taskInterfaceSettingsLoaded,
      isMobile,
      issue?.id,
      issueId,
      setPanelVisible,
      requestPanelMaximize,
      suppressPanelUntilPlan,
      taskChatShellEnabled,
    ],
  );

  useEffect(() => {
    if (!routeIssueDocumentDeepLink(location.hash)) {
      setDocumentDeepLink(null);
      // The deep link ended (hash cleared or issue changed): drop any
      // maximize request the panel never consumed so it cannot maximize a
      // later, unrelated panel, and re-arm for the next viewer=full hash.
      lastMaximizeRequestKeyRef.current = null;
      clearPanelMaximizeRequest();
    }
  }, [
    issueId,
    location.hash,
    routeIssueDocumentDeepLink,
    clearPanelMaximizeRequest,
  ]);

  // Leaving the issue page entirely also ends the deep link's lifetime.
  useEffect(
    () => () => {
      clearPanelMaximizeRequest();
    },
    [clearPanelMaximizeRequest],
  );

  // React Router does not emit a location update when the user clicks a link
  // whose hash is already current. Capture that repeated intent so a manually
  // collapsed document reopens and scrolls back into view.
  useEffect(() => {
    const handleSameHashDocumentClick = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const rawHref = anchor.getAttribute("href");
      if (!rawHref) return;

      let targetUrl: URL;
      try {
        targetUrl = new URL(rawHref, window.location.href);
      } catch {
        return;
      }
      const sameIssue =
        rawHref.startsWith("#") ||
        (targetUrl.pathname === location.pathname &&
          targetUrl.search === location.search);
      if (!sameIssue || targetUrl.hash !== location.hash) return;
      routeIssueDocumentDeepLink(targetUrl.hash);
    };

    document.addEventListener("click", handleSameHashDocumentClick, true);
    return () =>
      document.removeEventListener("click", handleSameHashDocumentClick, true);
  }, [
    location.hash,
    location.pathname,
    location.search,
    routeIssueDocumentDeepLink,
  ]);

  // Scroll + briefly highlight work-product / direct-attachment anchors so the
  // company Artifacts page (PAP-10359) can deep-link to a specific artifact in
  // its issue context. Retries while the section data loads in.
  useEffect(() => {
    const match = location.hash.match(/^#(work-product|attachment)-(.+)$/);
    if (!match) return;
    const targetId = `${match[1]}-${decodeURIComponent(match[2]!)}`;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryScroll = () => {
      if (cancelled) return;
      const element = document.getElementById(targetId);
      if (!element) {
        if (attempts < 30) {
          attempts += 1;
          timer = setTimeout(tryScroll, 100);
        }
        return;
      }
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.classList.add("ring-2", "ring-primary/50", "transition-shadow");
      timer = setTimeout(
        () =>
          element.classList.remove(
            "ring-2",
            "ring-primary/50",
            "transition-shadow",
          ),
        3000,
      );
    };
    tryScroll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [location.hash, workProducts, attachments]);

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
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
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
    <div
      data-testid="issue-detail-header"
      className={cn(
        streamlinedTaskDetailEnabled ? "relative space-y-2" : "space-y-3",
        shellSectionClass,
      )}
    >
      {streamlinedTaskDetailEnabled ? (
        <div className="flex min-w-0 items-start gap-2 md:items-center md:pr-8">
          <div className="hidden md:block">{issueStatusControl}</div>
          <div
            data-slot="task-detail-title"
            className="flex min-w-0 flex-1 items-baseline gap-2"
          >
            <InlineEditor
              value={issue.title}
              onSave={(title) => updateIssue.mutateAsync({ title })}
              as="h2"
              className="min-w-0 text-xl font-semibold leading-normal text-balance"
            />
            <span
              data-slot="task-title-identifier"
              className="hidden shrink-0 font-mono text-sm text-muted-foreground md:inline"
            >
              {issue.identifier ?? issue.id.slice(0, 8)}
            </span>
          </div>
        </div>
      ) : null}

      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-2",
          streamlinedTaskDetailEnabled && "gap-x-3 gap-y-2 md:gap-x-6 md:pl-7",
        )}
      >
        {streamlinedTaskDetailEnabled ? (
          <div className="md:hidden">{issueStatusControl}</div>
        ) : null}
        {streamlinedTaskDetailEnabled ? (
          <span className="shrink-0 font-mono text-sm text-muted-foreground md:hidden">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
        ) : null}
        {!streamlinedTaskDetailEnabled ? issueStatusControl : null}
        {/* PAP-411: priority UI hidden behind SHOW_TASK_PRIORITY_UI. */}
        {SHOW_TASK_PRIORITY_UI && (
          <PriorityIcon
            priority={issue.priority}
            onChange={(priority) => updateIssue.mutate({ priority })}
          />
        )}
        {!streamlinedTaskDetailEnabled ? (
          <span className="shrink-0 font-mono text-sm text-muted-foreground">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
        ) : null}
        {hasLiveRuns && (
          <Badge
            variant="outline"
            className={cn("gap-1.5 text-(length:--text-nano)", liveBlueBadge)}
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
            </span>
            Live
          </Badge>
        )}

        {issue.originKind === "routine_execution" && issue.originId && (
          <Link
            to={`/routines/${issue.originId}`}
            className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-(length:--text-nano) font-medium text-violet-600 dark:text-violet-400 shrink-0 hover:bg-violet-500/20 transition-colors"
            title={`Routine execution from routine ${issue.originId}`}
          >
            <Repeat className="h-3 w-3" />
            Routine
          </Link>
        )}

        {issue.originKind === "task_watchdog" ? (
          <Badge
            variant="outline"
            className="border-sky-500/40 bg-sky-500/10 text-(length:--text-nano) text-sky-700 dark:text-sky-300"
            title="This task is a generated watchdog task. It verifies whether stopped work in the watched task tree is legitimate."
          >
            <ScanEye className="h-3 w-3" />
            Watchdog
          </Badge>
        ) : null}

        {/* Task Chat Redesign: no mode chip in the header — mode is a
              per-request choice made in the composer, and each agent reply
              carries its own mode chip; a header chip would misread as a
              task-global setting. Flag OFF keeps the legacy badge. */}
        {!taskChatShellEnabled &&
        (issue.workMode === "ask" || issue.workMode === "planning")
          ? (() => {
              const workModeMeta = workModeMetaFor(issue.workMode);
              const WorkModeIcon = workModeMeta.icon;
              return (
                <Badge
                  variant="outline"
                  className={cn(
                    "text-(length:--text-nano)",
                    workModeMeta.classes.badge,
                  )}
                  title={`This task is in ${workModeMeta.label.toLowerCase()}.`}
                >
                  <WorkModeIcon className="h-3 w-3" aria-hidden />
                  {workModeMeta.label}
                </Badge>
              );
            })()
          : null}

        {hasAssignedBacklogBlocker(issue.blockedBy) ? (
          <Badge
            variant="outline"
            data-testid="issue-detail-parked-blocker"
            className="border-amber-500/60 bg-amber-500/15 text-(length:--text-nano) text-amber-700 dark:text-amber-300"
            title="Blocked by parked work: at least one assigned blocker is in the backlog and will not wake its assignee."
          >
            <Flag className="h-3 w-3" />
            Blocked by parked work
          </Badge>
        ) : null}

        {/* Project reads as a tile plus a name, matching the project rows in
              the sidebar and the Projects list rather than a bare outline
              glyph. The tile stays neutral here on purpose: the eyebrow already
              carries the status glyph's colour, and a second tinted swatch
              beside it competes with the one signal that means something.
              Project colour still identifies the project on project-native
              surfaces. */}
        {issue.projectId ? (
          <Link
            to={`/projects/${issue.projectId}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
          >
            <ProjectTile
              size="xs"
              icon={resolvedProject?.icon ?? issue.project?.icon}
            />
            <span className="truncate">
              {resolvedProject?.name ??
                issue.project?.name ??
                issue.projectId.slice(0, 8)}
            </span>
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-subtle-foreground px-1 -mx-1 py-0.5">
            <ProjectTile size="xs" />
            No project
          </span>
        )}

        <IssueAttributionByline
          issue={issue}
          agentMap={agentMap}
          userProfileMap={userProfileMap}
          userLabelMap={userLabelMap}
        />

        {!streamlinedTaskDetailEnabled && (issue.labels ?? []).length > 0 && (
          <div className="hidden sm:flex items-center gap-1">
            {(issue.labels ?? []).slice(0, 4).map((label) => (
              <Badge
                variant="outline"
                key={label.id}
                className="text-(length:--text-nano)"
                style={{
                  borderColor: label.color,
                  color: pickTextColorForPillBg(label.color, 0.12),
                  backgroundColor: `${label.color}1f`,
                }}
              >
                {label.name}
              </Badge>
            ))}
            {(issue.labels ?? []).length > 4 && (
              <span className="text-(length:--text-nano) text-muted-foreground">
                +{(issue.labels ?? []).length - 4}
              </span>
            )}
          </div>
        )}

        {!streamlinedTaskDetailEnabled && !(isMobile && isFromInbox) && (
          <div className="ml-auto flex items-center gap-0.5 md:hidden shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy task as markdown"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setMobilePropsOpen(true)}
              title="Properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>
        )}

        <div className="hidden md:flex items-center md:ml-auto shrink-0">
          {!streamlinedTaskDetailEnabled && canArchiveFromInbox && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                if (!archivePending && issue?.id)
                  archiveFromInbox.mutate(issue.id);
              }}
              disabled={archivePending}
              title="Archive from inbox"
              aria-label="Archive from inbox"
            >
              <Archive className="h-4 w-4" />
            </Button>
          )}
          {!issue.tabledAt && !isTerminalIssue ? (
            <NotNowButton
              companyId={issue.companyId}
              issueId={issue.id}
              issueLabel={issue.identifier}
            />
          ) : null}
          {fileViewerEnabled ? (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setFileViewerPromptOpen(true)}
              title="Open file... (g f)"
              aria-label="Open file in this issue"
            >
              <FileCode2 className="h-4 w-4" />
            </Button>
          ) : null}
          {!streamlinedTaskDetailEnabled ? (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy task as markdown"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          ) : null}
          {!streamlinedTaskDetailEnabled &&
          !taskChatShellEnabled &&
          (!panelVisible || suppressPanelUntilPlan) ? (
            <TooltipProvider>
              <SidePanelToggleButton
                open={false}
                onToggle={openTaskSidePanel}
                shortcut="]"
                className="shrink-0"
              />
            </TooltipProvider>
          ) : null}
          <div
            data-slot="task-title-actions"
            className={cn(
              streamlinedTaskDetailEnabled &&
                "absolute right-0 top-0 flex h-7 items-center",
            )}
          >
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  aria-label="More task actions"
                  title="More task actions"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setMoreOpen(true);
                    }
                  }}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-52 p-1" align="end">
                {streamlinedTaskDetailEnabled ? (
                  <>
                    <button
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50"
                      onClick={() => {
                        openNewSubIssue();
                        setMoreOpen(false);
                      }}
                    >
                      <Plus className="h-3 w-3" />
                      Add subtask
                    </button>
                    <button
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50"
                      onClick={() => {
                        void copyIssueToClipboard();
                        setMoreOpen(false);
                      }}
                    >
                      {copied ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      Copy as markdown
                    </button>
                    {canArchiveFromInbox ? (
                      <button
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50 disabled:opacity-50"
                        disabled={archivePending}
                        onClick={() => {
                          if (!archivePending && issue?.id)
                            archiveFromInbox.mutate(issue.id);
                          setMoreOpen(false);
                        }}
                      >
                        <Archive className="h-3 w-3" />
                        Archive from inbox
                      </button>
                    ) : null}
                  </>
                ) : null}
                <TaskTreeControlMenuItems
                  scope={treeControlScope}
                  canPause={
                    canPauseLeafWork ||
                    (canShowSubtreeControls &&
                      !activePauseHold &&
                      !isTerminalIssue)
                  }
                  canResume={canResumeLeafWork || canResumeSubtree}
                  canCancel={canShowSubtreeControls}
                  canRestore={canRestoreSubtree}
                  pending={executeTreeControl.isPending}
                  onPause={() => {
                    executeTreeControl.mutate({
                      mode: "pause",
                      scope: treeControlScope,
                    });
                    setMoreOpen(false);
                  }}
                  onResume={() => {
                    executeTreeControl.reset();
                    setTreeControlMode("resume");
                    setTreeControlWakeAgentsOnResume(
                      isAgentOwnedNonTerminalIssue || canShowSubtreeControls,
                    );
                    setTreeControlOpen(true);
                    setMoreOpen(false);
                  }}
                  onCancel={() => {
                    executeTreeControl.reset();
                    setTreeControlMode("cancel");
                    setTreeControlOpen(true);
                    setMoreOpen(false);
                  }}
                  onRestore={() => {
                    executeTreeControl.reset();
                    setTreeControlMode("restore");
                    setTreeControlWakeAgentsOnResume(false);
                    setTreeControlOpen(true);
                    setMoreOpen(false);
                  }}
                />
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                  onClick={() => {
                    updateIssue.mutate(
                      { hiddenAt: new Date().toISOString() },
                      { onSuccess: () => navigate("/issues/all") },
                    );
                    setMoreOpen(false);
                  }}
                >
                  <EyeOff className="h-3 w-3" />
                  Hide this task
                </button>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      {!streamlinedTaskDetailEnabled ? (
        <InlineEditor
          value={issue.title}
          onSave={(title) => updateIssue.mutateAsync({ title })}
          as="h2"
          className={
            taskChatShellEnabled
              ? "text-base font-semibold"
              : "text-xl font-bold"
          }
        />
      ) : null}

      {taskChatShellEnabled && !streamlinedTaskDetailEnabled
        ? subTasksTree
        : null}

      <TabledBanner issue={issue} />

      {/* On the chat tab the strip above the composer carries the monitor's
          state and Check now; the other tabs have no composer, so they keep
          this banner. */}
      {resolvedDetailTab === "chat" ? null : (
        <IssueMonitorBanner
          issue={issue}
          onCheckNow={() => checkIssueMonitorNow.mutate()}
          checkingNow={checkIssueMonitorNow.isPending}
        />
      )}

      {taskChatShellEnabled ? null : (
        <InlineEditor
          value={issue.description ?? ""}
          onSave={(description) => updateIssue.mutateAsync({ description })}
          as="p"
          className="text-sm leading-7 text-foreground"
          placeholder="Add a description..."
          multiline
          foldable
          mentions={mentionOptions}
          externalReferences={
            externalObjectsState.isEnabled
              ? externalObjectsState.markdownReferences
              : undefined
          }
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
          onDropFile={async (file) => {
            await uploadAttachment.mutateAsync(file);
          }}
        />
      )}
    </div>
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

          {taskChatShellEnabled ? null : showRichSubIssuesSection ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-muted-foreground">
                  Sub-tasks
                </h3>
              </div>
              <IssuesList
                issues={childIssues}
                isLoading={childIssuesLoading}
                agents={agents}
                projects={projects}
                liveIssueIds={liveIssueIds}
                mutedIssueIds={mutedChildIssueIds}
                issueBadgeById={childPauseBadgeById}
                projectId={issue.projectId ?? undefined}
                viewStateKey={`paperclip:issue-detail:${issue.id}:subissues-view`}
                issueLinkState={resolvedIssueDetailState ?? location.state}
                searchFilters={{
                  descendantOf: issue.id,
                  includeBlockedBy: true,
                }}
                searchWithinLoadedIssues
                baseCreateIssueDefaults={buildSubIssueDefaultsForViewer(
                  issue,
                  currentUserId,
                )}
                createIssueLabel="Sub-task"
                defaultSortField="workflow"
                showProgressSummary
                parentIssueIdForCostSummary={issue.id}
                onUpdateIssue={handleChildIssueUpdate}
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
              <Button
                variant="outline"
                size="sm"
                onClick={openNewSubIssue}
                className="shrink-0 shadow-none"
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New Sub-task
              </Button>
            </div>
          )}

          {!taskChatShellEnabled && showPlanDecompositionsSection ? (
            <IssuePlanDecompositionsSection
              issueId={issue.id}
              issueIdentifier={issue.identifier}
              agentMap={agentMap}
            />
          ) : null}

          {/* Flag ON: attachments/work products/workspace live in the properties
          pane (Artifacts tab) — the center column belongs to the thread. */}
          {taskChatShellEnabled ? null : (
            <IssueDocumentsSection
              issue={issue}
              canDeleteDocuments={Boolean(session?.user?.id)}
              canManageDocumentLocks={Boolean(session?.user?.id)}
              feedbackVotes={feedbackVotes}
              feedbackDataSharingPreference={feedbackDataSharingPreference}
              feedbackTermsUrl={FEEDBACK_TERMS_URL}
              mentions={mentionOptions}
              externalReferences={
                externalObjectsState.isEnabled
                  ? externalObjectsState.markdownReferences
                  : undefined
              }
              imageUploadHandler={async (file) => {
                const attachment = await uploadAttachment.mutateAsync(file);
                return attachment.contentPath;
              }}
              onVote={async (revisionId, vote, options) => {
                await feedbackVoteMutation.mutateAsync({
                  targetType: "issue_document_revision",
                  targetId: revisionId,
                  vote,
                  reason: options?.reason,
                  allowSharing: options?.allowSharing,
                  sharingPreferenceAtSubmit: feedbackDataSharingPreference,
                });
              }}
              extraActions={!hasAttachments ? attachmentUploadButton : null}
              agentMap={agentMap}
              userProfileMap={userProfileMap}
            />
          )}

          {taskChatShellEnabled ? null : (
            <IssueOutputSection
              workProducts={workProducts}
              onMediaClick={(item) => {
                const meta = item.metadata;
                if (!meta) return;
                const idx = mediaGalleryItems.findIndex(
                  (galleryItem) =>
                    galleryItem.contentPath === meta.contentPath ||
                    galleryItem.id === `work-product-${item.id}` ||
                    galleryItem.id === meta.attachmentId,
                );
                setGalleryIndex(idx >= 0 ? idx : 0);
                setGalleryOpen(true);
              }}
            />
          )}

          {taskChatShellEnabled ? null : attachmentsInitialLoading ? (
            <IssueSectionSkeleton titleWidth="w-24" rows={2} />
          ) : hasAttachments ? (
            <IssueAttachmentsSection
              attachments={attachmentList}
              uploadButton={attachmentUploadButton}
              error={attachmentError}
              dragActive={attachmentDragActive}
              deletePending={deleteAttachment.isPending}
              onDelete={(attachmentId) => deleteAttachment.mutate(attachmentId)}
              onImageClick={(attachment) => {
                const idx = mediaGalleryItems.findIndex(
                  (a) => a.id === attachment.id,
                );
                setGalleryIndex(idx >= 0 ? idx : 0);
                setGalleryOpen(true);
              }}
              onDragEnter={(evt) => {
                evt.preventDefault();
                setAttachmentDragActive(true);
              }}
              onDragOver={(evt) => {
                evt.preventDefault();
                setAttachmentDragActive(true);
              }}
              onDragLeave={(evt) => {
                if (
                  evt.currentTarget.contains(evt.relatedTarget as Node | null)
                )
                  return;
                setAttachmentDragActive(false);
              }}
              onDrop={(evt) => void handleAttachmentDrop(evt)}
            />
          ) : null}

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
                  composerDisabledReason={issue.conversationAgentId && !instanceExperimentalSettings?.enableAgentChat ? "Agent Chat is disabled in Experimental settings." : treeControlStateError ? "Couldn’t check whether this task is paused. Refresh to try again." : null}
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
                  onWorkModeChange={(nextMode) => {
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
          <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
            <SheetContent
              side={
                taskChatShellEnabled
                  ? "bottom"
                  : documentDeepLink?.documentKey === "plan"
                    ? "right"
                    : "bottom"
              }
              showCloseButton={!taskChatShellEnabled}
              className={cn(
                taskChatShellEnabled
                  ? "h-(--sz-85dvh) max-h-(--sz-85dvh) w-full max-w-none gap-0 p-0 pb-(--sz-safe-bottom)"
                  : documentDeepLink?.documentKey === "plan"
                    ? "inset-0 h-dvh w-screen max-w-none gap-0 border-0 p-0 sm:max-w-none"
                    : "max-h-(--sz-85dvh) pb-(--sz-safe-bottom)",
              )}
              data-testid={
                taskChatShellEnabled
                  ? "mobile-task-side-panel"
                  : documentDeepLink?.documentKey === "plan"
                    ? "mobile-plan-panel"
                    : undefined
              }
            >
              {taskChatShellEnabled ? (
                <>
                  <SheetHeader className="sr-only">
                    <SheetTitle>Task side panel</SheetTitle>
                  </SheetHeader>
                  <TaskSidePanel
                    key={`${issue.id}:mobile`}
                    issue={issue}
                    accountScope={currentUserId ?? "anonymous"}
                    childIssues={childIssues}
                    issueLinkState={
                      streamlinedTaskDetailEnabled
                        ? relationIssueLinkState
                        : undefined
                    }
                    onAddSubIssue={openNewSubIssue}
                    onUpdate={(data) => updateIssue.mutate(data)}
                    inline
                    hasActiveRun={resolvedHasActiveRun}
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
                    onCheckMonitorNow={() => checkIssueMonitorNow.mutate()}
                    checkingMonitorNow={checkIssueMonitorNow.isPending}
                    fileTabsEnabled={fileViewerEnabled}
                    streamlinedTabs={streamlinedTaskDetailEnabled}
                    showSubtasksTab={streamlinedTaskDetailEnabled}
                    tasksTab={resolvedTasksTab}
                    artifactsOpenRequestId={isMobile && !artifactsOpenRequest?.handled && artifactsOpenRequest?.issueId === issue.id
                      ? artifactsOpenRequest.requestId : undefined}
                    onArtifactsOpened={handleArtifactsOpened}
                    openSkillId={openSkill?.id ?? null}
                    openSkillName={openSkill?.name ?? null}
                    onSkillOpened={handleSkillOpened}
                    documentDeepLink={
                      documentDeepLink?.issueId === issue.id
                        ? documentDeepLink
                        : null
                    }
                    onRequestClose={() => setMobilePropsOpen(false)}
                  />
                </>
              ) : (
                <>
                  <SheetHeader>
                    <SheetTitle className="text-sm">
                      {documentDeepLink?.documentKey === "plan"
                        ? "Plan"
                        : "Properties"}
                    </SheetTitle>
                  </SheetHeader>
                  <ScrollArea className="flex-1 overflow-y-auto">
                    <div className="px-4 pb-4">
                      <IssueProperties
                        issue={issue}
                        childIssues={childIssues}
                        issueLinkState={
                          streamlinedTaskDetailEnabled
                            ? relationIssueLinkState
                            : undefined
                        }
                        onAddSubIssue={openNewSubIssue}
                        onUpdate={(data) => updateIssue.mutate(data)}
                        inline
                        hasActiveRun={resolvedHasActiveRun}
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
                        onCheckMonitorNow={() => checkIssueMonitorNow.mutate()}
                        checkingMonitorNow={checkIssueMonitorNow.isPending}
                        documentDeepLink={
                          documentDeepLink?.issueId === issue.id
                            ? documentDeepLink
                            : null
                        }
                      />
                    </div>
                  </ScrollArea>
                </>
              )}
            </SheetContent>
          </Sheet>
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
