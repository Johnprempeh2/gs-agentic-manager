/** One line in the "what happened since you were last here" digest. */
export type AgentWorkDigestItemKind =
  | "task_finished"
  | "task_started"
  | "decision_raised"
  | "run_failed";

export interface AgentWorkDigestItem {
  kind: AgentWorkDigestItemKind;
  /** Plain-language line, for example "Finished GRE-12: Faster board". */
  label: string;
  at: string;
  issueId: string | null;
  issueIdentifier: string | null;
  runId: string | null;
}

export interface AgentWorkDigestCounts {
  tasksFinished: number;
  tasksStarted: number;
  decisionsRaised: number;
  failures: number;
}

export interface AgentWorkDigestAgent {
  agentId: string;
  agentName: string;
  counts: AgentWorkDigestCounts;
  /** Newest first. */
  items: AgentWorkDigestItem[];
}

/** Where `since` came from: the request, the user's stored last visit, or the 24-hour fallback. */
export type AgentWorkDigestSinceSource = "query" | "last_visit" | "default_window";

export interface AgentWorkDigest {
  companyId: string;
  since: string;
  sinceSource: AgentWorkDigestSinceSource;
  generatedAt: string;
  counts: AgentWorkDigestCounts;
  /** Agents with at least one item, busiest first. */
  agents: AgentWorkDigestAgent[];
}

export interface AgentWorkDigestVisit {
  companyId: string;
  lastVisitedAt: string;
}
