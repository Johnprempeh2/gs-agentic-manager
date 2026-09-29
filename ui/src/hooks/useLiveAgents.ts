import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { usePublishSharedQueryData, useSharedPollingQuery } from "./useSharedPolling";

/** An agent with at least one run that is running right now. */
export interface LiveAgent {
  agentId: string;
  agentName: string;
  /** Its running runs, newest first. */
  runs: LiveRunForIssue[];
  /** The task of its newest running run that has one, if any. */
  issueId: string | null;
}

/**
 * The one definition of "live" the sidebar count and the dashboard share
 * (GRE-257): agents with a run whose status is `running`. Queued runs are not
 * live yet, and an agent with several running runs counts once.
 */
export function selectLiveAgents(runs: LiveRunForIssue[] | undefined): LiveAgent[] {
  const byAgent = new Map<string, LiveAgent>();
  const running = (runs ?? [])
    .filter((run) => run.status === "running")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  for (const run of running) {
    const existing = byAgent.get(run.agentId);
    if (existing) {
      existing.runs.push(run);
      existing.issueId ??= run.issueId ?? null;
    } else {
      byAgent.set(run.agentId, {
        agentId: run.agentId,
        agentName: run.agentName,
        runs: [run],
        issueId: run.issueId ?? null,
      });
    }
  }
  return [...byAgent.values()];
}

/** The company's queued and running runs, fed by live events (no interval poll). */
export function useCompanyLiveRuns(companyId: string | null | undefined) {
  const liveRunsQueryKey = queryKeys.liveRuns(companyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!companyId,
    // Event-sourced via LiveUpdatesProvider (GitHub issue 9627) + reconnect reconcile — no
    // interval poll needed. Polling here also re-armed React Query's timer on
    // every live-event cache write, a major source of steady-state churn.
    refetchInterval: false,
    leaderOnly: true,
  });
  const query = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, query.data, query.dataUpdatedAt);
  return query;
}

/** Live agents for the company, from {@link selectLiveAgents}. */
export function useLiveAgents(companyId: string | null | undefined) {
  const { data: runs, isLoading } = useCompanyLiveRuns(companyId);
  const liveAgents = useMemo(() => selectLiveAgents(runs), [runs]);
  return { liveAgents, runs, isLoading };
}
