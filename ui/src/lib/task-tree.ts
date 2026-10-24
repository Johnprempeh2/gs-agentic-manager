import type { IssueTree, IssueTreeExternalBlocker, IssueTreeNode } from "@greatstone/shared";
import { buildLinkGraph, treeLinksFrom, type TreeLinkGraph } from "./task-tree-links";

/**
 * The task tree: index the flat subtree from GET /issues/:id/tree, decide
 * what is visible (finished branches folded into a "+N done" pill, collapsed
 * branches), lay it out as a tidy top-down tree, and trace the blocked path
 * from the root to every root blocker. Pure functions, no React.
 */

const FINISHED = new Set(["done", "cancelled"]);

export function isFinished(status: string) {
  return FINISHED.has(status);
}

export interface TaskTreeIndex {
  root: IssueTreeNode;
  byId: Map<string, IssueTreeNode>;
  /** Sub-tasks in creation order (by key number), then title. */
  children: Map<string, IssueTreeNode[]>;
  external: Map<string, IssueTreeExternalBlocker>;
  truncated: boolean;
  limits: IssueTree["limits"];
  /** Finished tasks the server counted but did not send, by the task they sit under. */
  hiddenDone: ReadonlyMap<string, number>;
  /** Every open "blocks" link between tasks in the tree and outside it (GRE-2290). */
  graph: TreeLinkGraph;
}

const keyCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareNodes(a: IssueTreeNode, b: IssueTreeNode) {
  return keyCollator.compare(a.identifier ?? a.title, b.identifier ?? b.title) || keyCollator.compare(a.title, b.title);
}

export function indexTaskTree(
  tree: IssueTree,
  hiddenDone: ReadonlyMap<string, number> = new Map(),
): TaskTreeIndex | null {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const root = byId.get(tree.rootId);
  if (!root) return null;
  const children = new Map<string, IssueTreeNode[]>();
  for (const node of tree.nodes) {
    if (node.id === root.id || !node.parentId || !byId.has(node.parentId)) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) list.sort(compareNodes);
  const external = new Map(tree.externalBlockers.map((blocker) => [blocker.id, blocker]));
  const isOpen = (id: string) => {
    const task = byId.get(id) ?? external.get(id);
    return !!task && !isFinished(task.status);
  };
  return {
    root,
    byId,
    children,
    external,
    truncated: tree.truncated,
    limits: tree.limits,
    hiddenDone,
    graph: buildLinkGraph(treeLinksFrom(tree.blockLinks, tree.nodes, isOpen)),
  };
}

/** The card that gathers the tasks outside the tree that link to it. */
export function outsideGroupId(rootId: string) {
  return `${rootId}:outside`;
}

/** A task outside the tree, drawn as a card like the rest. */
export function outsideAsNode(task: IssueTreeExternalBlocker, rootId: string): IssueTreeNode {
  return {
    id: task.id,
    identifier: task.identifier,
    title: task.title,
    status: task.status,
    priority: "medium",
    assigneeAgentId: task.assigneeAgentId,
    assigneeUserId: task.assigneeUserId,
    parentId: outsideGroupId(rootId),
    depth: 2,
    blockedByIds: [],
    childCount: 0,
    doneChildCount: 0,
    terminalBlockerId: null,
    unblockAction: task.waitReason?.unblockAction ?? null,
    unblockOwner: task.waitReason?.unblockOwner ?? null,
    pendingCard: task.waitReason?.pendingCard ?? null,
    isKeyTask: false,
    updatedAt: new Date(0),
  };
}

/** Every task under `id` (not counting it). */
export function descendantCount(index: TaskTreeIndex, id: string): number {
  let count = 0;
  for (const child of index.children.get(id) ?? []) count += 1 + descendantCount(index, child.id);
  return count;
}

/** Finished tasks counted but not sent, under `id` and its sub-tasks. */
function hiddenDoneUnder(index: TaskTreeIndex, id: string): number {
  let count = index.hiddenDone.get(id) ?? 0;
  for (const child of index.children.get(id) ?? []) count += hiddenDoneUnder(index, child.id);
  return count;
}

function wholeBranchFinished(index: TaskTreeIndex, node: IssueTreeNode): boolean {
  if (!isFinished(node.status)) return false;
  return (index.children.get(node.id) ?? []).every((child) => wholeBranchFinished(index, child));
}

