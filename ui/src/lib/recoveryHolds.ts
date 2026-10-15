import type { ExecutionReconciliation } from "@greatstone/shared";

/** What the person clearing a hold knows about the last run's outside step. */
export type HoldOutcomeChoice = "not_sure" | "it_finished" | "it_did_not_happen";

export const HOLD_OUTCOME_OPTIONS: { value: HoldOutcomeChoice; title: string; description: string }[] = [
  {
    value: "not_sure",
    title: "I'm not sure",
    description: "The agent checks what already happened before it repeats anything.",
  },
  {
    value: "it_finished",
    title: "It finished the step",
    description: "The agent carries on from there and does not repeat it.",
  },
  {
    value: "it_did_not_happen",
    title: "It did not happen",
    description: "The agent does the step again.",
  },
];

const ACTION_OUTCOME: Record<HoldOutcomeChoice, ExecutionReconciliation["actionOutcome"]> = {
  not_sure: "mixed",
  it_finished: "completed",
  it_did_not_happen: "not_performed",
};

const OUTCOME_EVIDENCE: Record<HoldOutcomeChoice, string> = {
  not_sure:
    "Cleared from the holds list. The board is not sure what the last run did. Check what already happened before you repeat any outside step.",
  it_finished:
    "Cleared from the holds list. The board confirmed the last run finished its outside step. Do not repeat it.",
  it_did_not_happen:
    "Cleared from the holds list. The board confirmed the last run did not carry out its outside step. It is safe to do it now.",
};

/** The reconciliation the server needs to let a held task run again. */
export function buildHoldReconciliation(input: {
  runId: string;
  choice: HoldOutcomeChoice;
  note?: string;
  workspaceNote?: string;
}): ExecutionReconciliation {
  const note = input.note?.trim();
  const workspaceNote = input.workspaceNote?.trim();
  return {
    runId: input.runId,
    providerStopped: true,
    actionOutcome: ACTION_OUTCOME[input.choice],
    outcomeEvidence: note ? `${OUTCOME_EVIDENCE[input.choice]} Note from the board: ${note}` : OUTCOME_EVIDENCE[input.choice],
    ...(workspaceNote ? { workspaceRepairEvidence: workspaceNote } : {}),
  };
}

/** Workspace notes must say enough for the agent to trust the workspace again. */
export const WORKSPACE_NOTE_MIN_LENGTH = 20;
