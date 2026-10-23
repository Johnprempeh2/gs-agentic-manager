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

/* ---- Board layout ---- */

export const BOARD_CARD = { width: 208, height: 64, gapX: 56, gapY: 16 } as const;

/** Card positions: stored x/y when set, otherwise a left-to-right tree (depth across, leaves down). */
export function boardLayout(tree: Tree): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  let row = 0;
  const place = (parentId: string | null, depth: number): number[] => {
    const ys: number[] = [];
    for (const node of childrenOf(tree, parentId)) {
      const childYs = place(node.id, depth + 1);
      // A parent sits level with its first sub-page, so the top-left of the board is always the start.
      const y = childYs.length ? childYs[0]! : row++ * (BOARD_CARD.height + BOARD_CARD.gapY);
      const auto = { x: depth * (BOARD_CARD.width + BOARD_CARD.gapX), y };
      positions.set(node.id, { x: node.x ?? auto.x, y: node.y ?? auto.y });
      ys.push(y);
    }
    return ys;
  };
  place(null, 0);
  return positions;
}
