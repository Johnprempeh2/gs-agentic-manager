import type { IssueStatus } from "../constants.js";

/**
 * A task GS Agentic Manager will not run again until someone records what its
 * last run did, because that run stopped part-way through an outside step.
 */
export interface RecoveryHold {
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    status: IssueStatus;
  };
  assigneeAgentId: string | null;
  recoveryActionId: string;
  /** The run whose outcome is unknown. Clearing the hold records what it did. */
  runId: string | null;
  cause: string;
  nextAction: string;
  heldSince: string;
  /** The run also left its workspace in an unsafe state that needs repair notes. */
  needsWorkspaceRepair: boolean;
}

export interface RecoveryHoldList {
  holds: RecoveryHold[];
}
