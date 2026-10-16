/**
 * "This week at Greatstone": one page for the executives, built from the
 * last seven days. What the agents finished, what is stuck and for how long,
 * what moved in the client pipeline, what needs the reader, and what each
 * agent cost.
 */
export interface WeeklyReportTask {
  id: string;
  identifier: string | null;
  title: string;
}

export interface WeeklyReportAgentWork {
  agentId: string;
  name: string;
  /** Tasks this agent finished in the week. */
  finished: number;
  /** Most recent finished tasks, newest first, at most three. */
  items: WeeklyReportTask[];
}

export interface WeeklyReportStuckTask extends WeeklyReportTask {
  /** Who holds it, when an agent does. */
  agentName: string | null;
  /** When it got stuck. */
  stuckSince: string;
}

export interface WeeklyReportPipelineMove {
  caseId: string;
  title: string;
  pipelineName: string;
  fromStage: string | null;
  toStage: string;
  at: string;
}

export interface WeeklyReportAgentCost {
  agentId: string;
  name: string;
  cents: number;
}

export interface WeeklyReport {
  companyId: string;
  companyName: string;
  generatedAt: string;
  /** Start of the week: seven days before `generatedAt`. */
  since: string;
  finished: { count: number; agents: WeeklyReportAgentWork[] };
  /** Stuck tasks, longest stuck first; `items` holds at most ten. */
  stuck: { count: number; items: WeeklyReportStuckTask[] };
  pipeline: {
    /** New clients or cases added in the week. */
    added: number;
    /** Stage moves in the week. */
    moved: number;
    /** Cases that reached a done stage. */
    won: number;
    /** Cases that reached a cancelled stage. */
    lost: number;
    /** Most recent moves, newest first, at most eight. */
    moves: WeeklyReportPipelineMove[];
  };
  /** What needs the reader now; `items` holds at most five. */
  needsYou: { count: number; items: WeeklyReportTask[] };
  /** Spend recorded against each agent in the week, highest first. */
  costs: { totalCents: number; agents: WeeklyReportAgentCost[] };
}
