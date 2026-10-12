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
 * What needs a decision from the user (GRE-586): decision cards plus overdue
 * waits that have no card. Tasks merely assigned to the user are not
 * decisions; they count on My tasks instead.
 */
export function decisionsCountOf(needsMe: Pick<NeedsMe, "count" | "assignedTaskCount">): number {
  return Math.max(0, needsMe.count - needsMe.assignedTaskCount);
}

/**
 * The one Decisions count: sidebar badge, mobile nav and the Decisions header
 * all read it from the same query, so the numbers cannot disagree.
 */
export function useDecisionsCount(companyId: string | null | undefined): number {
  const { data } = useNeedsMe(companyId);
  return data ? decisionsCountOf(data) : 0;
}

/** Open tasks assigned to the user that are not already a decision (GRE-586). */
export function useMyTasksCount(companyId: string | null | undefined): number {
  const { data } = useNeedsMe(companyId);
  return data?.assignedTaskCount ?? 0;
}
