import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronDown, ChevronRight, LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { DiagramFrame } from "@/components/diagram/DiagramFrame";
import { readDiagramPrefs, useDiagramViewport, writeDiagramPrefs } from "@/components/diagram/useDiagramViewport";
import { cn } from "@/lib/utils";
import { BOARD_CARD, boardLayout, childrenOf, descendantIds, flatten, moveTo, nodeStatus, updateNode } from "./model";
import { MENU_LABELS, MoveControls, StatusPill, focusRing, type SitemapViewProps } from "./SitemapViews";

const PAD = 16;
const NUDGE = 16;
const GRID = 20;

/**
 * Board (GRE-2111): the same tree as a visual map on a pannable, zoomable
 * canvas. Drag a card to move it; drop it on another card to make it a
 * sub-page there; drag empty space or scroll to pan. From the keyboard:
 * arrow keys move between cards, Alt with the arrows nudges the selected
 * card (Shift for bigger steps), and the controls above move it in the
 * structure. Find, fold all, minimap and full screen come from DiagramFrame.
 */
export function SitemapBoardView({ tree, onChange, pagesById, readOnly, storageKey }: SitemapViewProps & { storageKey?: string }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    const stored = readDiagramPrefs(storageKey).collapsed;
    return new Set(Array.isArray(stored) ? stored : []);
  });
  const [initialCollapsed] = useState(collapsed);
  useEffect(() => {
    if (collapsed !== initialCollapsed) writeDiagramPrefs(storageKey, { collapsed: [...collapsed] });
  }, [collapsed, initialCollapsed, storageKey]);

  const hasChildren = useMemo(() => new Set(tree.nodes.flatMap((node) => (node.parentId ? [node.parentId] : []))), [tree]);
  const shown = useMemo(() => {
    const hidden = new Set<string>();
    for (const id of collapsed) for (const below of descendantIds(tree, id)) hidden.add(below);
    return { ...tree, nodes: tree.nodes.filter((node) => !hidden.has(node.id)) };
  }, [tree, collapsed]);
  /** Cards in reading order, for the up and down keys. */
  const order = useMemo(() => flatten(shown).map((row) => row.node), [shown]);
  const layout = useMemo(() => boardLayout(shown), [shown]);
  const [selected, setSelected] = useState<string | null>(null);
  const [foundId, setFoundId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(null);
  const [target, setTarget] = useState<string | null>(null);

  const bounds = useMemo(() => {
    let width = 0;
    let height = 0;
    for (const { x, y } of layout.values()) {
      width = Math.max(width, x + BOARD_CARD.width);
      height = Math.max(height, y + BOARD_CARD.height);
    }
    return { width: width + PAD * 2, height: height + PAD * 2 };
  }, [layout]);
  // The board opens at full size from the top left, as it always has.
  const home = useCallback(() => ({ x: 0, y: 0, k: 1 }), []);
  const viewport = useDiagramViewport({ content: bounds, storageKey: storageKey ? `${storageKey}.view` : undefined, home });
  const { view, viewportRef, reveal } = viewport;
  const boxes = useMemo(
    () => [...layout.values()].map(({ x, y }) => ({ x: x + PAD, y: y + PAD, width: BOARD_CARD.width, height: BOARD_CARD.height })),
    [layout],
  );

  const positionOf = (id: string) => {
    const base = layout.get(id) ?? { x: 0, y: 0 };
    return drag?.id === id ? { x: base.x + drag.dx, y: base.y + drag.dy } : base;
  };

  const cardUnder = (id: string, x: number, y: number) => {
    const blocked = descendantIds(tree, id);
    const cx = x + BOARD_CARD.width / 2;
    const cy = y + BOARD_CARD.height / 2;
    for (const node of shown.nodes) {
      if (node.id === id || blocked.has(node.id)) continue;
      const pos = layout.get(node.id)!;
      if (cx >= pos.x && cx <= pos.x + BOARD_CARD.width && cy >= pos.y && cy <= pos.y + BOARD_CARD.height) return node.id;
    }
    return null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, id: string) => {
    setSelected(id);
    if (readOnly || event.button !== 0) return;
    // The card moves, not the board.
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, dx: 0, dy: 0, startX: event.clientX, startY: event.clientY, moved: false });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    // Screen pixels to board pixels at the current zoom.
    const dx = (event.clientX - drag.startX) / view.k;
    const dy = (event.clientY - drag.startY) / view.k;
    const moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 4;
    setDrag({ ...drag, dx, dy, moved });
    const base = layout.get(drag.id)!;
    setTarget(moved ? cardUnder(drag.id, base.x + dx, base.y + dy) : null);
  };
  const onPointerUp = () => {
    if (!drag) return;
    if (drag.moved) {
      if (target) {
        // Re-parented: let the board lay it out again under its new parent.
        onChange(updateNode(moveTo(tree, drag.id, target), drag.id, { x: null, y: null }));
      } else {
        const base = layout.get(drag.id)!;
        onChange(updateNode(tree, drag.id, { x: Math.max(0, Math.round(base.x + drag.dx)), y: Math.max(0, Math.round(base.y + drag.dy)) }));
      }
    }
    setDrag(null);
    setTarget(null);
  };

  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const focusCard = (id: string | undefined) => {
    if (!id) return;
    setSelected(id);
    viewportRef.current?.querySelector<HTMLElement>(`[data-board-node="${id}"]`)?.focus({ preventScroll: true });
    const pos = layout.get(id);
    if (pos) reveal({ x: pos.x + PAD, y: pos.y + PAD, width: BOARD_CARD.width, height: BOARD_CARD.height }, true);
  };

  /** Unfold the way to a page, select it and bring it into view. */
  const findPage = (id: string) => {
    const byId = new Map(tree.nodes.map((node) => [node.id, node]));
    const path = new Set<string>();
    for (let parent = byId.get(id)?.parentId; parent; parent = byId.get(parent)?.parentId) path.add(parent);
    setCollapsed((current) => ([...current].some((entry) => path.has(entry)) ? new Set([...current].filter((entry) => !path.has(entry))) : current));
    setFoundId(id);
    setPendingFocus(id);
  };
  // Focus after the unfolded layout has rendered.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingFocus || !layout.has(pendingFocus)) return;
    const pos = layout.get(pendingFocus)!;
    setSelected(pendingFocus);
    viewportRef.current?.querySelector<HTMLElement>(`[data-board-node="${pendingFocus}"]`)?.focus({ preventScroll: true });
    reveal({ x: pos.x + PAD, y: pos.y + PAD, width: BOARD_CARD.width, height: BOARD_CARD.height });
    setPendingFocus(null);
  }, [pendingFocus, layout, reveal, viewportRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelected(id);
      return;
    }
    const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!arrows.includes(event.key)) return;
    event.preventDefault();
    if (event.altKey) {
      if (readOnly) return;
      const step = event.shiftKey ? NUDGE * 4 : NUDGE;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]!;
      const pos = layout.get(id)!;
      onChange(updateNode(tree, id, { x: Math.max(0, pos.x + delta[0]!), y: Math.max(0, pos.y + delta[1]!) }));
      return;
    }
    const node = tree.nodes.find((entry) => entry.id === id);
    const at = order.findIndex((entry) => entry.id === id);
    if (event.key === "ArrowUp") focusCard(order[at - 1]?.id);
    else if (event.key === "ArrowDown") focusCard(order[at + 1]?.id);
    // Left folds an open branch, then climbs; Right unfolds, then descends (the tree pattern).
    else if (event.key === "ArrowLeft") {
      if (hasChildren.has(id) && !collapsed.has(id)) toggle(id);
      else focusCard(node?.parentId ?? undefined);
    } else if (collapsed.has(id)) toggle(id);
    else focusCard(childrenOf(shown, id)[0]?.id);
  };

  const selectedNode = selected ? tree.nodes.find((node) => node.id === selected) : undefined;
  const blocked = selectedNode ? descendantIds(tree, selectedNode.id) : new Set<string>();
  const findItems = useMemo(() => tree.nodes.map((node) => ({ id: node.id, label: node.title, detail: node.path })), [tree]);

  return (
    <div className="space-y-4" data-testid="sitemap-board">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {selectedNode && !readOnly ? (
          <>
            <span className="font-medium">{selectedNode.title}</span>
            <MoveControls tree={tree} node={selectedNode} onChange={onChange} />
            <label className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Sub-page of</span>
              <NativeSelect
                value={selectedNode.parentId ?? ""}
                onChange={(event) => onChange(updateNode(moveTo(tree, selectedNode.id, event.target.value || null), selectedNode.id, { x: null, y: null }))}
                className="h-7 w-auto text-xs"
              >
                <option value="">Top level</option>
                {tree.nodes
                  .filter((node) => node.id !== selectedNode.id && !blocked.has(node.id))
                  .sort((a, b) => a.path.localeCompare(b.path))
                  .map((node) => (
                    <option key={node.id} value={node.id}>{node.title}</option>
                  ))}
              </NativeSelect>
            </label>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {readOnly
              ? "Select a card to see where it sits. Drag empty space or scroll to move around."
              : "Drag a card to place it, or drop it on another card to make it a sub-page. Arrow keys move between cards; Alt with the arrows nudges one."}
          </p>
        )}
        {readOnly ? null : (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => onChange({ ...tree, nodes: tree.nodes.map((node) => ({ ...node, x: null, y: null })) })}
          >
            <LayoutGrid aria-hidden="true" />
            Tidy the board
          </Button>
        )}
      </div>
      <DiagramFrame
        label="Sitemap board"
        viewport={viewport}
        content={bounds}
        boxes={boxes}
        find={{ items: findItems, onPick: findPage }}
        onCollapseAll={() => setCollapsed(new Set(tree.nodes.filter((node) => node.parentId && hasChildren.has(node.id)).map((node) => node.id)))}
        onExpandAll={() => setCollapsed(new Set())}
        className="h-(--sz-70vh)"
      >
        <div
          ref={viewportRef}
          className={cn(
            "relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-xl border border-border bg-muted",
            viewport.panning ? "cursor-grabbing" : "cursor-grab",
          )}
          style={{ backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
          data-testid="sitemap-board-canvas"
          {...viewport.panHandlers}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ width: bounds.width, height: bounds.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
          >
            <svg className="pointer-events-none absolute inset-0 text-border" width={bounds.width} height={bounds.height} aria-hidden="true">
              {shown.nodes.map((node) => {
                if (!node.parentId || !layout.has(node.parentId)) return null;
                const from = positionOf(node.parentId);
                const to = positionOf(node.id);
                const x1 = from.x + PAD + BOARD_CARD.width;
                const y1 = from.y + PAD + BOARD_CARD.height / 2;
                const x2 = to.x + PAD;
                const y2 = to.y + PAD + BOARD_CARD.height / 2;
                const mid = (x1 + x2) / 2;
                return <path key={node.id} d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`} fill="none" stroke="currentColor" strokeWidth={1.5} />;
              })}
            </svg>
            <ul aria-label="Sitemap board">
              {shown.nodes.map((node) => {
                const pos = positionOf(node.id);
                const status = nodeStatus(node, pagesById);
                const folds = hasChildren.has(node.id);
                const folded = collapsed.has(node.id);
                return (
                  <li key={node.id} className={cn("absolute", drag?.id === node.id && drag.moved && "z-raised")} style={{ left: pos.x + PAD, top: pos.y + PAD, width: BOARD_CARD.width, height: BOARD_CARD.height }}>
                    <div
                      role="button"
                      tabIndex={selected === node.id || (!selected && node.id === order[0]?.id) ? 0 : -1}
                      aria-pressed={selected === node.id}
                      aria-label={`${node.title}, ${node.path}${folds ? (folded ? ", sub-pages folded" : ", has sub-pages") : ""}`}
                      data-board-node={node.id}
                      data-found={foundId === node.id ? "" : undefined}
                      onPointerDown={(event) => onPointerDown(event, node.id)}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onPointerCancel={() => {
                        setDrag(null);
                        setTarget(null);
                      }}
                      onKeyDown={(event) => onKeyDown(event, node.id)}
                      onFocus={() => setSelected(node.id)}
                      className={cn(
                        "flex h-full w-full touch-none select-none items-center gap-1 rounded-lg border bg-card pl-3 pr-1 shadow-xs",
                        readOnly ? "cursor-default" : "cursor-grab",
                        focusRing,
                        selected === node.id ? "border-foreground" : "border-border",
                        (target === node.id || foundId === node.id) && "ring-2 ring-ring",
                        drag?.id === node.id && drag.moved && "cursor-grabbing",
                      )}
                      data-testid="sitemap-board-card"
                    >
                      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
                        <span className="truncate text-sm font-medium">{node.title}</span>
                        <span className="flex min-w-0 items-center gap-1.5">
                          <StatusPill status={status} />
                          <span className="truncate font-mono text-xs text-muted-foreground">{node.menu !== "none" ? `${MENU_LABELS[node.menu]} · ` : ""}{node.path}</span>
                        </span>
                      </span>
                      {folds ? (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={folded ? `Show the sub-pages of ${node.title}` : `Fold the sub-pages of ${node.title}`}
                          aria-expanded={!folded}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle(node.id);
                          }}
                          className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground", focusRing)}
                        >
                          {folded ? <ChevronRight className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </DiagramFrame>
    </div>
  );
}
