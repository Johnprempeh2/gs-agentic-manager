import { useMemo, useLayoutEffect, useEffect, useRef } from "react";
import { useQuery, useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../../lib/query-placeholder-data";
import { hasLegacyIssueDetailQuery } from "../../lib/issueDetailBreadcrumb";
import { getIssueDetailQueryOptions } from "../../lib/issueDetailCache";
import {
  beginIssueDetailNavigation,
  reportIssueDetailWebVitals,
  scheduleIssueDetailPaintMeasure,
  ISSUE_DETAIL_HEADER_PAINT_MARK,
  ISSUE_DETAIL_HEADER_MEASURE,
  ISSUE_DETAIL_CONTENT_PAINT_MARK,
  ISSUE_DETAIL_CONTENT_MEASURE,
} from "../../lib/issue-detail-performance";
import {
  ISSUE_COMMENT_PAGE_SIZE,
  getNextIssueCommentPageParam,
  flattenIssueCommentPages,
  shouldAutoloadOlderIssueComments,
} from "../../lib/optimistic-issue-comments";
import { useIssueExternalObjects } from "../../hooks/useIssueExternalObjects";
import {
  isClosedIsolatedExecutionWorkspace,
  type IssueComment,
  type IssueThreadInteraction,
  type IssueAttachment,
  type IssueWorkProduct,
  type Agent,
  type Issue,
} from "@greatstone/shared";
import { ISSUE_COMMENT_AUTOLOAD_LIMIT } from "./helpers";
import type { QueryClient } from "@tanstack/react-query";
import type { IssueDetailHeaderSeed } from "@/lib/issueDetailBreadcrumb";
import type { RefObject } from "react";
import type { Company } from "@greatstone/shared";
import type { Location } from "@/lib/router";

export type UseIssueAndCommentsInput = {
  queryClient: QueryClient;
  issueId: string | undefined;
  issueHeaderSeed: IssueDetailHeaderSeed | null;
  conversation: { agent: Agent; issue: Issue | null; ensureIssue: () => Promise<Issue>; } | undefined;
  draftIssue: Issue | undefined;
  pendingDraftWorkMode: RefObject<"standard" | "ask" | "planning" | "skill_test" | null>;
  companies: Company[];
  companyPrefix: string | undefined;
  location: Location<any>;
  selectedCompanyId: string | null;
  detailTab: string;
};

export function useIssueAndComments({
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
}: UseIssueAndCommentsInput) {
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

  return {
    isLoading,
    error,
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
  };
}
