import type { IssueTreeBlockLink, IssueTreeNode } from "@greatstone/shared";

/**
 * The "blocks" links of a tree (GRE-2290): every link between the tasks the
 * tree shows and the tasks outside it, however long the chain. Loops are
 * found, never followed for ever. Pure functions, no React.
 */

/** One link: `from` blocks `to`. */
export interface TreeLink {
  from: string;
  to: string;
}

export interface TreeLinkGraph {
  links: TreeLink[];
  /** Open blockers of each task, sorted. */
  blockersOf: ReadonlyMap<string, string[]>;
  /** Tasks each task holds up, sorted. */
  blocksOf: ReadonlyMap<string, string[]>;
  /** Tasks in a loop, and the links that close one (`from>to`). */
  loopNodeIds: ReadonlySet<string>;
  loopLinks: ReadonlySet<string>;
}

export function linkKey(from: string, to: string) {
  return `${from}>${to}`;
}

/**
 * The links the server sent, or, from an older server, the links read off
 * each node's open blockers.
 */
export function treeLinksFrom(
  blockLinks: IssueTreeBlockLink[] | undefined,
  nodes: Pick<IssueTreeNode, "id" | "blockedByIds">[],
  isOpen: (id: string) => boolean,
): TreeLink[] {
  const out = new Map<string, TreeLink>();
  const add = (from: string, to: string) => {
    if (from !== to && isOpen(from)) out.set(linkKey(from, to), { from, to });
  };
  if (blockLinks) for (const link of blockLinks) add(link.blockerId, link.blockedId);
  else for (const node of nodes) for (const blockerId of node.blockedByIds) add(blockerId, node.id);
  return [...out.values()];
}

/**
 * Strongly connected parts of more than one task are loops (Tarjan). Returns
 * the loop each task sits in, keyed by task id.
 */
function findLoops(ids: string[], blocksOf: ReadonlyMap<string, string[]>) {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const loopOf = new Map<string, number>();
  let counter = 0;
  let loops = 0;

  // Iterative, so a chain of thousands cannot overflow the call stack.
  for (const start of ids) {
    if (order.has(start)) continue;
    const work: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    order.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const outs = blocksOf.get(frame.id) ?? [];
      if (frame.next < outs.length) {
        const to = outs[frame.next]!;
        frame.next += 1;
        if (!order.has(to)) {
          order.set(to, counter);
          low.set(to, counter);
          counter += 1;
          stack.push(to);
          onStack.add(to);
          work.push({ id: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, order.get(to)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === order.get(frame.id)) {
        const part: string[] = [];
        let id: string;
        do {
          id = stack.pop()!;
          onStack.delete(id);
          part.push(id);
        } while (id !== frame.id);
        if (part.length > 1) {
          for (const member of part) loopOf.set(member, loops);
          loops += 1;
        }
      }
    }
  }
  return loopOf;
}

function pushTo(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildLinkGraph(links: TreeLink[]): TreeLinkGraph {
  const blockersOf = new Map<string, string[]>();
  const blocksOf = new Map<string, string[]>();
  for (const { from, to } of links) {
    pushTo(blockersOf, to, from);
    pushTo(blocksOf, from, to);
  }
  for (const list of blockersOf.values()) list.sort();
  for (const list of blocksOf.values()) list.sort();
  const ids = [...new Set(links.flatMap((link) => [link.from, link.to]))].sort();
  const loopOf = findLoops(ids, blocksOf);
  // A link closes a loop when both its tasks sit in the same loop: then its
  // blocked task leads back to its blocker.
  const loopLinks = new Set(
    links
      .filter((link) => loopOf.has(link.from) && loopOf.get(link.from) === loopOf.get(link.to))
      .map((link) => linkKey(link.from, link.to)),
  );
  return { links, blockersOf, blocksOf, loopNodeIds: new Set(loopOf.keys()), loopLinks };
}

/**
 * The chain down from a task's first blocker: each hop's first open blocker,
 * to the task at the end. A loop stops the chain where it comes back round.
 */
export function blockerChain(graph: TreeLinkGraph, firstBlockerId: string): string[] {
  const chain = [firstBlockerId];
  const seen = new Set(chain);
  let id = firstBlockerId;
  for (;;) {
    const next = (graph.blockersOf.get(id) ?? []).find((blocker) => !seen.has(blocker));
    if (!next) return chain;
    chain.push(next);
    seen.add(next);
    id = next;
  }
}

/** One loop through a task, as a path that ends back on it. */
export function loopThrough(graph: TreeLinkGraph, id: string): string[] | null {
  if (!graph.loopNodeIds.has(id)) return null;
  // Breadth first along "is blocked by", inside the loop, back to the task.
  const previous = new Map<string, string>();
  const queue = [id];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    for (const blocker of graph.blockersOf.get(current) ?? []) {
      if (!graph.loopNodeIds.has(blocker)) continue;
      if (blocker === id) {
        const path = [id];
        let step = current;
        while (step !== id) {
          path.push(step);
          step = previous.get(step)!;
        }
        path.push(id);
        return path;
      }
      if (previous.has(blocker)) continue;
      previous.set(blocker, current);
      queue.push(blocker);
    }
  }
  return null;
}

/**
 * "Only what's blocked and why": every blocked task, and every task up its
 * chains, however far. The tree keeps their parents so they stay in place.
 */
export function blockedAndWhyIds(
  graph: TreeLinkGraph,
  tasks: Iterable<{ id: string; status: string }>,
): Set<string> {
  const keep = new Set<string>();
  const queue: string[] = [];
  for (const task of tasks) {
    if (task.status !== "blocked") continue;
    keep.add(task.id);
    queue.push(task.id);
  }
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const blocker of graph.blockersOf.get(id) ?? []) {
      if (keep.has(blocker)) continue;
      keep.add(blocker);
      queue.push(blocker);
    }
  }
  return keep;
}
