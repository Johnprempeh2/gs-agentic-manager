import type { IssuePriority, IssueStatus } from "../constants.js";
import type { IssueUnblockOwner } from "./issue.js";

/** A card on a blocked task that is still waiting for a reply. */
export interface IssueTreePendingCard {
  id: string;
  kind: string;
  /** The card's title or summary, when it has one. */
  title: string | null;
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
  createdAt: Date;
}

/** What a blocked task says it waits on, besides other tasks. */
export interface IssueTreeWaitReason {
  /** What the owner says is needed to unblock it, when they said. */
  unblockAction: string | null;
  /** Who the owner says must act. */
  unblockOwner: IssueUnblockOwner | null;
  /** The oldest card on the task still waiting for a reply. */
  pendingCard: IssueTreePendingCard | null;
}

/** One task in a task tree: the root, or anything under it. */
export interface IssueTreeNode {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  /** Null for the root of the tree. */
  parentId: string | null;
  depth: number;
  /** Tasks marked as blocking this one, inside or outside the tree. */
  blockedByIds: string[];
  /** Direct sub-tasks, counted even when the tree was cut short. */
  childCount: number;
  doneChildCount: number;
  /** For a blocked task: the task further down the chain that needs action. */
  terminalBlockerId: string | null;
  /**
   * For a blocked task: the task at the bottom of its blocker chain, when the
   * chain goes deeper than its first open blocker. Set even when that task is
   * waiting on a person, unlike `terminalBlockerId`.
   */
  rootBlockerId?: string | null;
  /** What the owner says is needed to unblock it, when they said. */
  unblockAction: string | null;
  /** Who the owner says must act, when they said. Blocked tasks only. */
  unblockOwner?: IssueUnblockOwner | null;
  /** The oldest card waiting for a reply. Blocked tasks only. */
  pendingCard?: IssueTreePendingCard | null;
  /** Marked by the project lead as a task that drives the project. */
  isKeyTask?: boolean;
  updatedAt: Date;
}

/** A task that blocks something in the tree but sits outside it. */
export interface IssueTreeExternalBlocker {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  /**
   * Why it waits, when it is blocked. Set for the tasks the tree names as a
   * root blocker too, so "Root: GRE-12, waiting on John" can be shown.
   */
  waitReason?: IssueTreeWaitReason | null;
}

export interface IssueTree {
  rootId: string;
  /** Root first, then breadth first. */
  nodes: IssueTreeNode[];
  externalBlockers: IssueTreeExternalBlocker[];
  /** True when the tree was cut at the node or depth limit. */
  truncated: boolean;
  limits: { maxNodes: number; maxDepth: number };
  /** The root task's project, for the way back up to the project tree. */
  project?: { id: string; name: string } | null;
}

/** Who looks after a project's structure. */
export interface ProjectTreeLead {
  agentId: string | null;
  /** True when the project has no lead and the company lead covers it. */
  covering: boolean;
}

/**
 * The project tree (GET /projects/:id/tree): the key tasks that drive the
 * project with their open work, and the open work that sits under none of
 * them ("Unsorted"). Finished work is counted, not sent, unless asked for.
 */
export interface ProjectTree {
  project: { id: string; name: string; status: string; lead: ProjectTreeLead };
  /** Key tasks at the top of their branch. */
  keyTaskIds: string[];
  /** Open tasks at the top of the project that sit under no key task. */
  unsortedIds: string[];
  /** Tasks, parents before children. A branch top has `parentId` null. */
  nodes: IssueTreeNode[];
  externalBlockers: IssueTreeExternalBlocker[];
  /** Finished tasks left out, by the task they sit under (their own sub-tasks included). */
  hiddenDoneByParent: Record<string, number>;
  /** Work under each key task (not counting it), cancelled left out. */
  keyTaskProgress: Record<string, { done: number; total: number }>;
  /** Every task in the key task branches (key tasks included), by state, cancelled left out. */
  counts: { done: number; active: number; blocked: number; waiting: number };
  /** The open "tidy this project" task, when one is waiting. */
  openTidyTaskId: string | null;
  truncated: boolean;
  limits: { maxNodes: number; maxDepth: number };
}
