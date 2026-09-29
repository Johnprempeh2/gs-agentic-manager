import { AgentIdentity } from "@/components/AgentIdentity";
import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { Identity } from "./Identity";
import type { Issue, IssueStatus } from "@greatstone/shared";
import { AlertTriangle } from "lucide-react";
import { isSuccessfulRunHandoffRequired } from "../lib/successful-run-handoff";
import { collectSubtreeLiveCounts } from "../lib/liveIssueIds";
import { cn } from "../lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const KANBAN_BOARD_HIGH_VOLUME_THRESHOLD = 100;
export const KANBAN_COLUMN_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export type KanbanColumnPageSize = (typeof KANBAN_COLUMN_PAGE_SIZE_OPTIONS)[number];
export const KANBAN_COLUMN_DEFAULT_PAGE_SIZE: KanbanColumnPageSize = 10;
export const KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLUMN_REVEAL_INCREMENT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLD_STATUSES = ["backlog", "done", "cancelled"] as const;

export const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const satisfies readonly IssueStatus[];

const defaultKanbanColumnTone = {
  rail: "gs-lane gs-lane-neutral border-transparent",
  railOver: "gs-lane-over",
  header: "text-muted-foreground",
  count: "text-muted-foreground",
  body: "gs-lane gs-lane-neutral",
  bodyOver: "gs-lane gs-lane-neutral gs-lane-over",
  card: "",
};

// Every column carries its status hue (matching the app-wide status
// vocabulary: gray backlog, amber todo, blue in-progress, violet review,
// red blocked, green done) so no column reads as accidentally unstyled.
// Lanes are glass (gs-lane): the hue enters as a lit top edge and a tint that
// fades down, and deepens while a card is over the lane (gs-lane-over).
// Counts sit in a glass pill at full tone strength, never alpha-faded.
export const kanbanColumnTones: Partial<Record<IssueStatus, typeof defaultKanbanColumnTone>> = {
  backlog: {
    rail: "gs-lane gs-lane-neutral border-transparent",
    railOver: "gs-lane-over",
    header: "text-muted-foreground",
    count: "text-muted-foreground",
    body: "gs-lane gs-lane-neutral",
    bodyOver: "gs-lane gs-lane-neutral gs-lane-over",
    card: "",
  },
  todo: {
    rail: "gs-lane gs-lane-amber border-transparent",
    railOver: "gs-lane-over",
    header: "text-amber-700 dark:text-amber-300",
    count: "text-amber-700 dark:text-amber-300",
    body: "gs-lane gs-lane-amber",
    bodyOver: "gs-lane gs-lane-amber gs-lane-over",
    card: "",
  },
  in_progress: {
    rail: "gs-lane gs-lane-blue border-transparent",
    railOver: "gs-lane-over",
    header: "text-blue-700 dark:text-blue-300",
    count: "text-blue-700 dark:text-blue-300",
    body: "gs-lane gs-lane-blue",
    bodyOver: "gs-lane gs-lane-blue gs-lane-over",
    card: "",
  },
  blocked: {
    rail: "gs-lane gs-lane-red border-transparent",
    railOver: "gs-lane-over",
    header: "text-red-700 dark:text-red-300",
    count: "text-red-700 dark:text-red-300",
    body: "gs-lane gs-lane-red",
    bodyOver: "gs-lane gs-lane-red gs-lane-over",
    card: "",
  },
  in_review: {
    rail: "gs-lane gs-lane-violet border-transparent",
    railOver: "gs-lane-over",
    header: "text-violet-700 dark:text-violet-300",
    count: "text-violet-700 dark:text-violet-300",
    body: "gs-lane gs-lane-violet",
    bodyOver: "gs-lane gs-lane-violet gs-lane-over",
    card: "",
  },
  done: {
    rail: "gs-lane gs-lane-green border-transparent",
    railOver: "gs-lane-over",
    header: "text-green-700 dark:text-green-300",
    count: "text-green-700 dark:text-green-300",
    body: "gs-lane gs-lane-green",
    bodyOver: "gs-lane gs-lane-green gs-lane-over",
    card: "",
  },
  cancelled: {
    rail: "border-neutral-300/70 bg-muted/25 opacity-80 dark:border-neutral-700/70 dark:bg-neutral-900/20",
    railOver: "bg-muted/45 opacity-90 ring-1 ring-neutral-400/25 dark:bg-neutral-900/35",
    header: "text-subtle-foreground",
    count: "text-subtle-foreground",
    body: "bg-muted/25 ring-1 ring-inset ring-border/50",
    bodyOver: "bg-muted/45 ring-1 ring-inset ring-neutral-400/25",
    card: "bg-muted/35 text-muted-foreground opacity-80 hover:shadow-none",
  },
};

