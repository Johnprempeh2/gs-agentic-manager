import { isBlockedDependentsHandoffCancelled } from "@/lib/blocked-dependents-handoff";
import { useMemo, useCallback } from "react";
import { type InfiniteData, useMutation } from "@tanstack/react-query";
import { issuesApi } from "../../api/issues";
import { heartbeatsApi } from "../../api/heartbeats";
import { queryKeys } from "../../lib/queryKeys";
import {
  type InboxIssueCacheSnapshot,
  cancelInboxIssueQueries,
  clearLocalInboxArchive,
  restoreIssueToInboxCaches,
  beginLocalInboxArchive,
  removeIssueFromInboxCaches,
  boundLocalInboxArchive,
  invalidateInboxIssueQueries,
} from "../../lib/inboxArchiveCache";
import {
  removeIssueCommentFromPages,
  upsertIssueCommentInPages,
  matchesIssueRef,
  applyOptimisticIssueFieldUpdate,
  applyOptimisticIssueFieldUpdateToCollection,
} from "../../lib/optimistic-issue-comments";
import { recordRecentTask } from "../../lib/recent-tasks";
import type { IssueChatComposerHandle } from "../../components/IssueChatThread";
import { IssuesList } from "../../components/IssuesList";
import { waitForStoppedRuns } from "../../lib/wait-for-stopped-runs";
import { buildSubIssueDefaultsForViewer } from "../../lib/subIssueDefaults";
import type {
  IssueComment,
  IssueThreadInteraction,
  Issue,
  IssueTreeControlMode,
  Agent,
} from "@greatstone/shared";
import {
  type ResolveRecoveryActionOutcome,
  createRunCancelledStatusUpdateError,
  didRunCancelBeforeStatusUpdateFail,
} from "./helpers";
import type { QueryClient } from "@tanstack/react-query";
import type { Location } from "@/lib/router";
import type { RefObject, Dispatch, SetStateAction } from "react";
import type { ToastInput } from "@/context/ToastContext";
import type { Project } from "@greatstone/shared";
import type { IssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";

export type UseIssueMutationsInput = {
  issueId: string | undefined;
  issue: Issue | undefined;
  queryClient: QueryClient;
  location: Location<any>;
  commentComposerRef: RefObject<IssueChatComposerHandle | null>;
  selectedCompanyId: string | null;
  pushToast: (input: ToastInput) => string | null;
  streamlinedUiEnabled: boolean;
  sessionResolved: boolean;
  currentUserId: string | null;
  runStateIssueId: string | undefined;
  setTreeControlWakeWarning: Dispatch<SetStateAction<string | null>>;
  treeControlState: Awaited<ReturnType<typeof issuesApi.getTreeControlState>> | undefined;
  setTreeControlOpen: Dispatch<SetStateAction<boolean>>;
  setTreeControlWakeAgentsOnResume: Dispatch<SetStateAction<boolean>>;
  resolvedCompanyId: string | null;
  taskChatShellEnabled: boolean;
  streamlinedTaskDetailEnabled: boolean;
  showRichSubIssuesSection: boolean;
  childIssues: Issue[];
  childIssuesLoading: boolean;
  agents: Agent[] | undefined;
  projects: Project[] | undefined;
  liveIssueIds: Set<string>;
  resolvedIssueDetailState: IssueDetailLocationState | null;
};

export function useIssueMutations({
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
}: UseIssueMutationsInput) {
  const issueCacheRefs = useMemo(() => {
    const refs = new Set<string>();
    if (issueId) refs.add(issueId);
    if (issue?.id) refs.add(issue.id);
    if (issue?.identifier) refs.add(issue.identifier);
    return [...refs];
  }, [issue?.id, issue?.identifier, issueId]);

  const invalidateIssueDetail = useCallback(() => {
    for (const ref of issueCacheRefs) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(ref) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.activity(ref),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.interactions(ref),
      });
    }
  }, [issueCacheRefs, queryClient]);
  const invalidateIssueThreadLazily = useCallback(() => {
    for (const ref of issueCacheRefs) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.detail(ref),
        refetchType: "inactive",
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.activity(ref),
        refetchType: "inactive",
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.interactions(ref),
        refetchType: "inactive",
      });
    }
  }, [issueCacheRefs, queryClient]);

  const invalidateIssueRunState = useCallback(() => {
    for (const ref of issueCacheRefs) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(ref) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.liveRuns(ref),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.activeRun(ref),
      });
    }
  }, [issueCacheRefs, queryClient]);

  const invalidateIssueDocumentAnnotationState = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["issues", "document-annotations", issueId!],
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.issues.documents(issueId!),
    });
  }, [issueId, queryClient]);

  const removeCommentFromCache = useCallback(
    (commentId: string) => {
      queryClient.setQueryData<
        InfiniteData<IssueComment[], string | null> | undefined
      >(queryKeys.issues.comments(issueId!), (current) => {
        if (!current) return current;
        return {
          ...current,
          pages: removeIssueCommentFromPages(current.pages, commentId),
        };
      });
    },
    [issueId, queryClient],
  );

  const clearCommentHashIfCurrent = useCallback(
    (commentId: string) => {
      if (typeof window === "undefined") return;
      if (window.location.hash !== `#comment-${commentId}`) return;
      window.history.replaceState(
        null,
        "",
        `${location.pathname}${location.search}`,
      );
    },
    [location.pathname, location.search],
  );

  const upsertCommentInCache = useCallback(
    (comment: IssueComment) => {
      for (const ref of issueCacheRefs) {
        queryClient.setQueryData<
          InfiniteData<IssueComment[], string | null> | undefined
        >(queryKeys.issues.comments(ref), (current) =>
          current
            ? {
                ...current,
                pages: upsertIssueCommentInPages(current.pages, comment),
              }
            : current,
        );
      }
    },
    [issueCacheRefs, queryClient],
  );

  const restoreQueuedCommentDraft = useCallback((body: string) => {
    commentComposerRef.current?.restoreDraft(body);
  }, []);

  const invalidateIssueCollections = useCallback(() => {
    if (selectedCompanyId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.list(selectedCompanyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.listMineByMe(selectedCompanyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(selectedCompanyId),
      });
    }
  }, [queryClient, selectedCompanyId]);
  const undoInboxArchive = useCallback(
    async (
      id: string,
      companyId: string | undefined,
      previousData: InboxIssueCacheSnapshot,
    ) => {
      if (companyId) {
        await cancelInboxIssueQueries(queryClient, companyId);
        clearLocalInboxArchive(companyId, id);
        restoreIssueToInboxCaches(queryClient, previousData, id);
      }

      try {
        await issuesApi.unarchiveFromInbox(id);
        pushToast({ title: "Task restored to inbox", tone: "success" });
      } catch (error) {
        if (companyId) {
          beginLocalInboxArchive(companyId, id);
          removeIssueFromInboxCaches(queryClient, companyId, id);
          boundLocalInboxArchive(companyId, id);
        }
        pushToast({
          title: "Undo failed",
          body:
            error instanceof Error
              ? error.message
              : "Unable to restore this task to the inbox",
          tone: "error",
        });
      } finally {
        if (companyId) {
          await invalidateInboxIssueQueries(queryClient, companyId);
        }
      }
    },
    [pushToast, queryClient],
  );
  const upsertInteractionInCache = useCallback(
    (interaction: IssueThreadInteraction) => {
      queryClient.setQueryData<IssueThreadInteraction[] | undefined>(
        queryKeys.issues.interactions(issueId!),
        (current) => {
          const existing = current ?? [];
          const next = existing.filter((entry) => entry.id !== interaction.id);
          next.push(interaction);
          next.sort((left, right) => {
            const createdAtDelta =
              new Date(left.createdAt).getTime() -
              new Date(right.createdAt).getTime();
            return createdAtDelta === 0
              ? left.id.localeCompare(right.id)
              : createdAtDelta;
          });
          return next;
        },
      );
    },
    [issueId, queryClient],
  );

  const applyOptimisticIssueCacheUpdate = useCallback(
    (refs: Iterable<string>, data: Record<string, unknown>) => {
      queryClient.setQueriesData<Issue>(
        { queryKey: ["issues", "detail"] },
        (cached) =>
          cached && matchesIssueRef(cached, refs)
            ? applyOptimisticIssueFieldUpdate(cached, data)
            : cached,
      );

      if (!selectedCompanyId) return;
      queryClient.setQueryData<Issue[] | undefined>(
        queryKeys.issues.list(selectedCompanyId),
        (cached) =>
          applyOptimisticIssueFieldUpdateToCollection(cached, refs, data),
      );
    },
    [queryClient, selectedCompanyId],
  );

  const mergeIssueResponseIntoCaches = useCallback(
    (refs: Iterable<string>, nextIssue: Issue) => {
      queryClient.setQueriesData<Issue>(
        { queryKey: ["issues", "detail"] },
        (cached) =>
          cached && matchesIssueRef(cached, refs)
            ? { ...cached, ...nextIssue }
            : cached,
      );

      if (!selectedCompanyId) return;
      queryClient.setQueryData<Issue[] | undefined>(
        queryKeys.issues.list(selectedCompanyId),
        (cached) =>
          cached?.map((item) =>
            matchesIssueRef(item, refs) ? { ...item, ...nextIssue } : item,
          ),
      );
    },
    [queryClient, selectedCompanyId],
  );

  const markIssueRead = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.listMineByMe(selectedCompanyId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.sidebarBadges(selectedCompanyId),
        });
      }
    },
  });

  const updateIssue = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      issuesApi.update(issueId!, data),
    onMutate: async (data) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.issues.detail(issueId!),
      });
      if (selectedCompanyId) {
        await queryClient.cancelQueries({
          queryKey: queryKeys.issues.list(selectedCompanyId),
        });
      }

      const previousIssue = queryClient.getQueryData<Issue>(
        queryKeys.issues.detail(issueId!),
      );
      const issueRefs = new Set<string>([issueId!]);
      if (previousIssue?.id) issueRefs.add(previousIssue.id);
      if (previousIssue?.identifier) issueRefs.add(previousIssue.identifier);

      const previousDetailQueries = queryClient
        .getQueriesData<Issue>({ queryKey: ["issues", "detail"] })
        .filter(
          ([, cachedIssue]) =>
            cachedIssue && matchesIssueRef(cachedIssue, issueRefs),
        );
      const previousList = selectedCompanyId
        ? queryClient.getQueryData<Issue[]>(
            queryKeys.issues.list(selectedCompanyId),
          )
        : undefined;

      applyOptimisticIssueCacheUpdate(issueRefs, data);

      return { previousDetailQueries, previousList, selectedCompanyId };
    },
    onSuccess: ({
      comment: _comment,
      changes: _changes,
      blockedByIssueIds: _blockedByIssueIds,
      ...nextIssue
    }) => {
      const issueRefs = new Set<string>([issueId!, nextIssue.id]);
      if (nextIssue.identifier) issueRefs.add(nextIssue.identifier);
      mergeIssueResponseIntoCaches(issueRefs, nextIssue);
      if (streamlinedUiEnabled && sessionResolved) {
        recordRecentTask(nextIssue, currentUserId);
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.activity(issueId!),
      });
      invalidateIssueCollections();
    },
    onError: (err, _variables, context) => {
      for (const [queryKey, previousIssue] of context?.previousDetailQueries ??
        []) {
        queryClient.setQueryData(queryKey, previousIssue);
      }
      if (context?.selectedCompanyId) {
        queryClient.setQueryData(
          queryKeys.issues.list(context.selectedCompanyId),
          context.previousList,
        );
      }
      // The person closed the blocked-dependents dialog; nothing failed.
      if (isBlockedDependentsHandoffCancelled(err)) return;
      pushToast({
        title: "Task update failed",
        body:
          err instanceof Error ? err.message : "Unable to save task changes",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.detail(issueId!),
      });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(selectedCompanyId),
        });
      }
    },
  });
  const resolveRecoveryAction = useMutation({
    mutationFn: (data: {
      actionId?: string;
      outcome: ResolveRecoveryActionOutcome;
      sourceIssueStatus: "todo" | "done" | "in_review" | "blocked";
      resolutionNote?: string | null;
    }) => issuesApi.resolveRecoveryAction(issueId!, data),
    onSuccess: ({ issue: nextIssue }) => {
      const issueRefs = new Set<string>([issueId!, nextIssue.id]);
      if (nextIssue.identifier) issueRefs.add(nextIssue.identifier);
      mergeIssueResponseIntoCaches(issueRefs, nextIssue);
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.activity(issueId!),
      });
      invalidateIssueCollections();
    },
    onError: (err) => {
      pushToast({
        title: "Recovery resolution failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to resolve recovery action",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.detail(issueId!),
      });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(selectedCompanyId),
        });
      }
    },
  });
  // The inline notice owns feedback; do not also emit a global error toast.
  const retryDispositionRecovery = useMutation({
    mutationFn: async (actionId: string) => {
      const result = await issuesApi.resolveRecoveryAction(issueId!, {
        actionId,
        outcome: "restored",
        sourceIssueStatus: "todo",
      });
      if (
        result.issue.status !== "todo" ||
        result.issue.assigneeAgentId !== result.recoveryAction.returnOwnerAgentId
      ) {
        throw new Error("The task’s state has changed. Refresh to see its current state.");
      }
      return result;
    },
    onSuccess: ({ issue: nextIssue }) => {
      const issueRefs = new Set<string>([issueId!, nextIssue.id]);
      if (nextIssue.identifier) issueRefs.add(nextIssue.identifier);
      mergeIssueResponseIntoCaches(issueRefs, nextIssue);
      invalidateIssueCollections();
    },
    onSettled: () => {
      for (const queryKey of [
        queryKeys.issues.detail(issueId!),
        queryKeys.issues.activity(issueId!),
        queryKeys.issues.runs(runStateIssueId ?? issueId!),
        queryKeys.issues.liveRuns(runStateIssueId ?? issueId!),
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
  const executeTreeControl = useMutation({
    onMutate: () => setTreeControlWakeWarning(null),
    mutationFn: async ({
      mode,
      scope,
      runId,
      wakeAgents = false,
    }: {
      mode: IssueTreeControlMode;
      scope: "leaf" | "subtree";
      runId?: string;
      wakeAgents?: boolean;
      feedback?: "composer";
    }) => {
      if (mode === "resume") {
        const pauseHoldId = treeControlState?.activePauseHold?.holdId;
        if (!pauseHoldId) {
          throw new Error(
            "No active subtree pause hold is available to resume.",
          );
        }
        const releasedHold = await issuesApi.releaseTreeHold(
          issueId!,
          pauseHoldId,
          {
            reason: null,
            metadata: {
              wakeAgents,
            },
          },
        );
        return { kind: "release" as const, hold: releasedHold };
      }
      const created = await issuesApi.createTreeHold(issueId!, {
        mode,
        reason: null,
        releasePolicy: {
          strategy: "manual",
          ...(mode === "pause"
            ? {
                note: scope === "leaf" ? "leaf_pause" : "full_pause",
              }
            : {}),
        },
        ...(runId
          ? { metadata: { source: "issue_active_run_control", runId } }
          : {}),
        ...(mode === "restore" ? { metadata: { wakeAgents } } : {}),
      });
      if (mode === "pause") {
        // Show the hold promptly; keep Stop pending until termination is verified.
        void queryClient.invalidateQueries({
          queryKey: ["issues", "tree-control-state", issueId ?? "pending"],
        });
        await waitForStoppedRuns(
          created.preview.activeRuns.map((run) => run.id),
        );
      }
      return {
        kind: "create" as const,
        hold: created.hold,
        preview: created.preview,
      };
    },
    onSuccess: (result) => {
      if (result.kind === "release" && result.hold.wakeFailures?.length) {
        setTreeControlWakeWarning(
          `Pause released, but ${result.hold.wakeFailures.length} ${result.hold.wakeFailures.length === 1 ? "task" : "tasks"} could not start. ${result.hold.wakeFailures[0].message} Check the affected agents and try starting them again.`,
        );
      }
      setTreeControlOpen(false);
      setTreeControlWakeAgentsOnResume(false);
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.detail(issueId!),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.activity(issueId!),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.liveRuns(runStateIssueId ?? issueId!),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.activeRun(runStateIssueId ?? issueId!),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.runs(runStateIssueId ?? issueId!),
        }),
        queryClient.invalidateQueries({
          queryKey: ["issues", "tree-control-state", issueId ?? "pending"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["issues", "tree-holds", issueId ?? "pending"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["issues", "tree-control-preview", issueId ?? "pending"],
        }),
      ]);
      if (selectedCompanyId) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.list(selectedCompanyId),
          }),
          ...(issue?.id
            ? [
                queryClient.invalidateQueries({
                  queryKey: queryKeys.issues.listByParent(
                    selectedCompanyId,
                    issue.id,
                  ),
                }),
                queryClient.invalidateQueries({
                  queryKey: queryKeys.issues.listByDescendantRoot(
                    selectedCompanyId,
                    issue.id,
                  ),
                }),
              ]
            : []),
        ]);
      }
    },
  });
  const stopResponse = useMutation({
    mutationFn: async (runId: string) => {
      await heartbeatsApi.cancel(runId);
      await waitForStoppedRuns([runId]);
    },
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(runStateIssueId ?? issueId!) }),
    ]),
  });
  const stopAndFinalizeRun = useMutation({
    mutationFn: async ({
      runId,
      status,
    }: {
      runId: string;
      status: "cancelled" | "done";
    }) => {
      await heartbeatsApi.cancel(runId);
      try {
        return await issuesApi.update(issueId!, { status });
      } catch (err) {
        throw createRunCancelledStatusUpdateError(err);
      }
    },
    onSuccess: ({ comment: _comment, ...nextIssue }, { status }) => {
      const issueRefs = new Set<string>([issueId!, nextIssue.id]);
      if (nextIssue.identifier) issueRefs.add(nextIssue.identifier);
      mergeIssueResponseIntoCaches(issueRefs, nextIssue);
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.activity(issueId!),
      });
      invalidateIssueRunState();
      invalidateIssueCollections();
      pushToast({
        title:
          status === "done"
            ? "Run stopped and task done"
            : "Run stopped and task cancelled",
        tone: "success",
      });
    },
    onError: (err, { status }) => {
      const runWasStopped = didRunCancelBeforeStatusUpdateFail(err);
      pushToast({
        title: runWasStopped
          ? "Run stopped; task update failed"
          : status === "done"
            ? "Stop and done failed"
            : "Stop and cancel failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to stop the run and update the task",
        tone: "error",
      });
    },
    onSettled: (_data, err) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.detail(issueId!),
      });
      if (err) invalidateIssueRunState();
      if (selectedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(selectedCompanyId),
        });
      }
    },
  });
  const handleIssuePropertiesUpdate = useCallback(
    (data: Record<string, unknown>) => {
      updateIssue.mutate(data);
    },
    [updateIssue.mutate],
  );

  const updateChildIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: ["issues", resolvedCompanyId],
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.sidebarBadges(resolvedCompanyId),
        });
      }
    },
    onError: (err) => {
      pushToast({
        title: "Task update failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to save sub-task changes",
        tone: "error",
      });
    },
  });
  const handleChildIssueUpdate = useCallback(
    (id: string, data: Record<string, unknown>) => {
      updateChildIssue.mutate({ id, data });
    },
    [updateChildIssue.mutate],
  );

  const subTasksTree = useMemo(
    () =>
      taskChatShellEnabled &&
      !streamlinedTaskDetailEnabled &&
      issue &&
      showRichSubIssuesSection ? (
        <IssuesList
          issues={childIssues}
          isLoading={childIssuesLoading}
          agents={agents}
          projects={projects}
          liveIssueIds={liveIssueIds}
          projectId={issue.projectId ?? undefined}
          viewStateKey={`paperclip:issue-detail:${issue.id}:subissues-view`}
          issueLinkState={resolvedIssueDetailState ?? location.state}
          searchFilters={{ descendantOf: issue.id, includeBlockedBy: true }}
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
      ) : null,
    [
      taskChatShellEnabled,
      streamlinedTaskDetailEnabled,
      issue,
      showRichSubIssuesSection,
      childIssues,
      childIssuesLoading,
      agents,
      projects,
      liveIssueIds,
      resolvedIssueDetailState,
      location.state,
      currentUserId,
      handleChildIssueUpdate,
    ],
  );

  const checkIssueMonitorNow = useMutation({
    mutationFn: () => issuesApi.checkMonitorNow(issueId!),
    onSuccess: () => {
      invalidateIssueDetail();
      invalidateIssueRunState();
      invalidateIssueCollections();
      pushToast({
        title: "Monitor check queued",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Monitor check failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to trigger the monitor right now",
        tone: "error",
      });
    },
  });

  return {
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
  };
}
