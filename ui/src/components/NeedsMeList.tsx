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

/**
 * The one "needs me" list (GRE-358), compact: open decisions and tasks
 * assigned to the user. Renders nothing when there is nothing to show.
 */
export function NeedsMeList({ needsMe, includeDecisions = false, title }: NeedsMeListProps) {
  // "At your desk" cards wait for the computer, not this count (GRE-450).
  const decisions = includeDecisions ? needsMe.decisions.filter((card) => !card.atDesk) : [];
  const tasks = needsMe.assignedTasks;
  const shown = decisions.length + tasks.length;
  if (shown === 0) return null;

  const heading = title ?? (includeDecisions ? "Needs you" : "Assigned to you");

  return (
    <section aria-label={heading} className="space-y-2">
      <h2 className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
        {heading}
        <span className="tabular-nums text-muted-foreground" aria-label={`${shown} items`}>
          {shown}
        </span>
      </h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
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
