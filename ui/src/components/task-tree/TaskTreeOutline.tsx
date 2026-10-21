import type { ReactNode } from "react";
import type { IssueTreeNode } from "@greatstone/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Link } from "@/lib/router";
import { StatusIcon } from "@/components/StatusIcon";
import type { BlockedTrace, VisibleItem, VisibleTaskItem } from "@/lib/task-tree";
import { cn } from "@/lib/utils";
import { ProgressRing } from "./ProgressRing";
import { KeyTaskMark } from "./TaskTreeCard";
import { TaskTreeOwner, type TaskTreePeople } from "./TaskTreeOwner";

export interface TaskTreeOutlineProps {
  visibleRoot: VisibleTaskItem;
  trace: BlockedTrace;
  people: TaskTreePeople;
  hrefFor: (item: VisibleTaskItem) => string;
  waitingOnById?: ReadonlyMap<string, string>;
  onToggleCollapsed: (id: string) => void;
  onShowFinished: () => void;
  /** Row to bring into view and highlight. */
  highlightId?: string | null;
  /** A control at the end of a row. */
  actionFor?: (node: IssueTreeNode) => ReactNode;
  className?: string;
}

/**
 * The tree on a phone: an indented outline with the same status colours.
 * Rows on the blocked path carry a red rail down their left edge.
 */
export function TaskTreeOutline({
  visibleRoot,
  trace,
  people,
  hrefFor,
  waitingOnById,
  onToggleCollapsed,
  onShowFinished,
  highlightId,
  actionFor,
  className,
}: TaskTreeOutlineProps) {
  const row = (item: VisibleItem, depth: number) => {
    const indent = { paddingLeft: depth * 16 + 4 };
    if (item.kind === "done") {
      return (
        <li key={item.id} role="treeitem" aria-level={depth + 1} aria-selected={false}>
          <button
            type="button"
            onClick={onShowFinished}
            style={indent}
            className="flex min-h-11 w-full items-center gap-2 rounded-md pr-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent/50"
          >
            <span className="inline-block size-5 shrink-0" aria-hidden="true" />
            <StatusIcon status="done" size="sm" />+{item.count} done
          </button>
        </li>
      );
    }
    const node = item.node;
    const onPath = trace.pathNodeIds.has(node.id);
    const isRootBlocker = trace.rootBlockers.some((blocker) => blocker.inTree && blocker.id === node.id);
    const waitingOn = waitingOnById?.get(node.id);
    const hasChildren = item.descendants > 0;
    return (
      <li
        key={item.id}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={false}
        aria-expanded={hasChildren ? !item.collapsed : undefined}
        data-outline-node={node.id}
        data-on-blocked-path={onPath ? "" : undefined}
      >
        <div
          style={indent}
          className={cn(
            "relative flex min-h-11 items-center gap-2 rounded-md pr-2",
            highlightId === node.id && "bg-accent",
          )}
        >
          <span
            aria-hidden="true"
            className={cn("absolute inset-y-1 left-0 w-0.5 rounded-full", onPath ? "bg-status-danger" : "bg-transparent")}
          />
          {hasChildren ? (
            <button
              type="button"
              onClick={() => onToggleCollapsed(node.id)}
              aria-label={item.collapsed ? `Show ${item.descendants} sub-tasks` : "Hide sub-tasks"}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {item.collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
          ) : (
            <span className="inline-block size-5 shrink-0" aria-hidden="true" />
          )}
          <StatusIcon status={node.status} size="sm" />
          <Link to={hrefFor(item)} className="min-w-0 flex-1 py-2 text-sm">
            <span className={cn("line-clamp-2 text-foreground", depth === 0 ? "font-semibold" : "font-medium")}>{node.title}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-2">
              {node.identifier ? <span className="font-mono text-xs text-muted-foreground">{node.identifier}</span> : null}
              {node.isKeyTask ? <KeyTaskMark /> : null}
              <TaskTreeOwner people={people} owner={node} className="min-w-0" />
            </span>
            {isRootBlocker || waitingOn ? (
              <span className="mt-1 inline-flex max-w-full truncate rounded-full bg-status-danger-soft px-2 py-0.5 text-xs font-medium text-status-danger-foreground">
                {isRootBlocker ? "Root blocker" : `Waiting on ${waitingOn}`}
              </span>
            ) : null}
          </Link>
          {actionFor?.(node)}
          {node.childCount > 0 ? <ProgressRing done={node.doneChildCount} total={node.childCount} /> : null}
        </div>
        {item.children.length > 0 ? (
          <ul role="group">{item.children.map((child) => row(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <ul role="tree" aria-label="Task tree" data-slot="task-tree-outline" className={cn("space-y-0.5", className)}>
      {row(visibleRoot, 0)}
    </ul>
  );
}
