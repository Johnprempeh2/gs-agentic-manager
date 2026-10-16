import type { IssueStatus } from "../constants.js";

/** Who has to act before a blocked task can move again. */
export type BlockedWorkOwnerType = "agent" | "user" | "board" | "nobody";

export interface BlockedWorkOwner {
  type: BlockedWorkOwnerType;
  agentId: string | null;
  userId: string | null;
}

export interface BlockedWorkIssueRef {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

/**
 * A blocked task whose blocker list no longer explains why it is blocked.
 * - `waiting_on_finished_work`: every task it waits on is done, so it can resume.
 * - `waiting_on_cancelled_work`: what it waits on was cancelled and nothing open remains.
 */
export type BlockedWorkTidyReason = "waiting_on_finished_work" | "waiting_on_cancelled_work";

export interface BlockedWorkItem {
  issue: BlockedWorkIssueRef;
  /** When the task went into blocked, or its last update when that is unknown. */
  waitingSince: string | null;
  owner: BlockedWorkOwner;
  /** The root causes holding this task. Its own id when nothing open blocks it. */
  rootIssueIds: string[];
  tidyReason: BlockedWorkTidyReason | null;
}

export interface BlockedWorkRootCause {
  /** The task everything else waits on: open work that is not itself waiting on other open work. */
  issue: BlockedWorkIssueRef;
  /** Who has to act on the root for the chain to move. */
  owner: BlockedWorkOwner;
  /** Plain-language next step for the owner, when the root carries one. */
  action: string | null;
  /** Blocked tasks held up by this root, directly or through a chain. Excludes the root itself. */
  heldIssueIds: string[];
  /** The longest wait among the root and the tasks it holds. */
  oldestWaitingSince: string | null;
}

export interface BlockedWorkOverview {
  generatedAt: string;
  totalBlocked: number;
  oldestWaitingSince: string | null;
  /** Roots that hold up at least one other blocked task, biggest first. */
  rootCauses: BlockedWorkRootCause[];
  /** Every blocked task, longest waiting first. */
  items: BlockedWorkItem[];
  /** True when the company had more blocked tasks than one overview reads. */
  truncated: boolean;
}
