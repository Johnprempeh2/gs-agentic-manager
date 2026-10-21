import type { IssuePriority, IssueStatus } from "../constants.js";

/** The few task fields the Desk, sidebar and palette need to list a task. */
export interface IssueFollowTaskSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  originKind: string;
  updatedAt: Date;
}

/** Counts across a followed task and everything under it. */
export interface IssueFollowRollupCounts {
  total: number;
  done: number;
  inProgress: number;
  /** Open tasks assigned to the viewer, or with a question waiting on a person. */
  waitingOnYou: number;
  blocked: number;
}

export interface IssueFollowRollupUpdate {
  kind: "comment" | "status";
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  /** Comment excerpt, or the new status for a status change. */
  summary: string;
  at: Date;
}

export interface IssueFollowWithRollup {
  issueId: string;
  followedAt: Date;
  issue: IssueFollowTaskSummary;
  counts: IssueFollowRollupCounts;
  latestUpdates: IssueFollowRollupUpdate[];
}

export interface IssueFollowState {
  issueId: string;
  following: boolean;
}

export interface RecentlyOpenedIssue {
  issueId: string;
  viewedAt: Date;
  issue: IssueFollowTaskSummary;
}
