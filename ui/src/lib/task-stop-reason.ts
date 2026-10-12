import type { Issue, IssueUnblockOwner } from "@greatstone/shared";
import { formatUserLabel } from "./assignees";

/**
 * One plain line for a task that is blocked or whose last run failed: what
 * stopped it, who must act, and what happens next. Built only from data the
 * page already has; never shows run ids, error codes or raw error text
 * (GRE-396). The raw error stays one click away in the run ledger.
 */
export interface TaskStopReason {
  /** "Claude is signed out", "Waiting for GRE-306". */
  stopped: string;
  /** "you", "Ridge", or null when nobody needs to act (the app retries on its own). */
  who: string | null;
  /** "Waiting for you to reconnect Claude", "Ridge will try again at 11:40". */
  next: string;
}

type Actor = "you" | "owner" | "nobody";

interface RunErrorWording {
  stopped: string;
  actor: Actor;
  /** {owner} is replaced with the agent who owns the task. */
  next: string;
}

const UNKNOWN_RUN_ERROR: RunErrorWording = {
  stopped: "The run stopped with an unknown error",
  actor: "owner",
  next: "Waiting for {owner} to look at it",
};

/**
 * Every run error code seen on the platform in the 7 days before 2 Oct 2026,
 * plus the near relatives the server sets for the same causes.
 */
const RUN_ERROR_WORDING: Record<string, RunErrorWording> = {
  claude_auth_required: {
    stopped: "Claude is signed out",
    actor: "you",
    next: "Waiting for you to reconnect Claude",
  },
  configuration_incomplete: {
    stopped: "The agent has no working AI connection",
    actor: "you",
    next: "Waiting for you to finish the agent's connection settings",
  },
  setup_failed: {
    stopped: "The run could not start",
    actor: "owner",
    next: "Waiting for {owner} to try again",
  },
  workspace_validation_failed: {
    stopped: "The task's code folder failed its safety check",
    actor: "owner",
    next: "Waiting for the code folder to be repaired",
  },
  process_lost: {
    stopped: "The agent stopped without warning",
    actor: "owner",
    next: "{owner} will pick it up again",
  },
  issue_dependencies_blocked: {
    stopped: "It waits for another task to finish",
    actor: "nobody",
    next: "It starts again when that task is done",
  },
  low_trust_requires_sandbox_environment: {
    stopped: "This task must run in a sandbox, and none is set",
    actor: "you",
    next: "Waiting for you to choose a sandbox for this task",
  },
  acpx_turn_failed: {
    stopped: "The agent's AI turn failed",
    actor: "owner",
    next: "Waiting for {owner} to try again",
  },
  adapter_failed: {
    stopped: "The agent's AI tool failed",
    actor: "owner",
    next: "Waiting for {owner} to try again",
  },
  run_silent_timeout: {
    stopped: "The agent went quiet for too long and was stopped",
    actor: "owner",
    next: "{owner} will pick it up again",
  },
  server_shutdown_interrupted: {
    stopped: "The app restarted during the run",
    actor: "owner",
    next: "{owner} will pick it up again",
  },
  cancelled: {
    stopped: "The run was cancelled",
    actor: "owner",
    next: "Waiting for {owner} to start again",
  },
  operator_interrupted: {
    stopped: "The run was stopped by hand",
    actor: "owner",
    next: "Waiting for {owner} to start again",
  },
  issue_reassigned: {
    stopped: "The task moved to another agent",
    actor: "owner",
    next: "{owner} will pick it up",
  },
  issue_assignee_changed: {
    stopped: "The task moved to another agent",
    actor: "owner",
    next: "{owner} will pick it up",
  },
  issue_terminal_status: {
    stopped: "The task was closed during the run",
    actor: "nobody",
    next: "Nothing more will run",
  },
  queued_comment_discarded: {
    stopped: "A waiting message was dropped",
    actor: "owner",
    next: "Waiting for {owner} to start again",
  },
  timeout: {
    stopped: "The run took too long and was stopped",
    actor: "owner",
    next: "Waiting for {owner} to try again",
  },
  provider_quota: {
    stopped: "The AI provider's usage limit was reached",
    actor: "nobody",
    next: "It runs again when the limit resets",
  },
  execution_reconciliation_required: {
    stopped: "The app could not confirm what the last run did",
    actor: "owner",
    next: "Waiting for {owner} to check the work",
  },
  native_runner_process_exited: {
    stopped: "The agent stopped without warning",
    actor: "owner",
    next: "{owner} will pick it up again",
  },
  native_session_interrupted: {
    stopped: "The agent's session was cut off",
    actor: "owner",
    next: "{owner} will pick it up again",
  },
  provider_transport_failed: {
    stopped: "The connection to the AI provider dropped",
    actor: "owner",
    next: "{owner} will pick it up again",
  },
};

