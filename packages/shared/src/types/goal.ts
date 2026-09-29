import type { GoalLevel, GoalStatus, IssueStatus } from "../constants.js";

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  /** Calendar date, "YYYY-MM-DD". */
  targetDate: string | null;
  doneWhen: string | null;
  targetValue: number | null;
  currentValue: number | null;
  unit: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type GoalProgressSource = "number" | "issues" | "none";

/**
 * Linked-issue counts cover the goal and its non-cancelled sub-goals.
 * Cancelled issues are left out, so total = done + open + blocked.
 */
export interface GoalProgress {
  percent: number | null;
  source: GoalProgressSource;
  done: number;
  open: number;
  blocked: number;
  total: number;
}

export type GoalBlocker =
  | { kind: "issue"; issueId: string; identifier: string | null; title: string; goalId: string }
  | { kind: "check_in"; text: string; checkInId: string };

export interface GoalCheckIn {
  id: string;
  companyId: string;
  goalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  progressPercent: number | null;
  blockers: string[];
  createdAt: Date;
}

export interface GoalWithProgress extends Goal {
  progress: GoalProgress;
  blockers: GoalBlocker[];
  latestCheckIn: GoalCheckIn | null;
}

export interface GoalMilestone {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  goalId: string;
  assigneeAgentId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface GoalDetail extends GoalWithProgress {
  /** Direct sub-goals, ordered by status then createdAt. */
  subGoals: GoalWithProgress[];
  /** Linked issues of the goal and its sub-goals, ordered for the journey map. */
  milestones: GoalMilestone[];
}