/** Done out of all sub-tasks under the root, cancelled ones left out. */
export function treeProgress(index: TaskTreeIndex) {
  let done = 0;
  let total = 0;
  for (const node of index.byId.values()) {
    if (node.id === index.root.id || node.status === "cancelled") continue;
    total += 1;
    if (node.status === "done") done += 1;
  }
  return { done, total };
}

// ---------------------------------------------------------------------------
// Visible tree
// ---------------------------------------------------------------------------

export type VisibleTaskItem = {
  kind: "task";
  id: string;
  node: IssueTreeNode;
  children: VisibleItem[];
  /** True when the viewer folded this branch away. */
  collapsed: boolean;
  /** Tasks under this one, shown or not. */
  descendants: number;
  /** The card that gathers the tasks outside the tree; it folds, it does not open. */
  group?: boolean;
  /** A task outside the tree, linked to it by "blocks". */
  outside?: { projectName: string | null };
};

export type VisibleDoneItem = {
  kind: "done";
  /** `${parentId}:done` */
  id: string;
  parentId: string;
  /** Finished tasks folded into the pill, their own sub-tasks included. */
  count: number;
};

export type VisibleItem = VisibleTaskItem | VisibleDoneItem;

export function doneItemId(parentId: string) {
  return `${parentId}:done`;
}

export function visibleTaskTree(
  index: TaskTreeIndex,
  options: {
    showFinished: boolean;
    collapsed: ReadonlySet<string>;
    /** Show only these tasks (and the way down to them); null shows everything. */
    only?: ReadonlySet<string> | null;
  },
): VisibleTaskItem {
  const only = options.only ?? null;
  const kept = new Map<string, boolean>();
  // A task stays under the filter when it is wanted or something under it is.
  const wanted = (node: IssueTreeNode): boolean => {
    if (!only) return true;
    const known = kept.get(node.id);
    if (known !== undefined) return known;
    const result = only.has(node.id) || (index.children.get(node.id) ?? []).some(wanted);
    kept.set(node.id, result);
    return result;
  };
  const build = (node: IssueTreeNode): VisibleTaskItem => {
    const all = (index.children.get(node.id) ?? []).filter(wanted);
    const descendants = only
      ? all.reduce((sum, child) => sum + 1 + descendantCount(index, child.id), 0)
      : descendantCount(index, node.id) + hiddenDoneUnder(index, node.id);
    const collapsed = options.collapsed.has(node.id) && descendants > 0;
    const children: VisibleItem[] = [];
    if (!collapsed) {
      let folded = only ? 0 : (index.hiddenDone.get(node.id) ?? 0);
      for (const child of all) {
        if (!options.showFinished && wholeBranchFinished(index, child)) {
          folded += 1 + descendantCount(index, child.id) + hiddenDoneUnder(index, child.id);
        } else {
          children.push(build(child));
        }
      }
      if (folded > 0) children.push({ kind: "done", id: doneItemId(node.id), parentId: node.id, count: folded });
    }
    return { kind: "task", id: node.id, node, children, collapsed, descendants };
  };
  const root = build(index.root);

  // Tasks outside the tree that link to it, gathered on one card under the
  // root and shown open: nothing linked is hidden unless the reader folds it.
  const outside = [...index.external.values()]
    .filter((task) => !only || only.has(task.id))
    .map((task) => outsideAsNode(task, index.root.id))
    .sort(compareNodes);
  if (outside.length > 0 && !root.collapsed) {
    const groupId = outsideGroupId(index.root.id);
    const collapsed = options.collapsed.has(groupId);
    const byId = new Map([...index.external.values()].map((task) => [task.id, task]));
    root.children.push({
      kind: "task",
      id: groupId,
      group: true,
      node: {
        ...outsideAsNode(
          { id: groupId, identifier: null, title: "", status: "todo", assigneeAgentId: null, assigneeUserId: null },
          index.root.id,
        ),
        title: `Linked from outside this tree: ${outside.length} ${outside.length === 1 ? "task" : "tasks"}`,
        parentId: index.root.id,
        depth: 1,
      },
      collapsed,
      descendants: outside.length,
      children: collapsed
        ? []
        : outside.map((node) => ({
            kind: "task" as const,
            id: node.id,
            node,
            children: [],
            collapsed: false,
            descendants: 0,
            outside: { projectName: byId.get(node.id)?.projectName ?? null },
          })),
    });
  }
  return root;
}

