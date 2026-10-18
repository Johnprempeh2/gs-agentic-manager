/**
 * Team scorecard: each agent's recent work in plain numbers. What it finished
 * in the window, and what it holds now: under way, waiting for review, stuck
 * and past its due date.
 */
export interface TeamScorecardTask {
  id: string;
  identifier: string | null;
  title: string;
}

export interface TeamScorecardAgent {
  agentId: string;
  name: string;
  title: string | null;
  /** Agent status, such as idle, running or paused. */
  status: string;
  finished: number;
  underWay: number;
  inReview: number;
  stuck: number;
  overdue: number;
  /**
   * Median time from start (or creation when work never formally started) to
   * finish for the tasks finished in the window, in milliseconds. Null when
   * nothing was finished.
   */
  medianFinishMs?: number | null;
  /** Most recent finished tasks, newest first, at most five. */
  recentlyFinished: TeamScorecardTask[];
  /** Stuck tasks, oldest first, at most three. */
  stuckTasks: TeamScorecardTask[];
}

export interface TeamScorecard {
  since: string;
  days: number;
  totals: { finished: number; underWay: number; inReview: number; stuck: number; overdue: number };
  agents: TeamScorecardAgent[];
}
