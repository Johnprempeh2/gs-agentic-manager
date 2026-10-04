import type { NeedsMe } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { StatusIcon } from "./StatusIcon";
import { issueUrl } from "../lib/utils";

interface NeedsMeListProps {
  needsMe: NeedsMe;
  /** Inbox shows decisions too; Decisions and Focus already show them as cards. */
  includeDecisions?: boolean;
  title?: string;
}

/** "1d 3h", "4d": how long a task has waited on the user or the board. */
export function formatWaitAge(ms: number) {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  if (days === 0) return `${hours}h`;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/**
 * The one "needs me" list (GRE-358), compact: tasks that have waited on the
 * user or the board for more than 24h, with their age (GRE-500), then open
 * decisions and tasks assigned to the user. Renders nothing when there is
 * nothing to show.
 */
export function NeedsMeList({ needsMe, includeDecisions = false, title }: NeedsMeListProps) {
  // "At your desk" cards wait for the computer, not this count (GRE-450).
  const waits = needsMe.overdueWaits ?? [];
  const waitIds = new Set(waits.map((wait) => wait.id));
  // A task that waits on you is listed once, as the wait.
  const decisions = includeDecisions
    ? needsMe.decisions.filter((card) => !card.atDesk && !(card.task && waitIds.has(card.task.id)))
    : [];
  const tasks = needsMe.assignedTasks;
  const shown = waits.length + decisions.length + tasks.length;
  if (shown === 0) return null;

  const heading = title ?? (includeDecisions || waits.length > 0 ? "Needs you" : "Assigned to you");

  return (
    <section aria-label={heading} className="space-y-2">
      <h2 className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
        {heading}
        <span className="tabular-nums text-muted-foreground" aria-label={`${shown} items`}>
          {shown}
        </span>
      </h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {waits.map((wait) => (
          <li key={wait.id}>
            <Link
              to={issueUrl(wait)}
              className="flex min-w-0 items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/50"
              title={wait.action || undefined}
            >
              <span className="shrink-0 rounded-sm bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                Waiting {formatWaitAge(wait.waitingForMs)}
              </span>
              <span className="min-w-0 truncate font-medium">{wait.title}</span>
              {wait.identifier ? (
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{wait.identifier}</span>
              ) : null}
            </Link>
          </li>
        ))}
        {decisions.map((card) => (
          <li key={card.id}>
            <Link
              to={card.task ? issueUrl(card.task) : "/decisions"}
              className="flex min-w-0 items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/50"
            >
              <span className="shrink-0 rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                Decision
              </span>
              <span className="min-w-0 truncate font-medium">{card.task?.title ?? card.title}</span>
              {card.task?.identifier ? (
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{card.task.identifier}</span>
              ) : null}
            </Link>
          </li>
        ))}
        {tasks.map((task) => (
          <li key={task.id}>
            <Link
              to={issueUrl(task)}
              className="flex min-w-0 items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/50"
            >
              <StatusIcon status={task.status} />
              <span className="min-w-0 truncate font-medium">{task.title}</span>
              {task.identifier ? (
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{task.identifier}</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
