import type {
  WebsitePage,
  WebsitePageMenu,
  WebsiteSitemapNode,
  WebsiteSitemapTree,
} from "@greatstone/shared";

// Pure edits on a sitemap option's tree (GRE-2111). Every view edits through
// these, so drag and the keyboard buttons do exactly the same thing. Each
// function returns a new tree and never mutates its input.

export type Tree = WebsiteSitemapTree;
export type Node = WebsiteSitemapNode;

export function childrenOf(tree: Tree, parentId: string | null): Node[] {
  return tree.nodes.filter((node) => node.parentId === parentId).sort((a, b) => a.order - b.order);
}

/** Depth-first rows with their depth, as the Tree view shows them. */
export function flatten(tree: Tree): Array<{ node: Node; depth: number }> {
  const rows: Array<{ node: Node; depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const node of childrenOf(tree, parentId)) {
      rows.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** One row of the vertical Tree (GRE-2509): what to draw to its left and whether it folds. */
export interface OutlineRow {
  node: Node;
  depth: number;
  /** One per level above this row's own: true when that ancestor has a later sibling, so its line runs on past this row. */
  rails: boolean[];
  /** The last of its siblings: its connector stops at its own row. */
  last: boolean;
  childCount: number;
  folded: boolean;
}

/** The Tree's rows read top to bottom, skipping the sub-pages of folded pages. */
export function outlineRows(tree: Tree, folded: ReadonlySet<string>): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (parentId: string | null, depth: number, rails: boolean[]) => {
    const siblings = childrenOf(tree, parentId);
    siblings.forEach((node, index) => {
      const childCount = childrenOf(tree, node.id).length;
      const last = index === siblings.length - 1;
      const isFolded = childCount > 0 && folded.has(node.id);
      rows.push({ node, depth, rails, last, childCount, folded: isFolded });
      // Top-level pages draw no connector, so their sub-pages carry no rail for them.
      if (!isFolded) walk(node.id, depth + 1, depth === 0 ? [] : [...rails, !last]);
    });
  };
  walk(null, 0, []);
  return rows;
}

/** Sections with more sub-pages than this open folded, below the top two levels. */
export const OUTLINE_FOLD_OVER = 12;

/** Opening fold: Home and its sections stay open; a deeper page with more than 12 sub-pages starts folded. */
export function defaultFolded(tree: Tree): Set<string> {
  const folded = new Set<string>();
  for (const { node, depth } of flatten(tree)) {
    if (depth >= 2 && childrenOf(tree, node.id).length > OUTLINE_FOLD_OVER) folded.add(node.id);
  }
  return folded;
}

/**
 * The part of a page's URL its parent does not already say (GRE-2509): under
 * `/consultancy/services` the page `/consultancy/services/websites` shows
 * `/websites`. A path that does not sit under its parent's shows in full.
 */
export function ownSlug(path: string, parentPath: string | undefined): string {
  const base = parentPath?.replace(/\/+$/, "");
  if (!base || !path.startsWith(`${base}/`) || path.length === base.length + 1) return path;
  return path.slice(base.length);
}

/** The pages above a page, nearest first. */
export function ancestorIds(tree: Tree, id: string): string[] {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const out: string[] = [];
  for (let parent = byId.get(id)?.parentId; parent && !out.includes(parent); parent = byId.get(parent)?.parentId) out.push(parent);
  return out;
}

export function descendantIds(tree: Tree, id: string): Set<string> {
  const out = new Set<string>();
  const walk = (parentId: string) => {
    for (const node of tree.nodes) {
      if (node.parentId === parentId && !out.has(node.id)) {
        out.add(node.id);
        walk(node.id);
      }
    }
  };
  walk(id);
  return out;
}

function withNodes(tree: Tree, nodes: Node[]): Tree {
  return { ...tree, nodes };
}

/** Renumber the siblings under one parent in the given order. */
function reorder(nodes: Node[], parentId: string | null, orderedIds: string[]): Node[] {
  const index = new Map(orderedIds.map((id, i) => [id, i]));
  return nodes.map((node) => (node.parentId === parentId && index.has(node.id) ? { ...node, order: index.get(node.id)! } : node));
}

export function updateNode(tree: Tree, id: string, patch: Partial<Node>): Tree {
  return withNodes(tree, tree.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)));
}

