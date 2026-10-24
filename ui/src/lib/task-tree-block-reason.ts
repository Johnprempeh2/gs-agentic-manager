import type {
  IssueTreeExternalBlocker,
  IssueTreeNode,
  IssueTreeWaitReason,
  IssueUnblockOwner,
} from "@greatstone/shared";
import { outsideAsNode, type TaskTreeIndex } from "./task-tree";
import { blockerChain, loopThrough } from "./task-tree-links";

/** Who can own or answer things in the tree, for naming them. */
export interface TreeNamePeople {
  agents: ReadonlyMap<string, { name: string }>;
  users: ReadonlyMap<string, { label: string }>;
  viewerUserId?: string | null;
}

/** One line of a blocked task's reason, with where it leads. */
export interface TreeBlockLine {
  text: string;
  /** The blocker, or the card on the task that waits for a reply. */
  href: string | null;
}

/**
 * Why a blocked task in the tree is blocked (GRE-2277): what holds it up
 * directly, and the task at the bottom of its chain with what that waits on.
 */
export interface TreeBlockReason {
  own: TreeBlockLine;
  /** The root of the chain, when it is further down than the first blocker. */
  root: TreeBlockLine | null;
  /** The loop the task sits in, when its blockers lead back to it (GRE-2290). */
  loop?: TreeBlockLine | null;
  /** Marked blocked, but no open blocker, card or note says why. */
  unexplained: boolean;
}

export const UNEXPLAINED_BLOCK_TEXT = "Blocked, but nothing recorded is blocking it";
/** The same warning on a tree card, where the status already says blocked. */
export const UNEXPLAINED_BLOCK_SHORT_TEXT = "Nothing recorded is blocking it";

/** Turns an agent, a person or the board into a name. */
export type TreeNameOf = (who: { agentId?: string | null; userId?: string | null } | "board") => string | null;

export function treeNameOf(people: TreeNamePeople): TreeNameOf {
  return (who) => {
    if (who === "board") return "the board";
    if (who.agentId) return people.agents.get(who.agentId)?.name ?? "an agent";
    if (who.userId) {
      if (who.userId === people.viewerUserId) return "you";
      return people.users.get(who.userId)?.label ?? "a teammate";
    }
    return null;
  };
}

/** Every blocked task's reason, by task id. */
export function describeTreeBlocks(index: TaskTreeIndex, people: TreeNamePeople): Map<string, TreeBlockReason> {
  const nameOf = treeNameOf(people);
  const reasons = new Map<string, TreeBlockReason>();
  for (const node of index.byId.values()) {
    const reason = describeTreeBlock(node, index, nameOf);
    if (reason) reasons.set(node.id, reason);
  }
  // Tasks outside the tree are cards too, and say why they are blocked.
  for (const task of index.external.values()) {
    const reason = describeTreeBlock(outsideAsNode(task, index.root.id), index, nameOf);
    if (reason) reasons.set(task.id, reason);
  }
  return reasons;
}

const CLOSED = new Set(["done", "cancelled"]);

type TreeTask = Pick<IssueTreeNode, "id" | "identifier" | "title" | "status">;

function taskRef(task: TreeTask) {
  return task.identifier ?? task.title;
}

function taskHref(task: TreeTask) {
  return `/issues/${task.identifier ?? task.id}`;
}

function ownerOf(owner: IssueUnblockOwner | null | undefined) {
  if (!owner) return null;
  return owner === "board" ? ("board" as const) : owner;
}

/** What a task waits on besides other tasks: a card first, then the owner's note. */
function waitLine(task: TreeTask, wait: IssueTreeWaitReason, nameOf: TreeNameOf): TreeBlockLine | null {
  const card = wait.pendingCard;
  if (card) {
    const who = nameOf({ agentId: card.addresseeAgentId, userId: card.addresseeUserId });
    const what = card.title ?? "a reply";
    return {
      text: who ? `Waiting on ${who}: ${what}` : `Waiting for a reply: ${what}`,
      href: `${taskHref(task)}#interaction-${card.id}`,
    };
  }
  if (wait.unblockAction) {
    const owner = ownerOf(wait.unblockOwner);
    const who = owner ? nameOf(owner) : null;
    return { text: who ? `Waiting on ${who}: ${wait.unblockAction}` : `Needs: ${wait.unblockAction}`, href: null };
  }
  return null;
}

