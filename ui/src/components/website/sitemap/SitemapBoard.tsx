import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { BOARD_CARD, boardLayout, descendantIds, moveTo, nodeStatus, updateNode } from "./model";
import { MENU_LABELS, MoveControls, StatusPill, focusRing, type SitemapViewProps } from "./SitemapViews";

const PAD = 16;
const NUDGE = 16;

/**
 * Board (GRE-2111): the same tree as a visual map. Drag a card to move it;
 * drop it on another card to make it a sub-page there. From the keyboard:
 * select a card, arrow keys nudge it (Shift for bigger steps), and the
 * controls above move it in the structure.
 */
export function SitemapBoardView({ tree, onChange, pagesById, readOnly }: SitemapViewProps) {
  const layout = useMemo(() => boardLayout(tree), [tree]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);

  const positionOf = (id: string) => {
    const base = layout.get(id) ?? { x: 0, y: 0 };
    return drag?.id === id ? { x: base.x + drag.dx, y: base.y + drag.dy } : base;
  };
  const bounds = useMemo(() => {
    let width = 0;
    let height = 0;
    for (const { x, y } of layout.values()) {
      width = Math.max(width, x + BOARD_CARD.width);
      height = Math.max(height, y + BOARD_CARD.height);
    }
    return { width: width + PAD * 2, height: height + PAD * 2 };
  }, [layout]);

  const cardUnder = (id: string, x: number, y: number) => {
    const blocked = descendantIds(tree, id);
    const cx = x + BOARD_CARD.width / 2;
    const cy = y + BOARD_CARD.height / 2;
    for (const node of tree.nodes) {
      if (node.id === id || blocked.has(node.id)) continue;
      const pos = layout.get(node.id)!;
      if (cx >= pos.x && cx <= pos.x + BOARD_CARD.width && cy >= pos.y && cy <= pos.y + BOARD_CARD.height) return node.id;
    }
    return null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, id: string) => {
    setSelected(id);
    if (readOnly || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, dx: 0, dy: 0, startX: event.clientX, startY: event.clientY, moved: false });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
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
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    const step = event.shiftKey ? NUDGE * 4 : NUDGE;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelected(id);
      return;
    }
    if (!delta || readOnly) return;
    event.preventDefault();
    const pos = layout.get(id)!;
    onChange(updateNode(tree, id, { x: Math.max(0, pos.x + delta[0]!), y: Math.max(0, pos.y + delta[1]!) }));
  };

  const selectedNode = selected ? tree.nodes.find((node) => node.id === selected) : undefined;
  const blocked = selectedNode ? descendantIds(tree, selectedNode.id) : new Set<string>();

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
            {readOnly ? "Select a card to see where it sits." : "Drag a card to place it, or drop it on another card to make it a sub-page. Select a card to move it from the keyboard."}
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
      <div className="relative h-(--sz-70vh) overflow-auto rounded-xl border border-border bg-muted/30" ref={canvas}>
        <div className="relative" style={{ width: bounds.width, height: bounds.height }}>
          <svg className="pointer-events-none absolute inset-0 text-border" width={bounds.width} height={bounds.height} aria-hidden="true">
            {tree.nodes.map((node) => {
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
            {tree.nodes.map((node) => {
              const pos = positionOf(node.id);
              const status = nodeStatus(node, pagesById);
              return (
                <li key={node.id} className={cn("absolute", drag?.id === node.id && drag.moved && "z-raised")} style={{ left: pos.x + PAD, top: pos.y + PAD, width: BOARD_CARD.width, height: BOARD_CARD.height }}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected === node.id}
                    aria-label={`${node.title}, ${node.path}`}
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
                      "flex h-full w-full touch-none select-none flex-col justify-center gap-1 rounded-lg border bg-card px-3 shadow-xs",
                      readOnly ? "cursor-default" : "cursor-grab",
                      focusRing,
                      selected === node.id ? "border-foreground" : "border-border",
                      target === node.id && "ring-2 ring-ring",
                      drag?.id === node.id && drag.moved && "cursor-grabbing",
                    )}
                    data-testid="sitemap-board-card"
                  >
                    <span className="truncate text-sm font-medium">{node.title}</span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <StatusPill status={status} />
                      <span className="truncate font-mono text-xs text-muted-foreground">{node.menu !== "none" ? `${MENU_LABELS[node.menu]} · ` : ""}{node.path}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
