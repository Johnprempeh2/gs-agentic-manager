import type { IssueUnblockDescriptor, IssueUnblockWaitingOn } from "@greatstone/shared";

export const WAITING_ON_CHOICES: { value: IssueUnblockWaitingOn; label: string; action: string }[] = [
  { value: "client", label: "A client", action: "Hear back from the client." },
  { value: "board", label: "You (the board)", action: "Wait for the board to act." },
  { value: "outside", label: "Someone outside the company", action: "Hear back from outside the company." },
];

interface TaskLike {
  assigneeAgentId?: string | null;
  unblockDescriptor?: IssueUnblockDescriptor | null;
}

/**
 * The note a person saves from "Set a waiting date" on a blocked task. It keeps
 * the owner and the owner's own words when a note is already there; otherwise
 * the assignee owns it, so the "date passed" wake goes to the agent doing the work.
 * A null date removes the date but keeps the rest.
 */
export function buildWaitingDescriptor(
  task: TaskLike,
  waitingOn: IssueUnblockWaitingOn,
  expectedBy: string | null,
): IssueUnblockDescriptor {
  const existing = task.unblockDescriptor ?? null;
  const owner = existing?.owner ?? (task.assigneeAgentId ? { agentId: task.assigneeAgentId } : "board");
  const fallbackAction = WAITING_ON_CHOICES.find((choice) => choice.value === waitingOn)!.action;
  const action = existing?.action?.trim() ? existing.action : fallbackAction;
  return { owner, action, waitingOn, ...(expectedBy ? { expectedBy } : {}) };
}
