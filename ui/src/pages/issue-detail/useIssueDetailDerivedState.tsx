import { TaskDetailTasksPanel } from "@/components/task-detail/TaskDetailTasksPanel";
import { useMemo, useState, useCallback } from "react";
import type { LiveRunForIssue } from "../../api/heartbeats";
import { assigneeValueFromSelection, suggestedCommentAssigneeValue } from "../../lib/assignees";
import {
  buildCompanyUserProfileMap,
  buildCompanyUserLabelMap,
  buildMarkdownMentionOptions,
  buildCompanyUserInlineOptions,
  isAgentTaskTarget,
} from "../../lib/company-members";
import { collectLiveIssueIds } from "../../lib/liveIssueIds";
import { mergeIssueComments, type OptimisticIssueComment } from "../../lib/optimistic-issue-comments";
import type { IssuePropertiesDocumentDeepLink } from "../../components/IssueProperties";
import { useIssuePlanDocument } from "../../hooks/useIssuePlanDocument";
import { useTaskArtifactArrival } from "../../hooks/useTaskArtifactArrival";
import type { MentionOption } from "../../components/MarkdownEditor";
import { StatusIcon } from "../../components/StatusIcon";
import { buildIssuePropertiesPanelKey } from "../../lib/issue-properties-panel-key";
import { shouldSuppressTaskPanelUntilPlan, openSkillPanelState } from "../../lib/task-side-panel-state";
import { shouldRenderRichSubIssuesSection, buildIssueSiblingNavigation } from "../../lib/issue-detail-subissues";
import { filterIssueDescendants } from "../../lib/issue-tree";
import { buildSubIssueDefaultsForViewer } from "../../lib/subIssueDefaults";
import {
  type Agent,
  ONBOARDING_FIRST_TASK_ORIGIN_KIND,
  type Issue,
  type IssueAttachment,
  type IssueWorkProduct,
  type IssueComment,
} from "@greatstone/shared";
import { EMPTY_ISSUES } from "./helpers";
import type { CompanyUserDirectoryResponse } from "@/api/access";
import type { Project } from "@greatstone/shared";
import type { ReactNode, Dispatch, SetStateAction, RefObject } from "react";
import type { UseQueryResult, RefetchOptions, QueryObserverResult } from "@tanstack/react-query";
import type { IssueDetailLocationState, IssueDetailHeaderSeed } from "@/lib/issueDetailBreadcrumb";
import type { Location } from "@/lib/router";
import type { NewIssueDefaults } from "@/context/DialogContext";

export type UseIssueDetailDerivedStateInput = {
  agents: Agent[] | undefined;
  companyMembers: CompanyUserDirectoryResponse | undefined;
  orderedProjects: Project[];
  mentionIssues: Issue[];
  issue: Issue | undefined;
  rawChildIssues: Issue[];
  tasksTab: { count: number; content: ReactNode; hasError?: boolean; } | undefined;
  streamlinedTaskDetailEnabled: boolean;
  createdTasksQuery: UseQueryResult<Issue[], Error>;
  childIssuesError: boolean;
  resolvedIssueDetailState: IssueDetailLocationState | null;
  location: Location<any>;
  projects: Project[] | undefined;
  childIssuesLoading: boolean;
  refetchChildIssues: (options?: RefetchOptions) => Promise<QueryObserverResult<Issue[], Error>>;
  companyLiveRuns: LiveRunForIssue[] | undefined;
  taskChatShellEnabled: boolean;
  setPanelVisible: (visible: boolean) => void;
  setOpenSkill: Dispatch<SetStateAction<{ id: string; name: string; } | null>>;
  isMobile: boolean;
  setMobilePropsOpen: Dispatch<SetStateAction<boolean>>;
  setDocumentDeepLink: Dispatch<SetStateAction<(IssuePropertiesDocumentDeepLink & { issueId: string; }) | null>>;
  setArtifactsOpenRequest: Dispatch<SetStateAction<{ issueId: string; requestId: number; handled?: boolean; } | null>>;
  attachments: IssueAttachment[] | undefined;
  workProducts: IssueWorkProduct[] | undefined;
  panelVisible: boolean;
  siblingIssuesLoading: boolean;
  siblingIssuesError: boolean;
  rawSiblingIssues: Issue[];
  openNewIssue: (defaults?: NewIssueDefaults) => void;
  currentUserId: string | null;
  comments: IssueComment[];
  optimisticComments: OptimisticIssueComment[];
  commentRenderKeys: RefObject<Map<string, string>>;
  issueId: string | undefined;
  issueHeaderSeed: IssueDetailHeaderSeed | null;
};

export function useIssueDetailDerivedState({
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
}: UseIssueDetailDerivedStateInput) {
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

  return {
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
  };
}
