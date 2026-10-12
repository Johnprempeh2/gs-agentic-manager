import { cn } from "../lib/utils";
import {
  describeTaskActivity,
  formatTaskActivityLine,
  type TaskActivityLineInput,
} from "../lib/task-activity-line";

export interface TaskActivityLineProps extends TaskActivityLineInput {
  className?: string;
}

/**
 * "Mica is working on it · waiting for Keystone's review": the one line at the
 * top of a task that says who is on it and what it waits for. Renders nothing
 * for finished or cancelled tasks.
 */
export function TaskActivityLine({ className, ...input }: TaskActivityLineProps) {
  const line = describeTaskActivity(input);
  if (!line) return null;
  return (
    <p
      data-testid="task-activity-line"
      title={formatTaskActivityLine(line)}
      className={cn("min-w-0 truncate text-sm text-foreground", className)}
    >
      {line.doing}
      {line.waitingFor ? (
        <span className="text-muted-foreground"> · waiting for {line.waitingFor}</span>
      ) : null}
    </p>
  );
}
