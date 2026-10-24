import type { ReactNode } from "react";
import { TaskRunStateChip } from "@/components/TaskRunStateChip";
import { useTaskRunStateFor } from "@/hooks/useTaskRunStates";
import type { IssueTreeNode } from "@greatstone/shared";
import { ChevronDown, ChevronUp, KeyRound } from "lucide-react";
import { PriorityIcon } from "@/components/PriorityIcon";
import { StatusIcon } from "@/components/StatusIcon";
import { issueStatusAccent, issueStatusAccentDefault } from "@/lib/status-colors";
import { SHOW_TASK_PRIORITY_UI } from "@/lib/ui-flags";
import { cn } from "@/lib/utils";
import type { TreeBlockReason } from "@/lib/task-tree-block-reason";
import { ProgressRing } from "./ProgressRing";
import { TaskTreeBlockReason } from "./TaskTreeBlockReason";
import { TaskTreeOwner, type TaskTreePeople } from "./TaskTreeOwner";

/** Fixed card size, so the layout can place cards before they render. */
export const TASK_TREE_CARD_WIDTH = 248;
export const TASK_TREE_CARD_HEIGHT = 112;

export interface TaskTreeCardProps {
  node: IssueTreeNode;
  people: TaskTreePeople;
  isRoot?: boolean;
  /** On the path from the root to a root blocker. */
  onBlockedPath?: boolean;
  isRootBlocker?: boolean;
  /** Key of a blocker outside the tree that this task waits on. */
  waitingOn?: string | null;
  /** Why it is blocked; replaces the "Waiting on" pill when set. */
  blockReason?: TreeBlockReason | null;
  /** Tasks under this one; 0 hides the collapse toggle. */
  descendants?: number;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** A control in the card's footer, such as the project tree's Tidy button. */
  action?: ReactNode;
  className?: string;
}

/** Marks a task that drives its project. */
export function KeyTaskMark({ className }: { className?: string }) {
  return (
    <span
      data-key-task=""
      title="Key task: drives the project"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-xs font-medium text-foreground",
        className,
      )}
    >
      <KeyRound className="size-3 text-primary" aria-hidden="true" />
      Key
    </span>
  );
}

/**
 * One task in the tree: status edge, key, title (two lines), owner, sub-task
 * progress and priority. Danger ring and a "Root blocker" pill when it is the
 * task holding the work up. A blocked task gives its title one line and says
 * why it is blocked on the next.
 */
export function TaskTreeCard({
  node,
  people,
  isRoot = false,
  onBlockedPath = false,
  isRootBlocker = false,
  waitingOn = null,
  blockReason = null,
  descendants = 0,
  collapsed = false,
  onToggleCollapsed,
  action,
  className,
}: TaskTreeCardProps) {
  const showPriority = SHOW_TASK_PRIORITY_UI && node.priority !== "medium";
  const runState = useTaskRunStateFor(node);
  return (
    <div
      data-slot="task-tree-card"
      data-root-blocker={isRootBlocker ? "" : undefined}
      className={cn(
        "relative flex h-full w-full flex-col rounded-xl border border-border bg-card text-left shadow-sm transition-colors",
        "group-hover/tree-node:border-ring group-focus-visible/tree-node:border-ring",
        isRoot && "border-primary",
        onBlockedPath && !isRootBlocker && "border-status-danger/40",
        isRootBlocker && "border-status-danger ring-2 ring-status-danger/30",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-3 left-0 w-1 rounded-r-full",
          issueStatusAccent[node.status] ?? issueStatusAccentDefault,
        )}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 py-2.5 pl-4 pr-3">
        <div className="flex items-center gap-1.5">
          <StatusIcon status={node.status} size="sm" queued={runState?.kind === "queued"} />
          {node.identifier ? (
            <span className="truncate font-mono text-xs text-muted-foreground">{node.identifier}</span>
          ) : null}
          {node.isKeyTask ? <KeyTaskMark /> : null}
          {showPriority ? <PriorityIcon priority={node.priority} /> : null}
          {node.childCount > 0 ? (
            <ProgressRing done={node.doneChildCount} total={node.childCount} className="ml-auto" />
          ) : null}
        </div>
        <p
          className={cn("text-sm font-medium leading-snug text-foreground", blockReason ? "line-clamp-1" : "line-clamp-2")}
          title={node.title}
        >
          {node.title}
        </p>
        {blockReason ? <TaskTreeBlockReason reason={blockReason} compact /> : null}
        <div className="mt-auto flex min-w-0 items-center gap-2">
          <TaskTreeOwner people={people} owner={node} className="min-w-0 flex-1" />
          {runState ? <TaskRunStateChip state={runState} short /> : null}
          {isRootBlocker ? (
            <span className="shrink-0 rounded-full bg-status-danger-soft px-2 py-0.5 text-xs font-medium text-status-danger-foreground">
              Root blocker
            </span>
          ) : waitingOn && !blockReason ? (
            <span className="shrink-0 truncate rounded-full bg-status-danger-soft px-2 py-0.5 text-xs font-medium text-status-danger-foreground">
              Waiting on {waitingOn}
            </span>
          ) : null}
          {action}
        </div>
      </div>
      {descendants > 0 && onToggleCollapsed ? (
        <button
          type="button"
          data-tree-toggle=""
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapsed();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          aria-label={collapsed ? `Show ${descendants} sub-tasks` : "Hide sub-tasks"}
          aria-expanded={!collapsed}
          tabIndex={-1}
          className={cn(
            "absolute -bottom-3 left-1/2 inline-flex h-6 -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-card px-2 text-xs text-muted-foreground shadow-xs transition-colors",
            "hover:border-ring hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {collapsed ? (
            <>
              <ChevronDown className="size-3" aria-hidden="true" />
              <span className="tabular-nums">{descendants}</span>
            </>
          ) : (
            <ChevronUp className="size-3" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </div>
  );
}
