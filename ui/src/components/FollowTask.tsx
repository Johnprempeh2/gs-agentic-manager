import type { MouseEvent } from "react";
import { Loader2, Star } from "lucide-react";
import type { IssueFollowRollupCounts, IssueFollowRollupUpdate } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { cn, relativeTime } from "../lib/utils";
import { plainTaskStatus } from "../lib/global-search";
import { useFollowIssue, useIssueFollows } from "../hooks/useIssueFollows";

export interface FollowTaskButtonProps {
  following: boolean;
  /** Task name for the accessible label, e.g. "GRE-1681". */
  taskName: string;
  pending?: boolean;
  /**
   * "button": labelled outline button for the task page.
   * "icon": quiet star for task rows; shown on hover or focus until followed.
   */
  variant?: "button" | "icon";
  onToggle: (nextFollowing: boolean) => void;
  className?: string;
}

/** A star that follows a task and everything under it. */
export function FollowTaskButton({
  following,
  taskName,
  pending = false,
  variant = "button",
  onToggle,
  className,
}: FollowTaskButtonProps) {
  const Icon = pending ? Loader2 : Star;
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Rows sit under a full-row link; the star must not open the task.
    event.preventDefault();
    event.stopPropagation();
    if (!pending) onToggle(!following);
  };
  const icon = (
    <Icon
      aria-hidden="true"
      className={cn(
        "size-3.5",
        pending && "motion-safe:animate-spin",
        !pending && following ? "fill-primary text-primary" : "text-muted-foreground",
      )}
    />
  );

  if (variant === "icon") {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-follow-task
        aria-label={following ? `Stop following ${taskName}` : `Follow ${taskName}`}
        aria-pressed={following}
        title={following ? "Following: in your sidebar and on your Desk" : "Follow this task and everything under it"}
        disabled={pending}
        onClick={handleClick}
        className={cn(
          "shrink-0",
          !following && "sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-visible:opacity-100",
          className,
        )}
      >
        {icon}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-follow-task
      aria-pressed={following}
      aria-label={following ? `Stop following ${taskName}` : `Follow ${taskName}`}
      title="Followed tasks show their progress in your sidebar and on your Desk"
      disabled={pending}
      onClick={handleClick}
      className={cn("shrink-0", className)}
    >
      {icon}
      {following ? "Following" : "Follow"}
    </Button>
  );
}

/** FollowTaskButton wired to the signed-in user's follows. */
export function FollowTaskToggle({
  issue,
  variant = "button",
  className,
}: {
  issue: { id: string; companyId: string; identifier: string | null; title: string };
  variant?: "button" | "icon";
  className?: string;
}) {
  const { followedIds } = useIssueFollows(issue.companyId);
  const mutation = useFollowIssue(issue.companyId);
  const taskName = issue.identifier ?? issue.title;
  const pending = mutation.isPending && mutation.variables?.issueId === issue.id;
  const following = pending ? mutation.variables!.follow : followedIds.has(issue.id);
  return (
    <FollowTaskButton
      following={following}
      pending={pending}
      taskName={taskName}
      variant={variant}
      className={className}
      onToggle={(follow) => mutation.mutate({ issueId: issue.id, follow, title: taskName })}
    />
  );
}

const ROLLUP_PARTS: ReadonlyArray<{
  key: Exclude<keyof IssueFollowRollupCounts, "total">;
  label: string;
  dot: string;
}> = [
  { key: "waitingOnYou", label: "waiting on you", dot: "bg-status-alert" },
  { key: "blocked", label: "blocked", dot: "bg-status-danger" },
  { key: "inProgress", label: "in progress", dot: "bg-status-running" },
  { key: "done", label: "done", dot: "bg-status-success" },
];

/** "3 of 8 done", the one-line progress used in the sidebar. */
export function followProgressLabel(counts: IssueFollowRollupCounts): string {
  return `${counts.done} of ${counts.total} done`;
}

/**
 * Progress of a followed task and everything under it (Desk): how much is
 * done, counts by state, and the latest comments or status changes.
 */
export function FollowRollupSummary({
  counts,
  latestUpdates = [],
  className,
}: {
  counts: IssueFollowRollupCounts;
  latestUpdates?: readonly IssueFollowRollupUpdate[];
  className?: string;
}) {
  const percent = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
  const bar = (
    <span
      role="progressbar"
      aria-label={followProgressLabel(counts)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="relative block h-1 w-full overflow-hidden rounded-full bg-muted"
    >
      <span className="absolute inset-y-0 left-0 rounded-full bg-status-success" style={{ width: `${percent}%` }} />
    </span>
  );

  const parts = ROLLUP_PARTS.filter((part) => counts[part.key] > 0);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} data-follow-rollup>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{followProgressLabel(counts)}</span>
        {parts.map((part) => (
          <span key={part.key} className="inline-flex items-center gap-1">
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", part.dot)} />
            {counts[part.key]} {part.label}
          </span>
        ))}
      </div>
      {bar}
      {latestUpdates.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Latest updates">
          {latestUpdates.map((update) => (
            <li key={`${update.kind}:${update.issueId}:${String(update.at)}`} className="flex min-w-0 items-baseline gap-2 text-xs">
              <Link
                to={`/issues/${update.issueIdentifier ?? update.issueId}`}
                className="shrink-0 font-mono text-muted-foreground hover:text-foreground hover:underline"
                title={update.issueTitle}
              >
                {update.issueIdentifier ?? update.issueTitle}
              </Link>
              <span className="min-w-0 flex-1 truncate">
                {update.kind === "status" ? `Moved to ${plainTaskStatus(update.summary).toLowerCase()}` : update.summary}
              </span>
              <span className="shrink-0 text-muted-foreground">{relativeTime(update.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
