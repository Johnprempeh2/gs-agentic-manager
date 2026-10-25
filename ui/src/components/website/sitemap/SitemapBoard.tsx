import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronUp, PenLine } from "lucide-react";
import type { WebsitePage } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { DiagramFrame } from "@/components/diagram/DiagramFrame";
import { readDiagramPrefs, useDiagramViewport, writeDiagramPrefs, type DiagramSize } from "@/components/diagram/useDiagramViewport";
import { cn } from "@/lib/utils";
import { BOARD_GAP, boardDefaultFolded, boardLayout, childrenOf, descendantIds, flatten, moveTo, nodeStatus, ownSlug, type BoardBox, type Node } from "./model";
import { MoveControls, StatusPill, focusRing, type SitemapViewProps } from "./SitemapViews";

const PAD = 16;
const GRID = 20;
/** Space above a card brought to the top of the view. */
const TOP_GAP = 24;

const pageOf = (node: Node, pagesById: Map<string, WebsitePage>) =>
  (node.pageId ? pagesById.get(node.pageId) : undefined) ?? pagesById.get(`slug:${node.path}`);

const pad = (box: BoardBox): BoardBox => ({ ...box, x: box.x + PAD, y: box.y + PAD });

/**
 * Board (GRE-2111, top to bottom since GRE-2542): Home at the top, its
 * sections in a row under it, and each section's pages stacked in a column
 * under that section. It opens at 100%, centred on Home, so every title can be
 * read; sections with more than 8 sub-pages open folded behind "+N pages".
 * Drag a card onto another card to make it a sub-page there; drag empty space
 * or scroll to pan. From the keyboard: up and down move through the cards in
 * reading order, left and right fold, unfold, climb and descend. Find, fold
 * all, minimap and full screen come from DiagramFrame.
 */
