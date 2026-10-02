import { useReauth, ReauthCancelledError } from "@/components/ReauthDialog";
import { clearLegacyChatMessageRequests } from "@/lib/chat-message-request";
import { useCallback } from "react";
import { useMutation, type InfiniteData } from "@tanstack/react-query";
import { issuesApi } from "../../api/issues";
import { CommentSubmissionUnknownError } from "../../lib/comment-submit-result";
import { approvalsApi } from "../../api/approvals";
import { queryKeys } from "../../lib/queryKeys";
import {
  type InboxIssueCacheSnapshot,
  beginLocalInboxArchive,
  cancelInboxIssueQueries,
  snapshotInboxIssueCaches,
  removeIssueFromInboxCaches,
  clearLocalInboxArchive,
  restoreIssueToInboxCaches,
  boundLocalInboxArchive,
  invalidateInboxIssueQueries,
  getIssuePresenceInActiveInboxCaches,
  confirmLocalInboxArchive,
} from "../../lib/inboxArchiveCache";
import {
  createOptimisticIssueComment,
  applyOptimisticIssueCommentUpdate,
  upsertIssueCommentInPages,
  takeOptimisticIssueComment,
  type OptimisticIssueComment,
} from "../../lib/optimistic-issue-comments";
import { recordRecentTask } from "../../lib/recent-tasks";
import { buildIssueThreadInteractionSummary } from "../../lib/issue-thread-interactions";
import type {
  Issue,
  IssueComment,
  IssueThreadInteraction,
  AskUserQuestionsAnswer,
  RequestItemVerdictsInteraction,
  RequestItemVerdictValue,
  AskUserQuestionsInteraction,
  FeedbackVote,
  Agent,
} from "@greatstone/shared";
import {
  readIssueRunStateFromCache,
  type ActionableIssueThreadInteraction,
  type CommentReassignment,
  mergeOptimisticFeedbackVote,
  fileBaseName,
  slugifyDocumentKey,
  titleizeFilename,
} from "./helpers";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { ToastInput } from "@/context/ToastContext";
import type { NavigateFunction } from "@/lib/router";
import type { IssueDetailBreadcrumb } from "@/lib/issueDetailBreadcrumb";

export type UseThreadMutationsInput = {
  setPendingApprovalAction: Dispatch<SetStateAction<{ approvalId: string; action: "approve" | "reject"; } | null>>;
  invalidateIssueDetail: () => void;
  queryClient: QueryClient;
  issueId: string | undefined;
  invalidateIssueCollections: () => void;
  resolvedCompanyId: string | null;
  pushToast: (input: ToastInput) => string | null;
  issue: Issue | undefined;
  currentUserId: string | null;
  resolveWritableIssueId: () => Promise<string>;
  runStateIssueId: string | undefined;
  setOptimisticComments: Dispatch<SetStateAction<OptimisticIssueComment[]>>;
  cancelledQueuedOptimisticCommentIdsRef: RefObject<Set<string>>;
  invalidateIssueThreadLazily: () => void;
  setLocallyQueuedCommentRunIds: Dispatch<SetStateAction<Map<string, string>>>;
  commentRenderKeys: RefObject<Map<string, string>>;
  streamlinedUiEnabled: boolean;
  sessionResolved: boolean;
  issueCacheRefs: string[];
  invalidateIssueRunState: () => void;
  upsertInteractionInCache: (interaction: IssueThreadInteraction) => void;
  removeCommentFromCache: (commentId: string) => void;
  restoreQueuedCommentDraft: (body: string) => void;
  upsertCommentInCache: (comment: IssueComment) => void;
  clearCommentHashIfCurrent: (commentId: string) => void;
  invalidateIssueDocumentAnnotationState: () => void;
  conversation: { agent: Agent; issue: Issue | null; ensureIssue: () => Promise<Issue>; } | undefined;
  loadedIssue: Issue | null;
  setAttachmentError: Dispatch<SetStateAction<string | null>>;
  selectedCompanyId: string | null;
  navigate: NavigateFunction;
  sourceBreadcrumb: IssueDetailBreadcrumb;
  undoInboxArchive: (id: string, companyId: string | undefined, previousData: InboxIssueCacheSnapshot) => Promise<void>;
};

