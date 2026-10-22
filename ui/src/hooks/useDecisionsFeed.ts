import { useQuery } from "@tanstack/react-query";
import type { NeedsMe } from "@greatstone/shared";
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
 * The one "needs you" number (22 Oct): every decision card, overdue wait and
 * expired question, computed once on the server. Tasks merely assigned to the
 * user are not in it; they are tasks on the Desk.
 */
export function decisionsCountOf(needsMe: Pick<NeedsMe, "decisionCount">): number {
  return Math.max(0, needsMe.decisionCount);
}

/**
 * The one Decisions count: sidebar badge, mobile nav and the Decisions header
 * all read it from the same query, so the numbers cannot disagree.
 */
export function useDecisionsCount(companyId: string | null | undefined): number {
  const { data } = useNeedsMe(companyId);
  return data ? decisionsCountOf(data) : 0;
}