export function SitemapBoardView({
  tree,
  onChange,
  pagesById,
  readOnly,
  storageKey,
  onEditPage,
}: SitemapViewProps & { storageKey?: string; onEditPage?: (pageId: string) => void }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    const stored = readDiagramPrefs(storageKey).collapsed;
    return Array.isArray(stored) ? new Set(stored) : boardDefaultFolded(tree);
  });
  const [initialCollapsed] = useState(collapsed);
  useEffect(() => {
    if (collapsed !== initialCollapsed) writeDiagramPrefs(storageKey, { collapsed: [...collapsed] });
  }, [collapsed, initialCollapsed, storageKey]);

  const hasChildren = useMemo(() => new Set(tree.nodes.flatMap((node) => (node.parentId ? [node.parentId] : []))), [tree]);
  const layout = useMemo(() => boardLayout(tree, collapsed), [tree, collapsed]);
  /** Cards in reading order, for the up and down keys. */
  const order = useMemo(() => flatten(tree).map((row) => row.node).filter((node) => layout.cards.has(node.id)), [tree, layout]);
  const [selected, setSelected] = useState<string | null>(null);
  const [foundId, setFoundId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(null);
  const [target, setTarget] = useState<string | null>(null);

  const bounds = useMemo(() => ({ width: layout.width + PAD * 2, height: layout.height + PAD * 2 }), [layout]);
  // Opens at 100% with Home (or the first section) centred at the top: readable, not shrunk to fit.
  const startId = layout.topId ?? order[0]?.id;
  const startBox = startId ? layout.cards.get(startId) : undefined;
  const home = useCallback(
    (vp: DiagramSize) => (startBox ? { k: 1, x: Math.round(vp.width / 2 - (startBox.x + PAD + startBox.width / 2)), y: 0 } : { x: 0, y: 0, k: 1 }),
    [startBox],
  );
  const viewport = useDiagramViewport({ content: bounds, storageKey: storageKey ? `${storageKey}.view` : undefined, home });
  const { view, viewportRef, reveal, setView } = viewport;
  const boxes = useMemo(() => [...layout.cards.values()].map(pad), [layout]);

  const boxOf = (id: string): BoardBox => {
    const box = pad(layout.cards.get(id)!);
    return drag?.id === id ? { ...box, x: box.x + drag.dx, y: box.y + drag.dy } : box;
  };

  const cardUnder = (id: string, x: number, y: number) => {
    const blocked = descendantIds(tree, id);
    for (const [other, box] of layout.cards) {
      if (other === id || blocked.has(other)) continue;
      if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return other;
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
    const box = layout.cards.get(drag.id)!;
    setTarget(moved ? cardUnder(drag.id, box.x + box.width / 2 + dx, box.y + box.height / 2 + dy) : null);
  };
  const onPointerUp = () => {
    if (!drag) return;
    // The board is always laid out tidy: a drop on a card re-parents, anywhere else springs back.
    if (drag.moved && target) onChange(moveTo(tree, drag.id, target));
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
    const box = layout.cards.get(id);
    if (box) reveal(pad(box), true);
  };

  /**
   * Put a card near the top of the view, so the pages under it show below it.
   * Keeps the zoom unless it is too small to read, then comes back to 100%.
   */
  const showAtTop = (box: BoardBox) => {
    const el = viewportRef.current;
    if (!el || el.clientWidth === 0) return reveal(box);
    const k = Math.max(view.k, 1);
    const left = box.x * k + view.x;
    const inView = k === view.k && left >= 0 && left + box.width * k <= el.clientWidth;
    setView({ k, x: inView ? view.x : el.clientWidth / 2 - (box.x + box.width / 2) * k, y: TOP_GAP - box.y * k });
  };

  /** Unfold the way to a page, select it and bring it into view at a size that can be read. */
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
    if (!pendingFocus || !layout.cards.has(pendingFocus)) return;
    const box = pad(layout.cards.get(pendingFocus)!);
    setSelected(pendingFocus);
    viewportRef.current?.querySelector<HTMLElement>(`[data-board-node="${pendingFocus}"]`)?.focus({ preventScroll: true });
    showAtTop(box);
    setPendingFocus(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocus, layout, viewportRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelected(id);
      return;
    }
    const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!arrows.includes(event.key) || event.altKey) return;
    event.preventDefault();
    const node = tree.nodes.find((entry) => entry.id === id);
    const at = order.findIndex((entry) => entry.id === id);
    const folds = hasChildren.has(id) && id !== layout.topId;
    if (event.key === "ArrowUp") focusCard(order[at - 1]?.id);
    else if (event.key === "ArrowDown") focusCard(order[at + 1]?.id);
    // Left folds an open branch, then climbs; Right unfolds, then descends (the tree pattern).
    else if (event.key === "ArrowLeft") {
      if (folds && !collapsed.has(id)) toggle(id);
      else focusCard(node?.parentId ?? undefined);
    } else if (folds && collapsed.has(id)) toggle(id);
    else focusCard(childrenOf(tree, id)[0]?.id);
  };

  const selectedNode = selected ? tree.nodes.find((node) => node.id === selected) : undefined;
  const selectedPage = selectedNode && onEditPage ? pageOf(selectedNode, pagesById) : undefined;
  const blocked = selectedNode ? descendantIds(tree, selectedNode.id) : new Set<string>();
  const findItems = useMemo(() => tree.nodes.map((node) => ({ id: node.id, label: node.title, detail: node.path })), [tree]);
  const byId = useMemo(() => new Map(tree.nodes.map((node) => [node.id, node])), [tree]);

  /** Short lines: Home to each section along one bar, and down the left of each column to its pages. */
  const lines = (() => {
    const out: Array<{ key: string; d: string; dashed?: boolean }> = [];
    for (const node of tree.nodes) {
      if (!node.parentId || !layout.cards.has(node.id) || !layout.cards.has(node.parentId)) continue;
      const from = boxOf(node.parentId);
      const to = boxOf(node.id);
      if (node.parentId === layout.topId) {
        const bar = from.y + from.height + BOARD_GAP.level / 2;
        out.push({ key: node.id, d: `M ${from.x + from.width / 2} ${from.y + from.height} V ${bar} H ${to.x + to.width / 2} V ${to.y}` });
      } else {
        out.push({ key: node.id, d: `M ${from.x + BOARD_GAP.indent / 2} ${from.y + from.height} V ${to.y + to.height / 2} H ${to.x}` });
      }
    }
    for (const [id, more] of layout.more) {
      const from = boxOf(id);
      const to = pad(more);
      out.push({ key: `more-${id}`, d: `M ${from.x + BOARD_GAP.indent / 2} ${from.y + from.height} V ${to.y + to.height / 2} H ${to.x}`, dashed: true });
    }
    return out;
  })();

  return (
    <div className="space-y-4" data-testid="sitemap-board">
      <div className="flex min-h-7 flex-wrap items-center gap-2 text-sm">
        {selectedNode ? (
          <>
            <span className="font-medium">{selectedNode.title}</span>
            {readOnly ? null : (
              <>
                <MoveControls tree={tree} node={selectedNode} onChange={onChange} />
                <label className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Sub-page of</span>
                  <NativeSelect
                    value={selectedNode.parentId ?? ""}
                    onChange={(event) => onChange(moveTo(tree, selectedNode.id, event.target.value || null))}
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
            )}
            {selectedPage && onEditPage ? (
              <Button type="button" size="xs" variant="outline" onClick={() => onEditPage(selectedPage.id)}>
                <PenLine aria-hidden="true" />
                Open in editor
              </Button>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {readOnly
              ? "Select a card to see where it sits. Drag empty space or scroll to move around."
              : "Select a card to move it, or drop it on another card to make it a sub-page. Drag empty space or scroll to move around."}
          </p>
        )}
      </div>
      <DiagramFrame
        label="Sitemap board"
        viewport={viewport}
        content={bounds}
        boxes={boxes}
        find={{ items: findItems, onPick: findPage }}
        onCollapseAll={() => setCollapsed(new Set(tree.nodes.filter((node) => node.id !== layout.topId && hasChildren.has(node.id)).map((node) => node.id)))}
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
            <svg className="pointer-events-none absolute inset-0 text-muted-foreground/50" width={bounds.width} height={bounds.height} aria-hidden="true">
              {lines.map((line) => (
                <path key={line.key} d={line.d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray={line.dashed ? "4 4" : undefined} />
              ))}
            </svg>
            <ul aria-label="Sitemap board">
              {order.map((node) => {
                const box = boxOf(node.id);
                const status = nodeStatus(node, pagesById);
                const page = onEditPage ? pageOf(node, pagesById) : undefined;
                const folds = hasChildren.has(node.id) && node.id !== layout.topId;
                const folded = collapsed.has(node.id);
                const parentPath = node.parentId ? byId.get(node.parentId)?.path : undefined;
                const shownSelected = selected === node.id;
                return (
                  <li
                    key={node.id}
                    className={cn("group absolute", drag?.id === node.id && drag.moved && "z-raised")}
                    style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
                  >
                    <div
                      role="button"
                      tabIndex={shownSelected || (!selected && node.id === order[0]?.id) ? 0 : -1}
                      aria-pressed={shownSelected}
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
                        "flex h-full w-full touch-none select-none flex-col justify-between gap-1 rounded-lg border bg-card p-3 text-card-foreground shadow-xs",
                        readOnly ? "cursor-default" : "cursor-grab",
                        focusRing,
                        shownSelected ? "border-foreground" : "border-border",
                        (target === node.id || foundId === node.id) && "ring-2 ring-ring",
                        drag?.id === node.id && drag.moved && "cursor-grabbing",
                      )}
                      data-testid="sitemap-board-card"
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={node.title}>{node.title}</span>
                        {folds && !folded ? (
                          <button
                            type="button"
                            tabIndex={-1}
                            aria-label={`Fold the sub-pages of ${node.title}`}
                            aria-expanded
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggle(node.id);
                            }}
                            className={cn("-my-1 -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground", focusRing)}
                          >
                            <ChevronUp className="size-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground" title={node.path}>{ownSlug(node.path, parentPath)}</span>
                      <span className="flex min-w-0 items-center justify-between gap-2">
                        <StatusPill status={status} />
                        {page && onEditPage ? (
                          // Shows on hover, or once the card is tapped or focused; the bar above has it for the keyboard.
                          <button
                            type="button"
                            tabIndex={-1}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              onEditPage(page.id);
                            }}
                            className={cn(
                              "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-foreground hover:bg-accent",
                              focusRing,
                              shownSelected ? "visible" : "invisible group-hover:visible",
                            )}
                          >
                            <PenLine className="size-3.5" aria-hidden="true" />
                            Open in editor
                          </button>
                        ) : null}
                      </span>
                    </div>
                  </li>
                );
              })}
              {[...layout.more].map(([id, more]) => {
                const node = byId.get(id)!;
                const box = pad(more);
                const label = `+${more.count} ${more.count === 1 ? "page" : "pages"}`;
                return (
                  <li key={`more-${id}`} className="absolute" style={{ left: box.x, top: box.y, width: box.width, height: box.height }}>
                    <button
                      type="button"
                      aria-label={`Show the ${more.count} sub-pages of ${node.title}`}
                      aria-expanded={false}
                      data-board-more={id}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => {
                        toggle(id);
                        showAtTop(pad(layout.cards.get(id)!));
                      }}
                      className={cn(
                        "inline-flex size-full items-center justify-center rounded-full border border-dashed border-border bg-card text-xs font-medium text-foreground shadow-xs hover:bg-accent",
                        focusRing,
                      )}
                    >
                      {label}
                    </button>
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
