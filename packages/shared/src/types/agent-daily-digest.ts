/**
 * The nightly digest: what each agent did in one UTC day, with what it cost.
 * Stored once per company per day and written to the lead agent's standing
 * "Daily digest" task. The weekly report reads the stored days back.
 */
export interface AgentDailyDigestItem {
  /** Task identifier such as GRE-12, when the task has one. */
  identifier: string | null;
  title: string;
}

export interface AgentDailyDigestMove extends AgentDailyDigestItem {
  /** The status the agent moved the task to, such as in_review. */
  toStatus: string;
}

export interface AgentDailyDigestCounts {
  tasksCompleted: number;
  /** Status changes the agent made, other than finishing a task. */
  tasksMoved: number;
  comments: number;
  runs: number;
  /** Runs that failed or timed out. */
  failures: number;
  spendCents: number;
}

export interface AgentDailyDigestAgent {
  agentId: string;
  name: string;
  counts: AgentDailyDigestCounts;
  /** A few of the tasks it finished, newest first. */
  completed: AgentDailyDigestItem[];
  /** A few of the status moves it made, newest first. */
  moved: AgentDailyDigestMove[];
  /** A few of the tasks its failed runs were on, newest first. */
  failed: AgentDailyDigestItem[];
}

export interface AgentDailyDigestPayload {
  /** The UTC day covered, YYYY-MM-DD. */
  date: string;
  windowStart: string;
  windowEnd: string;
  totals: AgentDailyDigestCounts;
  /** Busiest agent first; agents with nothing to report are left out. */
  agents: AgentDailyDigestAgent[];
}

export interface AgentDailyDigest {
  id: string;
  companyId: string;
  date: string;
  payload: AgentDailyDigestPayload;
  /** The digest as markdown, as the lead agent reads it. */
  body: string;
  leadAgentId: string | null;
  /** The standing task it was written to, such as GRE-40. */
  deliveredIssueIdentifier: string | null;
  deliveredIssueId: string | null;
  deliveredAt: string | null;
  /** Why it was kept but not delivered. */
  skippedReason: string | null;
  createdAt: string;
}