export function useThreadMutations({
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
}: UseThreadMutationsInput) {
  const approvalDecision = useMutation({
    mutationFn: async ({
      approvalId,
      action,
    }: {
      approvalId: string;
      action: "approve" | "reject";
    }) => {
      if (action === "approve") {
        return approvalsApi.approve(approvalId);
      }
      return approvalsApi.reject(approvalId);
    },
    onMutate: ({ approvalId, action }) => {
      setPendingApprovalAction({ approvalId, action });
    },
    onSuccess: (_approval, variables) => {
      invalidateIssueDetail();
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.approvals(issueId!),
      });
      invalidateIssueCollections();
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.detail(variables.approvalId),
      });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.list(resolvedCompanyId),
        });
      }
      pushToast({
        title:
          variables.action === "approve"
            ? "Approval approved"
            : "Approval rejected",
        tone: "success",
      });
    },
    onError: (err, variables) => {
      pushToast({
        title:
          variables.action === "approve"
            ? "Approval failed"
            : "Rejection failed",
        body: err instanceof Error ? err.message : "Unable to update approval",
        tone: "error",
      });
    },
    onSettled: () => {
      setPendingApprovalAction(null);
    },
  });

  const addComment = useMutation({
    mutationFn: async ({ body, reopen, interrupt, attachmentIds, clientRequestId }: {
      body: string; reopen?: boolean; interrupt?: boolean; attachmentIds?: string[]; clientRequestId?: string;
    }) => {
      if (issue?.conversationAgentId) clearLegacyChatMessageRequests(`${issue.companyId}:${currentUserId}:${issue.conversationAgentId}`);
      return issuesApi.addComment(await resolveWritableIssueId(), body, reopen, interrupt, attachmentIds, clientRequestId ?? crypto.randomUUID());
    },
    onMutate: async ({ body, reopen, interrupt }) => {
      // Start cache cancellation immediately but do not put it in front of the
      // optimistic echo. The new-runner startup placeholder must paint in the
      // same frame as send, even when an in-flight comments query is slow to
      // cancel.
      const cancelComments = queryClient.cancelQueries({
        queryKey: queryKeys.issues.comments(issueId!),
      });
      const cancelIssue = queryClient.cancelQueries({
        queryKey: queryKeys.issues.detail(issueId!),
      });

      const previousIssue = queryClient.getQueryData<Issue>(
        queryKeys.issues.detail(issueId!),
      );
      const queuedComment = !interrupt
        ? readIssueRunStateFromCache(queryClient, runStateIssueId ?? issueId!, issue)
            .interruptibleIssueRun
        : null;
      const optimisticComment = issue
        ? createOptimisticIssueComment({
            companyId: issue.companyId,
            issueId: issue.id,
            body,
            authorUserId: currentUserId,
            clientStatus: queuedComment ? "queued" : "pending",
            queueTargetRunId: queuedComment?.id ?? null,
          })
        : null;

      if (optimisticComment) {
        setOptimisticComments((current) => [...current, optimisticComment]);
      }
      if (previousIssue) {
        queryClient.setQueryData(
          queryKeys.issues.detail(issueId!),
          applyOptimisticIssueCommentUpdate(previousIssue, { reopen }),
        );
      }

      await Promise.all([cancelComments, cancelIssue]);

      return {
        optimisticCommentId: optimisticComment?.clientId ?? null,
        queuedCommentTargetRunId: queuedComment?.id ?? null,
        previousIssue,
      };
    },
    onSuccess: async (comment, _variables, context) => {
      if (
        context?.optimisticCommentId &&
        cancelledQueuedOptimisticCommentIdsRef.current.has(
          context.optimisticCommentId,
        )
      ) {
        cancelledQueuedOptimisticCommentIdsRef.current.delete(
          context.optimisticCommentId,
        );
        setOptimisticComments((current) =>
          current.filter(
            (entry) => entry.clientId !== context.optimisticCommentId,
          ),
        );
        try {
          await issuesApi.cancelComment(comment.issueId, comment.id);
          invalidateIssueDetail();
          invalidateIssueThreadLazily();
          invalidateIssueCollections();
          return;
        } catch (err) {
          pushToast({
            title: "Cancel failed",
            body:
              err instanceof Error
                ? err.message
                : "Unable to cancel the queued comment",
            tone: "error",
          });
        }
      }
      if (context?.queuedCommentTargetRunId) {
        setLocallyQueuedCommentRunIds((current) => {
          const next = new Map(current);
          next.set(comment.id, context.queuedCommentTargetRunId!);
          return next;
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.issues.queuedComments(issueId ?? comment.issueId),
        });
      }
      if (context?.optimisticCommentId) {
        commentRenderKeys.current.set(comment.id, context.optimisticCommentId);
      }
      queryClient.setQueryData<InfiniteData<IssueComment[], string | null>>(
        queryKeys.issues.comments(issueId ?? comment.issueId),
        (current) =>
          current
            ? {
                ...current,
                pages: upsertIssueCommentInPages(current.pages, comment),
              }
            : {
                pageParams: [null],
                pages: upsertIssueCommentInPages(undefined, comment),
              },
      );
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter(
            (entry) => entry.clientId !== context.optimisticCommentId,
          ),
        );
      }
      if (streamlinedUiEnabled && issue && sessionResolved) {
        recordRecentTask(
          issue,
          currentUserId,
          new Date(comment.createdAt).getTime(),
        );
      }
    },
    onError: (err, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter(
            (entry) => entry.clientId !== context.optimisticCommentId,
          ),
        );
      }
      if (context?.previousIssue) {
        queryClient.setQueryData(
          queryKeys.issues.detail(issueId!),
          context.previousIssue,
        );
      }
      pushToast({
        title:
          err instanceof CommentSubmissionUnknownError
            ? "Comment save unconfirmed"
            : "Comment failed",
        body: err instanceof Error ? err.message : "Unable to post comment",
        tone: "error",
      });
    },
    onSettled: (result, _error, variables) => {
      if (result && !issueId) void queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(result.issueId) });
      if (_error) void queryClient.invalidateQueries({ queryKey: ["issues", "tree-control-state"] });
      invalidateIssueThreadLazily();
      // Binding happens when the comment saves, after the upload's earlier
      // refetch. Refresh even after an unknown response: the write may exist.
      if (variables.attachmentIds?.length) {
        for (const ref of issueCacheRefs) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.issues.attachments(ref),
          });
        }
      }
      if (variables.interrupt) {
        invalidateIssueRunState();
      }
      if (variables.reopen) {
        invalidateIssueCollections();
      }
    },
  });
  // An "Update live?" card asks for the password in login mode (GRE-164).
  const { withReauth, dialog: reauthDialog } = useReauth();
  const acceptInteraction = useMutation({
    mutationFn: ({
      interaction,
      selectedClientKeys,
      selectedOptionIds,
      rememberAction,
    }: {
      interaction: ActionableIssueThreadInteraction;
      selectedClientKeys?: string[];
      selectedOptionIds?: string[];
      rememberAction?: boolean;
    }) =>
      withReauth("release", (options) =>
        issuesApi.acceptInteraction(
          issueId!,
          interaction.id,
          { selectedClientKeys, selectedOptionIds, rememberAction },
          options,
        ),
      ),
    onSuccess: (interaction) => {
      upsertInteractionInCache(interaction);
      if (
        interaction.kind === "suggest_tasks" &&
        resolvedCompanyId &&
        issue?.id
      ) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.listByParent(resolvedCompanyId, issue.id),
        });
      }
      invalidateIssueDetail();
      invalidateIssueCollections();
      const createdCount =
        interaction.kind === "suggest_tasks"
          ? (interaction.result?.createdTasks?.length ?? 0)
          : 0;
      const skippedCount =
        interaction.kind === "suggest_tasks"
          ? (interaction.result?.skippedClientKeys?.length ?? 0)
          : 0;
      pushToast({
        title:
          interaction.kind === "request_confirmation"
            ? "Request confirmed"
            : interaction.kind === "request_checkbox_confirmation"
              ? "Selection confirmed"
              : skippedCount > 0
                ? `Accepted ${createdCount} draft${createdCount === 1 ? "" : "s"} and skipped ${skippedCount}`
                : "Suggested tasks accepted",
        tone: "success",
      });
    },
    onError: (err) => {
      if (err instanceof ReauthCancelledError) return;
      pushToast({
        title: "Accept failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to accept the suggested tasks",
        tone: "error",
      });
    },
  });
  const rejectInteraction = useMutation({
    mutationFn: ({
      interaction,
      reason,
    }: {
      interaction: ActionableIssueThreadInteraction;
      reason?: string;
    }) => issuesApi.rejectInteraction(issueId!, interaction.id, reason),
    onSuccess: (interaction) => {
      upsertInteractionInCache(interaction);
      invalidateIssueDetail();
      invalidateIssueCollections();
      pushToast({
        title:
          interaction.kind === "request_confirmation"
            ? buildIssueThreadInteractionSummary(interaction)
            : "Suggestion rejected",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Reject failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to reject the suggested tasks",
        tone: "error",
      });
    },
  });
  const answerInteraction = useMutation({
    mutationFn: ({
      interaction,
      answers,
    }: {
      interaction: IssueThreadInteraction;
      answers: AskUserQuestionsAnswer[];
    }) => issuesApi.respondToInteraction(issueId!, interaction.id, { answers }),
    onSuccess: (interaction) => {
      upsertInteractionInCache(interaction);
      invalidateIssueDetail();
      invalidateIssueCollections();
      pushToast({
        title: "Answers submitted",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Submit failed",
        body: err instanceof Error ? err.message : "Unable to submit answers",
        tone: "error",
      });
    },
  });

  const submitInteractionVerdicts = useMutation({
    mutationFn: ({
      interaction,
      verdicts,
    }: {
      interaction: RequestItemVerdictsInteraction;
      verdicts: {
        id: string;
        verdict: RequestItemVerdictValue;
        reason?: string;
      }[];
    }) =>
      issuesApi.submitInteractionVerdicts(issueId!, interaction.id, verdicts),
    onSuccess: (interaction, variables) => {
      upsertInteractionInCache(interaction);
      invalidateIssueDetail();
      invalidateIssueCollections();
      const applied = variables.verdicts.length;
      const complete =
        interaction.kind === "request_item_verdicts"
          ? (interaction.result?.complete ?? false)
          : false;
      pushToast({
        title: complete
          ? "All verdicts applied"
          : `Applied ${applied} decision${applied === 1 ? "" : "s"}`,
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Apply failed",
        body:
          err instanceof Error ? err.message : "Unable to apply the verdicts",
        tone: "error",
      });
    },
  });

  const cancelInteraction = useMutation({
    mutationFn: ({
      interaction,
    }: {
      interaction: AskUserQuestionsInteraction;
    }) => issuesApi.cancelInteraction(issueId!, interaction.id),
    onSuccess: (interaction) => {
      upsertInteractionInCache(interaction);
      invalidateIssueDetail();
      invalidateIssueCollections();
      pushToast({
        title: "Question cancelled",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Cancel failed",
        body:
          err instanceof Error ? err.message : "Unable to cancel the question",
        tone: "error",
      });
    },
  });

  const skipInteraction = useMutation({
    mutationFn: ({ interaction }: { interaction: IssueThreadInteraction }) =>
      issuesApi.skipInteraction(issueId!, interaction.id),
    onSuccess: (interaction) => {
      upsertInteractionInCache(interaction);
      invalidateIssueDetail();
      invalidateIssueCollections();
    },
    onError: (err) => {
      pushToast({
        title: "Skip failed",
        body:
          err instanceof Error ? err.message : "Unable to skip this request",
        tone: "error",
      });
    },
  });

  const addCommentAndReassign = useMutation({
    mutationFn: ({
      body,
      reopen,
      interrupt,
      reassignment,
      attachmentIds,
      clientRequestId,
    }: {
      body: string;
      reopen?: boolean;
      interrupt?: boolean;
      reassignment: CommentReassignment;
      attachmentIds?: string[];
      clientRequestId?: string;
    }) =>
      issuesApi.update(issueId!, {
        comment: body,
        commentClientRequestId: clientRequestId,
        ...(attachmentIds?.length ? { attachmentIds } : {}),
        assigneeAgentId: reassignment.assigneeAgentId,
        assigneeUserId: reassignment.assigneeUserId,
        ...(reopen ? { status: "todo" } : {}),
        ...(interrupt ? { interrupt } : {}),
      }),
    onMutate: async ({ body, reopen, reassignment, interrupt }) => {
      // Cache cancellation can wait on an active request for several seconds.
      // Start it now, but paint the optimistic echo before awaiting it so a
      // reassignment never clears the composer into an empty thread.
      const cancelComments = queryClient.cancelQueries({
        queryKey: queryKeys.issues.comments(issueId!),
      });
      const cancelIssue = queryClient.cancelQueries({
        queryKey: queryKeys.issues.detail(issueId!),
      });

      const previousIssue = queryClient.getQueryData<Issue>(
        queryKeys.issues.detail(issueId!),
      );
      const queuedComment = !interrupt
        ? readIssueRunStateFromCache(queryClient, runStateIssueId ?? issueId!, issue)
            .interruptibleIssueRun
        : null;
      const optimisticComment = issue
        ? createOptimisticIssueComment({
            companyId: issue.companyId,
            issueId: issue.id,
            body,
            authorUserId: currentUserId,
            clientStatus: queuedComment ? "queued" : "pending",
            queueTargetRunId: queuedComment?.id ?? null,
          })
        : null;

      if (optimisticComment) {
        setOptimisticComments((current) => [...current, optimisticComment]);
      }
      if (previousIssue) {
        queryClient.setQueryData(
          queryKeys.issues.detail(issueId!),
          applyOptimisticIssueCommentUpdate(previousIssue, {
            reopen,
            reassignment,
          }),
        );
      }

      await Promise.all([cancelComments, cancelIssue]);

      return {
        optimisticCommentId: optimisticComment?.clientId ?? null,
        queuedCommentTargetRunId: queuedComment?.id ?? null,
        previousIssue,
      };
    },
    onSuccess: async (result, _variables, context) => {
      const { comment, ...nextIssue } = result;
      queryClient.setQueryData(queryKeys.issues.detail(issueId!), nextIssue);
      if (
        comment &&
        context?.optimisticCommentId &&
        cancelledQueuedOptimisticCommentIdsRef.current.has(
          context.optimisticCommentId,
        )
      ) {
        cancelledQueuedOptimisticCommentIdsRef.current.delete(
          context.optimisticCommentId,
        );
        setOptimisticComments((current) =>
          current.filter(
            (entry) => entry.clientId !== context.optimisticCommentId,
          ),
        );
        try {
          await issuesApi.cancelComment(issueId!, comment.id);
          invalidateIssueDetail();
          invalidateIssueThreadLazily();
          invalidateIssueCollections();
          return;
        } catch (err) {
          pushToast({
            title: "Cancel failed",
            body:
              err instanceof Error
                ? err.message
                : "Unable to cancel the queued comment",
            tone: "error",
          });
        }
      }
      if (comment && context?.queuedCommentTargetRunId) {
        setLocallyQueuedCommentRunIds((current) => {
          const next = new Map(current);
          next.set(comment.id, context.queuedCommentTargetRunId!);
          return next;
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.issues.queuedComments(issueId!),
        });
      }
      if (comment) {
        if (context?.optimisticCommentId)
          commentRenderKeys.current.set(
            comment.id,
            context.optimisticCommentId,
          );
        queryClient.setQueryData<InfiniteData<IssueComment[], string | null>>(
          queryKeys.issues.comments(issueId!),
          (current) =>
            current
              ? {
                  ...current,
                  pages: upsertIssueCommentInPages(current.pages, comment),
                }
              : {
                  pageParams: [null],
                  pages: upsertIssueCommentInPages(undefined, comment),
                },
        );
      }
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter(
            (entry) => entry.clientId !== context.optimisticCommentId,
          ),
        );
      }
    },
    onError: (err, _variables, context) => {
      if (context?.optimisticCommentId) {
        setOptimisticComments((current) =>
          current.filter(
            (entry) => entry.clientId !== context.optimisticCommentId,
          ),
        );
      }
      if (context?.previousIssue) {
        queryClient.setQueryData(
          queryKeys.issues.detail(issueId!),
          context.previousIssue,
        );
      }
      pushToast({
        title:
          err instanceof CommentSubmissionUnknownError
            ? "Comment save unconfirmed"
            : "Comment failed",
        body: err instanceof Error ? err.message : "Unable to post comment",
        tone: "error",
      });
    },
    onSettled: (_result, _error, variables) => {
      if (_error) void queryClient.invalidateQueries({ queryKey: ["issues", "tree-control-state"] });
      invalidateIssueThreadLazily();
      if (variables.attachmentIds?.length) {
        for (const ref of issueCacheRefs) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.issues.attachments(ref),
          });
        }
      }
      if (variables.interrupt) {
        invalidateIssueRunState();
      }
      invalidateIssueCollections();
    },
  });

  const interruptQueuedComment = useMutation({
    mutationFn: (runId: string | null) => issuesApi.interruptLatestQueuedComments(issueId!, runId),
    onSuccess: () => {
      invalidateIssueDetail();
      invalidateIssueRunState();
      pushToast({
        title: "Interrupt requested",
        body: "Queued messages will be sent when the previous run has stopped.",
        tone: "success",
      });
    },
    onError: (err) => {
      invalidateIssueDetail();
      invalidateIssueRunState();
      pushToast({
        title: "Interrupt failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to interrupt the active run",
        tone: "error",
      });
    },
  });

  const cancelQueuedComment = useMutation({
    mutationFn: async ({ commentId }: { commentId: string }) =>
      issuesApi.cancelComment(issueId!, commentId),
    onSuccess: (comment) => {
      setLocallyQueuedCommentRunIds((current) => {
        if (!current.has(comment.id)) return current;
        const next = new Map(current);
        next.delete(comment.id);
        return next;
      });
      removeCommentFromCache(comment.id);
      restoreQueuedCommentDraft(comment.body);
      invalidateIssueDetail();
      invalidateIssueThreadLazily();
      invalidateIssueCollections();
      pushToast({
        title: "Queued comment canceled",
        body: "The queued message was restored to the composer.",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Cancel failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to cancel the queued comment",
        tone: "error",
      });
    },
  });

  const deleteComment = useMutation({
    mutationFn: async ({ commentId }: { commentId: string }) =>
      issuesApi.deleteComment(issueId!, commentId),
    onSuccess: (comment) => {
      upsertCommentInCache(comment);
      clearCommentHashIfCurrent(comment.id);
      invalidateIssueDetail();
      invalidateIssueThreadLazily();
      invalidateIssueCollections();
      invalidateIssueDocumentAnnotationState();
      pushToast({
        title: "Comment deleted",
        body: "The thread now shows a deleted-comment marker.",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Delete failed",
        body:
          err instanceof Error ? err.message : "Unable to delete the comment",
        tone: "error",
      });
    },
  });

  const handleCancelQueuedComment = useCallback(
    (commentId: string) => {
      if (commentId.startsWith("optimistic-")) {
        cancelledQueuedOptimisticCommentIdsRef.current.add(commentId);
        let cancelledCommentBody: string | null = null;
        setOptimisticComments((current) => {
          const next = takeOptimisticIssueComment(current, commentId);
          cancelledCommentBody = next.comment?.body ?? null;
          return next.comments;
        });
        if (cancelledCommentBody) {
          restoreQueuedCommentDraft(cancelledCommentBody);
          pushToast({
            title: "Queued comment canceled",
            body: "The queued message was restored to the composer.",
            tone: "success",
          });
        }
        return;
      }

      void cancelQueuedComment.mutateAsync({ commentId });
    },
    [cancelQueuedComment, restoreQueuedCommentDraft, pushToast],
  );

  const feedbackVoteMutation = useMutation({
    mutationFn: (variables: {
      targetType: "issue_comment" | "issue_document_revision";
      targetId: string;
      vote: "up" | "down";
      reason?: string;
      allowSharing?: boolean;
      sharingPreferenceAtSubmit: "allowed" | "not_allowed" | "prompt";
    }) =>
      issuesApi.upsertFeedbackVote(issueId!, {
        targetType: variables.targetType,
        targetId: variables.targetId,
        vote: variables.vote,
        ...(variables.reason ? { reason: variables.reason } : {}),
        ...(variables.allowSharing ? { allowSharing: true } : {}),
      }),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.issues.feedbackVotes(issueId!),
      });
      const previousVotes = queryClient.getQueryData<FeedbackVote[]>(
        queryKeys.issues.feedbackVotes(issueId!),
      );
      queryClient.setQueryData<FeedbackVote[]>(
        queryKeys.issues.feedbackVotes(issueId!),
        mergeOptimisticFeedbackVote(
          previousVotes,
          {
            issueId: issueId!,
            targetType: variables.targetType,
            targetId: variables.targetId,
            vote: variables.vote,
            reason: variables.reason,
          },
          currentUserId,
        ),
      );
      return { previousVotes };
    },
    onSuccess: (_savedVote, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.feedbackVotes(issueId!),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.instance.generalSettings,
      });
      pushToast({
        title:
          variables.sharingPreferenceAtSubmit === "prompt"
            ? variables.allowSharing
              ? "Feedback saved. Future votes will share"
              : "Feedback saved. Future votes will stay local"
            : variables.allowSharing
              ? "Feedback saved and sharing enabled"
              : "Feedback saved",
        tone: "success",
      });
    },
    onError: (err, _variables, context) => {
      if (context?.previousVotes) {
        queryClient.setQueryData(
          queryKeys.issues.feedbackVotes(issueId!),
          context.previousVotes,
        );
      }
      pushToast({
        title: "Failed to save feedback",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (conversation) {
        return issuesApi.uploadAttachment(conversation.agent.companyId, await resolveWritableIssueId(), file);
      }
      if (!loadedIssue)
        throw new Error("Task details are still loading. Please try again.");
      return issuesApi.uploadAttachment(
        loadedIssue.companyId,
        loadedIssue.id,
        file,
      );
    },
    onSuccess: (result) => {
      setAttachmentError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.attachments(issueId ?? result.issueId),
      });
      invalidateIssueDetail();
      if (!issueId) void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(result.issueId) });
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const importMarkdownDocument = useMutation({
    mutationFn: async (file: File) => {
      const baseName = fileBaseName(file.name);
      const key = slugifyDocumentKey(baseName);
      const existing =
        (issue?.documentSummaries ?? []).find((doc) => doc.key === key) ?? null;
      const body = await file.text();
      const inferredTitle = titleizeFilename(baseName);
      const nextTitle = existing?.title ?? inferredTitle ?? null;
      return issuesApi.upsertDocument(await resolveWritableIssueId(), key, {
        title: key === "plan" ? null : nextTitle,
        format: "markdown",
        body,
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
    },
    onSuccess: (result) => {
      setAttachmentError(null);
      invalidateIssueDetail();
      if (!issueId) void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(result.issueId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.documents(issueId ?? result.issueId),
      });
    },
    onError: (err) => {
      setAttachmentError(
        err instanceof Error ? err.message : "Document import failed",
      );
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) =>
      issuesApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.attachments(issueId!),
      });
      invalidateIssueDetail();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const archiveFromInbox = useMutation({
    mutationFn: (id: string) => issuesApi.archiveFromInbox(id),
    onMutate: async (id) => {
      if (!selectedCompanyId)
        return { previousData: [] as InboxIssueCacheSnapshot };
      beginLocalInboxArchive(selectedCompanyId, id);
      await cancelInboxIssueQueries(queryClient, selectedCompanyId);
      const previousData = snapshotInboxIssueCaches(
        queryClient,
        selectedCompanyId,
      );
      removeIssueFromInboxCaches(queryClient, selectedCompanyId, id);
      return { companyId: selectedCompanyId, previousData };
    },
    onSuccess: (_data, id, context) => {
      if (selectedCompanyId) {
        removeIssueFromInboxCaches(queryClient, selectedCompanyId, id);
      }
      invalidateIssueCollections();
      navigate(
        sourceBreadcrumb.href.startsWith("/inbox")
          ? sourceBreadcrumb.href
          : "/inbox",
        { replace: true },
      );
      pushToast({
        title: "Task archived from inbox",
        tone: "success",
        action: {
          label: "Undo",
          onClick: () => {
            void undoInboxArchive(
              id,
              context?.companyId,
              context?.previousData ?? [],
            );
          },
        },
      });
    },
    onError: (err, id, context) => {
      if (context?.companyId) clearLocalInboxArchive(context.companyId, id);
      if (context?.previousData) {
        restoreIssueToInboxCaches(queryClient, context.previousData, id);
      }
      pushToast({
        title: "Archive failed",
        body:
          err instanceof Error
            ? err.message
            : "Unable to archive this task from the inbox",
        tone: "error",
      });
    },
    onSettled: async (_data, error, id, context) => {
      if (!context?.companyId) return;
      if (!error) boundLocalInboxArchive(context.companyId, id);
      await invalidateInboxIssueQueries(queryClient, context.companyId);
      if (!error) {
        const presence = getIssuePresenceInActiveInboxCaches(
          queryClient,
          context.companyId,
          id,
        );
        if (presence !== "unknown")
          confirmLocalInboxArchive(context.companyId, id);
      }
    },
  });

  return {
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
  };
}
