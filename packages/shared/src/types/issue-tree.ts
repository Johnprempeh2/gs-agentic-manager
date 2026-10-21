import type { IssuePriority, IssueStatus } from "../constants.js";

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
  /** What the owner says is needed to unblock it, when they said. */
  unblockAction: string | null;
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
}

export interface IssueTree {
  rootId: string;
  /** Root first, then breadth first. */
  nodes: IssueTreeNode[];
  externalBlockers: IssueTreeExternalBlocker[];
  /** True when the tree was cut at the node or depth limit. */
  truncated: boolean;
  limits: { maxNodes: number; maxDepth: number };
}
