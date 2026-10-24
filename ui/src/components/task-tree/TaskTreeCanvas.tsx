import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { TaskRunStateChip } from "@/components/TaskRunStateChip";
import { useTaskRunStateFor } from "@/hooks/useTaskRunStates";
import type { IssueTreeNode } from "@greatstone/shared";
import { DiagramFrame, type DiagramFindItem } from "@/components/diagram/DiagramFrame";
import { fitView, useDiagramViewport, type DiagramView } from "@/components/diagram/useDiagramViewport";
import { StatusIcon } from "@/components/StatusIcon";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  connectorPath,
  edgeKey,
  flattenVisible,
  layoutTidyTree,
  type BlockedTrace,
  type LayoutBox,
  type TreeLayout,
  type VisibleItem,
  type VisibleTaskItem,
} from "@/lib/task-tree";
import { taskStatusLabel } from "@/lib/task-status-labels";
import { cn, relativeTime } from "@/lib/utils";
import { TASK_TREE_CARD_HEIGHT, TASK_TREE_CARD_WIDTH, TaskTreeCard } from "./TaskTreeCard";
import { ownerName, type TaskTreePeople } from "./TaskTreeOwner";

const DONE_PILL = { width: 112, height: 32 };
const LAYOUT = { siblingGap: 28, levelGap: 72, padding: 48 };
/** The tree opens no smaller than this; past it, the root stays in view instead. "Fit to screen" shows it all. */
const MIN_READABLE_ZOOM = 0.6;
const FIT_MARGIN = 32;
const GRID = 20;

export type TaskTreeView = DiagramView;

export interface TaskTreeCanvasProps {
  visibleRoot: VisibleTaskItem;
  trace: BlockedTrace;
  people: TaskTreePeople;
  /** Blocker outside the tree that each task waits on, by task id. */
  waitingOnById?: ReadonlyMap<string, string>;
  onOpen: (node: IssueTreeNode) => void;
  onToggleCollapsed: (id: string) => void;
  onShowFinished: () => void;
  /** Pan to this item; bump `nonce` to pan again to the same one. */
  focusRequest?: { id: string; nonce: number } | null;
  /** A control for a card's footer. */
  actionFor?: (node: IssueTreeNode) => ReactNode;
  /** Remembers zoom and place for this tree. */
  storageKey?: string;
  /** Every task "Find" can jump to, folded or not. */
  findItems?: DiagramFindItem[];
  /** Unfold the way to a task and bring it into view (sets `focusRequest`). */
  onFind?: (id: string) => void;
  onCollapseAll?: () => void;
  onExpandAll?: () => void;
  /** Open in full screen straight away (the phone opens the diagram this way). */
  startFullscreen?: boolean;
  onExitFullscreen?: () => void;
  className?: string;
}

function cssMilliseconds(name: string, fallback: number) {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith("ms") ? value : raw.endsWith("s") ? value * 1000 : value;
}

type Point = { x: number; y: number };