/** Code families the server sets with many suffixes. */
const RUN_ERROR_PREFIX_WORDING: Array<[prefix: string, wording: RunErrorWording]> = [
  [
    "workspace_git_scan_",
    {
      stopped: "The check of the task's code folder did not finish",
      actor: "owner",
      next: "Waiting for {owner} to try again",
    },
  ],
  [
    "low_trust_",
    {
      stopped: "Safety settings did not let this run start",
      actor: "you",
      next: "Waiting for you to check the task's safety settings",
    },
  ],
];

function wordingFor(code: string | null | undefined): RunErrorWording {
  const key = code?.trim();
  if (!key) return UNKNOWN_RUN_ERROR;
  const exact = RUN_ERROR_WORDING[key];
  if (exact) return exact;
  const family = RUN_ERROR_PREFIX_WORDING.find(([prefix]) => key.startsWith(prefix));
  return family ? family[1] : UNKNOWN_RUN_ERROR;
}

/** True when the code has its own plain sentence (not the unknown fallback). */
export function hasPlainRunErrorWording(code: string): boolean {
  return wordingFor(code) !== UNKNOWN_RUN_ERROR;
}

/** Run statuses and cancel codes that mean the work stopped, not that it moved on. */
const STOPPED_RUN_STATUSES = new Set(["failed", "timed_out"]);
const STOPPING_CANCEL_CODES = new Set([
  "run_silent_timeout",
  "server_shutdown_interrupted",
  "adapter_failed",
  "process_lost",
  "issue_dependencies_blocked",
]);

export interface TaskStopReasonRun {
  status: string;
  errorCode?: string | null;
}

export function runStoppedTheTask(run: TaskStopReasonRun | null | undefined): boolean {
  if (!run) return false;
  if (STOPPED_RUN_STATUSES.has(run.status)) return true;
  return (run.status === "cancelled" || run.status === "interrupted") && STOPPING_CANCEL_CODES.has(run.errorCode ?? "");
}

export interface TaskStopReasonInput {
  issue: Pick<
    Issue,
    | "status"
    | "assigneeAgentId"
    | "assigneeUserId"
    | "blockedBy"
    | "unblockDescriptor"
    | "scheduledRetry"
    | "activeRecoveryAction"
  >;
  /** The task's most recent finished run, if known. */
  lastRun?: TaskStopReasonRun | null;
  hasLiveRuns: boolean;
  currentUserId: string | null | undefined;
  agentNames: ReadonlyMap<string, { name: string }>;
  userLabels?: ReadonlyMap<string, string> | null;
  /** Clock time for "will try again at 11:40"; injectable for tests. */
  formatTime?: (date: Date) => string;
}

type Principal = { agentId?: string | null; userId?: string | null };

