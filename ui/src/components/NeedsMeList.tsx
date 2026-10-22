import type { NeedsMe } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { StatusIcon } from "./StatusIcon";
import { issueUrl } from "../lib/utils";

interface NeedsMeListProps {
  needsMe: NeedsMe;
  /** Inbox Mine lists assigned tasks; the Desk's Decisions section does not (GRE-586). */
  includeAssigned?: boolean;
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
 * Compact rows: tasks that have waited on the user or the board for more
 * than 24h, with their age (GRE-500), agents' questions that expired
 * unanswered, then tasks assigned to the user. Decision cards render as cards
 * elsewhere. Renders nothing when there is nothing to show.
 */
export function NeedsMeList({ needsMe, includeAssigned = true, title }: NeedsMeListProps) {
  // A wait with a decision card is shown (and counted) as that card.
  const cardTaskIds = new Set(needsMe.decisions.map((card) => card.task?.id).filter(Boolean));
  const waits = (needsMe.overdueWaits ?? []).filter((wait) => !cardTaskIds.has(wait.id));
  const tasks = includeAssigned ? needsMe.assignedTasks : [];
  // Questions from agents that expired before anyone answered them.
  const expiredCards = needsMe.expiredCards ?? [];
  const overdue = waits.length + expiredCards.length;
  const shown = overdue + tasks.length;
  if (shown === 0) return null;

  // Overdue rows are part of the Decisions count shown above them, so they
  // carry no second number. Assigned tasks are counted on their own.
  const heading = title ?? (overdue > 0 ? "Overdue" : "Assigned to you");
  const showCount = overdue === 0;

  return (
    <section aria-label={heading} className="space-y-2">
      <h2 className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
        {heading}
        {showCount ? (
          <span className="tabular-nums text-muted-foreground" aria-label={`${shown} items`}>
            {shown}
          </span>
        ) : null}
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
              <span className="min-w-0 line-clamp-2 font-medium sm:truncate">{wait.title}</span>
              {wait.identifier ? (
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{wait.identifier}</span>
              ) : null}
            </Link>
          </li>
        ))}
        {expiredCards.map((card) => (
          <li key={card.interactionId} data-testid="needs-me-expired-card">
            <Link
              to={issueUrl(card)}
              className="flex min-w-0 items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/50"
              title={card.question ? `Unanswered: ${card.question}` : undefined}
            >
              <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                Question expired
              </span>
              <span className="min-w-0 line-clamp-2 font-medium sm:truncate">{card.question ?? card.title}</span>
              {card.identifier ? (
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{card.identifier}</span>
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
              <span className="min-w-0 line-clamp-2 font-medium sm:truncate">{task.title}</span>
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
