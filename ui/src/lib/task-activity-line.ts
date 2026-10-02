import type {
  ExecutionProjection,
  Issue,
  IssueExecutionStagePrincipal,
  IssueThreadInteraction,
  IssueUnblockOwner,
} from "@greatstone/shared";
import { formatUserLabel } from "./assignees";

/**
 * One plain-language line for the top of a task: who is on it, what they are
 * doing now, and what the task waits for. Built only from data the task page
 * already has; never shows run ids or raw status codes (GRE-308).
 */
export interface TaskActivityLine {
  /** "Mica is working on it", "Nobody is assigned". */
  doing: string;
  /** "Keystone's review", "your answer", "GRE-306". Null when nothing blocks the task. */
  waitingFor: string | null;
}

export interface TaskActivityLineInput {
  issue: Pick<
    Issue,
    | "status"
    | "assigneeAgentId"
    | "assigneeUserId"
    | "blockedBy"
    | "executionState"
    | "unblockDescriptor"
    | "tabledAt"
    | "scheduledRetry"
    | "activeRun"
  >;
  hasLiveRuns: boolean;
  /** True when a monitor holds the task (see isWaitingOnMonitor). */
  waitingOnMonitor: boolean;
  monitorServiceName?: string | null;
  interactions?: ReadonlyArray<Pick<IssueThreadInteraction, "status" | "addresseeAgentId" | "addresseeUserId">>;
  currentUserId: string | null | undefined;
  agentNames: ReadonlyMap<string, { name: string }>;
  userLabels?: ReadonlyMap<string, string> | null;
}

type Principal = { agentId?: string | null; userId?: string | null };

function principalName(
  principal: Principal,
  input: TaskActivityLineInput,
): { name: string; isYou: boolean } | null {
  if (principal.agentId) {
    return { name: input.agentNames.get(principal.agentId)?.name ?? "an agent", isYou: false };
  }
  if (principal.userId) {
    if (input.currentUserId && principal.userId === input.currentUserId) return { name: "you", isYou: true };
    return { name: formatUserLabel(principal.userId, input.userLabels) ?? "a person", isYou: false };
  }
  return null;
}

function possessive(principal: Principal, input: TaskActivityLineInput, noun: string): string {
  const who = principalName(principal, input);
  if (!who) return `a ${noun}`;
  return who.isYou ? `your ${noun}` : `${who.name}'s ${noun}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const RUN_PHASE_DOING: Partial<Record<ExecutionProjection["phase"], string>> = {
  queued: "is about to start",
  reconnecting: "is reconnecting",
  retry_scheduled: "will try again soon",
  finishing: "is finishing up",
  recovery_needed: "stopped and needs help",
  waiting_for_access: "is waiting for access",
  waiting_for_answer: "is waiting for an answer",
};

function stagePrincipal(principal: IssueExecutionStagePrincipal | null | undefined): Principal | null {
  if (!principal) return null;
  return principal.type === "agent" ? { agentId: principal.agentId } : { userId: principal.userId };
}

function unblockOwner(owner: IssueUnblockOwner): Principal | "board" {
  if (owner === "board") return "board";
  return "agentId" in owner ? { agentId: owner.agentId } : { userId: owner.userId };
}

function describeWaitingFor(input: TaskActivityLineInput): string | null {
  const { issue } = input;

  const pending = (input.interactions ?? []).filter((interaction) => interaction.status === "pending");
  if (pending.length > 0) {
    const first = pending[0]!;
    const addressee: Principal = { agentId: first.addresseeAgentId, userId: first.addresseeUserId };
    return addressee.agentId || addressee.userId ? possessive(addressee, input, "answer") : "an answer on this task";
  }

  const openBlockers = (issue.blockedBy ?? []).filter(
    (blocker) => blocker.status !== "done" && blocker.status !== "cancelled",
  );
  if (openBlockers.length > 0) {
    const first = openBlockers[0]!;
    const label = first.identifier ?? "another task";
    return openBlockers.length > 1 ? `${label} and ${openBlockers.length - 1} more` : label;
  }

  if (issue.status === "blocked" && issue.unblockDescriptor) {
    const owner = unblockOwner(issue.unblockDescriptor.owner);
    if (owner === "board") return "the board";
    return principalName(owner, input)?.name ?? null;
  }

  if (input.waitingOnMonitor) return input.monitorServiceName?.trim() || "a scheduled check";

  return null;
}

/**
 * While a review or approval stage is open the server moves the assignee to the
 * reviewer, so the line names the person who handed the work over instead.
 */
function describePendingStage(input: TaskActivityLineInput): TaskActivityLine | null {
  const state = input.issue.executionState;
  if (state?.status !== "pending" || !state.currentStageType) return null;
  const noun = state.currentStageType === "approval" ? "approval" : "review";
  const participant = stagePrincipal(state.currentParticipant);
  const reviewer = participant ? principalName(participant, input) : null;
  if (input.hasLiveRuns && reviewer) {
    const verb = noun === "approval" ? "checking it for approval" : "reviewing it";
    return { doing: `${capitalize(reviewer.name)} ${reviewer.isYou ? "are" : "is"} ${verb}`, waitingFor: null };
  }
  const author = principalName(stagePrincipal(state.returnAssignee) ?? {}, input);
  return {
    doing: author ? `${capitalize(author.name)} handed it over` : `Ready for ${noun}`,
    waitingFor: participant ? possessive(participant, input, noun) : `a ${noun}`,
  };
}

function describeDoing(input: TaskActivityLineInput, waitingFor: string | null): string {
  const { issue } = input;
  const assignee = principalName({ agentId: issue.assigneeAgentId, userId: issue.assigneeUserId }, input);
  if (!assignee) return "Nobody is assigned";
  const subject = capitalize(assignee.name);
  const be = assignee.isYou ? "are" : "is";

  if (issue.tabledAt) return `Set aside for now; ${assignee.name} will come back to it`;

  if (input.hasLiveRuns) {
    const phase = issue.activeRun?.execution?.phase;
    const phrase = phase ? RUN_PHASE_DOING[phase] : undefined;
    if (phrase) return `${subject} ${assignee.isYou ? phrase.replace(/^is /, "are ") : phrase}`;
    return `${subject} ${be} working on it`;
  }

  if (issue.scheduledRetry) return `${subject} will try again later`;

  switch (issue.status) {
    case "backlog":
      return `${subject} ${be} assigned; not started`;
    case "todo":
      return `${subject} will pick it up next`;
    case "in_review":
      return `In review with ${assignee.name}`;
    case "blocked":
      return `${subject} ${be} stopped`;
    case "in_progress":
      if (issue.executionState?.status === "changes_requested") return `${subject} ${be} making the requested changes`;
      return waitingFor ? `${subject} ${be} on it` : `${subject} ${be} on it; not running right now`;
    default:
      return `${subject} ${be} on it`;
  }
}

/** Returns null for finished or cancelled tasks: the status icon already says it. */
export function describeTaskActivity(input: TaskActivityLineInput): TaskActivityLine | null {
  if (input.issue.status === "done" || input.issue.status === "cancelled") return null;
  const stage = describePendingStage(input);
  if (stage) return stage;
  const waitingFor = input.hasLiveRuns ? null : describeWaitingFor(input);
  return { doing: describeDoing(input, waitingFor), waitingFor };
}

export function formatTaskActivityLine(line: TaskActivityLine): string {
  return line.waitingFor ? `${line.doing} · waiting for ${line.waitingFor}` : line.doing;
}