export function getKanbanColumnTone(status: IssueStatus) {
  return kanbanColumnTones[status] ?? defaultKanbanColumnTone;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function resolveKanbanTargetStatus(overId: string, issues: Issue[]): IssueStatus | null {
  if ((boardStatuses as readonly string[]).includes(overId)) {
    return overId as IssueStatus;
  }
  return issues.find((issue) => issue.id === overId)?.status ?? null;
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  compactCards?: boolean;
  collapsedStatuses?: string[];
  initialVisibleCount?: number;
  revealIncrement?: number;
  /** Lanes to render, in order. Defaults to every board status. */
  statuses?: readonly IssueStatus[];
  /** Show the task key (GRE-123) on cards. The dashboard shows titles only. */
  showIdentifiers?: boolean;
  /** Lanes share the row's width instead of a fixed width each. */
  fillWidth?: boolean;
  /** Without it the board is read-only: cards link out but cannot be dragged. */
  onUpdateIssue?: (id: string, data: Record<string, unknown>) => void;
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  issues,
  agents,
  liveIssueIds,
  subtreeLiveCounts,
  compactCards = false,
  collapsed = false,
  showIdentifiers = true,
  fillWidth = false,
  readOnly = false,
  visibleCount,
  revealIncrement,
  onShowMore,
}: {
  status: IssueStatus;
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  subtreeLiveCounts?: ReadonlyMap<string, number>;
  compactCards?: boolean;
  collapsed?: boolean;
  showIdentifiers?: boolean;
  fillWidth?: boolean;
  readOnly?: boolean;
  visibleCount: number;
  revealIncrement: number;
  onShowMore: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  const isEmpty = issues.length === 0;
  const visibleIssues = collapsed ? [] : issues.slice(0, visibleCount);
  const hiddenCount = Math.max(issues.length - visibleIssues.length, 0);
  const nextRevealCount = Math.min(revealIncrement, hiddenCount);
  const tone = getKanbanColumnTone(status);

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-(--sz-220px) w-(--sz-52px) shrink-0 flex-col items-center rounded-xl border px-1.5 py-2 transition-colors",
          tone.rail,
          isOver && tone.railOver,
        )}
        title={`${statusLabel(status)}: ${issues.length}`}
      >
        <StatusIcon status={status} />
        <span className={cn("mt-2 [writing-mode:vertical-rl] rotate-180 text-(length:--text-nano) font-semibold uppercase tracking-wide", tone.header)}>
          {statusLabel(status)}
        </span>
        <Badge variant="ghost" className={cn("mt-auto bg-background px-1.5 text-(length:--text-nano) tabular-nums", tone.header)}>
          {issues.length}
        </Badge>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col",
        fillWidth ? "min-w-(--sz-220px) flex-1 basis-0" : "shrink-0 min-w-(--sz-260px) w-(--sz-260px)",
      )}
      data-testid={`kanban-column-${status}`}
    >
      <div className="flex items-center gap-2 px-3 py-2 mb-1">
        <StatusIcon status={status} />
        <span className={cn("text-xs font-semibold uppercase tracking-wide", tone.header)}>
          {statusLabel(status)}
        </span>
        <span className={cn("gs-count-pill ml-auto text-xs tabular-nums", tone.count)}>
          {issues.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex-1 min-h-(--sz-120px) rounded-xl p-2 space-y-2 transition-colors",
          isOver ? tone.bodyOver : tone.body,
        )}
      >
        {/* Hidden cards are intentionally excluded from sort targets until revealed. */}
        <SortableContext
          items={visibleIssues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {visibleIssues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              isLive={liveIssueIds?.has(issue.id)}
              subtreeLiveCount={subtreeLiveCounts?.get(issue.id) ?? 0}
              compact={compactCards}
              showIdentifier={showIdentifiers}
              readOnly={readOnly}
              className={tone.card}
            />
          ))}
        </SortableContext>
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="mt-1 flex w-full items-center justify-center rounded-md border border-dashed border-border bg-background/70 px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            onClick={onShowMore}
          >
            Show {nextRevealCount} more
          </button>
        ) : null}
        {issues.length > 0 && (hiddenCount > 0 || issues.length >= visibleCount) ? (
          <p className="px-1 pt-1 text-(length:--text-micro) text-muted-foreground">
            Showing {visibleIssues.length} of {issues.length}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  isLive,
  subtreeLiveCount = 0,
  isOverlay,
  compact = false,
  showIdentifier = true,
  readOnly = false,
  className,
}: {
  issue: Issue;
  agents?: Agent[];
  isLive?: boolean;
  subtreeLiveCount?: number;
  isOverlay?: boolean;
  compact?: boolean;
  showIdentifier?: boolean;
  readOnly?: boolean;
  className?: string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue }, disabled: readOnly });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handoffRequired = isSuccessfulRunHandoffRequired(issue);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "block",
        !readOnly && "cursor-grab active:cursor-grabbing",
        isDragging && !isOverlay ? "opacity-30" : "",
        isOverlay ? "gs-drag-lift" : "gs-glass-card-interactive",
        compact ? "p-2" : "p-2.5",
        className,
      )}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        disableIssueQuicklook
        className="block no-underline text-inherit"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        {showIdentifier || handoffRequired || isLive || subtreeLiveCount > 0 ? (
        <div className={`flex items-start gap-1.5 ${compact ? "mb-1" : "mb-1.5"}`}>
          {showIdentifier ? (
            <span className="text-xs text-muted-foreground font-mono shrink-0">
              {issue.identifier ?? issue.id.slice(0, 8)}
            </span>
          ) : null}
          {handoffRequired ? (
            <Badge variant="outline"
              className="border-amber-400/45 bg-amber-50/60 px-1.5 text-(length:--text-nano) text-amber-700 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300"
              title="This task needs a next step"
              aria-label="Needs next step"
            >
              <AlertTriangle className="h-3 w-3" />
              Next step
            </Badge>
          ) : null}
          {isLive && (
            <span className="inline-flex shrink-0 items-center gap-1 text-(length:--text-nano) font-medium text-blue-600 dark:text-blue-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              {compact ? "Live" : null}
            </span>
          )}
          {!isLive && subtreeLiveCount > 0 && (
            <Badge variant="outline"
              className="border-border px-1.5 text-(length:--text-nano) text-muted-foreground"
              title={`${subtreeLiveCount} sub-task${subtreeLiveCount === 1 ? "" : "s"} running below`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/60" aria-hidden="true" />
              {subtreeLiveCount} live below
            </Badge>
          )}
        </div>
        ) : null}
        <p className={`${compact ? "mb-1.5 text-xs" : "mb-2 text-sm"} leading-snug line-clamp-2`}>{issue.title}</p>
        <div className="flex items-center gap-2 min-w-0">
          {/* PAP-411: priority UI hidden behind SHOW_TASK_PRIORITY_UI. */}
          {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority={issue.priority} />}
          {issue.assigneeAgentId && (() => {
            const name = agentName(issue.assigneeAgentId);
            return name ? (
              <AgentIdentity agent={agents?.find((agent) => agent.id === issue.assigneeAgentId) ?? { id: issue.assigneeAgentId, name }} size="xs" />
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                {issue.assigneeAgentId.slice(0, 8)}
              </span>
            );
          })()}
        </div>
      </Link>
    </Card>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  liveIssueIds,
  compactCards = false,
  collapsedStatuses = [],
  initialVisibleCount = KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT,
  revealIncrement = KANBAN_COLUMN_REVEAL_INCREMENT,
  statuses = boardStatuses,
  showIdentifiers = true,
  fillWidth = false,
  onUpdateIssue,
}: KanbanBoardProps) {
  const readOnly = !onUpdateIssue;
  const [activeId, setActiveId] = useState<string | null>(null);
  const paginationKey = `${initialVisibleCount}:${revealIncrement}`;
  const [visibleState, setVisibleState] = useState<{
    paginationKey: string;
    counts: Record<string, number>;
  }>({ paginationKey, counts: {} });
  const visibleCountByStatus = visibleState.paginationKey === paginationKey ? visibleState.counts : {};
  const collapsedStatusSet = useMemo(() => new Set(collapsedStatuses), [collapsedStatuses]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const columnIssues = useMemo(() => {
    const grouped: Record<IssueStatus, Issue[]> = {} as Record<IssueStatus, Issue[]>;
    for (const status of boardStatuses) {
      grouped[status] = [];
    }
    for (const issue of issues) {
      if (grouped[issue.status]) {
        grouped[issue.status].push(issue);
      }
    }
    return grouped;
  }, [issues]);

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  const subtreeLiveCounts = useMemo(
    () => collectSubtreeLiveCounts(issues, liveIssueIds ?? new Set<string>()),
    [issues, liveIssueIds],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    // Determine target status: the "over" could be a column id (status string)
    // or another card's id. Find which column the "over" belongs to.
    const targetStatus = resolveKanbanTargetStatus(over.id as string, issues);

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue?.(issueId, { status: targetStatus });
    }
  }

  function handleDragOver(_event: DragOverEvent) {
    // Could be used for visual feedback; keeping simple for now
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
        {statuses.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            issues={columnIssues[status] ?? []}
            agents={agents}
            liveIssueIds={liveIssueIds}
            subtreeLiveCounts={subtreeLiveCounts}
            compactCards={compactCards}
            showIdentifiers={showIdentifiers}
            fillWidth={fillWidth}
            readOnly={readOnly}
            // Compact mode (any lane explicitly collapsed) also collapses
            // empty lanes to the same labeled rail, so an empty In Progress
            // reads like the other rails instead of a lone expanded column.
            collapsed={collapsedStatusSet.has(status) || (collapsedStatusSet.size > 0 && columnIssues[status].length === 0)}
            visibleCount={visibleCountByStatus[status] ?? initialVisibleCount}
            revealIncrement={revealIncrement}
            onShowMore={() => {
              setVisibleState((current) => {
                const counts = current.paginationKey === paginationKey ? current.counts : {};
                return {
                  paginationKey,
                  counts: {
                    ...counts,
                    [status]: (counts[status] ?? initialVisibleCount) + revealIncrement,
                  },
                };
              });
            }}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard issue={activeIssue} agents={agents} isOverlay compact={compactCards} showIdentifier={showIdentifiers} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
