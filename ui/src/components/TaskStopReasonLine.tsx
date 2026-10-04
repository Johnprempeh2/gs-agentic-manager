import { useQuery } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";
import {
  describeTaskStopReason,
  formatTaskStopReason,
  runStoppedTheTask,
  taskStopReasonWhoLabel,
  type TaskStopReasonInput,
} from "../lib/task-stop-reason";

export interface TaskStopReasonLineProps extends Omit<TaskStopReasonInput, "lastRun"> {
  issueId: string;
  className?: string;
}

/**
 * "Claude is signed out · You to act · Waiting for you to reconnect Claude":
 * why a blocked or failed task stopped, who must act, and what happens next.
 * The raw run error stays one click away on the run page. Renders nothing when
 * nothing stopped the task.
 */
export function TaskStopReasonLine({ issueId, className, ...input }: TaskStopReasonLineProps) {
  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });
  // Runs come newest first; a queued or running run means the task moved on.
  const lastRun = runs?.[0] ?? null;
  const reason = describeTaskStopReason({ ...input, lastRun });
  if (!reason) return null;
  const runLink = lastRun && runStoppedTheTask(lastRun) ? `/agents/${lastRun.agentId}/runs/${lastRun.runId}` : null;
  const who = taskStopReasonWhoLabel(reason);
  return (
    <p
      data-testid="task-stop-reason-line"
      title={formatTaskStopReason(reason)}
      className={cn("flex min-w-0 items-baseline gap-1 text-sm", className)}
    >
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{reason.stopped}</span>
        <span className="text-muted-foreground">
          {" · "}
          {who}
          {" · "}
          {reason.next}
        </span>
      </span>
      {runLink ? (
        <Link to={runLink} className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Details
        </Link>
      ) : null}
    </p>
  );
}
