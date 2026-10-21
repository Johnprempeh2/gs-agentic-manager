import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { IssueTreeNode } from "@greatstone/shared";
import { Maximize, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
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
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
/** "Fit to screen" never shrinks cards below this; past it, the root stays in view instead. */
const MIN_READABLE_ZOOM = 0.6;
const FIT_MARGIN = 32;
const DRAG_THRESHOLD = 4;
const GRID = 20;

export interface TaskTreeView {
  x: number;
  y: number;
  k: number;
}

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
  className?: string;
}

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

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
 * Drag to pan; wheel, pinch or the buttons to zoom; arrow keys move between
 * tasks, Enter opens one, Space folds its branch.
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
  className,
}: TaskTreeCanvasProps) {
  const reduced = usePrefersReducedMotion();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<TaskTreeView>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;

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
  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (width === 0 || height === 0) return;
    const whole = Math.min(1, (width - FIT_MARGIN * 2) / layout.width, (height - FIT_MARGIN * 2) / layout.height);
    if (whole >= MIN_READABLE_ZOOM) {
      setView({ k: whole, x: (width - layout.width * whole) / 2, y: Math.max(FIT_MARGIN, (height - layout.height * whole) / 2) });
      return;
    }
    // Too big to fit and still read: keep the cards legible, top of the tree in view,
    // centred on the whole tree's width (centring on the root cut off a wide branch).
    // Too big to fit and still read: keep the cards legible, the top of the tree in
    // view, and centre on the span from the root to the first root blocker, so the
    // task holding everything up is on screen when the tree opens.
    const k = MIN_READABLE_ZOOM;
    const rootBox = layout.boxes.find((box) => box.depth === 0);
    const blockerBox = trace.rootBlockers
      .map((blocker) => layout.byId.get(blocker.anchorId))
      .find((box) => box !== undefined);
    const span = [rootBox, blockerBox].filter((box): box is NonNullable<typeof box> => box !== undefined);
    const left = span.length ? Math.min(...span.map((box) => box.x)) : 0;
    const right = span.length ? Math.max(...span.map((box) => box.x + box.width)) : layout.width;
    setView({ k, x: width / 2 - ((left + right) / 2) * k, y: FIT_MARGIN - (rootBox?.y ?? 0) * k });
  }, [layout, trace]);

  const fittedOnce = useRef(false);
  useLayoutEffect(() => {
    if (fittedOnce.current) return;
    fittedOnce.current = true;
    fit();
  }, [fit]);

  const zoomAt = useCallback((factor: number, at?: Point) => {
    const viewport = viewportRef.current;
    const current = viewRef.current;
    const k = clampZoom(current.k * factor);
    const px = at?.x ?? (viewport?.clientWidth ?? 0) / 2;
    const py = at?.y ?? (viewport?.clientHeight ?? 0) / 2;
    setView({ k, x: px - (px - current.x) * (k / current.k), y: py - (py - current.y) * (k / current.k) });
  }, []);

  const panTo = useCallback(
    (id: string, onlyIfHidden = false) => {
      const viewport = viewportRef.current;
      const box = layout.byId.get(id);
      if (!viewport || !box) return;
      const { k, x, y } = viewRef.current;
      const left = box.x * k + x;
      const top = box.y * k + y;
      if (
        onlyIfHidden &&
        left >= 0 &&
        top >= 0 &&
        left + box.width * k <= viewport.clientWidth &&
        top + box.height * k <= viewport.clientHeight
      ) {
        return;
      }
      setView({
        k,
        x: viewport.clientWidth / 2 - (box.x + box.width / 2) * k,
        y: viewport.clientHeight / 2 - (box.y + box.height / 2) * k,
      });
    },
    [layout],
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

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
      zoomAt(factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ── Pointer: drag to pan, two fingers to pinch ──────────────────────────
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; view: TaskTreeView; moved: boolean; pinch?: { distance: number; mid: Point } } | null>(null);
  const suppressClick = useRef(false);

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    pointers.current.set(event.pointerId, localPoint(event));
    suppressClick.current = false;
    const points = [...pointers.current.values()];
    if (points.length === 2) {
      const [a, b] = points as [Point, Point];
      gesture.current = {
        start: a,
        view: viewRef.current,
        moved: true,
        pinch: { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } },
      };
    } else {
      gesture.current = { start: localPoint(event), view: viewRef.current, moved: false };
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, localPoint(event));
    const current = gesture.current;
    const points = [...pointers.current.values()];
    if (current.pinch && points.length >= 2) {
      const [a, b] = points as [Point, Point];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const k = clampZoom(current.view.k * (distance / Math.max(current.pinch.distance, 1)));
      const mid = current.pinch.mid;
      setView({
        k,
        x: mid.x - (mid.x - current.view.x) * (k / current.view.k),
        y: mid.y - (mid.y - current.view.y) * (k / current.view.k),
      });
      return;
    }
    const point = pointers.current.get(event.pointerId)!;
    const dx = point.x - current.start.x;
    const dy = point.y - current.start.y;
    if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!current.moved) {
      current.moved = true;
      // Capture only once it is a drag, so a plain click still reaches the card.
      viewportRef.current?.setPointerCapture?.(event.pointerId);
    }
    setView({ ...current.view, x: current.view.x + dx, y: current.view.y + dy });
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (gesture.current?.moved) suppressClick.current = true;
    if (pointers.current.size === 0) gesture.current = null;
  };

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

  // ── Paint ───────────────────────────────────────────────────────────────
  const hoverItem = hoveredId ? items.get(hoveredId) : keyboardFocus ? items.get(activeFocusId) : undefined;
  const hoverBox = hoverItem?.kind === "task" ? boxAt(hoverItem.id) : null;

  return (
    <div
      ref={viewportRef}
      data-slot="task-tree-canvas"
      className={cn(
        "task-tree-canvas relative h-full min-h-0 w-full touch-none select-none overflow-hidden rounded-xl border border-border",
        gesture.current?.moved ? "cursor-grabbing" : "cursor-grab",
        className,
      )}
      style={{
        backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div
        role="tree"
        aria-label="Task tree"
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: layout.width, height: layout.height }}
      >
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
          return (
            <div
              key={item.id}
              {...common}
              aria-expanded={item.descendants > 0 ? !item.collapsed : undefined}
              aria-label={`${node.identifier ? `${node.identifier} ` : ""}${node.title}, ${taskStatusLabel(node.status)}`}
              data-on-blocked-path={trace.pathNodeIds.has(node.id) ? "" : undefined}
              className="group/tree-node absolute left-0 top-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
              />
            </div>
          );
        })}
      </div>

      {hoverItem?.kind === "task" && hoverBox ? (
        <TaskTreeHoverCard
          node={hoverItem.node}
          people={people}
          left={(hoverBox.x + hoverBox.width) * view.k + view.x + 10}
          top={hoverBox.y * view.k + view.y}
        />
      ) : null}

      <div
        className="absolute bottom-3 right-3 z-raised flex items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-sm"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button variant="ghost" size="icon-xs" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAt(1 / 1.2)}>
          <Minus />
        </Button>
        <span className="w-10 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {Math.round(view.k * 100)}%
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAt(1.2)}>
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Fit to screen" title="Fit to screen" onClick={fit}>
          <Maximize />
        </Button>
      </div>
    </div>
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
  return (
    <div
      role="tooltip"
      data-slot="task-tree-hover-card"
      className="pointer-events-none absolute z-popover w-56 space-y-1.5 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-sm"
      style={{ left, top }}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <StatusIcon status={node.status} size="sm" />
        {taskStatusLabel(node.status)}
      </div>
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
