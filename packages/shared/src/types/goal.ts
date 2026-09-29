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

/**
 * Why a blocked task cannot move, most specific first:
 * - waiting_on_issue: an unfinished task it depends on (`waitingOn`)
 * - waiting_on_person: an open question or approval for a person
 * - no_owner: nobody is assigned
 * - failed_run: its last agent run failed
 * - unknown: none of the above; `note` carries the last comment
 */
export type GoalBlockerReason = "waiting_on_issue" | "waiting_on_person" | "no_owner" | "failed_run" | "unknown";

/** Who must act next to clear a blocker. `name` is null when the person is not known. */
export type GoalBlockerActor =
  | { type: "agent"; id: string; name: string | null }
  | { type: "user"; id: string; name: string | null };

export interface GoalBlockerWaitingOn {
  issueId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

export interface GoalIssueBlocker {
  kind: "issue";
  issueId: string;
  identifier: string | null;
  title: string;
  goalId: string;
  reason: GoalBlockerReason;
  waitingOn: GoalBlockerWaitingOn | null;
  actor: GoalBlockerActor | null;
  /** Latest comment on the blocked task, as written (the UI cleans it). */
  note: string | null;
  /** Other tasks in this goal that cannot move until this one does. */
  holdsUpCount: number;
}

/**
 * Goal blockers come ranked: check-in blockers first (someone wrote them on
 * purpose), then blocked tasks that hold up the most other goal tasks, then
 * the oldest blocked task. The first entry is the goal's main blocker.
 */
export type GoalBlocker =
  | GoalIssueBlocker
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