/** Move a page among its siblings by -1 (up) or +1 (down). */
export function moveSibling(tree: Tree, id: string, delta: -1 | 1): Tree {
  const node = tree.nodes.find((entry) => entry.id === id);
  if (!node) return tree;
  const siblings = childrenOf(tree, node.parentId).map((entry) => entry.id);
  const from = siblings.indexOf(id);
  const to = from + delta;
  if (to < 0 || to >= siblings.length) return tree;
  siblings.splice(from, 1);
  siblings.splice(to, 0, id);
  return withNodes(tree, reorder(tree.nodes, node.parentId, siblings));
}

/**
 * Put a page under `parentId` at `index` among its new siblings (end when omitted).
 * Refuses (returns the tree unchanged) a move under itself or one of its sub-pages.
 */
export function moveTo(tree: Tree, id: string, parentId: string | null, index?: number): Tree {
  if (parentId === id || (parentId && descendantIds(tree, id).has(parentId))) return tree;
  const node = tree.nodes.find((entry) => entry.id === id);
  if (!node) return tree;
  const oldSiblings = childrenOf(tree, node.parentId).map((entry) => entry.id).filter((entry) => entry !== id);
  let nodes = tree.nodes.map((entry) => (entry.id === id ? { ...entry, parentId } : entry));
  nodes = reorder(nodes, node.parentId, oldSiblings);
  const newSiblings = nodes
    .filter((entry) => entry.parentId === parentId && entry.id !== id)
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.id);
  newSiblings.splice(index === undefined ? newSiblings.length : Math.max(0, Math.min(index, newSiblings.length)), 0, id);
  return withNodes(tree, reorder(nodes, parentId, newSiblings));
}

/** Make a page a sub-page of the sibling above it. */
export function indent(tree: Tree, id: string): Tree {
  const node = tree.nodes.find((entry) => entry.id === id);
  if (!node) return tree;
  const siblings = childrenOf(tree, node.parentId);
  const position = siblings.findIndex((entry) => entry.id === id);
  if (position <= 0) return tree;
  return moveTo(tree, id, siblings[position - 1]!.id);
}

/** Move a page up one level, just after its old parent. */
export function outdent(tree: Tree, id: string): Tree {
  const node = tree.nodes.find((entry) => entry.id === id);
  const parent = node?.parentId ? tree.nodes.find((entry) => entry.id === node.parentId) : undefined;
  if (!node || !parent) return tree;
  const position = childrenOf(tree, parent.parentId).findIndex((entry) => entry.id === parent.id);
  return moveTo(tree, id, parent.parentId, position + 1);
}

export function newNodeId(tree: Tree): string {
  const ids = new Set(tree.nodes.map((node) => node.id));
  let n = tree.nodes.length + 1;
  while (ids.has(`n${n}`)) n += 1;
  return `n${n}`;
}

