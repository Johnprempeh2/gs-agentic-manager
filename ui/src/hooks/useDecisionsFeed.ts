import { useQuery } from "@tanstack/react-query";
import { decisionsFeedApi } from "../api/decisionsFeed";
import { queryKeys } from "../lib/queryKeys";

/** The one Decisions feed (GRE-263). List and Focus read the same query. */
export function useDecisionsFeed(companyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.decisionsFeed.feed(companyId!),
    queryFn: () => decisionsFeedApi.get(companyId!),
    enabled: !!companyId,
    refetchOnWindowFocus: true,
  });
}

/**
 * The one "needs me" list (GRE-358): open decisions plus tasks assigned to the
 * user. Inbox Mine, the Decisions header, Focus and the nav badge all read it.
 */
export function useNeedsMe(companyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.decisionsFeed.needsMe(companyId!),
    queryFn: () => decisionsFeedApi.needsMe(companyId!),
    enabled: !!companyId,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
}

/**
 * The one "needs me" count: sidebar badge and mobile nav. Same query as Inbox
 * Mine and the Decisions header, so the numbers cannot disagree.
 */
export function useDecisionsCount(companyId: string | null | undefined): number {
  const { data } = useNeedsMe(companyId);
  return data?.count ?? 0;
}
