import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type SVGProps } from "react";
import { TaskRunStateChip } from "@/components/TaskRunStateChip";
import { useTaskRunStateFor } from "@/hooks/useTaskRunStates";
import type { IssueTreeNode } from "@greatstone/shared";
import { DiagramFrame, type DiagramFindItem } from "@/components/diagram/DiagramFrame";
import { fitView, useDiagramViewport, type DiagramView } from "@/components/diagram/useDiagramViewport";
import { StatusIcon } from "@/components/StatusIcon";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  blockLinkMidpoint,
  blockLinkPath,
  connectorMidpoint,
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
import type { TreeBlockReason } from "@/lib/task-tree-block-reason";
import { routeBlockLinks } from "@/lib/task-tree-links";
import { cn, relativeTime } from "@/lib/utils";
import { TaskTreeBlockReason } from "./TaskTreeBlockReason";
import { TASK_TREE_CARD_HEIGHT, TASK_TREE_CARD_WIDTH, TaskTreeCard } from "./TaskTreeCard";
import { ownerName, type TaskTreePeople } from "./TaskTreeOwner";
import type { VisibleBlockLink } from "./useTaskTreeView";

/** How a "blocks" line is drawn: dashed, with an arrow on the task it holds up. */
const BLOCK_DASH = "6 5";
/** Loop links are violet and dotted, so they never read as the red "leads to a block" line. */
const LOOP_DASH = "1 5";
/** Lines that do not touch the hovered or selected card fade to this. */
const FADED_LINK = 0.15;

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
  /** Why each blocked task is blocked, by task id. */
  blockReasonById?: ReadonlyMap<string, TreeBlockReason>;
  /** Every "blocks" link, between the cards that show its ends (GRE-2290). */
  blockLinks?: VisibleBlockLink[];
  /** Tasks in a blocking loop. */
  loopIds?: ReadonlySet<string>;
  /** Names of the tasks each task blocks and is blocked by, for the hover card. */
  linkNamesById?: ReadonlyMap<string, { blockedBy: string[]; blocks: string[] }>;
  onOpen: (node: IssueTreeNode) => void;
  onToggleCollapsed: (id: string) => void;
  onShowFinished: () => void;
  /** Pan to this item; bump `nonce` to pan again to the same one. */
  focusRequest?: { id: string; nonce: number } | null;
  /** With "Only what's blocked and why" on: the cards the view opens fitted to. */
  homeIds?: ReadonlySet<string> | null;
  /** Go back to the home view whenever this changes. */
  homeRequest?: number;
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
  blockReasonById,
  blockLinks = [],
  loopIds,
  linkNamesById,
  onOpen,
  onToggleCollapsed,
  onShowFinished,
  focusRequest,
  homeIds,
  homeRequest,
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
  const markerId = useId().replace(/:/g, "");

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
  // One line per pair of tasks (GRE-2384): blocking between a parent and its
  // child, or along a chain of such lines, restyles those lines instead of
  // drawing a second one beside them.
  const routed = useMemo(() => routeBlockLinks(blockLinks, layout.edges), [blockLinks, layout.edges]);
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
  // and still reads. Otherwise cards stay legible and the view opens on a
  // blocking chain: the first root blocker and as many of the tasks it holds
  // up as fit, nearest first, so both ends of its lines are on screen. With
  // nothing blocked it opens on the top of the tree.
  const home = useCallback(
    (viewport: { width: number; height: number }): TaskTreeView => {
      const focus = [...(homeIds ?? [])].flatMap((id) => layout.byId.get(id) ?? []);
      if (focus.length > 0) return fitBounds(focus.map(boundsOf).reduce(joinBounds), viewport);
      const whole = fitView(layout, viewport);
      if (whole.k >= MIN_READABLE_ZOOM) return { ...whole, y: Math.max(FIT_MARGIN, whole.y) };
      const k = MIN_READABLE_ZOOM;
      const blocker = trace.rootBlockers.find((entry) => layout.byId.has(entry.anchorId));
      const anchor = blocker ? layout.byId.get(blocker.anchorId)! : null;
      if (!blocker || !anchor) {
        const rootBox = layout.boxes.find((box) => box.depth === 0);
        const centre = rootBox ? rootBox.x + rootBox.width / 2 : layout.width / 2;
        return { k, x: viewport.width / 2 - centre * k, y: FIT_MARGIN - (rootBox?.y ?? 0) * k };
      }
      const fits = (span: Bounds) =>
        (span.right - span.left) * k <= viewport.width - FIT_MARGIN * 2 &&
        (span.bottom - span.top) * k <= viewport.height - FIT_MARGIN * 2;
      const distance = (box: LayoutBox) => Math.hypot(box.x - anchor.x, box.y - anchor.y);
      let span = boundsOf(anchor);
      const heldUp = blocker.holdsUp
        .map((id) => layout.byId.get(id))
        .filter((box): box is LayoutBox => box !== undefined)
        .sort((a, b) => distance(a) - distance(b));
      for (const box of heldUp) {
        const wider = joinBounds(span, boundsOf(box));
        if (fits(wider)) span = wider;
      }
      return {
        k,
        x: viewport.width / 2 - ((span.left + span.right) / 2) * k,
        y: viewport.height / 2 - ((span.top + span.bottom) / 2) * k,
      };
    },
    [layout, trace, homeIds],
  );
  const viewport = useDiagramViewport({ content: layout, storageKey: storageKey ? `${storageKey}.view` : undefined, home });
  const { view, viewportRef, reveal, reset, suppressClick } = viewport;

  const homeSeen = useRef(homeRequest);
  useEffect(() => {
    if (homeSeen.current === homeRequest) return;
    homeSeen.current = homeRequest;
    reset();
  }, [homeRequest, reset]);

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
    else if (item.group) onToggleCollapsed(item.id);
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
            if (!from || !to || routed.onEdges.has(edgeKey(edge.from, edge.to))) return null;
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
                blockReason={blockReasonById?.get(node.id) ?? null}
                projectName={item.outside ? item.outside.projectName ?? "No project" : null}
                inLoop={loopIds?.has(node.id) ?? false}
                isGroup={item.group}
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
    [layout, routed, positions, items, activeFocusId, foundId, trace, people, waitingOnById, blockReasonById, loopIds, visibleRoot.id, actionFor, onOpen, onToggleCollapsed, onShowFinished],
  );

  // "Blocks" lines sit over the sub-task lines and under the cards. They draw
  // apart from the cards, so hovering a card redraws only the lines: its own
  // come to full strength and the rest fade, so one chain reads by eye.
  const emphasisId = hoveredId ?? (keyboardFocus ? activeFocusId : null) ?? foundId;
  const nameOf = useCallback(
    (id: string) => {
      const item = items.get(id);
      return item?.kind === "task" ? item.node.identifier ?? item.node.title : id;
    },
    [items],
  );
  const blockLayer = useMemo(
    () =>
      blockLinks.length === 0 ? null : (
        <svg
          aria-hidden="true"
          width={layout.width}
          height={layout.height}
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
        >
          <defs>
            <marker id={`${markerId}-block`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9 z" className="fill-status-warning" />
            </marker>
            <marker id={`${markerId}-loop`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9 z" className="fill-status-review" />
            </marker>
          </defs>
          {layout.edges.map((edge) => {
            const key = edgeKey(edge.from, edge.to);
            const carried = routed.onEdges.get(key);
            const from = boxAt(edge.from);
            const to = boxAt(edge.to);
            if (!carried || !from || !to) return null;
            const ends = new Set([...carried.links, ...carried.via.map((hop) => hop.link)].flatMap((link) => [link.from, link.to]));
            const touches = emphasisId !== null && ends.has(emphasisId);
            const faded = emphasisId !== null && !touches;
            const loop = carried.links.some((link) => link.loop);
            const folded = carried.links.every((link) => link.folded);
            const down = carried.links.some((link) => link.from === edge.from);
            const up = carried.links.some((link) => link.from === edge.to);
            const marker = `url(#${markerId}-${loop ? "loop" : "block"})`;
            const d = connectorPath(from, to);
            const title = [
              ...carried.links.flatMap((link) => link.labels),
              ...carried.via.flatMap(({ link, through }) =>
                link.labels.map((label) => `${label}, through ${through.map(nameOf).join(", ")}`),
              ),
            ].join("\n");
            return (
              <BlockLine
                key={`edge:${key}`}
                d={d}
                title={title}
                mid={loop ? connectorMidpoint(from, to) : null}
                opacity={faded ? FADED_LINK : folded && !touches ? 0.6 : 1}
                pathProps={{
                  "data-block-edge": key,
                  "data-block-loop": loop ? "" : undefined,
                  "data-block-emphasis": touches ? "" : faded ? "faded" : undefined,
                  strokeWidth: (loop ? 2.5 : 1.75) + (touches ? 1 : 0),
                  strokeDasharray: loop ? LOOP_DASH : BLOCK_DASH,
                  markerEnd: down ? marker : undefined,
                  markerStart: up ? marker : undefined,
                  className: loop ? "stroke-status-review" : "stroke-status-warning",
                }}
              />
            );
          })}
          {routed.lines.map((link) => {
            const from = boxAt(link.from);
            const to = boxAt(link.to);
            if (!from || !to) return null;
            const touches = emphasisId === link.from || emphasisId === link.to;
            const faded = emphasisId !== null && !touches;
            return (
              <BlockLine
                key={`block:${link.from}>${link.to}`}
                d={blockLinkPath(from, to)}
                title={link.labels.join("\n")}
                mid={link.loop ? blockLinkMidpoint(from, to) : null}
                opacity={faded ? FADED_LINK : link.folded && !touches ? 0.6 : 1}
                pathProps={{
                  "data-block-link": edgeKey(link.from, link.to),
                  "data-block-loop": link.loop ? "" : undefined,
                  "data-block-folded": link.folded ? "" : undefined,
                  "data-block-emphasis": touches ? "" : faded ? "faded" : undefined,
                  strokeWidth: (link.loop ? 2.5 : 1.75) + (touches ? 1 : 0),
                  strokeDasharray: link.loop ? LOOP_DASH : BLOCK_DASH,
                  markerEnd: `url(#${markerId}-${link.loop ? "loop" : "block"})`,
                  className: link.loop ? "stroke-status-review" : "stroke-status-warning",
                }}
              />
            );
          })}
        </svg>
      ),
    [blockLinks.length, routed, layout.edges, boxAt, emphasisId, layout.width, layout.height, markerId, nameOf],
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
          {blockLayer}
          {layer}
        </div>

        {blockLinks.length > 0 ? <TaskTreeLinkLegend loops={blockLinks.some((link) => link.loop)} paths={trace.pathEdges.size > 0} /> : null}

        {hoverItem?.kind === "task" && !hoverItem.group && hoverBox ? (
          <TaskTreeHoverCard
            node={hoverItem.node}
            people={people}
            links={linkNamesById?.get(hoverItem.node.id) ?? null}
            blockReason={blockReasonById?.get(hoverItem.node.id) ?? null}
            left={(hoverBox.x + hoverBox.width) * view.k + view.x + 10}
            top={hoverBox.y * view.k + view.y}
          />
        ) : null}
      </div>
    </DiagramFrame>
  );
}

/**
 * One "blocks" line: dashed, with an arrow on the task it holds up, and a
 * wide clear stroke over it so hovering the line names the link.
 */
function BlockLine({
  d,
  title,
  mid,
  opacity,
  pathProps,
}: {
  d: string;
  title: string;
  mid: { x: number; y: number } | null;
  opacity: number;
  pathProps: SVGProps<SVGPathElement> & Record<`data-${string}`, string | undefined>;
}) {
  return (
    <g strokeOpacity={opacity}>
      <path d={d} fill="none" strokeLinecap="round" {...pathProps} />
      <path data-block-hit="" d={d} fill="none" stroke="transparent" strokeWidth={12} pointerEvents="stroke">
        <title>{title}</title>
      </path>
      {mid ? (
        <text
          x={mid.x}
          y={mid.y}
          textAnchor="middle"
          dominantBaseline="central"
          fillOpacity={opacity}
          className="fill-status-review text-sm font-semibold"
        >
          ↻
        </text>
      ) : null}
    </g>
  );
}

/** What the lines mean, in the corner of the canvas. */
function TaskTreeLinkLegend({ loops, paths }: { loops: boolean; paths: boolean }) {
  const sample = (className: string, dash?: string) => (
    <svg aria-hidden="true" width="28" height="8" className="shrink-0">
      <line x1="1" y1="4" x2="27" y2="4" strokeWidth="2" strokeLinecap="round" strokeDasharray={dash} className={className} />
    </svg>
  );
  return (
    <div
      data-slot="task-tree-link-legend"
      className="pointer-events-none absolute left-3 top-3 z-raised flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground shadow-sm"
    >
      <span className="inline-flex items-center gap-1.5">{sample("stroke-border")}Part of</span>
      <span className="inline-flex items-center gap-1.5">{sample("stroke-status-warning", "4 3")}Blocks</span>
      {paths ? <span className="inline-flex items-center gap-1.5">{sample("stroke-status-danger")}Leads to a block</span> : null}
      {loops ? <span className="inline-flex items-center gap-1.5">{sample("stroke-status-review", "0.5 4")}↻ Loop</span> : null}
    </div>
  );
}

function TaskTreeHoverCard({
  node,
  people,
  links,
  blockReason,
  left,
  top,
}: {
  node: IssueTreeNode;
  people: TaskTreePeople;
  links: { blockedBy: string[]; blocks: string[] } | null;
  blockReason: TreeBlockReason | null;
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
      {blockReason ? (
        <TaskTreeBlockReason reason={blockReason} />
      ) : node.unblockAction ? (
        <p className="text-xs text-muted-foreground">
          Needs: <span className="text-foreground">{node.unblockAction}</span>
        </p>
      ) : null}
      {links?.blockedBy.length ? (
        <p className="text-xs text-muted-foreground" data-hover-blocked-by="">
          Blocked by: <span className="text-foreground">{links.blockedBy.join(", ")}</span>
        </p>
      ) : null}
      {links?.blocks.length ? (
        <p className="text-xs text-muted-foreground" data-hover-blocks="">
          Blocks: <span className="text-foreground">{links.blocks.join(", ")}</span>
        </p>
      ) : null}
      {new Date(node.updatedAt).getTime() > 0 ? <p className="text-xs text-muted-foreground">Updated {relativeTime(node.updatedAt)}</p> : null}
    </div>
  );
}

type Bounds = { left: number; right: number; top: number; bottom: number };

/**
 * The view that shows `span` as large as reads, up to full size. When it is
 * too big even at the smallest readable zoom, its top-left stays on screen.
 */
function fitBounds(span: Bounds, viewport: { width: number; height: number }): TaskTreeView {
  const width = span.right - span.left;
  const height = span.bottom - span.top;
  const room = { width: viewport.width - FIT_MARGIN * 2, height: viewport.height - FIT_MARGIN * 2 };
  const k = Math.max(MIN_READABLE_ZOOM, Math.min(1, room.width / Math.max(width, 1), room.height / Math.max(height, 1)));
  const place = (start: number, size: number, available: number, total: number) =>
    size * k <= available ? total / 2 - (start + size / 2) * k : FIT_MARGIN - start * k;
  return {
    k,
    x: place(span.left, width, room.width, viewport.width),
    y: place(span.top, height, room.height, viewport.height),
  };
}

function boundsOf(box: LayoutBox): Bounds {
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

function joinBounds(a: Bounds, b: Bounds): Bounds {
  return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
}