function nodeWait(node: IssueTreeNode): IssueTreeWaitReason {
  return {
    unblockAction: node.unblockAction,
    unblockOwner: node.unblockOwner ?? null,
    pendingCard: node.pendingCard ?? null,
  };
}

function lookup(index: TaskTreeIndex, id: string): IssueTreeNode | IssueTreeExternalBlocker | null {
  return index.byId.get(id) ?? index.external.get(id) ?? null;
}

function waitOf(task: IssueTreeNode | IssueTreeExternalBlocker): IssueTreeWaitReason | null {
  if ("blockedByIds" in task) return task.status === "blocked" ? nodeWait(task) : null;
  return task.waitReason ?? null;
}

/** The reason for one blocked task; null when it is not blocked. */
export function describeTreeBlock(node: IssueTreeNode, index: TaskTreeIndex, nameOf: TreeNameOf): TreeBlockReason | null {
  if (node.status !== "blocked") return null;

  const openBlockers = [...new Set([...(index.graph.blockersOf.get(node.id) ?? []), ...node.blockedByIds])]
    .map((id) => lookup(index, id))
    .filter((task): task is IssueTreeNode | IssueTreeExternalBlocker => !!task && !CLOSED.has(task.status))
    .sort((a, b) => taskRef(a).localeCompare(taskRef(b), undefined, { numeric: true }));

  // Every blocker by name: a task blocked by three says all three.
  let own: TreeBlockLine | null = null;
  if (openBlockers.length > 0) {
    const first = openBlockers[0]!;
    own = { text: `Blocked by ${openBlockers.map(taskRef).join(", ")}`, href: taskHref(first) };
  } else {
    own = waitLine(node, nodeWait(node), nameOf);
  }

  const loopPath = loopThrough(index.graph, node.id);
  const loop = loopPath
    ? {
        text: `Blocking loop: ${loopPath.map((id) => (lookup(index, id) ? taskRef(lookup(index, id)!) : id)).join(" → ")}`,
        href: null,
      }
    : null;
  if (!own) return { own: { text: UNEXPLAINED_BLOCK_TEXT, href: null }, root: null, unexplained: true, loop };

  // The chain from the first blocker down to its end, every hop named.
  let root: TreeBlockLine | null = null;
  const first = openBlockers[0];
  const hops = first
    ? blockerChain(index.graph, first.id)
        .slice(1)
        .filter((id) => id !== node.id)
        .map((id) => lookup(index, id))
        .filter((task): task is IssueTreeNode | IssueTreeExternalBlocker => !!task && !CLOSED.has(task.status))
    : [];
  const fallback = node.rootBlockerId ? lookup(index, node.rootBlockerId) : null;
  if (hops.length === 0 && fallback && fallback.id !== first?.id && !CLOSED.has(fallback.status)) hops.push(fallback);
  const rootTask = hops[hops.length - 1];
  if (rootTask) {
    const wait = waitOf(rootTask);
    const waitText = wait ? waitLine(rootTask, wait, nameOf) : null;
    const tail = waitText
      ? `, ${waitText.text.charAt(0).toLowerCase()}${waitText.text.slice(1)}`
      : rootTask.status === "blocked" && !loopPath
        ? ", nothing recorded"
        : "";
    const label = hops.length > 1 ? `Chain: ${hops.map(taskRef).join(" → ")}` : `Root: ${taskRef(rootTask)}`;
    root = { text: `${label}${tail}`, href: waitText?.href ?? taskHref(rootTask) };
  }
  return { own, root, unexplained: false, loop };
}
