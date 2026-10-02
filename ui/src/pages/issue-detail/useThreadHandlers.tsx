import { useMemo, useRef, useEffect, useCallback } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { loadRemainingIssueCommentPages, ISSUE_COMMENT_PAGE_SIZE } from "../../lib/optimistic-issue-comments";
import type { IssueChatRunFinalizationAction } from "../../components/IssueChatThread";
import { getPromotedOutputAttachmentIds } from "../../lib/issue-output";
import { copyTextToClipboard } from "../../lib/clipboard";
import type {
  IssueComment,
  IssueThreadInteraction,
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  RequestItemVerdictsInteraction,
  RequestItemVerdictValue,
  IssueWorkProduct,
  IssueAttachment,
  Issue,
} from "@greatstone/shared";
import {
  JUMP_TO_LATEST_MAX_COMMENT_PAGES,
  type CommentReassignment,
  type ActionableIssueThreadInteraction,
} from "./helpers";
import { InboxMobileToolbar } from "./InboxMobileToolbar";
import { useIssueMutations } from "./useIssueMutations";
import { useThreadMutations } from "./useThreadMutations";
import type { Dispatch, SetStateAction, ReactNode } from "react";
import type { ToastInput } from "@/context/ToastContext";
import type { NavigateFunction } from "@/lib/router";
import type { IssueDetailBreadcrumb } from "@/lib/issueDetailBreadcrumb";
import type { FetchNextPageOptions, InfiniteQueryObserverResult, RefetchOptions, QueryObserverResult, QueryClient, UseMutationResult } from "@tanstack/react-query";

export type UseThreadHandlersInput = {
  workProducts: IssueWorkProduct[] | undefined;
  attachments: IssueAttachment[] | undefined;
  issue: Issue | undefined;
  setCopied: Dispatch<SetStateAction<boolean>>;
  pushToast: (input: ToastInput) => string | null;
  archiveFromInbox: ReturnType<typeof useThreadMutations>["archiveFromInbox"];
  setMobilePropsOpen: Dispatch<SetStateAction<boolean>>;
  updateIssue: ReturnType<typeof useIssueMutations>["updateIssue"];
  navigate: NavigateFunction;
  sourceBreadcrumb: IssueDetailBreadcrumb;
  isMobile: boolean;
  isFromInbox: boolean;
  setMobileToolbar: (node: ReactNode | null) => void;
  streamlinedUiEnabled: boolean;
  preferInboxHistoryBack: boolean;
  attachmentsLoading: boolean;
  fetchOlderComments: (options?: FetchNextPageOptions) => Promise<InfiniteQueryObserverResult<InfiniteData<IssueComment[], unknown>, Error>>;
  refetchComments: (options?: RefetchOptions) => Promise<QueryObserverResult<InfiniteData<IssueComment[], unknown>, Error>>;
  issueId: string | undefined;
  queryClient: QueryClient;
  shouldPrefetchOlderComments: boolean;
  linkedCommentPending: boolean;
  hasOlderComments: boolean;
  commentsLoadingOlder: boolean;
  feedbackVoteMutation: ReturnType<typeof useThreadMutations>["feedbackVoteMutation"];
  feedbackDataSharingPreference: "allowed" | "not_allowed" | "prompt";
  addCommentAndReassign: ReturnType<typeof useThreadMutations>["addCommentAndReassign"];
  addComment: ReturnType<typeof useThreadMutations>["addComment"];
  uploadAttachment: UseMutationResult<IssueAttachment, Error, File, unknown>;
  interruptQueuedComment: ReturnType<typeof useThreadMutations>["interruptQueuedComment"];
  stopAndFinalizeRun: ReturnType<typeof useIssueMutations>["stopAndFinalizeRun"];
  acceptInteraction: ReturnType<typeof useThreadMutations>["acceptInteraction"];
  rejectInteraction: ReturnType<typeof useThreadMutations>["rejectInteraction"];
  answerInteraction: ReturnType<typeof useThreadMutations>["answerInteraction"];
  cancelInteraction: ReturnType<typeof useThreadMutations>["cancelInteraction"];
  skipInteraction: ReturnType<typeof useThreadMutations>["skipInteraction"];
  submitInteractionVerdicts: ReturnType<typeof useThreadMutations>["submitInteractionVerdicts"];
};