/** Ids of every visible item, parent before child. */
export function flattenVisible(root: VisibleItem): VisibleItem[] {
  const out: VisibleItem[] = [];
  const walk = (item: VisibleItem) => {
    out.push(item);
    if (item.kind === "task") item.children.forEach(walk);
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Tidy tree layout
// ---------------------------------------------------------------------------

export interface LayoutBox {
  id: string;
  kind: VisibleItem["kind"];
  parentId: string | null;
  depth: number;
  /** Top-left corner, in canvas pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TreeLayout {
  boxes: LayoutBox[];
  byId: Map<string, LayoutBox>;
  edges: { from: string; to: string }[];
  width: number;
  height: number;
}

export interface TidyTreeOptions {
  sizeOf: (item: VisibleItem) => { width: number; height: number };
  /** Space between neighbours on the same row. */
  siblingGap: number;
  /** Space between rows. */
  levelGap: number;
  /** Empty margin around the whole tree. */
  padding: number;
}

interface Contour {
  /** Per level below (and including) the subtree root: leftmost and rightmost edge, relative to the root's centre. */
  left: number[];
  right: number[];
}

/**
 * A tidy tree in the Reingold-Tilford family: each subtree is laid out on
 * its own, siblings are pushed apart until their contours clear at every
 * level, and each parent is centred over its first and last child. Nothing
 * overlaps, row by row, whatever the card widths.
 */
export function layoutTidyTree(root: VisibleItem, options: TidyTreeOptions): TreeLayout {
  const offset = new Map<string, number>(); // centre x relative to the parent's centre
  const sizes = new Map<string, { width: number; height: number }>();

  const place = (item: VisibleItem): Contour => {
    const size = options.sizeOf(item);
    sizes.set(item.id, size);
    const half = size.width / 2;
    const kids = item.kind === "task" ? item.children : [];
    if (kids.length === 0) return { left: [-half], right: [half] };

    const subs = kids.map(place);
    const positions = [0];
    const acc: Contour = { left: [...subs[0]!.left], right: [...subs[0]!.right] };
    for (let i = 1; i < subs.length; i += 1) {
      const sub = subs[i]!;
      let shift = Number.NEGATIVE_INFINITY;
      const shared = Math.min(acc.right.length, sub.left.length);
      for (let level = 0; level < shared; level += 1) {
        shift = Math.max(shift, acc.right[level]! - sub.left[level]! + options.siblingGap);
      }
      positions.push(shift);
      for (let level = 0; level < sub.left.length; level += 1) {
        const l = sub.left[level]! + shift;
        const r = sub.right[level]! + shift;
        if (level < acc.left.length) {
          acc.left[level] = Math.min(acc.left[level]!, l);
          acc.right[level] = Math.max(acc.right[level]!, r);
        } else {
          acc.left.push(l);
          acc.right.push(r);
        }
      }
    }
    const mid = (positions[0]! + positions[positions.length - 1]!) / 2;
    kids.forEach((kid, i) => offset.set(kid.id, positions[i]! - mid));
    return {
      left: [-half, ...acc.left.map((value) => value - mid)],
      right: [half, ...acc.right.map((value) => value - mid)],
    };
  };

  place(root);

  // Row heights: every row is as tall as its tallest item.
  const rowHeights: number[] = [];
  const centres = new Map<string, { cx: number; depth: number; parentId: string | null }>();
  const walk = (item: VisibleItem, cx: number, depth: number, parentId: string | null) => {
    centres.set(item.id, { cx, depth, parentId });
    rowHeights[depth] = Math.max(rowHeights[depth] ?? 0, sizes.get(item.id)!.height);
    if (item.kind === "task") for (const kid of item.children) walk(kid, cx + offset.get(kid.id)!, depth + 1, item.id);
  };
  walk(root, 0, 0, null);

  const rowTop: number[] = [];
  let top = options.padding;
  for (let depth = 0; depth < rowHeights.length; depth += 1) {
    rowTop[depth] = top;
    top += rowHeights[depth]! + options.levelGap;
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const [id, { cx }] of centres) {
    const { width } = sizes.get(id)!;
    minX = Math.min(minX, cx - width / 2);
    maxX = Math.max(maxX, cx + width / 2);
  }

  const boxes: LayoutBox[] = [];
  const edges: TreeLayout["edges"] = [];
  const kindOf = new Map(flattenVisible(root).map((item) => [item.id, item.kind]));
  for (const [id, { cx, depth, parentId }] of centres) {
    const { width, height } = sizes.get(id)!;
    boxes.push({
      id,
      kind: kindOf.get(id)!,
      parentId,
      depth,
      x: cx - width / 2 - minX + options.padding,
      y: rowTop[depth]!,
      width,
      height,
    });
    if (parentId) edges.push({ from: parentId, to: id });
  }
  return {
    boxes,
    byId: new Map(boxes.map((box) => [box.id, box])),
    edges,
    width: maxX - minX + options.padding * 2,
    height: top - options.levelGap + options.padding,
  };
}

/** A smooth top-down connector from the bottom of one box to the top of another. */
export function connectorPath(from: Pick<LayoutBox, "x" | "y" | "width" | "height">, to: Pick<LayoutBox, "x" | "y" | "width">) {
  const x1 = from.x + from.width / 2;
  const y1 = from.y + from.height;
  const x2 = to.x + to.width / 2;
  const y2 = to.y;
  const bend = (y2 - y1) / 2;
  return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
}

type Box = Pick<LayoutBox, "x" | "y" | "width" | "height">;

/**
 * A "blocks" line from the blocker's side to the blocked task's side, bowed
 * so it reads apart from the straight-down sub-task lines. Cards side by
 * side join at their facing edges; cards stacked in one column join on the
 * right, with a bow out to the side.
 */
export function blockLinkPath(from: Box, to: Box) {
  const fromCx = from.x + from.width / 2;
  const toCx = to.x + to.width / 2;
  const y1 = from.y + from.height / 2;
  const y2 = to.y + to.height / 2;
  const overlap = Math.min(from.x + from.width, to.x + to.width) - Math.max(from.x, to.x);
  if (overlap > 0) {
    const x1 = from.x + from.width;
    const x2 = to.x + to.width;
    const bow = Math.max(x1, x2) + Math.min(120, 40 + Math.abs(y2 - y1) / 4);
    return `M ${x1} ${y1} C ${bow} ${y1}, ${bow} ${y2}, ${x2} ${y2}`;
  }
  const rightward = toCx > fromCx;
  const x1 = rightward ? from.x + from.width : from.x;
  const x2 = rightward ? to.x : to.x + to.width;
  const pull = Math.max(40, Math.abs(x2 - x1) / 3);
  // Cards on one row bow up over the row, so the line clears the cards between.
  const lift = Math.abs(y2 - y1) < from.height ? Math.min(160, 30 + Math.abs(x2 - x1) / 6) : 0;
  return `M ${x1} ${y1} C ${x1 + (rightward ? pull : -pull)} ${y1 - lift}, ${x2 - (rightward ? pull : -pull)} ${y2 - lift}, ${x2} ${y2}`;
}

// ---------------------------------------------------------------------------
// Blocked path
// ---------------------------------------------------------------------------

export interface RootBlocker {
  /** The task that needs action: in the tree, or outside it. */
  id: string;
  inTree: boolean;
  /** The task in the tree to show for it: itself, or the task it holds up. */
  anchorId: string;
  /** Blocked tasks in the tree that wait on it, directly or down a chain. */
  holdsUp: string[];
  title: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  /** What is needed, in a few words. */
  need: string;
  waitingOnViewer: boolean;
}

export interface BlockedTrace {
  rootBlockers: RootBlocker[];
  /** Tasks on a path from the root to a root blocker. */
  pathNodeIds: Set<string>;
  /** `${parentId}>${childId}` for every tree edge on such a path. */
  pathEdges: Set<string>;
  /** "Blocks" links inside the tree on a blocked chain, blocker to blocked. */
  blockLinks: { from: string; to: string }[];
}

export function edgeKey(from: string, to: string) {
  return `${from}>${to}`;
}

type BlockerLike = Pick<IssueTreeNode, "status" | "assigneeAgentId" | "assigneeUserId"> & { unblockAction?: string | null };

/** What a blocker needs, in a few words. */
export function blockerNeed(task: BlockerLike): string {
  if (task.status === "blocked") return task.unblockAction ?? "Needs unblocking";
  if (task.status === "in_review") return "Needs a review";
  if (!task.assigneeAgentId && !task.assigneeUserId) return "Needs an owner";
  if (task.status === "in_progress") return "In progress";
  return "Not started yet";
}

export function traceBlockedPaths(index: TaskTreeIndex, viewerUserId?: string | null): BlockedTrace {
  const statusOf = (id: string) => index.byId.get(id)?.status ?? index.external.get(id)?.status ?? null;
  const isOpen = (id: string) => {
    const status = statusOf(id);
    return status !== null && !isFinished(status);
  };
  // A task's open blockers: its links, inside the tree and out, however far.
  const openBlockers = (id: string) => {
    const node = index.byId.get(id);
    return [
      ...new Set([
        ...(index.graph.blockersOf.get(id) ?? []),
        ...(node?.blockedByIds ?? []),
        ...(node?.terminalBlockerId ? [node.terminalBlockerId] : []),
      ]),
    ].filter((blockerId) => blockerId !== id && isOpen(blockerId));
  };

  const found = new Map<string, { anchors: Set<string>; holdsUp: Set<string> }>();
  const blockLinks = new Map<string, { from: string; to: string }>();
  const record = (id: string, anchor: string, heldUp: string) => {
    const entry = found.get(id) ?? { anchors: new Set<string>(), holdsUp: new Set<string>() };
    entry.anchors.add(anchor);
    entry.holdsUp.add(heldUp);
    found.set(id, entry);
  };

  for (const start of index.byId.values()) {
    if (start.status !== "blocked") continue;
    const seen = new Set<string>();
    // `anchor` is the nearest task in the tree on the way: where an outside
    // task is shown when the outside card is folded.
    const visit = (id: string, anchor: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const blockers = openBlockers(id);
      if (blockers.length === 0) {
        record(id, anchor, start.id);
        return;
      }
      for (const blockerId of blockers) {
        const inTree = index.byId.has(blockerId);
        if (inTree) blockLinks.set(edgeKey(blockerId, id), { from: blockerId, to: id });
        const next = inTree ? blockerId : anchor;
        if (statusOf(blockerId) === "blocked") visit(blockerId, next);
        else if (!seen.has(blockerId)) {
          seen.add(blockerId);
          record(blockerId, next, start.id);
        }
      }
    };
    visit(start.id, start.id);
  }

  const pathNodeIds = new Set<string>();
  const pathEdges = new Set<string>();
  const climb = (id: string) => {
    let node = index.byId.get(id);
    while (node) {
      pathNodeIds.add(node.id);
      if (!node.parentId) break;
      pathEdges.add(edgeKey(node.parentId, node.id));
      node = index.byId.get(node.parentId);
    }
  };

  const rootBlockers: RootBlocker[] = [];
  for (const [id, { anchors, holdsUp }] of found) {
    const node = index.byId.get(id);
    const task = node ?? index.external.get(id)!;
    const [anchorId] = [...anchors];
    for (const anchor of anchors) climb(anchor);
    rootBlockers.push({
      id,
      inTree: !!node,
      anchorId: anchorId!,
      holdsUp: [...holdsUp].filter((heldUp) => heldUp !== id),
      title: task.title,
      identifier: task.identifier,
      status: task.status,
      assigneeAgentId: task.assigneeAgentId,
      assigneeUserId: task.assigneeUserId,
      need: blockerNeed(node ?? { ...task, unblockAction: null }),
      waitingOnViewer: !!viewerUserId && task.assigneeUserId === viewerUserId,
    });
  }
  rootBlockers.sort(
    (a, b) =>
      Number(b.waitingOnViewer) - Number(a.waitingOnViewer) ||
      b.holdsUp.length - a.holdsUp.length ||
      keyCollator.compare(a.identifier ?? a.title, b.identifier ?? b.title),
  );
  return { rootBlockers, pathNodeIds, pathEdges, blockLinks: [...blockLinks.values()] };
}

/** The visible item that stands for a task: itself, or the nearest shown ancestor. */
export function visibleStandIn(index: TaskTreeIndex, visibleIds: ReadonlySet<string>, id: string): string | null {
  if (index.external.has(id)) {
    if (visibleIds.has(id)) return id;
    const groupId = outsideGroupId(index.root.id);
    return visibleIds.has(groupId) ? groupId : visibleIds.has(index.root.id) ? index.root.id : null;
  }
  let node = index.byId.get(id);
  while (node) {
    if (visibleIds.has(node.id)) return node.id;
    if (!node.parentId) return null;
    const parentId = node.parentId;
    if (visibleIds.has(doneItemId(parentId)) && isFinished(node.status)) return doneItemId(parentId);
    node = index.byId.get(parentId);
  }
  return null;
}

/** Ancestors of a task, root first, not counting it. */
export function ancestorIds(index: TaskTreeIndex, id: string): string[] {
  if (index.external.has(id)) return [index.root.id, outsideGroupId(index.root.id)];
  const out: string[] = [];
  let node = index.byId.get(id);
  while (node?.parentId) {
    out.unshift(node.parentId);
    node = index.byId.get(node.parentId);
  }
  return out;
}
