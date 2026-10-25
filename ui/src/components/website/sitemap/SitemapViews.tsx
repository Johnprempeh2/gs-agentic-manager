import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  GripVertical,
  IndentDecrease,
  IndentIncrease,
  PenLine,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { WebsitePage, WebsitePageMenu } from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import {
  SITEMAP_STATUS_LABELS,
  addNode,
  childrenOf,
  flatten,
  indent,
  menuItems,
  moveSibling,
  moveTo,
  nodeStatus,
  outdent,
  placeInMenu,
  removeNode,
  updateNode,
  type Node,
  type SitemapPageStatus,
  type Tree,
} from "./model";

export interface SitemapViewProps {
  tree: Tree;
  onChange: (tree: Tree) => void;
  pagesById: Map<string, WebsitePage>;
  readOnly: boolean;
}

export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const STATUS_CLASSES: Record<SitemapPageStatus, string> = {
  new: "bg-muted text-foreground",
  planned: "bg-status-warning-soft text-status-warning-foreground",
  drafted: "bg-status-running-soft text-status-running-foreground",
  live: "bg-status-success-soft text-status-success-foreground",
};

export const MENU_LABELS: Record<WebsitePageMenu, string> = { header: "Header", footer: "Footer", none: "No menu" };

export function Pill({ className, children }: { className: string; children: ReactNode }) {
  return <span className={cn("inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium", className)}>{children}</span>;
}

export function StatusPill({ status }: { status: SitemapPageStatus }) {
  return <Pill className={STATUS_CLASSES[status]}>{SITEMAP_STATUS_LABELS[status]}</Pill>;
}

/** Agreed strings (GRE-2081): `menus.planned_hidden` and `journeys.gap`. */
export const plannedHiddenNote = (page: string) => `${page} is planned, so it stays out of this menu until it is live.`;
export const journeyGapNote = (page: string) => `${page} is planned, not live. Visitors cannot take this step yet.`;

function IconAction({ label, icon: Icon, onClick, disabled }: { label: string; icon: typeof ArrowUp; onClick: () => void; disabled?: boolean }) {
  return (
    <Button type="button" variant="ghost" size="icon-xs" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      <Icon aria-hidden="true" />
    </Button>
  );
}

/** Keyboard alternatives for every drag: move up, move down, indent, outdent. */
export function MoveControls({ tree, node, onChange }: { tree: Tree; node: Node; onChange: (tree: Tree) => void }) {
  const siblings = childrenOf(tree, node.parentId);
  const position = siblings.findIndex((entry) => entry.id === node.id);
  return (
    <>
      <IconAction label={`Move ${node.title} up`} icon={ArrowUp} disabled={position <= 0} onClick={() => onChange(moveSibling(tree, node.id, -1))} />
      <IconAction label={`Move ${node.title} down`} icon={ArrowDown} disabled={position >= siblings.length - 1} onClick={() => onChange(moveSibling(tree, node.id, 1))} />
      <IconAction label={`Make ${node.title} a sub-page of the page above`} icon={IndentIncrease} disabled={position <= 0} onClick={() => onChange(indent(tree, node.id))} />
      <IconAction label={`Move ${node.title} up a level`} icon={IndentDecrease} disabled={!node.parentId} onClick={() => onChange(outdent(tree, node.id))} />
    </>
  );
}

