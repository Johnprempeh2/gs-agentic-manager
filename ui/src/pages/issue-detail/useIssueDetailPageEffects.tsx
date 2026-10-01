import type { useNavigationType } from "@/lib/router";
import { Settings as ChatSettings } from "lucide-react";
import { agentDetailHref } from "../agent-detail-navigation";
import { deriveInitials } from "@/components/Identity";
import { useEffect, useMemo, useCallback, useLayoutEffect, useRef } from "react";
import { Link } from "@/lib/router";
import {
  hasLegacyIssueDetailQuery,
  rememberIssueDetailLocationState,
  createIssueDetailPath,
} from "../../lib/issueDetailBreadcrumb";
import {
  resolveInboxQuickArchiveKeyAction,
  hasBlockingShortcutDialog,
  resolveIssueDetailGoKeyAction,
} from "../../lib/keyboardShortcuts";
import { isImageAttachment, isVideoAttachment } from "../../lib/issue-attachments";
import { getIssueOutputs, isImageLikeOutput, isVideoLikeOutput } from "../../lib/issue-output";
import { IssueProperties, type IssuePropertiesDocumentDeepLink } from "../../components/IssueProperties";
import { TaskSidePanel } from "../../components/task-side-panel";
import { SidePanelToggleButton } from "../../components/side-panel";
import { IssueGalleryContext } from "../../context/IssueGalleryContext";
import type { GalleryMediaItem } from "../../components/ImageGalleryModal";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Agent, Issue, IssueAttachment, IssueWorkProduct } from "@greatstone/shared";
import { shouldScrollIssueDetailToTopOnNavigation } from "./helpers";
import { useIssueMutations } from "./useIssueMutations";
import { useThreadMutations } from "./useThreadMutations";
import type { Breadcrumb, BreadcrumbPanelControl } from "@/context/BreadcrumbContext";
import type { IssueDetailBreadcrumb, IssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import type { JSX, ReactNode, RefObject, Dispatch, SetStateAction } from "react";
import type { Location, NavigateFunction } from "@/lib/router";
import type { Company } from "@greatstone/shared";
import type { IssueExternalObjectsResult } from "@/hooks/useIssueExternalObjects";
import type { UseMutationResult } from "@tanstack/react-query";
import type { SidePanelContentMode } from "@/components/side-panel/types";

export type UseIssueDetailPageEffectsInput = {
  conversation: { agent: Agent; issue: Issue | null; ensureIssue: () => Promise<Issue>; } | undefined;
  agents: Agent[] | undefined;
  issue: Issue | undefined;
  setBreadcrumbs: (crumbs: Breadcrumb[]) => void;
  sourceBreadcrumb: IssueDetailBreadcrumb;
  breadcrumbTitle: string;
  breadcrumbIdentifier: string | undefined;
  breadcrumbStatusLeading: JSX.Element | undefined;
  breadcrumbStatusKey: string | undefined;
  hasLiveRuns: boolean;
  streamlinedTaskDetailEnabled: boolean;
  taskChatShellEnabled: boolean;
  setBreadcrumbPanelControl: (control: BreadcrumbPanelControl | null) => void;
  panelVisible: boolean;
  suppressPanelUntilPlan: boolean;
  toggleTaskSidePanel: () => void;
  isMobile: boolean;
  setBreadcrumbToolbar: (node: ReactNode | null) => void;
  openTaskSidePanel: () => void;
  resolvedIssueDetailState: IssueDetailLocationState | null;
  lastScrollIssueIdRef: RefObject<string | undefined>;
  issueId: string | undefined;
  navigationType: ReturnType<typeof useNavigationType>;
  loadedIssue: Issue | null;
  location: Location<any>;
  loadedIssueCompany: Company | undefined;
  companyPrefix: string | undefined;
  navigate: NavigateFunction;
  lastMarkedReadIssueIdRef: RefObject<string | null>;
  markIssueRead: ReturnType<typeof useIssueMutations>["markIssueRead"];
  attachments: IssueAttachment[] | undefined;
  workProducts: IssueWorkProduct[] | undefined;
  setGalleryIndex: Dispatch<SetStateAction<number>>;
  setGalleryOpen: Dispatch<SetStateAction<boolean>>;
  panelIssue: Issue | null;
  closePanel: () => void;
  panelChildIssues: Issue[];
  relationIssueLinkState: unknown;
  openNewSubIssue: () => void;
  handleIssuePropertiesUpdate: (data: Record<string, unknown>) => void;
  resolvedHasActiveRun: boolean;
  externalObjectsState: IssueExternalObjectsResult;
  checkIssueMonitorNow: UseMutationResult<{ ok: true; }, Error, void, unknown>;
  documentDeepLink: (IssuePropertiesDocumentDeepLink & { issueId: string; }) | null;
  openSkill: { id: string; name: string; } | null;
  handleSkillOpened: (skillId: string) => void;
  openPanel: (content: ReactNode, options?: { contentMode?: SidePanelContentMode; }) => void;
  currentUserId: string | null;
  fileViewerEnabled: boolean;
  resolvedTasksTab: { count: number; content: ReactNode; hasError?: boolean; } | { count: number; hasError: boolean; content: JSX.Element; } | undefined;
  artifactsOpenRequest: { issueId: string; requestId: number; handled?: boolean; } | null;
  handleArtifactsOpened: (requestId: number) => void;
  issuePanelKey: string;
  keyboardShortcutsEnabled: boolean;
  archiveFromInbox: ReturnType<typeof useThreadMutations>["archiveFromInbox"];
  setDetailTab: Dispatch<SetStateAction<string>>;
  setPendingCommentComposerFocusKey: Dispatch<SetStateAction<number>>;
  setFileViewerPromptOpen: Dispatch<SetStateAction<boolean>>;
};

export function useIssueDetailPageEffects({
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
}: UseIssueDetailPageEffectsInput) {
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

  return {
    conversationAgent,
    isFromInbox,
    mediaGalleryItems,
    openIssueGallery,
    handleChatImageClick,
  };
}
