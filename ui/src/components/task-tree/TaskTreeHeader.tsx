import type { ReactNode } from "react";
import type { IssueTreeNode } from "@greatstone/shared";
import { CircleCheck } from "lucide-react";
import { StatusIcon } from "@/components/StatusIcon";
import type { RootBlocker } from "@/lib/task-tree";
import { cn } from "@/lib/utils";
import { ownerName, TaskTreeOwner, type TaskTreePeople } from "./TaskTreeOwner";

export interface TaskTreeStatusCounts {
  done: number;
  active: number;
  blocked: number;
  waiting: number;
}

/** Sub-tasks under the root by state, cancelled ones left out. */
export function countTreeStatuses(nodes: Iterable<IssueTreeNode>, rootId: string): TaskTreeStatusCounts {
  const counts = { done: 0, active: 0, blocked: 0, waiting: 0 };
  for (const node of nodes) {
    if (node.id === rootId || node.status === "cancelled") continue;
    if (node.status === "done") counts.done += 1;
    else if (node.status === "in_progress" || node.status === "in_review") counts.active += 1;
    else if (node.status === "blocked") counts.blocked += 1;
    else counts.waiting += 1;
  }
  return counts;
}

const SEGMENTS: { key: keyof TaskTreeStatusCounts; label: string; fill: string }[] = [
  { key: "done", label: "done", fill: "bg-status-success" },
  { key: "active", label: "in progress", fill: "bg-status-running" },
  { key: "blocked", label: "blocked", fill: "bg-status-danger" },
  { key: "waiting", label: "not started", fill: "bg-muted-foreground" },
];

export interface TaskTreeHeaderProps {
  root: IssueTreeNode;
  counts: TaskTreeStatusCounts;
  rootBlockers: RootBlocker[];
  people: TaskTreePeople;
  onSelectBlocker?: (blocker: RootBlocker) => void;
  /** Shown when the tree was cut short. */
  truncatedNote?: string | null;
  /** A line under the title, such as who leads the project. */
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * Above the tree: the root task, overall progress ("18 of 24 done") and
 * "What is holding this up": every root blocker as a chip, anything waiting
 * on the viewer first.
 */
export function TaskTreeHeader({
  root,
  counts,
  rootBlockers,
  people,
  onSelectBlocker,
  truncatedNote,
  subtitle,
  actions,
  className,
}: TaskTreeHeaderProps) {
  return (
    <section
      data-slot="task-tree-header"
      aria-label="Task tree summary"
      className={cn("space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm", className)}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <StatusIcon status={root.status} size="sm" />
            {root.identifier ? <span className="font-mono text-xs text-muted-foreground">{root.identifier}</span> : null}
          </div>
          <h1 className="text-xl font-bold leading-tight text-foreground">{root.title}</h1>
          {subtitle ? <div className="text-sm text-muted-foreground">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>

      <TaskTreeProgress counts={counts} />

      <div className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">What is holding this up</h2>
        {rootBlockers.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleCheck className="size-4 shrink-0 text-status-success" aria-hidden="true" />
            Nothing is blocked.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {rootBlockers.map((blocker) => (
              <li key={blocker.id} className="min-w-0 max-w-full">
                <button
                  type="button"
                  onClick={() => onSelectBlocker?.(blocker)}
                  data-blocker-chip={blocker.id}
                  title={`Show ${blocker.identifier ?? blocker.title} in the tree`}
                  className={cn(
                    "flex min-w-0 max-w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    blocker.waitingOnViewer
                      ? "border-status-warning/40 bg-status-warning-soft hover:border-status-warning"
                      : "border-status-danger/30 bg-status-danger-soft hover:border-status-danger",
                  )}
                >
                  <TaskTreeOwner people={people} owner={blocker} className="shrink-0 [&>span:last-child]:hidden" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {blocker.identifier ? <span className="font-mono text-xs text-muted-foreground">{blocker.identifier} </span> : null}
                      {blocker.title}
                    </span>
                    <span
                      className={cn(
                        "block truncate text-xs",
                        blocker.waitingOnViewer ? "text-status-warning-foreground" : "text-status-danger-foreground",
                      )}
                    >
                      {blocker.waitingOnViewer ? "Waiting on you" : (ownerName(people, blocker) ?? "No owner")}
                      {" · "}
                      {blocker.need}
                      {blocker.inTree ? null : " · outside this tree"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {truncatedNote ? <p className="text-xs text-muted-foreground">{truncatedNote}</p> : null}
    </section>
  );
}

/** "18 of 24 done", the bar and the counts by state. Also on the Website page. */
export function TaskTreeProgress({ counts, className }: { counts: TaskTreeStatusCounts; className?: string }) {
  const total = counts.done + counts.active + counts.blocked + counts.waiting;
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-sm text-foreground">
        <span className="font-semibold tabular-nums">{counts.done}</span>
        <span className="text-muted-foreground"> of </span>
        <span className="font-semibold tabular-nums">{total}</span>
        <span className="text-muted-foreground"> done</span>
      </p>
      <div
        className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Sub-tasks done"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={counts.done}
        aria-valuetext={`${counts.done} of ${total} done`}
      >
        {SEGMENTS.filter((segment) => segment.key !== "waiting" && counts[segment.key] > 0).map((segment) => (
          <span
            key={segment.key}
            className={cn("h-full first:rounded-l-full", segment.fill)}
            style={{ width: `${(counts[segment.key] / Math.max(total, 1)) * 100}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {SEGMENTS.map((segment) => (
          <li key={segment.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-2 rounded-full", segment.fill)} />
            <span className="tabular-nums text-foreground">{counts[segment.key]}</span> {segment.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