/** Title and path, edited in place. Enter saves, Escape cancels. */
export function NodeEditor({ node, onSave, onCancel }: { node: Node; onSave: (patch: Pick<Node, "title" | "path">) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(node.title);
  const [path, setPath] = useState(node.path);
  const valid = title.trim().length > 0 && /^\/([a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*)?$/.test(path.trim());
  const save = () => valid && onSave({ title: title.trim(), path: path.trim() });
  return (
    <form
      className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <Input aria-label="Page title" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus className="h-8 sm:max-w-xs" />
      <Input aria-label="Page path" value={path} onChange={(event) => setPath(event.target.value)} className="h-8 font-mono text-xs sm:max-w-xs" aria-invalid={!valid} />
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={!valid}>Done</Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/* ---- Tree ---- */

type DropPlace = "before" | "inside" | "after";

export function SitemapTreeView({
  tree,
  onChange,
  pagesById,
  readOnly,
  onEditPage,
}: SitemapViewProps & { onEditPage?: (pageId: string) => void }) {
  const rows = useMemo(() => flatten(tree), [tree]);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; place: DropPlace } | null>(null);

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

  return (
    <div className="space-y-4" data-testid="sitemap-tree">
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => {
            const added = addNode(tree, null);
            onChange(added.tree);
            setEditing(added.id);
          }}>
            <Plus aria-hidden="true" />
            Add page
          </Button>
          <p className="text-xs text-muted-foreground">Drag a page onto another to make it a sub-page, or above or below it to reorder. The arrow buttons do the same from the keyboard.</p>
        </div>
      )}
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">This option has no pages yet.</p> : null}
      <ul className="divide-y divide-border rounded-xl border border-border" aria-label="Sitemap pages">
        {rows.map(({ node, depth }) => {
          const status = nodeStatus(node, pagesById);
          const page = (node.pageId ? pagesById.get(node.pageId) : undefined) ?? pagesById.get(`slug:${node.path}`);
          const marker = drop?.id === node.id ? drop.place : null;
          return (
            <li
              key={node.id}
              draggable={!readOnly && editing !== node.id}
              onDragStart={(event) => {
                setDragging(node.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", node.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDrop(null);
              }}
              onDragOver={(event) => {
                if (!dragging || dragging === node.id) return;
                event.preventDefault();
                setDrop({ id: node.id, place: placeFor(event) });
              }}
              onDragLeave={() => setDrop((current) => (current?.id === node.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                onDrop(node.id, placeFor(event));
                setDrop(null);
              }}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm",
                dragging === node.id && "bg-muted",
                marker === "inside" && "bg-accent",
                marker === "before" && "border-t-2 border-t-ring",
                marker === "after" && "border-b-2 border-b-ring",
              )}
              style={{ paddingInlineStart: `calc(var(--spacing) * ${3 + depth * 4})` }}
              data-testid="sitemap-tree-row"
            >
              {readOnly ? null : <GripVertical aria-hidden="true" className="size-4 shrink-0 cursor-grab text-muted-foreground" />}
              {editing === node.id ? (
                <NodeEditor
                  node={node}
                  onCancel={() => setEditing(null)}
                  onSave={(patch) => {
                    onChange(updateNode(tree, node.id, patch));
                    setEditing(null);
                  }}
                />
              ) : (
                <div className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 font-medium">{node.title}</span>
                  <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{node.path}</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusPill status={status} />
                    {node.menu !== "none" ? <Pill className="bg-muted text-foreground">{MENU_LABELS[node.menu]}</Pill> : null}
                    {node.noindex ? <Pill className="bg-muted text-muted-foreground">Not indexed</Pill> : null}
                  </div>
                </div>
              )}
              {page && onEditPage && editing !== node.id ? (
                <Button type="button" variant="outline" size="xs" onClick={() => onEditPage(page.id)} aria-label={`Edit page ${node.title}`}>
                  <PenLine aria-hidden="true" />
                  Edit page
                </Button>
              ) : null}
              {readOnly || editing === node.id ? null : (
                <div className="flex w-full flex-wrap items-center gap-0.5 sm:w-auto">
                  <IconAction label={`Rename ${node.title}`} icon={Pencil} onClick={() => setEditing(node.id)} />
                  <MoveControls tree={tree} node={node} onChange={onChange} />
                  <IconAction
                    label={`Add a sub-page under ${node.title}`}
                    icon={Plus}
                    onClick={() => {
                      const added = addNode(tree, node.id);
                      onChange(added.tree);
                      setEditing(added.id);
                    }}
                  />
                  <IconAction label={`Remove ${node.title} from this option`} icon={Trash2} onClick={() => onChange(removeNode(tree, node.id))} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---- List ---- */

type ListKey = "title" | "path" | "status" | "seoTitle" | "menu" | "owner";

const LIST_COLUMNS: Array<{ key: ListKey; label: string }> = [
  { key: "title", label: "Title" },
  { key: "path", label: "URL" },
  { key: "status", label: "Status" },
  { key: "seoTitle", label: "SEO title" },
  { key: "menu", label: "Menu" },
  { key: "owner", label: "Owner" },
];

export function SitemapListView({ tree, pagesById }: SitemapViewProps) {
  const [sort, setSort] = useState<{ key: ListKey; direction: 1 | -1 }>({ key: "path", direction: 1 });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<SitemapPageStatus | "all">("all");
  const [menuFilter, setMenuFilter] = useState<WebsitePageMenu | "all">("all");

  const rows = useMemo(() => {
    const value = (node: Node, key: ListKey): string => {
      const page = node.pageId ? pagesById.get(node.pageId) : undefined;
      if (key === "status") return nodeStatus(node, pagesById);
      if (key === "seoTitle") return page?.seo.title ?? node.seoTitle ?? "";
      if (key === "menu") return MENU_LABELS[node.menu];
      if (key === "owner") return node.owner ?? "";
      return node[key];
    };
    const needle = query.trim().toLowerCase();
    return tree.nodes
      .filter((node) => statusFilter === "all" || nodeStatus(node, pagesById) === statusFilter)
      .filter((node) => menuFilter === "all" || node.menu === menuFilter)
      .filter((node) => !needle || `${node.title} ${node.path} ${node.owner ?? ""}`.toLowerCase().includes(needle))
      .map((node) => ({ node, values: Object.fromEntries(LIST_COLUMNS.map((column) => [column.key, value(node, column.key)])) as Record<ListKey, string> }))
      .sort((a, b) => a.values[sort.key].localeCompare(b.values[sort.key]) * sort.direction);
  }, [tree, pagesById, sort, query, statusFilter, menuFilter]);

  return (
    <div className="space-y-4" data-testid="sitemap-list">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 basis-full flex-col gap-1 text-sm sm:basis-auto sm:max-w-xs">
          <span className="font-medium">Filter</span>
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, URL or owner" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Status</span>
          <NativeSelect value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as SitemapPageStatus | "all")}>
            <option value="all">All</option>
            {(Object.keys(SITEMAP_STATUS_LABELS) as SitemapPageStatus[]).map((status) => (
              <option key={status} value={status}>{SITEMAP_STATUS_LABELS[status]}</option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Menu</span>
          <NativeSelect value={menuFilter} onChange={(event) => setMenuFilter(event.target.value as WebsitePageMenu | "all")}>
            <option value="all">All</option>
            {(Object.keys(MENU_LABELS) as WebsitePageMenu[]).map((menu) => (
              <option key={menu} value={menu}>{MENU_LABELS[menu]}</option>
            ))}
          </NativeSelect>
        </label>
        <p className="text-xs text-muted-foreground" aria-live="polite">{rows.length} of {tree.nodes.length} pages</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-full text-sm" aria-label="Every page in this option">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              {LIST_COLUMNS.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (sort.direction === 1 ? "ascending" : "descending") : "none"}
                    className={cn("px-3 py-2 font-medium", (column.key === "seoTitle" || column.key === "owner") && "hidden md:table-cell", column.key === "menu" && "hidden sm:table-cell")}
                  >
                    <button
                      type="button"
                      className={cn("inline-flex items-center gap-1 rounded-sm hover:text-foreground", focusRing, active && "text-foreground")}
                      onClick={() => setSort({ key: column.key, direction: active ? (sort.direction === 1 ? -1 : 1) : 1 })}
                    >
                      {column.label}
                      {active ? (sort.direction === 1 ? <ArrowUp aria-hidden="true" className="size-3" /> : <ArrowDown aria-hidden="true" className="size-3" />) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(({ node, values }) => (
              <tr key={node.id}>
                <td className="px-3 py-2 font-medium">{node.title}</td>
                <td className="break-all px-3 py-2 font-mono text-xs text-muted-foreground">{node.path}</td>
                <td className="px-3 py-2"><StatusPill status={values.status as SitemapPageStatus} /></td>
                <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">{values.seoTitle || "None"}</td>
                <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">{values.menu}</td>
                <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">{values.owner || "None"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---- Menus ---- */

const MENU_ORDER: WebsitePageMenu[] = ["header", "footer", "none"];

export function SitemapMenusView({ tree, onChange, pagesById, readOnly }: SitemapViewProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ menu: WebsitePageMenu; index: number } | null>(null);
  const byId = useMemo(() => new Map(tree.nodes.map((node) => [node.id, node])), [tree]);

  const drop = (menu: WebsitePageMenu, index: number) => {
    if (dragging) onChange(placeInMenu(tree, dragging, menu, index));
    setDragging(null);
    setOver(null);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-3" data-testid="sitemap-menus">
      {MENU_ORDER.map((menu) => {
        const items = menuItems(tree, menu);
        // Header: a page whose parent is also in the header is a dropdown item under it.
        const groups = new Map<string, Node[]>();
        for (const item of items) {
          const parent = item.parentId ? byId.get(item.parentId) : undefined;
          const key = menu === "header" && parent?.menu === "header" ? `Under ${parent.title}` : item.menuColumn?.trim() || (menu === "none" ? "" : "Main");
          groups.set(key, [...(groups.get(key) ?? []), item]);
        }
        return (
          <section
            key={menu}
            aria-labelledby={`sitemap-menu-${menu}`}
            className={cn("gs-glass-card min-w-0 space-y-3 rounded-xl border p-4", over?.menu === menu && "ring-2 ring-ring")}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              if (over?.menu !== menu) setOver({ menu, index: items.length });
            }}
            onDrop={(event) => {
              event.preventDefault();
              drop(menu, over?.menu === menu ? over.index : items.length);
            }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 id={`sitemap-menu-${menu}`} className="text-sm font-semibold">{MENU_LABELS[menu]}</h3>
              <span className="text-xs text-muted-foreground">{items.length} pages</span>
            </div>
            {items.length === 0 ? <p className="text-xs text-muted-foreground">{readOnly ? "No pages." : "Drag pages here, or use Move to on a page."}</p> : null}
            {[...groups.entries()].map(([group, groupItems]) => (
              <div key={group || "all"} className="space-y-1.5">
                {group ? <h4 className="text-xs font-medium text-muted-foreground">{group}</h4> : null}
                <ul className="space-y-1.5">
                  {groupItems.map((item) => {
                    const index = items.findIndex((entry) => entry.id === item.id);
                    const status = nodeStatus(item, pagesById);
                    return (
                      <li
                        key={item.id}
                        draggable={!readOnly}
                        onDragStart={(event) => {
                          setDragging(item.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", item.id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setOver(null);
                        }}
                        onDragOver={(event) => {
                          if (!dragging) return;
                          event.preventDefault();
                          event.stopPropagation();
                          setOver({ menu, index });
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          drop(menu, index);
                        }}
                        className={cn(
                          "flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5 text-sm",
                          over?.menu === menu && over.index === index && dragging !== item.id && "border-t-2 border-t-ring",
                        )}
                      >
                        {readOnly ? null : <GripVertical aria-hidden="true" className="size-4 shrink-0 cursor-grab text-muted-foreground" />}
                        <span className="min-w-0 flex-1 break-words font-medium" title={item.path}>{item.title}</span>
                        <StatusPill status={status} />
                        {status === "planned" && menu !== "none" ? <p className="w-full text-xs text-muted-foreground">{plannedHiddenNote(item.title)}</p> : null}
                        {readOnly ? null : (
                          <div className="flex w-full flex-wrap items-center gap-1">
                            {menu === "none" ? null : (
                              <>
                                <IconAction label={`Move ${item.title} up in the ${MENU_LABELS[menu]} menu`} icon={ArrowUp} disabled={index === 0} onClick={() => onChange(placeInMenu(tree, item.id, menu, index - 1))} />
                                <IconAction label={`Move ${item.title} down in the ${MENU_LABELS[menu]} menu`} icon={ArrowDown} disabled={index === items.length - 1} onClick={() => onChange(placeInMenu(tree, item.id, menu, index + 1))} />
                              </>
                            )}
                            <NativeSelect
                              aria-label={`Move ${item.title} to`}
                              value={menu}
                              onChange={(event) => onChange(placeInMenu(tree, item.id, event.target.value as WebsitePageMenu))}
                              className="h-6 w-auto text-xs"
                            >
                              {MENU_ORDER.map((target) => (
                                <option key={target} value={target}>{MENU_LABELS[target]}</option>
                              ))}
                            </NativeSelect>
                            {menu === "none" ? null : (
                              <Input
                                aria-label={`Column for ${item.title}`}
                                placeholder="Column"
                                defaultValue={item.menuColumn ?? ""}
                                onBlur={(event) => {
                                  const value = event.target.value.trim() || null;
                                  if (value !== (item.menuColumn ?? null)) onChange(updateNode(tree, item.id, { menuColumn: value }));
                                }}
                                className="h-6 w-32 text-xs"
                              />
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/* ---- Journeys ---- */

export function SitemapJourneysView({ tree, onChange, pagesById, readOnly }: SitemapViewProps) {
  const byId = useMemo(() => new Map(tree.nodes.map((node) => [node.id, node])), [tree]);
  const [newName, setNewName] = useState("");
  const [dragging, setDragging] = useState<{ journeyId: string; index: number } | null>(null);
  const setJourneys = (journeys: Tree["journeys"]) => onChange({ ...tree, journeys });
  const updateSteps = (journeyId: string, steps: string[]) =>
    setJourneys(tree.journeys.map((journey) => (journey.id === journeyId ? { ...journey, steps } : journey)));
  const moveStep = (steps: string[], from: number, to: number) => {
    const next = [...steps];
    const [step] = next.splice(from, 1);
    next.splice(to, 0, step!);
    return next;
  };
  const sortedPages = [...tree.nodes].sort((a, b) => a.path.localeCompare(b.path));

  return (
    <div className="space-y-4" data-testid="sitemap-journeys">
      {readOnly ? null : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newName.trim()) return;
            const ids = new Set(tree.journeys.map((journey) => journey.id));
            let n = tree.journeys.length + 1;
            while (ids.has(`j${n}`)) n += 1;
            setJourneys([...tree.journeys, { id: `j${n}`, name: newName.trim(), steps: [] }]);
            setNewName("");
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm sm:max-w-sm">
            <span className="font-medium">New journey</span>
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="For example: Leader, first call to blueprint" maxLength={120} />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={!newName.trim()}>
            <Plus aria-hidden="true" />
            Add journey
          </Button>
        </form>
      )}
      {tree.journeys.length === 0 ? <p className="text-sm text-muted-foreground">No journeys yet. A journey is the path a visitor takes, page by page, to an enquiry.</p> : null}
      {tree.journeys.map((journey) => (
        <section key={journey.id} aria-labelledby={`journey-${journey.id}`} className="gs-glass-card min-w-0 space-y-3 rounded-xl border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {readOnly ? (
              <h3 id={`journey-${journey.id}`} className="text-sm font-semibold">{journey.name}</h3>
            ) : (
              <Input
                id={`journey-${journey.id}`}
                aria-label="Journey name"
                defaultValue={journey.name}
                onBlur={(event) => {
                  const name = event.target.value.trim();
                  if (name && name !== journey.name) setJourneys(tree.journeys.map((entry) => (entry.id === journey.id ? { ...entry, name } : entry)));
                }}
                className="h-8 max-w-sm font-semibold"
              />
            )}
            {readOnly ? null : (
              <Button type="button" size="xs" variant="ghost" onClick={() => setJourneys(tree.journeys.filter((entry) => entry.id !== journey.id))}>
                <Trash2 aria-hidden="true" />
                Delete journey
              </Button>
            )}
          </div>
          <ol className="flex flex-wrap items-center gap-2" aria-label={`${journey.name} steps`}>
            {journey.steps.map((step, index) => {
              const node = byId.get(step);
              const status = node ? nodeStatus(node, pagesById) : null;
              return (
                <li
                  key={`${step}-${index}`}
                  className="flex items-center gap-2"
                  draggable={!readOnly}
                  onDragStart={() => setDragging({ journeyId: journey.id, index })}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(event) => {
                    if (dragging?.journeyId === journey.id) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragging?.journeyId === journey.id) updateSteps(journey.id, moveStep(journey.steps, dragging.index, index));
                    setDragging(null);
                  }}
                >
                  {index > 0 ? <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" /> : null}
                  <span className={cn("inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-sm", status === "planned" && "border-dashed")}>
                    <span className="text-xs text-muted-foreground">{index + 1}</span>
                    <span className="font-medium">{node?.title ?? "Removed page"}</span>
                    {status ? <StatusPill status={status} /> : null}
                    {readOnly ? null : (
                      <>
                        <IconAction label={`Move ${node?.title ?? "step"} earlier`} icon={ArrowLeft} disabled={index === 0} onClick={() => updateSteps(journey.id, moveStep(journey.steps, index, index - 1))} />
                        <IconAction label={`Move ${node?.title ?? "step"} later`} icon={ArrowRight} disabled={index === journey.steps.length - 1} onClick={() => updateSteps(journey.id, moveStep(journey.steps, index, index + 1))} />
                        <IconAction label={`Remove ${node?.title ?? "step"} from ${journey.name}`} icon={Trash2} onClick={() => updateSteps(journey.id, journey.steps.filter((_, i) => i !== index))} />
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
          <JourneyGaps tree={tree} steps={journey.steps} pagesById={pagesById} />
          {readOnly ? null : (
            <label className="flex max-w-sm flex-col gap-1 text-sm">
              <span className="font-medium">Add a step</span>
              <NativeSelect
                value=""
                onChange={(event) => {
                  if (event.target.value) updateSteps(journey.id, [...journey.steps, event.target.value]);
                }}
              >
                <option value="">Choose a page</option>
                {sortedPages.map((node) => (
                  <option key={node.id} value={node.id}>{node.title} ({node.path})</option>
                ))}
              </NativeSelect>
            </label>
          )}
        </section>
      ))}
    </div>
  );
}

/** One line per planned step, so the gaps in a journey read without hovering. */
function JourneyGaps({ tree, steps, pagesById }: { tree: Tree; steps: string[]; pagesById: Map<string, WebsitePage> }) {
  const planned = [...new Set(steps)]
    .map((step) => tree.nodes.find((node) => node.id === step))
    .filter((node): node is Node => !!node && nodeStatus(node, pagesById) === "planned");
  if (planned.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs text-muted-foreground" aria-label="Steps visitors cannot take yet">
      {planned.map((node) => <li key={node.id}>{journeyGapNote(node.title)}</li>)}
    </ul>
  );
}