export function useThreadHandlers({
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
}: UseThreadHandlersInput) {
  const promotedOutputAttachmentIds = useMemo(
    () => getPromotedOutputAttachmentIds(workProducts),
    [workProducts],
  );
  const attachmentList = useMemo(
    () =>
      (attachments ?? []).filter(
        (attachment) => !promotedOutputAttachmentIds.has(attachment.id),
      ),
    [attachments, promotedOutputAttachmentIds],
  );
  const copyIssueToClipboard = async () => {
    if (!issue) return;
    const decodeEntities = (text: string) => {
      const el = document.createElement("textarea");
      el.innerHTML = text;
      return el.value;
    };
    const title = decodeEntities(issue.title);
    const body = decodeEntities(issue.description ?? "");
    const md = `# ${issue.identifier}: ${title}\n\n${body}`.trimEnd();
    try {
      await copyTextToClipboard(md);
      setCopied(true);
      pushToast({ title: "Copied to clipboard", tone: "success" });
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      pushToast({
        title: "Copy failed",
        body:
          error instanceof Error
            ? error.message
            : "Unable to copy task markdown",
        tone: "error",
      });
    }
  };

  // Gmail-style mobile toolbar when viewing an issue from inbox.
  // Callbacks are stored in a ref so the effect deps stay stable and
  // don't trigger an infinite render loop (useMutation results and
  // non-memoized functions change identity every render).
  const inboxToolbarCallbacksRef = useRef({
    onArchive: () => {
      if (!archiveFromInbox.isPending && issue?.id)
        archiveFromInbox.mutate(issue.id);
    },
    onCopy: () => copyIssueToClipboard(),
    onProperties: () => setMobilePropsOpen(true),
    onHide: () => {
      updateIssue.mutate(
        { hiddenAt: new Date().toISOString() },
        { onSuccess: () => navigate("/issues/all") },
      );
    },
  });
  inboxToolbarCallbacksRef.current = {
    onArchive: () => {
      if (!archiveFromInbox.isPending && issue?.id)
        archiveFromInbox.mutate(issue.id);
    },
    onCopy: () => copyIssueToClipboard(),
    onProperties: () => setMobilePropsOpen(true),
    onHide: () => {
      updateIssue.mutate(
        { hiddenAt: new Date().toISOString() },
        { onSuccess: () => navigate("/issues/all") },
      );
    },
  };

  const backHref = sourceBreadcrumb.href ?? "/inbox";
  const showInboxToolbar = isMobile && isFromInbox;
  const archivePending = archiveFromInbox.isPending;
  const issueHidden = !!issue?.hiddenAt;
  const canArchiveFromInbox = isFromInbox && !!issue?.id && !issueHidden;

  useEffect(() => {
    if (!showInboxToolbar) {
      setMobileToolbar(null);
      return;
    }

    setMobileToolbar(
      <InboxMobileToolbar
        backHref={backHref}
        preferHistoryBack={streamlinedUiEnabled ? preferInboxHistoryBack : true}
        issueId={issue?.id}
        issueHidden={issueHidden}
        archivePending={archivePending}
        onArchive={() => inboxToolbarCallbacksRef.current.onArchive()}
        onCopy={() => inboxToolbarCallbacksRef.current.onCopy()}
        onProperties={() => inboxToolbarCallbacksRef.current.onProperties()}
        onHide={() => inboxToolbarCallbacksRef.current.onHide()}
      />,
    );

    return () => setMobileToolbar(null);
  }, [
    showInboxToolbar,
    backHref,
    preferInboxHistoryBack,
    streamlinedUiEnabled,
    issue?.id,
    issueHidden,
    archivePending,
    setMobileToolbar,
  ]);

  const attachmentsInitialLoading =
    attachmentsLoading && attachments === undefined;
  const loadOlderComments = useCallback(() => {
    void fetchOlderComments();
  }, [fetchOlderComments]);
  const refetchLatestComments = useCallback(async () => {
    // Refetch page 0 first so comments that arrived after initial load are
    // visible, then load every remaining older page. The chat thread is
    // paginated and virtualized, so "latest" must be resolved against the
    // complete comment set rather than the current loaded window.
    const refreshed = await refetchComments();
    const loaded = await loadRemainingIssueCommentPages<IssueComment>({
      pages: refreshed.data?.pages,
      pageParams: refreshed.data?.pageParams as
        Array<string | null> | undefined,
      pageSize: ISSUE_COMMENT_PAGE_SIZE,
      maxPages: JUMP_TO_LATEST_MAX_COMMENT_PAGES,
      fetchPage: (afterCommentId) =>
        issuesApi.listComments(issueId!, {
          order: "desc",
          limit: ISSUE_COMMENT_PAGE_SIZE,
          after: afterCommentId,
        }),
    });
    queryClient.setQueryData<InfiniteData<IssueComment[], string | null>>(
      queryKeys.issues.comments(issueId!),
      loaded,
    );
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => resolve());
    });
  }, [issueId, queryClient, refetchComments]);
  useEffect(() => {
    if (
      !shouldPrefetchOlderComments &&
      !(linkedCommentPending && hasOlderComments && !commentsLoadingOlder)
    )
      return;
    void fetchOlderComments();
  }, [
    fetchOlderComments,
    shouldPrefetchOlderComments,
    linkedCommentPending,
    hasOlderComments,
    commentsLoadingOlder,
  ]);
  const handleCommentVote = useCallback(
    async (
      commentId: string,
      vote: "up" | "down",
      options?: { allowSharing?: boolean; reason?: string },
    ) => {
      await feedbackVoteMutation.mutateAsync({
        targetType: "issue_comment",
        targetId: commentId,
        vote,
        reason: options?.reason,
        allowSharing: options?.allowSharing,
        sharingPreferenceAtSubmit: feedbackDataSharingPreference,
      });
    },
    [feedbackDataSharingPreference, feedbackVoteMutation],
  );
  const handleChatAdd = useCallback(
    async (
      body: string,
      reopen?: boolean,
      reassignment?: CommentReassignment,
      attachmentIds?: string[],
      clientRequestId?: string,
    ) => {
      if (reassignment) {
        await addCommentAndReassign.mutateAsync({
          body,
          reopen,
          reassignment,
          attachmentIds,
          clientRequestId,
        });
        return;
      }
      await addComment.mutateAsync({ body, reopen, attachmentIds, clientRequestId });
    },
    [addComment, addCommentAndReassign],
  );
  const handleCommentImageUpload = useCallback(
    async (file: File) => {
      const attachment = await uploadAttachment.mutateAsync(file);
      return attachment.contentPath;
    },
    [uploadAttachment],
  );
  const handleCommentAttachImage = useCallback(
    async (file: File) => {
      return uploadAttachment.mutateAsync(file);
    },
    [uploadAttachment],
  );
  const handleInterruptQueuedRun = useCallback(
    async (runId: string | null) => {
      await interruptQueuedComment.mutateAsync(runId);
    },
    [interruptQueuedComment],
  );
  const runFinalizationActions = useMemo<
    readonly IssueChatRunFinalizationAction[]
  >(
    () => [
      {
        id: "cancel",
        label: "Stop and cancel",
        pendingLabel: "Stopping and cancelling...",
        isPending:
          stopAndFinalizeRun.isPending &&
          stopAndFinalizeRun.variables?.status === "cancelled",
        disabled: stopAndFinalizeRun.isPending,
        onSelect: (runId) =>
          stopAndFinalizeRun.mutateAsync({ runId, status: "cancelled" }).then(
            () => undefined,
            () => undefined,
          ),
      },
      {
        id: "done",
        label: "Stop and done",
        pendingLabel: "Stopping and marking done...",
        isPending:
          stopAndFinalizeRun.isPending &&
          stopAndFinalizeRun.variables?.status === "done",
        disabled: stopAndFinalizeRun.isPending,
        onSelect: (runId) =>
          stopAndFinalizeRun.mutateAsync({ runId, status: "done" }).then(
            () => undefined,
            () => undefined,
          ),
      },
    ],
    [
      stopAndFinalizeRun.isPending,
      stopAndFinalizeRun.mutateAsync,
      stopAndFinalizeRun.variables?.status,
    ],
  );
  const handleAcceptInteraction = useCallback(
    async (
      interaction: ActionableIssueThreadInteraction,
      selectedClientKeys?: string[],
      selectedOptionIds?: string[],
      rememberAction?: boolean,
    ) => {
      await acceptInteraction.mutateAsync({
        interaction,
        selectedClientKeys,
        selectedOptionIds,
        rememberAction,
      });
    },
    [acceptInteraction],
  );
  const handleRejectInteraction = useCallback(
    async (interaction: ActionableIssueThreadInteraction, reason?: string) => {
      await rejectInteraction.mutateAsync({ interaction, reason });
    },
    [rejectInteraction],
  );
  const handleSubmitInteractionAnswers = useCallback(
    async (
      interaction: IssueThreadInteraction,
      answers: AskUserQuestionsAnswer[],
    ) => {
      await answerInteraction.mutateAsync({ interaction, answers });
    },
    [answerInteraction],
  );
  const handleCancelInteraction = useCallback(
    async (interaction: AskUserQuestionsInteraction) => {
      await cancelInteraction.mutateAsync({ interaction });
    },
    [cancelInteraction],
  );
  const handleSkipInteraction = useCallback(
    async (interaction: IssueThreadInteraction) => {
      await skipInteraction.mutateAsync({ interaction });
    },
    [skipInteraction],
  );
  const handleSubmitInteractionVerdicts = useCallback(
    async (
      interaction: RequestItemVerdictsInteraction,
      verdicts: {
        id: string;
        verdict: RequestItemVerdictValue;
        reason?: string;
      }[],
    ) => {
      await submitInteractionVerdicts.mutateAsync({ interaction, verdicts });
    },
    [submitInteractionVerdicts],
  );
  const canResumeFromBacklog =
    issue?.status === "backlog" &&
    Boolean(issue.assigneeAgentId || issue.assigneeUserId);
  const handleResumeFromBacklog = useCallback(async () => {
    await updateIssue.mutateAsync({ status: "todo" });
  }, [updateIssue.mutateAsync]);

  return {
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
  };
}
