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
 * The one Decisions count: sidebar badge and mobile nav. The server builds it
 * from the same feed, so it matches the Decisions header and Focus.
 */
export function useDecisionsCount(companyId: string | null | undefined): number {
  const { data } = useQuery({
    queryKey: queryKeys.decisionsFeed.count(companyId!),
    queryFn: () => decisionsFeedApi.count(companyId!),
    enabled: !!companyId,
    refetchInterval: 60_000,
  });
  return data?.count ?? 0;
}
