import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { issuesApi } from "../../api/issues";
import { readRecoveryReconcileWorkspaceId } from "../../lib/recovery-reconcile";
import { agentsApi } from "../../api/agents";
import { executionWorkspacesApi } from "../../api/execution-workspaces";
import { queryKeys } from "../../lib/queryKeys";
import { createIssueDetailPath } from "../../lib/issueDetailBreadcrumb";
import type { Issue } from "@greatstone/shared";
import { useIssueMutations } from "./useIssueMutations";
import type { QueryClient } from "@tanstack/react-query";
import type { ToastInput } from "@/context/ToastContext";
import type { NavigateFunction } from "@/lib/router";

export type UseRecoveryActionHandlersInput = {
  issue: Issue | undefined;
  queryClient: QueryClient;
  resolveRecoveryAction: ReturnType<typeof useIssueMutations>["resolveRecoveryAction"];
  invalidateIssueCollections: () => void;
  pushToast: (input: ToastInput) => string | null;
  navigate: NavigateFunction;
  invalidateIssueDetail: () => void;
};

export function useRecoveryActionHandlers({
  issue,
  queryClient,
  resolveRecoveryAction,
  invalidateIssueCollections,
  pushToast,
  navigate,
  invalidateIssueDetail,
}: UseRecoveryActionHandlersInput) {
  const issueAssigneeAgentIdForResume = issue?.assigneeAgentId ?? null;
  const issueCompanyIdForResume = issue?.companyId ?? null;
  const issueStatusForResume = issue?.status ?? null;
  const issueIdForResume = issue?.id ?? null;
  const resumeAssigneeAgent = useMutation({
    mutationFn: async () => {
      if (!issueAssigneeAgentIdForResume) throw new Error("No assignee agent");
      await agentsApi.resume(
        issueAssigneeAgentIdForResume,
        issueCompanyIdForResume ?? undefined,
      );
      // The pause silently dropped this issue's assignment wake, so resuming
      // alone would leave the task idle until some other trigger fires.
      // Re-issue the wake for executable statuses; best-effort — the agent is
      // resumed either way and the next comment or timer also wakes it.
      if (
        issueIdForResume &&
        (issueStatusForResume === "todo" ||
          issueStatusForResume === "in_progress")
      ) {
        try {
          await agentsApi.wakeup(
            issueAssigneeAgentIdForResume,
            {
              source: "assignment",
              reason: "Assignee resumed from the task page",
              payload: {
                issueId: issueIdForResume,
                mutation: "assignee_resumed",
              },
            },
            issueCompanyIdForResume ?? undefined,
          );
        } catch {
          // Non-fatal: the resume succeeded; the wake retries on the next trigger.
        }
      }
    },
    onSuccess: async () => {
      if (issueCompanyIdForResume) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(issueCompanyIdForResume),
        });
      }
    },
  });
  const handleResumeAssignee = useCallback(async () => {
    await resumeAssigneeAgent.mutateAsync();
  }, [resumeAssigneeAgent.mutateAsync]);
  const activeRecoveryActionId = issue?.activeRecoveryAction?.id;
  const handleResolveRecoveryAction = useCallback(
    (
      outcome: import("../../components/IssueRecoveryActionCard").RecoveryResolveOutcome,
    ) => {
      const actionId = activeRecoveryActionId;
      if (!actionId) return;
      switch (outcome) {
        case "todo":
          void resolveRecoveryAction.mutateAsync({
            actionId,
            outcome: "restored",
            sourceIssueStatus: "todo",
          });
          return;
        case "done":
          void resolveRecoveryAction.mutateAsync({
            actionId,
            outcome: "restored",
            sourceIssueStatus: "done",
          });
          return;
        case "in_review":
          void resolveRecoveryAction.mutateAsync({
            actionId,
            outcome: "restored",
            sourceIssueStatus: "in_review",
          });
          return;
        case "false_positive_done":
          void resolveRecoveryAction.mutateAsync({
            actionId,
            outcome: "false_positive",
            sourceIssueStatus: "done",
          });
          return;
        case "false_positive_in_review":
          void resolveRecoveryAction.mutateAsync({
            actionId,
            outcome: "false_positive",
            sourceIssueStatus: "in_review",
          });
          return;
      }
    },
    [activeRecoveryActionId, resolveRecoveryAction.mutateAsync],
  );
  const handleTryAgainNoLiveExecutionPath = useCallback(() => {
    handleResolveRecoveryAction("todo");
  }, [handleResolveRecoveryAction]);

  // Action 3 (workspace_validation): one-click re-issue of the stalled task on a fresh isolated
  // git worktree based on the live (diverged) branch. Composes the existing safe issue-creation
  // endpoint — it never mutates the current workspace, so the operator's commits are preserved.
  const reissueIsolatedRecoveryAction = useMutation({
    mutationFn: async (
      request: import("../../components/IssueRecoveryActionCard").RecoveryReissueRequest,
    ) => {
      if (!issue) throw new Error("Task is not loaded yet.");
      const sourceLabel = issue.identifier ?? "the stalled task";
      const descriptionLines = [
        `Re-issued from ${sourceLabel} on an isolated git worktree after a workspace branch divergence.`,
        "",
        `- Base ref (live branch): \`${request.baseRef}\``,
        ...(request.expectedBranch
          ? [`- Recorded branch: \`${request.expectedBranch}\``]
          : []),
        "",
        "---",
        "",
        issue.description ?? "",
      ];
      return issuesApi.create(issue.companyId, {
        title: `Re-issue (isolated): ${issue.title ?? sourceLabel}`,
        description: descriptionLines.join("\n"),
        priority: issue.priority,
        projectId: issue.projectId ?? null,
        parentId: issue.parentId ?? null,
        assigneeAgentId:
          issue.activeRecoveryAction?.returnOwnerAgentId ??
          issue.activeRecoveryAction?.previousOwnerAgentId ??
          issue.assigneeAgentId ??
          null,
        executionWorkspacePreference: "isolated_workspace",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree", baseRef: request.baseRef },
        },
      });
    },
    onSuccess: (created) => {
      invalidateIssueCollections();
      pushToast({
        title: "Isolated re-issue created",
        body: created.identifier
          ? `${created.identifier} will run on a fresh isolated workspace.`
          : "A fresh isolated re-issue was created.",
        tone: "success",
      });
      if (created.identifier) {
        navigate(createIssueDetailPath(created.identifier));
      }
    },
    onError: (err) => {
      pushToast({
        title: "Re-issue failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to create an isolated re-issue.",
        tone: "error",
      });
    },
  });
  const handleReissueIsolatedRecoveryAction = useCallback(
    (
      request: import("../../components/IssueRecoveryActionCard").RecoveryReissueRequest,
    ) => {
      void reissueIsolatedRecoveryAction.mutateAsync(request);
    },
    [reissueIsolatedRecoveryAction.mutateAsync],
  );

  // Actions 1 & 2 (workspace_validation): reconcile the recorded workspace branch to the live one
  // via the S4 (PAP-1586) op. `forward` is the ancestry-proven safe path (server re-verifies);
  // `override` is the audited, permission-gated break-glass carrying the operator's reason. Both
  // resolve the matching recovery action server-side, so the task resumes via the existing flow.
  const reconcileRecoveryAction = useMutation({
    // The target workspace id is captured at click time (see the handlers below) and threaded
    // through as an explicit argument, so the in-flight mutation always reconciles the workspace
    // the operator saw on the card — never a value re-read from a `issue` snapshot that may have
    // been refetched to a different `executionWorkspaceId` while the request was pending.
    mutationFn: async (
      input:
        | { workspaceId: string; mode: "forward" }
        | { workspaceId: string; mode: "override"; reason: string }
        | { workspaceId: string; mode: "quarantine_restore" },
    ) => {
      const { workspaceId, ...body } = input;
      return executionWorkspacesApi.reconcile(workspaceId, body);
    },
    onSuccess: (_result, variables) => {
      // Refresh the detail card itself (not just the list collections): a successful reconcile
      // clears the active recovery action, so the card must re-fetch to stop showing stale actions.
      invalidateIssueDetail();
      invalidateIssueCollections();
      pushToast(
        variables.mode === "quarantine_restore"
          ? {
              title: "Workspace repaired",
              body: "Dirty changes were quarantined onto a rescue branch and the recorded branch restored; the task will resume.",
              tone: "success",
            }
          : {
              title: "Workspace branch reconciled",
              body: "The recorded branch now matches the live branch; the task will resume.",
              tone: "success",
            },
      );
    },
    onError: (err) => {
      pushToast({
        title: "Reconcile failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to reconcile the workspace branch.",
        tone: "error",
      });
    },
  });
  // Bind the workspace id at the moment the operator clicks, from the same render that produced the
  // visible recovery card, rather than re-reading it inside the async mutation body. The target is
  // the workspace pinned by the recovery action's evidence — the workspace that actually diverged —
  // not the page-level `issue.executionWorkspaceId`, which can drift (e.g. a re-issue rebinds the
  // issue to a new workspace) while the card still shows the older action. Fall back to the
  // page-level id only when the action carries no workspace reference.
  const reconcileExecutionWorkspaceId =
    readRecoveryReconcileWorkspaceId(issue?.activeRecoveryAction) ??
    issue?.executionWorkspaceId ??
    null;
  const handleReconcileForwardRecoveryAction = useCallback(() => {
    if (!reconcileExecutionWorkspaceId) {
      pushToast({
        title: "Reconcile failed",
        body: "This task has no execution workspace to reconcile.",
        tone: "error",
      });
      return;
    }
    void reconcileRecoveryAction.mutateAsync({
      workspaceId: reconcileExecutionWorkspaceId,
      mode: "forward",
    });
  }, [
    reconcileExecutionWorkspaceId,
    reconcileRecoveryAction.mutateAsync,
    pushToast,
  ]);
  const handleBreakGlassOverrideRecoveryAction = useCallback(
    (reason: string) => {
      if (!reconcileExecutionWorkspaceId) {
        pushToast({
          title: "Reconcile failed",
          body: "This task has no execution workspace to reconcile.",
          tone: "error",
        });
        return;
      }
      void reconcileRecoveryAction.mutateAsync({
        workspaceId: reconcileExecutionWorkspaceId,
        mode: "override",
        reason,
      });
    },
    [
      reconcileExecutionWorkspaceId,
      reconcileRecoveryAction.mutateAsync,
      pushToast,
    ],
  );
  // Repair action (workspace_validation, dirty divergence): quarantine the dirty worktree onto a
  // rescue branch and restore the recorded branch. Lossless — no reason required.
  const handleQuarantineRestoreRecoveryAction = useCallback(() => {
    if (!reconcileExecutionWorkspaceId) {
      pushToast({
        title: "Repair failed",
        body: "This task has no execution workspace to repair.",
        tone: "error",
      });
      return;
    }
    void reconcileRecoveryAction.mutateAsync({
      workspaceId: reconcileExecutionWorkspaceId,
      mode: "quarantine_restore",
    });
  }, [
    reconcileExecutionWorkspaceId,
    reconcileRecoveryAction.mutateAsync,
    pushToast,
  ]);

  return {
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
  };
}
