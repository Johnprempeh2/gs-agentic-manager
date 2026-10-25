import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, GripVertical, Maximize2, Minimize2, PenLine, Pencil, Plus, Trash2 } from "lucide-react";
import { websiteFeatureForPath, type WebsiteFeature } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { DiagramFind, trapTab, useDiagramFullscreen } from "@/components/diagram/DiagramFrame";
import { cn } from "@/lib/utils";
import {
  addNode,
  ancestorIds,
  childrenOf,
  defaultFolded,
  moveTo,
  nodeStatus,
  outlineRows,
  removeNode,
  updateNode,
  type Node,
  type OutlineRow,
} from "./model";
import { IconAction, MENU_LABELS, MoveControls, NodeEditor, StatusPill, focusRing, type SitemapViewProps } from "./SitemapViews";

type DropPlace = "before" | "inside" | "after";

export type SitemapFeature = Pick<WebsiteFeature, "name" | "routePrefixes">;

/** Column widths on a wide screen, shared by the header and every row so they line up. */
const COLS = {
  path: "@5xl:w-56",
  status: "@5xl:w-32",
  feature: "@5xl:w-32",
  menu: "@5xl:w-24",
  edit: "@5xl:w-24",
} as const;

/** The connector colour: a quiet line that still reads in both themes. */
const LINE = "bg-muted-foreground/40";

/**
 * One level of indent. A rail carries an ancestor's line past this row; the
 * elbow joins this row to its parent (├ or └). Each column is as wide as the
 * fold button, so a line drops straight from its parent's chevron.
 */
function Rail({ on }: { on: boolean }) {
  return <span aria-hidden="true" className="relative w-5 shrink-0">{on ? <span className={cn("absolute inset-y-0 left-1/2 w-px", LINE)} /> : null}</span>;
}

function Elbow({ last }: { last: boolean }) {
  return (
    <span aria-hidden="true" className="relative w-5 shrink-0">
      <span className={cn("absolute left-1/2 top-0 w-px", LINE, last ? "h-4.5" : "bottom-0")} />
      <span className={cn("absolute left-1/2 top-4.5 h-px w-1/2", LINE)} />
    </span>
  );
}

function menuPlace(node: Node) {
  if (node.menu === "none") return "";
  return node.menuColumn?.trim() ? `${MENU_LABELS[node.menu]}, ${node.menuColumn.trim()}` : MENU_LABELS[node.menu];
}

/**
 * Tree (GRE-2111, vertical since GRE-2509): the sitemap read top to bottom
 * like a file tree. Home at the top left, each page under its parent one
 * step in, with lines joining them. Fold any section; deep sections with
 * many pages open folded. Find jumps to a page and unfolds the way to it.
 */
