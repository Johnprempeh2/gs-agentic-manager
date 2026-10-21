import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueFollowWithRollup, RecentlyOpenedIssue } from "@greatstone/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { useOptionalToastActions } from "../context/ToastContext";

/** Followed tasks refresh on their own so the rollups stay live. */
const FOLLOWS_REFETCH_MS = 60_000;

/** The signed-in user's followed tasks, each with its subtree rollup. */
export function useIssueFollows(companyId: string | null | undefined) {
  const query = useQuery({
    queryKey: queryKeys.issueFollows(companyId ?? "__none__"),
    queryFn: () => issuesApi.listFollows(companyId!),
    enabled: !!companyId,
    refetchInterval: FOLLOWS_REFETCH_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const followedIds = useMemo(() => new Set((query.data ?? []).map((follow) => follow.issueId)), [query.data]);
  return { ...query, follows: query.data ?? [], followedIds };
}

/** Follow or unfollow a task, showing the change at once. */
export function useFollowIssue(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const key = queryKeys.issueFollows(companyId ?? "__none__");
  return useMutation({
    mutationFn: ({ issueId, follow }: { issueId: string; follow: boolean; title: string }) =>
      follow ? issuesApi.follow(issueId) : issuesApi.unfollow(issueId),
    onMutate: async ({ issueId, follow }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<IssueFollowWithRollup[]>(key);
      // Unfollowing removes the row at once; a follow shows once the rollup loads.
      if (!follow) {
        queryClient.setQueryData<IssueFollowWithRollup[]>(key, (list) => list?.filter((item) => item.issueId !== issueId));
      }
      return { previous };
    },
    onError: (error, { follow, title }, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast?.pushToast({
        title: follow ? `Could not pin ${title}` : `Could not unpin ${title}`,
        body: error instanceof Error ? error.message : "Try again in a moment.",
        tone: "error",
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

/** The tasks the signed-in user opened most recently, newest first. */
export function useRecentlyOpenedIssues(
  companyId: string | null | undefined,
  options: { enabled?: boolean } = {},
): RecentlyOpenedIssue[] {
  const { data } = useQuery({
    queryKey: queryKeys.recentIssues(companyId ?? "__none__"),
    queryFn: () => issuesApi.listRecentlyOpened(companyId!),
    enabled: !!companyId && options.enabled !== false,
    retry: false,
  });
  return data ?? [];
}

/**
 * Records that the user opened this task, once per task id, so Recent follows
 * them to other devices. Chats with an agent are not tasks and stay out.
 */
export function useRecordIssueOpened(
  issue: { id: string; companyId: string; conversationAgentId?: string | null } | null | undefined,
) {
  const queryClient = useQueryClient();
  const issueId = issue?.id ?? null;
  const companyId = issue?.companyId ?? null;
  const skip = !issue || Boolean(issue.conversationAgentId);
  useEffect(() => {
    if (skip || !issueId || !companyId) return;
    Promise.resolve()
      .then(() => issuesApi.recordOpened(issueId))
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.recentIssues(companyId) }))
      .catch(() => {
        // Recent is a convenience: a failed write must not disturb the task page.
      });
  }, [issueId, companyId, skip, queryClient]);
}
