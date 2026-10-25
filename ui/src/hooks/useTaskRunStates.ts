import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { deriveTaskRunStates, runStateForTask, type TaskRunState } from "../lib/task-run-state";
import { useCompanyLiveRuns } from "./useLiveAgents";

const EMPTY = new Map<string, TaskRunState>();

/**
 * Running, queued or stuck state for every task in the company with a live
 * run. Shares the company live-runs and agents caches with the rest of the app,
 * so mounting it on several surfaces costs no extra requests.
 */
export function useTaskRunStates(companyId: string | null | undefined): Map<string, TaskRunState> {
  const { data: liveRuns } = useCompanyLiveRuns(companyId);
  const hasQueued = (liveRuns ?? []).some((run) => run.status === "queued");

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId && hasQueued,
  });

  // Only asked while something waits; a 403 for a non-board viewer reads as "not draining".
  const { data: taskDrain } = useQuery({
    queryKey: queryKeys.instance.taskDrain,
    queryFn: () => instanceSettingsApi.getTaskDrain(),
    enabled: hasQueued,
    retry: false,
    staleTime: 15_000,
    refetchInterval: hasQueued ? 30_000 : false,
  });

  return useMemo(() => {
    if (!liveRuns || liveRuns.length === 0) return EMPTY;
    const agentsById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
    // States are refreshed against the clock where they are shown (see TaskRunStateChip).
    return deriveTaskRunStates(liveRuns, {
      now: Date.now(),
      agentsById,
      releaseDraining: taskDrain?.draining === true,
    });
  }, [liveRuns, agents, taskDrain?.draining]);
}

/**
 * Run states for a tree of task nodes, so each node can read its own without
 * every node subscribing to the live-runs cache. Empty outside a provider.
 */
export const TaskRunStatesContext = createContext<ReadonlyMap<string, TaskRunState>>(EMPTY);

export function useTaskRunStateFor(task: { id: string; status?: string | null }): TaskRunState | null {
  return runStateForTask(useContext(TaskRunStatesContext), task);
}

/**
 * True when the task's agent run is queued, not running. Status icons pass this
 * as `queued` so a waiting task shows a clock, never the in-progress spinner.
 */
export function useTaskQueued(
  companyId: string | null | undefined,
  task: { id: string; status?: string | null } | null | undefined,
): boolean {
  const states = useTaskRunStates(companyId);
  return task ? runStateForTask(states, task)?.kind === "queued" : false;
}
