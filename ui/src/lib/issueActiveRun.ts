import type { Issue } from "@greatstone/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import { isTerminalIssueStatus } from "./liveIssueIds";

export function shouldTrackIssueActiveRun(
  issue: Pick<Issue, "status" | "executionRunId"> | null | undefined,
): boolean {
  return Boolean(issue && (issue.status === "in_progress" || issue.executionRunId));
}

export function resolveIssueActiveRun(
  issue: Pick<Issue, "status" | "executionRunId"> | null | undefined,
  activeRun: ActiveRunForIssue | null | undefined,
  liveRuns?: readonly LiveRunForIssue[],
): ActiveRunForIssue | null {
  if (!shouldTrackIssueActiveRun(issue)) return null;
  // The active-run query stops polling while the live-run list is populated.
  // Prefer the task's current execution identity when its cached run is stale.
  const runId = issue?.executionRunId ?? activeRun?.id;
  if (!runId) return null;
  return liveRuns?.find((run) => run.id === runId)
    ?? (activeRun?.id === runId ? activeRun : null);
}

/**
 * Refetch interval for a task page poller (runs, live runs, active run, email
 * thread). It polls at `liveMs` only while a run is live on an open task that
 * is on screen. An idle task falls back to `idleMs` (off by default). A done or
 * cancelled task, or a hidden tab, never polls: the live-updates socket and the
 * invalidation after each action keep those pages current.
 */
export function taskPollInterval(
  state: { issueStatus: string | null | undefined; live: boolean; visible: boolean },
  liveMs: number,
  idleMs: number | false = false,
): number | false {
  if (!state.visible || isTerminalIssueStatus(state.issueStatus)) return false;
  return state.live ? liveMs : idleMs;
}