/** Cards glide to their new place when the layout changes; new ones grow out of their parent. */
function useGlide(layout: TreeLayout, reduced: boolean) {
  const target = useMemo(() => new Map(layout.boxes.map((box) => [box.id, { x: box.x, y: box.y }])), [layout]);
  const [frame, setFrame] = useState(target);
  const shown = useRef<Map<string, Point>>(new Map());

  useLayoutEffect(() => {
    const from = shown.current;
    if (reduced || from.size === 0) {
      shown.current = target;
      setFrame(target);
      return;
    }
    const duration = cssMilliseconds("--motion-task-tree-glide", 240);
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / Math.max(duration, 1));
      const ease = 1 - (1 - t) ** 3;
      const next = new Map<string, Point>();
      for (const box of layout.boxes) {
        const end = target.get(box.id)!;
        const origin = from.get(box.id) ?? (box.parentId ? from.get(box.parentId) : undefined) ?? end;
        next.set(box.id, { x: origin.x + (end.x - origin.x) * ease, y: origin.y + (end.y - origin.y) * ease });
      }
      shown.current = next;
      setFrame(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [layout, target, reduced]);

  return frame;
}

/**
 * The tree on a pannable, zoomable canvas: SVG connectors under HTML cards.
 * Drag or scroll to pan; Ctrl or Cmd with the wheel, pinch, + and - or the
 * buttons to zoom; 0 fits. Arrow keys move between tasks, Enter opens one,
 * Space folds its branch. Find, fold all, minimap and full screen come from
 * the shared DiagramFrame.
 */
export function TaskTreeCanvas({
  visibleRoot,
  trace,
  people,
  waitingOnById,
  onOpen,
  onToggleCollapsed,
  onShowFinished,
  focusRequest,
  actionFor,
  storageKey,
  findItems,
  onFind,
  onCollapseAll,
  onExpandAll,
  startFullscreen,
  onExitFullscreen,
  className,
}: TaskTreeCanvasProps) {
  const reduced = usePrefersReducedMotion();

  const layout = useMemo(
    () =>
      layoutTidyTree(visibleRoot, {
        sizeOf: (item) =>
          item.kind === "done" ? DONE_PILL : { width: TASK_TREE_CARD_WIDTH, height: TASK_TREE_CARD_HEIGHT },
        ...LAYOUT,
      }),
    [visibleRoot],
  );
  const items = useMemo(() => new Map(flattenVisible(visibleRoot).map((item) => [item.id, item])), [visibleRoot]);
  const positions = useGlide(layout, reduced);
  const boxAt = useCallback(
    (id: string): LayoutBox | null => {
      const box = layout.byId.get(id);
      if (!box) return null;
      const point = positions.get(id) ?? box;
      return { ...box, x: point.x, y: point.y };
    },
    [layout, positions],
  );

  // ── View ────────────────────────────────────────────────────────────────
  // Where the tree opens and "Reset" returns to: the whole tree when it fits
  // and still reads; otherwise cards stay legible with the top of the tree in
  // view, centred on the span from the root to the first root blocker, so the
  // task holding everything up is on screen when the tree opens.
  const home = useCallback(
    (viewport: { width: number; height: number }): TaskTreeView => {
      const whole = fitView(layout, viewport);
      if (whole.k >= MIN_READABLE_ZOOM) return { ...whole, y: Math.max(FIT_MARGIN, whole.y) };
      const k = MIN_READABLE_ZOOM;
      const rootBox = layout.boxes.find((box) => box.depth === 0);
      const blockerBox = trace.rootBlockers
        .map((blocker) => layout.byId.get(blocker.anchorId))
        .find((box) => box !== undefined);
      const span = [rootBox, blockerBox].filter((box): box is NonNullable<typeof box> => box !== undefined);
      const left = span.length ? Math.min(...span.map((box) => box.x)) : 0;
      const right = span.length ? Math.max(...span.map((box) => box.x + box.width)) : layout.width;
      return { k, x: viewport.width / 2 - ((left + right) / 2) * k, y: FIT_MARGIN - (rootBox?.y ?? 0) * k };
    },
    [layout, trace],
  );
  const viewport = useDiagramViewport({ content: layout, storageKey: storageKey ? `${storageKey}.view` : undefined, home });
  const { view, viewportRef, reveal, suppressClick } = viewport;

  const panTo = useCallback(
    (id: string, onlyIfHidden = false) => {
      const box = layout.byId.get(id);
      if (box) reveal(box, onlyIfHidden);
    },
    [layout, reveal],
  );

  useEffect(() => {
    if (!focusRequest) return;
    panTo(focusRequest.id);
    setFocusedId(focusRequest.id);
    const element = viewportRef.current?.querySelector<HTMLElement>(`[data-tree-node="${focusRequest.id}"]`);
    element?.focus({ preventScroll: true });
    // Pan only when asked, not on every layout change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

// ── Keyboard and focus ──────────────────────────────────────────────────
  const [focusedId, setFocusedId] = useState<string>(visibleRoot.id);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const activeFocusId = items.has(focusedId) ? focusedId : visibleRoot.id;

  const moveFocus = (id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    setKeyboardFocus(true);
    const element = viewportRef.current?.querySelector<HTMLElement>(`[data-tree-node="${id}"]`);
    element?.focus({ preventScroll: true });
    panTo(id, true);
  };

  const activate = (item: VisibleItem) => {
    if (item.kind === "done") onShowFinished();
    else onOpen(item.node);
  };

  const onNodeKeyDown = (event: KeyboardEvent<HTMLElement>, item: VisibleItem) => {
    const box = layout.byId.get(item.id);
    if (!box) return;
    const row = layout.boxes.filter((other) => other.depth === box.depth).sort((a, b) => a.x - b.x);
    const at = row.findIndex((other) => other.id === item.id);
    switch (event.key) {
      case "ArrowDown": {
        const kids = item.kind === "task" ? item.children : [];
        event.preventDefault();
        if (item.kind === "task" && item.collapsed) onToggleCollapsed(item.id);
        else moveFocus(kids[Math.floor((kids.length - 1) / 2)]?.id);
        break;
      }
      case "ArrowUp":
        event.preventDefault();
        moveFocus(box.parentId ?? undefined);
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveFocus(row[at - 1]?.id);
        break;
      case "ArrowRight":
        event.preventDefault();
        moveFocus(row[at + 1]?.id);
        break;
      case "Enter":
        event.preventDefault();
        activate(item);
        break;
      case " ":
        if (item.kind === "task" && item.descendants > 0) {
          event.preventDefault();
          onToggleCollapsed(item.id);
        }
        break;
      default:
    }
  };

  // ── Find ────────────────────────────────────────────────────────────────
  const [foundId, setFoundId] = useState<string | null>(null);
  const find = useMemo(
    () =>
      findItems && onFind
        ? {
            items: findItems,
            onPick: (id: string) => {
              setFoundId(id);
              onFind(id);
            },
          }
        : undefined,
    [findItems, onFind],
  );

  // ── Paint ───────────────────────────────────────────────────────────────
  const hoverItem = hoveredId ? items.get(hoveredId) : keyboardFocus ? items.get(activeFocusId) : undefined;
  const hoverBox = hoverItem?.kind === "task" ? boxAt(hoverItem.id) : null;

  // The cards and lines do not depend on the view, so panning and zooming
  // only move the layer: smooth with hundreds of tasks.
  const layer = useMemo(
    () => (
      <>
        <svg
          aria-hidden="true"
          width={layout.width}
          height={layout.height}
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
        >
          {layout.edges.map((edge) => {
            const from = boxAt(edge.from);
            const to = boxAt(edge.to);
            if (!from || !to) return null;
            const onPath = trace.pathEdges.has(edgeKey(edge.from, edge.to));
            const d = connectorPath(from, to);
            return (
              <g key={`${edge.from}>${edge.to}`} data-tree-edge={edgeKey(edge.from, edge.to)} data-blocked-path={onPath ? "" : undefined}>
                <path
                  d={d}
                  fill="none"
                  strokeLinecap="round"
                  strokeWidth={onPath ? 2.5 : 1.5}
                  className={onPath ? "stroke-status-danger" : "stroke-border"}
                />
                {onPath ? (
                  <path d={d} fill="none" strokeLinecap="round" strokeWidth={2.5} strokeOpacity={0.7} className="task-tree-flow stroke-card" />
                ) : null}
              </g>
            );
          })}
        </svg>

        {layout.boxes.map((box) => {
          const item = items.get(box.id);
          const point = positions.get(box.id) ?? box;
          if (!item) return null;
          const focused = activeFocusId === item.id;
          const common = {
            "data-tree-node": item.id,
            role: "treeitem",
            tabIndex: focused ? 0 : -1,
            "aria-level": box.depth + 1,
            onFocus: () => setFocusedId(item.id),
            onBlur: () => setKeyboardFocus(false),
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => onNodeKeyDown(event, item),
            onClick: () => {
              if (suppressClick.current) return;
              activate(item);
            },
            style: { transform: `translate(${point.x}px, ${point.y}px)`, width: box.width, height: box.height },
          } as const;
          if (item.kind === "done") {
            return (
              <button
                key={item.id}
                type="button"
                {...common}
                aria-label={`${item.count} finished ${item.count === 1 ? "task" : "tasks"}. Show finished work`}
                className="absolute left-0 top-0 inline-flex items-center justify-center gap-1.5 rounded-full border border-border bg-card text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:border-ring hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <StatusIcon status="done" size="sm" />+{item.count} done
              </button>
            );
          }
          const node = item.node;
          const found = foundId === node.id;
          return (
            <div
              key={item.id}
              {...common}
              aria-expanded={item.descendants > 0 ? !item.collapsed : undefined}
              aria-label={`${node.identifier ? `${node.identifier} ` : ""}${node.title}, ${taskStatusLabel(node.status)}`}
              data-on-blocked-path={trace.pathNodeIds.has(node.id) ? "" : undefined}
              data-found={found ? "" : undefined}
              className={cn(
                "group/tree-node absolute left-0 top-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                found && "ring-2 ring-ring ring-offset-4 ring-offset-background",
              )}
              onPointerEnter={() => setHoveredId(node.id)}
              onPointerLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
            >
              <TaskTreeCard
                node={node}
                people={people}
                isRoot={node.id === visibleRoot.id}
                onBlockedPath={trace.pathNodeIds.has(node.id)}
                isRootBlocker={trace.rootBlockers.some((blocker) => blocker.inTree && blocker.id === node.id)}
                waitingOn={waitingOnById?.get(node.id) ?? null}
                descendants={item.descendants}
                collapsed={item.collapsed}
                onToggleCollapsed={() => onToggleCollapsed(node.id)}
                action={actionFor?.(node)}
              />
            </div>
          );
        })}
      </>
    ),
    // The handlers inside read current state through setters and refs; the layer redraws when what it shows changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, positions, items, activeFocusId, foundId, trace, people, waitingOnById, visibleRoot.id, actionFor, onOpen, onToggleCollapsed, onShowFinished],
  );

  return (
    <DiagramFrame
      label="Task tree"
      viewport={viewport}
      content={layout}
      boxes={layout.boxes}
      find={find}
      onCollapseAll={onCollapseAll}
      onExpandAll={onExpandAll}
      startFullscreen={startFullscreen}
      onExitFullscreen={onExitFullscreen}
      className={className}
    >
      <div
        ref={viewportRef}
        data-slot="task-tree-canvas"
        className={cn(
          "task-tree-canvas relative h-full min-h-0 w-full flex-1 touch-none select-none overflow-hidden rounded-xl border border-border",
          viewport.panning ? "cursor-grabbing" : "cursor-grab",
        )}
        style={{
          backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        {...viewport.panHandlers}
      >
        <div
          role="tree"
          aria-label="Task tree"
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: layout.width, height: layout.height }}
        >
          {layer}
        </div>

        {hoverItem?.kind === "task" && hoverBox ? (
          <TaskTreeHoverCard
            node={hoverItem.node}
            people={people}
            left={(hoverBox.x + hoverBox.width) * view.k + view.x + 10}
            top={hoverBox.y * view.k + view.y}
          />
        ) : null}
      </div>
    </DiagramFrame>
  );
}

function TaskTreeHoverCard({
  node,
  people,
  left,
  top,
}: {
  node: IssueTreeNode;
  people: TaskTreePeople;
  left: number;
  top: number;
}) {
  const runState = useTaskRunStateFor(node);
  return (
    <div
      role="tooltip"
      data-slot="task-tree-hover-card"
      className="pointer-events-none absolute z-popover w-56 space-y-1.5 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-sm"
      style={{ left, top }}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <StatusIcon status={node.status} size="sm" queued={runState?.kind === "queued"} />
        {taskStatusLabel(node.status)}
      </div>
      {runState ? <TaskRunStateChip state={runState} variant="full" className="flex-wrap" /> : null}
      <p className="text-xs text-muted-foreground">
        Owner: <span className="text-foreground">{ownerName(people, node) ?? "No owner yet"}</span>
      </p>
      {node.unblockAction ? (
        <p className="text-xs text-muted-foreground">
          Needs: <span className="text-foreground">{node.unblockAction}</span>
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">Updated {relativeTime(node.updatedAt)}</p>
    </div>
  );
}