/** A free path under the parent's path: `/parent/new-page`, `/parent/new-page-2`, ... */
export function freePath(tree: Tree, parentId: string | null, slug = "new-page"): string {
  const parent = parentId ? tree.nodes.find((node) => node.id === parentId) : undefined;
  const base = `${parent && parent.path !== "/" ? parent.path : ""}/${slug}`;
  const taken = new Set(tree.nodes.map((node) => node.path));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function addNode(tree: Tree, parentId: string | null, title = "New page"): { tree: Tree; id: string } {
  const id = newNodeId(tree);
  const order = childrenOf(tree, parentId).length;
  const node: Node = { id, title, path: freePath(tree, parentId), parentId, order, menu: "none", menuOrder: null };
  return { tree: withNodes(tree, [...tree.nodes, node]), id };
}

/** Remove a page from the option; its sub-pages move up to its parent. Journeys drop it. */
export function removeNode(tree: Tree, id: string): Tree {
  const node = tree.nodes.find((entry) => entry.id === id);
  if (!node) return tree;
  let next = tree;
  for (const child of childrenOf(tree, id)) next = moveTo(next, child.id, node.parentId);
  const remaining = childrenOf(next, node.parentId).map((entry) => entry.id).filter((entry) => entry !== id);
  return {
    nodes: reorder(next.nodes.filter((entry) => entry.id !== id), node.parentId, remaining),
    journeys: next.journeys.map((journey) => ({ ...journey, steps: journey.steps.filter((step) => step !== id) })),
  };
}

/** Copy a page and its sub-pages from another option into this one, under `parentId`. Paths already used get a suffix. */
export function copyBranch(from: Tree, nodeId: string, into: Tree, parentId: string | null): Tree {
  const root = from.nodes.find((node) => node.id === nodeId);
  if (!root) return into;
  const ids = [nodeId, ...descendantIds(from, nodeId)];
  const idMap = new Map<string, string>();
  let next = into;
  for (const id of ids) {
    const source = from.nodes.find((node) => node.id === id)!;
    const newId = newNodeId(next);
    idMap.set(id, newId);
    const targetParent = id === nodeId ? parentId : idMap.get(source.parentId!) ?? parentId;
    const taken = new Set(next.nodes.map((node) => node.path));
    let path = source.path;
    for (let n = 2; taken.has(path); n += 1) path = `${source.path}-${n}`;
    const order = id === nodeId ? childrenOf(next, parentId).length : source.order;
    next = withNodes(next, [
      ...next.nodes,
      { ...source, id: newId, parentId: targetParent, order, path, pageId: null, x: null, y: null },
    ]);
  }
  return next;
}

/* ---- Menus ---- */

/** Pages in one menu, in menu order. */
export function menuItems(tree: Tree, menu: WebsitePageMenu): Node[] {
  return tree.nodes
    .filter((node) => node.menu === menu)
    .sort((a, b) => (a.menuOrder ?? Number.MAX_SAFE_INTEGER) - (b.menuOrder ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title));
}

/** Put a page into a menu at `index` (end when omitted) and renumber that menu. */
export function placeInMenu(tree: Tree, id: string, menu: WebsitePageMenu, index?: number): Tree {
  const others = menuItems(tree, menu).map((node) => node.id).filter((entry) => entry !== id);
  others.splice(index === undefined ? others.length : Math.max(0, Math.min(index, others.length)), 0, id);
  const position = new Map(others.map((entry, i) => [entry, i + 1]));
  const oldMenu = tree.nodes.find((node) => node.id === id)?.menu;
  const oldOthers = oldMenu && oldMenu !== menu ? menuItems(tree, oldMenu).map((node) => node.id).filter((entry) => entry !== id) : [];
  const oldPosition = new Map(oldOthers.map((entry, i) => [entry, i + 1]));
  return withNodes(
    tree,
    tree.nodes.map((node) => {
      if (node.id === id) return { ...node, menu, menuOrder: menu === "none" ? null : position.get(id)! };
      if (menu !== "none" && position.has(node.id)) return { ...node, menuOrder: position.get(node.id)! };
      if (oldMenu !== "none" && oldPosition.has(node.id)) return { ...node, menuOrder: oldPosition.get(node.id)! };
      return node;
    }),
  );
}

/* ---- Page status ---- */

export type SitemapPageStatus = "new" | "planned" | "drafted" | "live";

export const SITEMAP_STATUS_LABELS: Record<SitemapPageStatus, string> = {
  new: "New",
  planned: "Planned",
  drafted: "Drafted",
  live: "Live",
};

/** Site pages by id and by `slug:<path>`, so a draft option's page shows the status of the page it would become. */
export function pagesLookup(pages: WebsitePage[]): Map<string, WebsitePage> {
  return new Map(pages.flatMap((page) => [[page.id, page], [`slug:${page.slug}`, page]] as const));
}

/** A node's page status: `new` when no site page has its id or path yet. */
export function nodeStatus(node: Node, pagesById: Map<string, WebsitePage>): SitemapPageStatus {
  const page = (node.pageId ? pagesById.get(node.pageId) : undefined) ?? pagesById.get(`slug:${node.path}`);
  if (!page) return "new";
  if (page.status === "planned") return "planned";
  if (page.status === "published") return "live";
  return "drafted";
}

/* ---- Board layout (GRE-2542) ---- */

/** Card size and spacing on the Board, in board pixels. At 100% the title is 14px and the path 12px. */
export const BOARD_CARD = { width: 232, height: 88 } as const;
export const BOARD_GAP = {
  /** Between two section columns. */
  column: 32,
  /** From Home down to the sections, and from a section down to its first page. */
  level: 48,
  /** Between pages stacked in a column. */
  stack: 12,
  /** How far a page sits in from its parent, so the parent's line runs down its left. */
  indent: 24,
} as const;
/** The "+N pages" button under a folded page. */
export const BOARD_MORE = { width: 120, height: 32 } as const;

/** Sections with more sub-pages than this open folded on the Board. */
export const BOARD_FOLD_OVER = 8;

export interface BoardBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardLayout {
  cards: Map<string, BoardBox>;
  /** One "+N pages" button per folded page, keyed by that page's id. */
  more: Map<string, BoardBox & { count: number }>;
  /** The page at the top (usually Home), when the site has a single top page. */
  topId: string | null;
  width: number;
  height: number;
}

/**
 * A top-down tree (GRE-2542): Home at the top, its sections in a row under it,
 * and each section's pages stacked in a column under that section, one step in
 * per level. Folded pages hide their sub-pages behind a "+N pages" button.
 * Stored x/y from the old left-to-right board are ignored: the board is always tidy.
 */
export function boardLayout(tree: Tree, folded: ReadonlySet<string> = new Set()): BoardLayout {
  const cards = new Map<string, BoardBox>();
  const more = new Map<string, BoardBox & { count: number }>();
  const roots = childrenOf(tree, null);
  const top = roots.length === 1 ? roots[0]! : null;
  const sections = top ? childrenOf(tree, top.id) : roots;
  const sectionY = top ? BOARD_CARD.height + BOARD_GAP.level : 0;

  // Stack a page's sub-pages under it; returns the bottom edge and the widest right edge.
  const stack = (parent: Node, box: BoardBox): { bottom: number; right: number } => {
    let bottom = box.y + box.height;
    let right = box.x + box.width;
    const x = box.x + BOARD_GAP.indent;
    const kids = childrenOf(tree, parent.id);
    if (kids.length === 0) return { bottom, right };
    if (folded.has(parent.id)) {
      const button = { x, y: bottom + BOARD_GAP.stack, ...BOARD_MORE, count: descendantIds(tree, parent.id).size };
      more.set(parent.id, button);
      return { bottom: button.y + button.height, right: Math.max(right, x + button.width) };
    }
    for (const [index, kid] of kids.entries()) {
      // A section's first page sits a level below it; the rest stack close.
      const gap = index === 0 && parent.parentId === (top?.id ?? null) ? BOARD_GAP.level / 2 : BOARD_GAP.stack;
      const kidBox = { x, y: bottom + gap, ...BOARD_CARD };
      cards.set(kid.id, kidBox);
      const below = stack(kid, kidBox);
      bottom = below.bottom;
      right = Math.max(right, below.right);
    }
    return { bottom, right };
  };

  let x = 0;
  let height = top ? BOARD_CARD.height : 0;
  for (const section of sections) {
    const box = { x, y: sectionY, ...BOARD_CARD };
    cards.set(section.id, box);
    const { bottom, right } = stack(section, box);
    height = Math.max(height, bottom);
    x = right + BOARD_GAP.column;
  }
  const rowWidth = Math.max(0, x - BOARD_GAP.column);
  const width = Math.max(rowWidth, top ? BOARD_CARD.width : 0);
  if (top) {
    cards.set(top.id, { x: (width - BOARD_CARD.width) / 2, y: 0, ...BOARD_CARD });
    // Home's own sub-pages are the sections; Home only folds from the toolbar, never on its own.
  }
  return { cards, more, topId: top?.id ?? null, width, height };
}

/** Opening fold on the Board: every page below Home with more than 8 sub-pages starts folded. */
export function boardDefaultFolded(tree: Tree): Set<string> {
  const roots = childrenOf(tree, null);
  const top = roots.length === 1 ? roots[0]!.id : null;
  return new Set(tree.nodes.filter((node) => node.id !== top && childrenOf(tree, node.id).length > BOARD_FOLD_OVER).map((node) => node.id));
}