export function SitemapTreeView({
  tree,
  onChange,
  pagesById,
  readOnly,
  onEditPage,
  features = [],
}: SitemapViewProps & { onEditPage?: (pageId: string) => void; features?: SitemapFeature[] }) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => defaultFolded(tree));
  const rows = useMemo(() => outlineRows(tree, folded), [tree, folded]);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; place: DropPlace } | null>(null);
  const [foundId, setFoundId] = useState<string | null>(null);
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const fullscreen = useDiagramFullscreen(frameRef);

  const toggle = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const findItems = useMemo(() => tree.nodes.map((node) => ({ id: node.id, label: node.title, detail: node.path })), [tree]);
  /** Unfold the way to a page, then bring it into view and mark it. */
  const findPage = (id: string) => {
    const path = new Set(ancestorIds(tree, id));
    setFolded((current) => ([...current].some((entry) => path.has(entry)) ? new Set([...current].filter((entry) => !path.has(entry))) : current));
    setFoundId(id);
    setPendingScroll(id);
  };
  useEffect(() => {
    if (!pendingScroll) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-sitemap-row="${pendingScroll}"]`);
    if (!row) return;
    row.scrollIntoView?.({ block: "center" });
    row.focus({ preventScroll: true });
    setPendingScroll(null);
  }, [pendingScroll, rows]);

  const placeFor = (event: DragEvent<HTMLElement>): DropPlace => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - box.top) / box.height;
    return ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
  };
  const onDrop = (targetId: string, place: DropPlace) => {
    if (!dragging || dragging === targetId) return;
    const target = tree.nodes.find((node) => node.id === targetId)!;
    if (place === "inside") onChange(moveTo(tree, dragging, targetId));
    else {
      const siblings = childrenOf(tree, target.parentId).filter((node) => node.id !== dragging);
      const index = siblings.findIndex((node) => node.id === targetId) + (place === "after" ? 1 : 0);
      onChange(moveTo(tree, dragging, target.parentId, index));
    }
  };

  const onFrameKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (fullscreen.active) trapTab(event, frameRef.current);
    if (event.key === "Escape" && fullscreen.mode === "overlay" && !event.defaultPrevented) {
      event.preventDefault();
      fullscreen.exit();
    }
  };

  const foldable = tree.nodes.filter((node) => node.parentId && childrenOf(tree, node.id).length > 0).map((node) => node.id);

  return (
    <div
      ref={frameRef}
      role="group"
      aria-label="Sitemap tree"
      data-testid="sitemap-tree"
      data-fullscreen={fullscreen.mode ?? undefined}
      onKeyDown={onFrameKeyDown}
      className={cn(
        "@container flex min-w-0 flex-col gap-4",
        fullscreen.active && "h-full min-h-0 bg-background p-4",
        fullscreen.mode === "overlay" && "fixed inset-0 z-dialog",
      )}
    >
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Sitemap tree controls">
        <DiagramFind items={findItems} onPick={findPage} />
        {readOnly ? null : (
          <Button type="button" size="xs" variant="outline" onClick={() => {
            const added = addNode(tree, null);
            onChange(added.tree);
            setEditing(added.id);
          }}>
            <Plus aria-hidden="true" />
            Add page
          </Button>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button type="button" variant="ghost" size="xs" onClick={() => setFolded(new Set(foldable))} title="Fold every section below the top level">
            <ChevronsDownUp aria-hidden="true" />
            Collapse all
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => setFolded(new Set())} title="Unfold every section">
            <ChevronsUpDown aria-hidden="true" />
            Expand all
          </Button>
          <Button type="button" variant={fullscreen.active ? "outline" : "ghost"} size="xs" onClick={fullscreen.toggle}>
            {fullscreen.active ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            {fullscreen.active ? "Exit full screen" : "Full screen"}
          </Button>
        </div>
      </div>
      {readOnly ? null : (
        <p className="text-xs text-muted-foreground">
          Drag a page onto another to make it a sub-page, or above or below it to reorder. The arrow buttons do the same from the keyboard.
          <span className="@5xl:hidden"> Tap a page to see its buttons.</span>
        </p>
      )}
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">This option has no pages yet.</p> : (
        <div className={cn("min-w-0 rounded-xl border border-border bg-card", fullscreen.active && "min-h-0 flex-1 overflow-y-auto")}>
          <div aria-hidden="true" className="hidden items-center gap-3 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground @5xl:flex">
            {readOnly ? null : <span className="w-4 shrink-0" />}
            <span className="min-w-0 flex-1">Page</span>
            <span className={COLS.path}>URL</span>
            <span className={COLS.status}>Status</span>
            <span className={COLS.feature}>Feature</span>
            <span className={COLS.menu}>Menu</span>
            {onEditPage ? <span className={COLS.edit} /> : null}
          </div>
          <ul ref={listRef} className="py-1" aria-label="Sitemap pages">
            {rows.map((row) => (
              <TreeRow
                key={row.node.id}
                row={row}
                tree={tree}
                onChange={onChange}
                pagesById={pagesById}
                readOnly={readOnly}
                onEditPage={onEditPage}
                feature={websiteFeatureForPath(row.node.path, features)?.name ?? null}
                editing={editing === row.node.id}
                onEdit={setEditing}
                found={foundId === row.node.id}
                dragging={dragging === row.node.id}
                marker={drop?.id === row.node.id ? drop.place : null}
                onToggle={() => toggle(row.node.id)}
                drag={{
                  onDragStart: (event) => {
                    setDragging(row.node.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", row.node.id);
                  },
                  onDragEnd: () => {
                    setDragging(null);
                    setDrop(null);
                  },
                  onDragOver: (event) => {
                    if (!dragging || dragging === row.node.id) return;
                    event.preventDefault();
                    setDrop({ id: row.node.id, place: placeFor(event) });
                  },
                  onDragLeave: () => setDrop((current) => (current?.id === row.node.id ? null : current)),
                  onDrop: (event) => {
                    event.preventDefault();
                    onDrop(row.node.id, placeFor(event));
                    setDrop(null);
                  },
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TreeRow({
  row,
  tree,
  onChange,
  pagesById,
  readOnly,
  onEditPage,
  feature,
  editing,
  onEdit,
  found,
  dragging,
  marker,
  onToggle,
  drag,
}: SitemapViewProps & {
  row: OutlineRow;
  onEditPage?: (pageId: string) => void;
  feature: string | null;
  editing: boolean;
  onEdit: (id: string | null) => void;
  found: boolean;
  dragging: boolean;
  marker: DropPlace | null;
  onToggle: () => void;
  drag: Record<"onDragStart" | "onDragEnd" | "onDragOver" | "onDragLeave" | "onDrop", (event: DragEvent<HTMLLIElement>) => void>;
}) {
  const { node, depth, rails, last, childCount, folded } = row;
  const status = nodeStatus(node, pagesById);
  const page = (node.pageId ? pagesById.get(node.pageId) : undefined) ?? pagesById.get(`slug:${node.path}`);
  const menu = menuPlace(node);
  const subPages = `${childCount} ${childCount === 1 ? "sub-page" : "sub-pages"}`;

  return (
    <li
      draggable={!readOnly && !editing}
      {...drag}
      tabIndex={-1}
      data-sitemap-row={node.id}
      data-found={found ? "" : undefined}
      data-testid="sitemap-tree-row"
      className={cn(
        "group relative flex items-stretch px-3 text-sm outline-none hover:bg-accent/50",
        dragging && "bg-muted",
        marker === "inside" && "bg-accent",
        found && "bg-accent ring-2 ring-inset ring-ring",
        marker === "before" && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-ring",
        marker === "after" && "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-ring",
      )}
    >
      {readOnly ? null : <GripVertical aria-hidden="true" className="mr-1 mt-2.5 size-4 shrink-0 cursor-grab text-muted-foreground" />}
      {rails.map((on, index) => <Rail key={index} on={on} />)}
      {depth > 0 ? <Elbow last={last} /> : null}
      <span className="relative w-5 shrink-0">
        {childCount > 0 ? (
          <>
            <button
              type="button"
              data-slot="icon-button"
              aria-expanded={!folded}
              aria-label={folded ? `Show the ${subPages} of ${node.title}` : `Fold the ${subPages} of ${node.title}`}
              onClick={onToggle}
              className={cn("relative z-raised mt-2 inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground", focusRing)}
            >
              {folded ? <ChevronRight className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
            </button>
            {folded ? null : <span aria-hidden="true" className={cn("absolute bottom-0 left-1/2 top-7 w-px", LINE)} />}
          </>
        ) : (
          depth > 0 ? (
            <>
              <span aria-hidden="true" className={cn("absolute left-0 top-4.5 h-px w-1/2", LINE)} />
              <span aria-hidden="true" className={cn("absolute left-1/2 top-3.75 size-1.5 -translate-x-1/2 rounded-full", LINE)} />
            </>
          ) : null
        )}
      </span>
      {editing ? (
        <div className="flex min-w-0 flex-1 py-1.5 pl-2">
          <NodeEditor
            node={node}
            onCancel={() => onEdit(null)}
            onSave={(patch) => {
              onChange(updateNode(tree, node.id, patch));
              onEdit(null);
            }}
          />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-1 py-1.5 pl-2 @5xl:flex-row @5xl:items-center @5xl:gap-3">
          <div className="flex min-h-6 min-w-0 flex-1 items-center gap-2">
            <span data-sitemap-title="" className={cn("min-w-0 break-words leading-6", depth === 0 ? "font-semibold" : "font-medium")}>{node.title}</span>
            {folded ? (
              <button type="button" data-slot="icon-button" onClick={onToggle} className={cn("shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground", focusRing)}>
                {subPages}
              </button>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 @5xl:contents">
            <span className={cn("min-w-0 break-all font-mono text-xs text-muted-foreground @5xl:truncate @5xl:break-normal", COLS.path)} title={node.path}>{node.path}</span>
            <span className={cn("flex items-center gap-1.5", COLS.status)}>
              <StatusPill status={status} />
              {node.noindex ? <span className="whitespace-nowrap text-xs text-muted-foreground">Not indexed</span> : null}
            </span>
            <span className={cn("min-w-0 text-xs text-muted-foreground @5xl:truncate", !feature && "hidden @5xl:block", COLS.feature)} title={feature ?? undefined}>
              {feature ?? ""}
            </span>
            <span className={cn("text-xs text-muted-foreground @5xl:truncate", !menu && "hidden @5xl:block", COLS.menu)}>{menu}</span>
          </div>
          {/* Under the page on a phone, the last column on a wide screen. */}
          {!readOnly || onEditPage ? (
            <RowActions tree={tree} node={node} onChange={onChange} readOnly={readOnly} page={page?.id} onEditPage={onEditPage} onEdit={onEdit} />
          ) : null}
        </div>
      )}
    </li>
  );
}

function RowActions({ tree, node, onChange, readOnly, page, onEditPage, onEdit }: {
  tree: SitemapViewProps["tree"];
  node: Node;
  onChange: SitemapViewProps["onChange"];
  readOnly: boolean;
  page: string | undefined;
  onEditPage?: (pageId: string) => void;
  onEdit: (id: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 @5xl:contents">
      {readOnly ? null : (
        // Shown for the row being worked on, so 178 rows do not each carry seven buttons: under
        // the tapped page on a phone, a small bar over the row's end on a wide screen.
        <div
          className={cn(
            "hidden flex-wrap items-center gap-0.5 group-focus-within:flex",
            "@5xl:pointer-events-none @5xl:flex @5xl:absolute @5xl:top-1 @5xl:z-raised @5xl:flex-nowrap @5xl:rounded-md @5xl:border @5xl:border-border @5xl:bg-card @5xl:p-0.5 @5xl:opacity-0 @5xl:shadow-xs",
            "@5xl:group-hover:pointer-events-auto @5xl:group-hover:opacity-100 @5xl:group-focus-within:pointer-events-auto @5xl:group-focus-within:opacity-100",
            onEditPage ? "@5xl:right-28" : "@5xl:right-3",
          )}
        >
          <IconAction label={`Rename ${node.title}`} icon={Pencil} onClick={() => onEdit(node.id)} />
          <MoveControls tree={tree} node={node} onChange={onChange} />
          <IconAction
            label={`Add a sub-page under ${node.title}`}
            icon={Plus}
            onClick={() => {
              const added = addNode(tree, node.id);
              onChange(added.tree);
              onEdit(added.id);
            }}
          />
          <IconAction label={`Remove ${node.title} from this option`} icon={Trash2} onClick={() => onChange(removeNode(tree, node.id))} />
        </div>
      )}
      {onEditPage ? (
        <div className={cn("flex shrink-0 items-center @5xl:justify-end", !page && "hidden @5xl:flex", COLS.edit)}>
          {page ? (
            <Button type="button" variant="outline" size="xs" onClick={() => onEditPage(page)} aria-label={`Edit page ${node.title}`}>
              <PenLine aria-hidden="true" />
              Edit page
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