function nameOf(principal: Principal, input: TaskStopReasonInput): string | null {
  if (principal.agentId) return input.agentNames.get(principal.agentId)?.name ?? "an agent";
  if (principal.userId) {
    if (input.currentUserId && principal.userId === input.currentUserId) return "you";
    return formatUserLabel(principal.userId, input.userLabels) ?? "a person";
  }
  return null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function defaultFormatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function unblockOwnerName(owner: IssueUnblockOwner, input: TaskStopReasonInput): string | null {
  if (owner === "board") return "you";
  return nameOf("agentId" in owner ? { agentId: owner.agentId } : { userId: owner.userId }, input);
}

/** "Ridge will try again at 11:40" when the app already planned a retry or repair. */
function plannedNext(input: TaskStopReasonInput): { who: string; next: string } | null {
  const retry = input.issue.scheduledRetry;
  if (retry && (retry.status === "scheduled_retry" || retry.status === "queued")) {
    const who = retry.agentName ?? nameOf({ agentId: retry.agentId }, input) ?? "The agent";
    const at = retry.scheduledRetryAt ? new Date(retry.scheduledRetryAt) : null;
    const when = at && !Number.isNaN(at.getTime()) ? ` at ${(input.formatTime ?? defaultFormatTime)(at)}` : " soon";
    return { who, next: `${capitalize(who)} will try again${when}` };
  }
  const recovery = input.issue.activeRecoveryAction;
  if (recovery && (recovery.status === "active" || recovery.status === "escalated")) {
    const who = nameOf({ agentId: recovery.ownerAgentId, userId: recovery.ownerUserId }, input);
    if (who) {
      return { who, next: who === "you" ? "Waiting for you to repair it" : `${capitalize(who)} is repairing it` };
    }
  }
  return null;
}

function describeRunError(code: string | null | undefined, input: TaskStopReasonInput): TaskStopReason {
  const wording = wordingFor(code);
  const owner = nameOf({ agentId: input.issue.assigneeAgentId, userId: input.issue.assigneeUserId }, input);
  const planned = wording.actor === "you" ? null : plannedNext(input);
  if (planned) return { stopped: wording.stopped, ...planned };
  const who = wording.actor === "you" ? "you" : wording.actor === "owner" ? owner : null;
  const ownerLabel = owner ?? "the task owner";
  const next = wording.next.replace("{owner}", ownerLabel);
  return { stopped: wording.stopped, who, next: capitalize(next) };
}

function describeBlockers(input: TaskStopReasonInput): TaskStopReason | null {
  const open = (input.issue.blockedBy ?? []).filter(
    (blocker) => blocker.status !== "done" && blocker.status !== "cancelled",
  );
  if (open.length === 0) return null;
  const first = open[0]!;
  const label = first.identifier ?? "another task";
  const more = open.length > 1 ? ` and ${open.length - 1} more` : "";
  const who = nameOf({ agentId: first.assigneeAgentId, userId: first.assigneeUserId }, input);
  return {
    stopped: `Waiting for ${label}${more}`,
    who: who ?? "nobody assigned",
    next: who
      ? `Starts again when ${who === "you" ? "you finish" : `${who} finishes`} ${label}`
      : `${label} needs an owner before this can start`,
  };
}

/**
 * Returns null when nothing stopped the task: it is running, finished, or its
 * last run went fine. Blockers win over the last run, because a blocked task's
 * last run usually failed *because* of them.
 */
export function describeTaskStopReason(input: TaskStopReasonInput): TaskStopReason | null {
  const { issue } = input;
  if (issue.status === "done" || issue.status === "cancelled") return null;
  if (input.hasLiveRuns) return null;

  const blockers = describeBlockers(input);
  if (blockers) return blockers;

  const lastRunStopped = runStoppedTheTask(input.lastRun);
  if (issue.status === "blocked") {
    const descriptor = issue.unblockDescriptor;
    if (descriptor) {
      const who = unblockOwnerName(descriptor.owner, input);
      return {
        stopped: lastRunStopped ? wordingFor(input.lastRun?.errorCode).stopped : "Marked blocked",
        who,
        next: descriptor.action.trim() ? descriptor.action.trim() : `Waiting for ${who ?? "someone"} to act`,
      };
    }
    if (lastRunStopped) return describeRunError(input.lastRun?.errorCode, input);
    const owner = nameOf({ agentId: issue.assigneeAgentId, userId: issue.assigneeUserId }, input);
    return {
      stopped: "Marked blocked with no reason given",
      who: owner,
      next: owner ? `Waiting for ${owner} to say what is needed` : "Waiting for someone to take it",
    };
  }

  if (lastRunStopped) return describeRunError(input.lastRun?.errorCode, input);
  return null;
}

/** "You to act", "Ridge to act", "Nobody needs to act". */
export function taskStopReasonWhoLabel(reason: TaskStopReason): string {
  return reason.who ? `${reason.who === "you" ? "You" : reason.who} to act` : "Nobody needs to act";
}

export function formatTaskStopReason(reason: TaskStopReason): string {
  return `${reason.stopped} · ${taskStopReasonWhoLabel(reason)} · ${reason.next}`;
}

export type TaskStopReasonRowContext = Pick<TaskStopReasonInput, "currentUserId" | "agentNames" | "userLabels">;

/**
 * The stop reason for a task list row. List rows carry the latest run summary,
 * scheduled retry, recovery action and blocker owners (GRE-403), so this needs
 * no extra fetch per row.
 */
export function describeIssueRowStopReason(
  issue: TaskStopReasonInput["issue"] & Pick<Issue, "latestRun" | "activeRun" | "executionRunId">,
  context: TaskStopReasonRowContext,
): TaskStopReason | null {
  return describeTaskStopReason({
    ...context,
    issue,
    lastRun: issue.latestRun ?? null,
    hasLiveRuns: Boolean(issue.activeRun || issue.executionRunId),
  });
}
