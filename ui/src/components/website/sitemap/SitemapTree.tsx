import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  GripVertical,
  IndentDecrease,
  IndentIncrease,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PenLine,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { websiteFeatureForPath, type WebsiteFeature } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DiagramFind, trapTab, useDiagramFullscreen } from "@/components/diagram/DiagramFrame";
import { cn } from "@/lib/utils";
import {
  addNode,
  ancestorIds,
  childrenOf,
  defaultFolded,
  indent,
  moveSibling,
  moveTo,
  nodeStatus,
  outdent,
  outlineRows,
  ownSlug,
  removeNode,
  updateNode,
  type Node,
  type OutlineRow,
} from "./model";
import { MENU_LABELS, NodeEditor, StatusPill, focusRing, type SitemapViewProps } from "./SitemapViews";

type DropPlace = "before" | "inside" | "after";

export type SitemapFeature = Pick<WebsiteFeature, "name" | "routePrefixes">;

/** Column widths on a wide screen, shared by the header and every row so they line up. */
const COLS = {
  path: "@5xl:w-64 @5xl:shrink-0",
  status: "@5xl:w-32 @5xl:shrink-0",
  feature: "@5xl:w-32 @5xl:shrink-0",
  menu: "@5xl:w-24 @5xl:shrink-0",
  edit: "@5xl:w-24 @5xl:shrink-0",
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

  const pathById = useMemo(() => new Map(tree.nodes.map((node) => [node.id, node.path])), [tree]);
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
          <span className="hidden @5xl:inline">Drag a page onto another to make it a sub-page, or above or below it to reorder. </span>
          Each page&apos;s <MoreHorizontal aria-hidden="true" className="inline size-3.5 align-text-bottom" /> menu renames, adds, moves and removes pages.
        </p>
      )}
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">This option has no pages yet.</p> : (
        <div className={cn("min-w-0 rounded-xl border border-border bg-card", fullscreen.active && "min-h-0 flex-1 overflow-y-auto")}>
          <div aria-hidden="true" className="hidden items-center gap-3 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground @5xl:flex">
            {readOnly ? null : <span className="mr-1 w-4 shrink-0" />}
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
                slug={ownSlug(row.node.path, row.node.parentId ? pathById.get(row.node.parentId) : undefined)}
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
  slug,
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
  /** The row's own part of its URL; the full path is its tooltip. */
  slug: string;
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
      {/* Touch cannot drag, so a phone leaves the handle out and gives deep pages the room; the arrow buttons move pages there. */}
      {readOnly ? null : <GripVertical aria-hidden="true" className="mr-1 mt-2.5 hidden size-4 shrink-0 cursor-grab text-muted-foreground @5xl:block" />}
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
        // A phone shows three short lines: the title, the URL, then status, feature and menu. A wide screen
        // shows one line in columns. The row's menu button keeps its own small space at the end of the
        // Page column, so nothing moves or hides when it shows.
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 pl-2 @5xl:flex-nowrap">
          <div className="flex min-h-6 min-w-0 basis-full items-center gap-2 @5xl:flex-1 @5xl:basis-0">
            <span data-sitemap-title="" className={cn("min-w-0 break-words leading-6", depth === 0 ? "font-semibold" : "font-medium")}>{node.title}</span>
            {folded ? (
              <button type="button" data-slot="icon-button" onClick={onToggle} className={cn("shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground", focusRing)}>
                {subPages}
              </button>
            ) : null}
            {!readOnly || (onEditPage && page) ? (
              // The wrapper, not the button, takes the spare space: touch styles reset a button's margin.
              <span className={cn("ml-auto flex shrink-0", readOnly && "@5xl:hidden")}>
                <RowMenu tree={tree} node={node} onChange={onChange} readOnly={readOnly} onEdit={onEdit} onEditPage={onEditPage && page ? () => onEditPage(page.id) : undefined} />
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 basis-full flex-col gap-0.5 text-xs text-muted-foreground @5xl:contents">
            <span data-sitemap-path="" className={cn("min-w-0 truncate font-mono", COLS.path)} title={node.path}>{slug}</span>
            <div className="flex min-w-0 items-center gap-2 @5xl:contents">
              <span className={cn("flex shrink-0 items-center gap-1.5", COLS.status)}>
                <StatusPill status={status} />
                {node.noindex ? <span className="whitespace-nowrap">Not indexed</span> : null}
              </span>
              <span className={cn("min-w-0 truncate", !feature && "hidden @5xl:block", COLS.feature)} title={feature ?? undefined}>
                {feature ?? ""}
              </span>
              <span className={cn("min-w-0 truncate", !menu && "hidden @5xl:block", COLS.menu)} title={menu || undefined}>{menu}</span>
            </div>
          </div>
          {onEditPage ? (
            <div className={cn("hidden shrink-0 items-center @5xl:flex @5xl:justify-end", COLS.edit)}>
              {page ? (
                <Button type="button" variant="outline" size="xs" onClick={() => onEditPage(page.id)} aria-label={`Edit page ${node.title}`}>
                  <PenLine aria-hidden="true" />
                  Edit page
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </li>
  );
}

/**
 * One row's actions behind a single button, so 178 rows do not each carry seven buttons and the
 * row's cells never move or hide. Always shown on a phone; on a wide screen it fades in on hover
 * or focus, in space kept for it. Move items keep the menu open so a page can step several places.
 * It also holds Edit page, which a wide screen shows as its own column too.
 */
function RowMenu({ tree, node, onChange, readOnly, onEdit, onEditPage }: {
  tree: SitemapViewProps["tree"];
  node: Node;
  onChange: SitemapViewProps["onChange"];
  readOnly: boolean;
  onEdit: (id: string | null) => void;
  onEditPage?: () => void;
}) {
  const siblings = childrenOf(tree, node.parentId);
  const position = siblings.findIndex((entry) => entry.id === node.id);
  const step = (next: SitemapViewProps["tree"]) => (event: Event) => {
    event.preventDefault();
    onChange(next);
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${node.title}`}
          title="Page actions"
          className={cn(
            "text-muted-foreground",
            !readOnly && "@5xl:opacity-0 @5xl:group-hover:opacity-100 @5xl:group-focus-within:opacity-100 @5xl:data-[state=open]:opacity-100",
          )}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {onEditPage ? (
          <DropdownMenuItem onSelect={onEditPage}>
            <PenLine aria-hidden="true" />
            Edit page
          </DropdownMenuItem>
        ) : null}
        {readOnly ? null : (
          <>
            <DropdownMenuItem onSelect={() => onEdit(node.id)}>
              <Pencil aria-hidden="true" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                const added = addNode(tree, node.id);
                onChange(added.tree);
                onEdit(added.id);
              }}
            >
              <Plus aria-hidden="true" />
              Add a sub-page
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={position <= 0} onSelect={step(moveSibling(tree, node.id, -1))}>
              <ArrowUp aria-hidden="true" />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={position >= siblings.length - 1} onSelect={step(moveSibling(tree, node.id, 1))}>
              <ArrowDown aria-hidden="true" />
              Move down
            </DropdownMenuItem>
            <DropdownMenuItem disabled={position <= 0} onSelect={step(indent(tree, node.id))}>
              <IndentIncrease aria-hidden="true" />
              Make a sub-page of the page above
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!node.parentId} onSelect={step(outdent(tree, node.id))}>
              <IndentDecrease aria-hidden="true" />
              Move up a level
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onChange(removeNode(tree, node.id))}>
              <Trash2 aria-hidden="true" />
              Remove from this option
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
