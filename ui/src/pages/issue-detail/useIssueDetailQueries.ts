import { useUserPreferences } from "../../hooks/useUserPreferences";
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSharedPollingQuery, usePublishSharedQueryData } from "@/hooks/useSharedPolling";
import { issuesApi } from "../../api/issues";
import { type LiveRunForIssue, heartbeatsApi, type ActiveRunForIssue } from "../../api/heartbeats";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { accessApi } from "../../api/access";
import { canBoardManageRuntime } from "../../lib/recovery-reconcile";
import { agentsApi } from "../../api/agents";
import { authApi } from "../../api/auth";
import { projectsApi } from "../../api/projects";
import { queryKeys } from "../../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../../lib/query-placeholder-data";
import { readIssueDetailBreadcrumb } from "../../lib/issueDetailBreadcrumb";
import { taskPollInterval, shouldTrackIssueActiveRun } from "../../lib/issueActiveRun";
import { usePageVisibility } from "../../lib/page-visibility";
import { useProjectOrder } from "../../hooks/useProjectOrder";
import { recordRecentTask } from "../../lib/recent-tasks";
import { usePluginSlots } from "@/plugins/slots";
import type { Issue } from "@greatstone/shared";
import { EMPTY_ISSUES, canBoardResolveRecoveryAction } from "./helpers";
import type { Dispatch, SetStateAction, ReactNode } from "react";
import type { Location } from "@/lib/router";

export type UseIssueDetailQueriesInput = {
  issueId: string | undefined;
  issue: Issue | undefined;
  locallyQueuedCommentRunIds: Map<string, string>;
  setLocallyQueuedCommentRunIds: Dispatch<SetStateAction<Map<string, string>>>;
  location: Location<any>;
  resolvedCompanyId: string | null;
  streamlinedTaskDetailEnabled: boolean;
  tasksTab: { count: number; content: ReactNode; hasError?: boolean; } | undefined;
  selectedCompanyId: string | null;
  streamlinedUiEnabled: boolean;
  detailTab: string;
  treeControlMode: "resume" | "cancel" | "restore";
  treeControlOpen: boolean;
};

export function useIssueDetailQueries({
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
}: UseIssueDetailQueriesInput) {
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

  return {
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
  };
}
