import type { IssueStatus } from "../constants.js";
import type { IssueUnblockOwner } from "./issue.js";

/**
 * What the block check found on one task (GRE-2287):
 * - `unexplained`: blocked, with no open blocker, no pending card and no
 *   recorded reason. The same rule as the tree's warning.
 * - `blockers_closed`: blocked, and every task it waits on is done or cancelled.
 * - `card_answered`: blocked, nothing open holds it, and a card on it was
 *   answered after it went into blocked.
 * - `condition_in_title`: the title names a condition, such as
 *   "(after John accepts the proof)", that may already be met.
 * - `old_human_ask`: a card or a blocked task has waited on a person for
 *   more than a day, so the lead can nudge them.
 */
export type BlockCheckKind =
  | "unexplained"
  | "blockers_closed"
  | "card_answered"
  | "condition_in_title"
  | "old_human_ask";

export interface BlockCheckIssueRef {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface BlockCheckItem {
  kind: BlockCheckKind;
  issue: BlockCheckIssueRef;
  /** One plain line that says what was found. */
  detail: string;
  /** When the thing found started: blocked since, card asked or answered. */
  since: string | null;
  /** The card concerned, for `card_answered` and card asks. */
  cardId: string | null;
  /** The closed blockers, for `blockers_closed`. */
  blockerIds: string[];
  /** Who must act, for `old_human_ask`. */
  waitingOn: IssueUnblockOwner | null;
}

export interface BlockCheckProject {
  /** Null for tasks with no project. */
  projectId: string | null;
  projectName: string | null;
  leadAgentId: string | null;
  items: BlockCheckItem[];
  /**
   * Changes only when the items change, so a routine can tell when there is
   * nothing new since its last run.
   */
  fingerprint: string;
}

export interface BlockCheckResult {
  generatedAt: string;
  /** Projects with at least one item, biggest first. */
  projects: BlockCheckProject[];
  totalItems: number;
  /** True when the company has more open tasks than one check reads. */
  truncated: boolean;
}
