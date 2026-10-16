import {
  isUnblockExpectedByPassed,
  requiresExecutionReconciliation,
  type Issue,
  type IssueBlockedInboxAttention,
  type IssueBlockedInboxIssueRef,
  type IssueRecoveryActionKind,
  type IssueRelationIssueSummary,
  type IssueThreadInteraction,
  type IssueUnblockOwner,
} from "@greatstone/shared";
import { formatUserLabel } from "./assignees";
import { createIssueDetailPath } from "./issueDetailBreadcrumb";
import { describeUnblockWaiting, describeTaskStopReason, runStoppedTheTask, type TaskStopReasonRun } from "./task-stop-reason";

/**
 * Why a blocked task is stuck, in words an executive can read without knowing
 * how the app works: one headline, an optional second sentence, who can clear
 * it and what they need to do. Built only from data the page already holds;
 * never shows internal ids, status names or raw JSON.
 */
export interface WhyBlocked {
  /** Which blocker this came from. For tests and test ids only; never shown. */
  source: WhyBlockedSource;
  /** "Waiting on Grace to finish 'Calibrate lidar' (GRE-12)." */
  headline: string;
  /** A second plain sentence, or null. */
  detail: string | null;
  /** "You", "Grace", "Nobody yet". */
  whoCanUnblock: string;
  /** "Nothing to do now. This task starts again when GRE-12 is done." */
  nextStep: string;
  /** Where to go to take the next step, when there is a page for it. */
  link: { label: string; href: string } | null;
  /** True when the date the task expected to hear back by has passed. */
  datePassed?: boolean;
}

export type WhyBlockedSource =
  | "questions"
  | "approval"
  | "pause_hold"
  | "blocker"
  | "blocker_unowned"
  | "blocker_parked"
  | "blocker_owner_paused"
  | "blockers_finished"
  | "blocker_cancelled"
  | "run_on_hold"
  | "repair"
  | "waiting"
  | "agent_paused"
  | "chain_stalled"
  | "missing_next_step"
  | "review_path"
  | "outside_wait"
  | "run_stopped"
  | "no_reason";

export interface WhyBlockedAgent {
  name: string;
  status?: string | null;
  pauseReason?: string | null;
}

export interface WhyBlockedInput {
  issue: Pick<Issue, "id" | "status" | "identifier" | "assigneeAgentId" | "assigneeUserId"> &
    Partial<
      Pick<
        Issue,
        "blockedBy" | "unblockDescriptor" | "activeRecoveryAction" | "blockedInboxAttention" | "latestRun" | "scheduledRetry"
      >
    >;
  /** The task's thread interactions; only the pending ones count. */
  interactions?: ReadonlyArray<
    Pick<IssueThreadInteraction, "id" | "kind" | "status" | "addresseeAgentId" | "addresseeUserId"> & {
      payload?: unknown;
    }
  > | null;
  /** Approvals linked to the task; only the pending ones count. */
  approvals?: ReadonlyArray<{ id: string; status: string }> | null;
  /** The pause hold that covers this task, if any. */
  pauseHold?: {
    isRoot: boolean;
    reason?: string | null;
    /** The task the hold was placed on, when it is not this one. */
    rootIssue?: { id: string; identifier: string | null; title: string } | null;
  } | null;
  /** The task's most recent finished run, if known. */
  lastRun?: TaskStopReasonRun | null;
  currentUserId: string | null | undefined;
  agents: ReadonlyMap<string, WhyBlockedAgent>;
  userLabels?: ReadonlyMap<string, string> | null;
  /** Today; injectable for tests. */
  now?: Date;
}

type Principal = { agentId?: string | null; userId?: string | null };

const CLOSED = new Set(["done", "cancelled"]);

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function nameOf(principal: Principal, input: WhyBlockedInput): string | null {
  if (principal.agentId) return input.agents.get(principal.agentId)?.name ?? "an agent";
  if (principal.userId) {
    if (input.currentUserId && principal.userId === input.currentUserId) return "you";
    return formatUserLabel(principal.userId, input.userLabels) ?? "a person";
  }
  return null;
}

function ownerOfIssue(input: WhyBlockedInput): string | null {
  return nameOf({ agentId: input.issue.assigneeAgentId, userId: input.issue.assigneeUserId }, input);
}

function unblockOwnerName(owner: IssueUnblockOwner, input: WhyBlockedInput): string {
  if (owner === "board") return "you";
  return nameOf("agentId" in owner ? { agentId: owner.agentId } : { userId: owner.userId }, input) ?? "someone";
}

/** "'Calibrate lidar' (GRE-12)" or "'Calibrate lidar'". */
function taskLabel(task: { identifier: string | null; title: string }): string {
  const title = task.title.trim() || "another task";
  return task.identifier ? `'${title}' (${task.identifier})` : `'${title}'`;
}

function shortTaskLabel(task: { identifier: string | null; title: string }): string {
  return task.identifier ?? taskLabel(task);
}

function taskHref(task: { id: string; identifier: string | null }): string {
  return createIssueDetailPath(task.identifier ?? task.id);
}

function openTaskLink(task: { id: string; identifier: string | null }) {
  return { label: task.identifier ? `Open ${task.identifier}` : "Open the blocking task", href: taskHref(task) };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function agentPaused(agentId: string | null | undefined, input: WhyBlockedInput): WhyBlockedAgent | null {
  if (!agentId) return null;
  const agent = input.agents.get(agentId);
  return agent && agent.status === "paused" ? agent : null;
}

/** Whole days between two UTC calendar days. */
function daysSince(day: string, now: Date): number {
  const [year, month, date] = day.split("-").map(Number);
  const then = Date.UTC(year!, (month ?? 1) - 1, date ?? 1);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((today - then) / 86_400_000));
}

function datePassedSentence(days: number): string {
  if (days <= 1) return "Date passed yesterday.";
  return `Date passed ${days} days ago.`;
}

// ---------------------------------------------------------------------------
// Pending decisions

function questionCount(interaction: { kind: string; payload?: unknown }): number {
  if (interaction.kind !== "ask_user_questions") return 0;
  const questions = (interaction.payload as { questions?: unknown } | undefined)?.questions;
  return Array.isArray(questions) ? questions.length : 0;
}

function describeAsk(interactions: ReadonlyArray<{ kind: string; payload?: unknown }>): string {
  const questions = interactions.reduce((sum, interaction) => sum + questionCount(interaction), 0);
  const others = interactions.filter((interaction) => interaction.kind !== "ask_user_questions").length;
  if (others === 0) return `answer ${plural(Math.max(questions, 1), "question", "questions")}`;
  if (questions === 0) {
    if (others > 1) return `respond to ${others} requests`;
    switch (interactions[0]!.kind) {
      case "request_draft_review":
        return "review a draft";
      case "suggest_tasks":
        return "look at some suggested tasks";
      case "connection_intent":
        return "connect an app";
      case "request_item_verdicts":
        return "give a verdict on some items";
      default:
        return "confirm a request";
    }
  }
  return `answer ${plural(questions, "question", "questions")} and respond to ${plural(others, "request", "requests")}`;
}

function describePendingInteractions(input: WhyBlockedInput): WhyBlocked | null {
  const pending = (input.interactions ?? []).filter((interaction) => interaction.status === "pending");
  if (pending.length === 0) return null;
  const first = pending[0]!;
  const who = nameOf({ agentId: first.addresseeAgentId, userId: first.addresseeUserId }, input) ?? "you";
  const ask = describeAsk(pending);
  const isYou = who === "you";
  return {
    source: "questions",
    headline: `Waiting for ${who} to ${ask}.`,
    detail: "The work carries on as soon as there is a reply.",
    whoCanUnblock: capitalize(who),
    nextStep: isYou ? `Open the request and reply.` : `Nothing for you to do unless ${who} asks for help.`,
    link: { label: pending.length > 1 ? "Open the first request" : "Open the request", href: `#interaction-${first.id}` },
  };
}

function describePendingApprovals(input: WhyBlockedInput): WhyBlocked | null {
  const pending = (input.approvals ?? []).filter((approval) => approval.status === "pending");
  if (pending.length === 0) return null;
  return {
    source: "approval",
    headline:
      pending.length === 1
        ? "Waiting for you to approve a request."
        : `Waiting for you to decide on ${pending.length} approval requests.`,
    detail: null,
    whoCanUnblock: "You",
    nextStep: "Approve it, turn it down or ask for changes.",
    link: { label: "Open the approval", href: `/approvals/${pending[0]!.id}` },
  };
}

// ---------------------------------------------------------------------------
// Holds

function describePauseHold(input: WhyBlockedInput): WhyBlocked | null {
  const hold = input.pauseHold;
  if (!hold) return null;
  const reason = hold.reason?.trim();
  const root = !hold.isRoot ? hold.rootIssue ?? null : null;
  return {
    source: "pause_hold",
    headline: root ? `Paused by a hold on ${taskLabel(root)}.` : "Paused by a hold: someone paused this task.",
    detail: reason ? `Reason given: ${reason}` : null,
    whoCanUnblock: "You",
    nextStep: root ? `Resume ${shortTaskLabel(root)} when the work should carry on.` : "Resume it when the work should carry on.",
    link: root ? openTaskLink(root) : null,
  };
}

const AGENT_PAUSE_WORDING: Record<string, (name: string) => { headline: string; next: string }> = {
  budget: (name) => ({
    headline: `Paused by a hold: ${name} hit its budget limit.`,
    next: `Raise ${name}'s budget or clear the hold.`,
  }),
  manual: (name) => ({
    headline: `Paused by a hold: ${name} was paused by hand.`,
    next: `Resume ${name} so the work can carry on.`,
  }),
  system: (name) => ({
    headline: `Paused by a hold: the app paused ${name} to keep things safe.`,
    next: `Check ${name}'s page and resume it when it is ready.`,
  }),
  company_archived: (name) => ({
    headline: `Paused by a hold: the company is archived, so ${name} is paused.`,
    next: "Restore the company to let work carry on.",
  }),
  import: (name) => ({
    headline: `Paused by a hold: ${name} was paused when the company was imported.`,
    next: `Resume ${name} once its settings are checked.`,
  }),
};

function describeAgentPaused(input: WhyBlockedInput): WhyBlocked | null {
  const agentId = input.issue.assigneeAgentId;
  const agent = agentPaused(agentId, input);
  if (!agent || !agentId) return null;
  const wording = (AGENT_PAUSE_WORDING[agent.pauseReason ?? ""] ?? AGENT_PAUSE_WORDING.manual)(agent.name);
  return {
    source: "agent_paused",
    headline: wording.headline,
    detail: "Nothing on this task runs until the hold is cleared.",
    whoCanUnblock: "You",
    nextStep: wording.next,
    link: { label: `Open ${agent.name}`, href: `/agents/${agentId}` },
  };
}

// ---------------------------------------------------------------------------
// Other tasks

function describeOneBlocker(
  blocker: Pick<IssueRelationIssueSummary, "id" | "identifier" | "title" | "status" | "assigneeAgentId" | "assigneeUserId">,
  input: WhyBlockedInput,
  moreCount: number,
): WhyBlocked {
  const label = taskLabel(blocker);
  const short = shortTaskLabel(blocker);
  const more = moreCount > 0 ? `It is also waiting on ${plural(moreCount, "other task", "other tasks")}.` : null;
  const link = openTaskLink(blocker);
  const owner = nameOf({ agentId: blocker.assigneeAgentId, userId: blocker.assigneeUserId }, input);

  if (!owner) {
    return {
      source: "blocker_unowned",
      headline: `Waiting on ${label}, which nobody owns yet.`,
      detail: more,
      whoCanUnblock: "You",
      nextStep: `Give ${short} an owner so it can start.`,
      link,
    };
  }
  if (blocker.status === "backlog") {
    return {
      source: "blocker_parked",
      headline: `Waiting on ${label}, which is parked and will not start on its own.`,
      detail: more,
      whoCanUnblock: "You",
      nextStep: `Move ${short} out of the backlog so ${owner === "you" ? "you" : owner} can start it.`,
      link,
    };
  }
  const pausedOwner = agentPaused(blocker.assigneeAgentId, input);
  if (pausedOwner) {
    return {
      source: "blocker_owner_paused",
      headline: `Waiting on ${owner} to finish ${label}, but ${owner} is paused.`,
      detail: more,
      whoCanUnblock: "You",
      nextStep: `Resume ${owner} or give ${short} to someone else.`,
      link,
    };
  }
  return {
    source: "blocker",
    headline: `Waiting on ${owner} to finish ${label}.`,
    detail: more,
    whoCanUnblock: capitalize(owner),
    nextStep:
      owner === "you"
        ? `Finish ${short}; this task starts again on its own.`
        : `Nothing to do now. This task starts again when ${short} is done.`,
    link,
  };
}

function describeBlockedBy(input: WhyBlockedInput): WhyBlocked | null {
  const blockers = input.issue.blockedBy ?? [];
  if (blockers.length === 0) return null;
  const open = blockers.filter((blocker) => !CLOSED.has(blocker.status));
  if (open.length === 0) {
    if (input.issue.status !== "blocked") return null;
    const cancelled = blockers.find((blocker) => blocker.status === "cancelled");
    if (cancelled) {
      return {
        source: "blocker_cancelled",
        headline: `It was waiting on ${taskLabel(cancelled)}, which was cancelled.`,
        detail: null,
        whoCanUnblock: "You",
        nextStep: "Remove the link or replace it with the work that is still needed.",
        link: openTaskLink(cancelled),
      };
    }
    return {
      source: "blockers_finished",
      headline: "Everything this task was waiting on is finished.",
      detail: "It still says blocked, but nothing holds it up any more.",
      whoCanUnblock: "You",
      nextStep: "Move it back to To do so the work can start again.",
      link: null,
    };
  }
  // Follow a chain to the task that actually needs someone, when the server sent one.
  const first = open[0]!;
  const terminal = first.terminalBlockers?.find((blocker) => !CLOSED.has(blocker.status) && blocker.id !== first.id);
  if (terminal) {
    const deep = describeOneBlocker(terminal, input, 0);
    return {
      ...deep,
      headline: `Waiting on ${taskLabel(first)}, which is held up further down.`,
      detail: [deep.headline, open.length > 1 ? `It is also waiting on ${plural(open.length - 1, "other task", "other tasks")}.` : null]
        .filter(Boolean)
        .join(" "),
    };
  }
  return describeOneBlocker(first, input, open.length - 1);
}

// ---------------------------------------------------------------------------
// Repairs

const REPAIR_CAUSE: Record<IssueRecoveryActionKind, string> = {
  missing_disposition: "The last run ended without saying what happens next.",
  deliberate_wait_without_target: "It was set to wait without saying what for.",
  stranded_assigned_issue: "It stopped moving with nobody working on it.",
  workspace_validation: "The task's code folder failed its safety check.",
  configuration_validation: "The agent's settings are not complete.",
  active_run_watchdog: "A run went quiet for too long.",
  issue_graph_liveness: "A chain of tasks it depends on has stalled.",
};

function describeRepair(input: WhyBlockedInput): WhyBlocked | null {
  const action = input.issue.activeRecoveryAction;
  if (!action || (action.status !== "active" && action.status !== "escalated")) return null;
  if (requiresExecutionReconciliation(action.cause)) {
    return {
      source: "run_on_hold",
      headline: "On hold: the last run stopped part-way through a step outside the app, such as a push or an email.",
      detail: "To be safe, nothing runs again until someone says what happened.",
      whoCanUnblock: "You",
      nextStep: "Check what the run did, then clear the hold so the agent can carry on.",
      link: null,
    };
  }
  const cause = REPAIR_CAUSE[action.kind] ?? "Something went wrong with the last run.";
  const owner =
    action.ownerType === "board"
      ? "you"
      : nameOf({ agentId: action.ownerAgentId, userId: action.ownerUserId }, input) ??
        (action.ownerType === "system" ? null : "someone");
  if (!owner) {
    return {
      source: "repair",
      headline: `Being repaired. ${cause}`,
      detail: null,
      whoCanUnblock: "Nobody, the app is fixing it",
      nextStep: "Nothing to do now. The app is putting it right.",
      link: null,
    };
  }
  if (owner === "you") {
    return {
      source: "repair",
      headline: `Needs your decision to carry on. ${cause}`,
      detail: null,
      whoCanUnblock: "You",
      nextStep: "Say how the work should carry on, or close the task.",
      link: null,
    };
  }
  return {
    source: "repair",
    headline: `${capitalize(owner)} is repairing it. ${cause}`,
    detail: null,
    whoCanUnblock: capitalize(owner),
    nextStep: `Nothing to do now. ${capitalize(owner)} will pick the work back up.`,
    link: null,
  };
}

// ---------------------------------------------------------------------------
// The owner's own note on what they wait for

function describeWaiting(input: WhyBlockedInput): WhyBlocked | null {
  const descriptor = input.issue.unblockDescriptor;
  if (input.issue.status !== "blocked" || !descriptor) return null;
  const now = input.now ?? new Date();
  const who = unblockOwnerName(descriptor.owner, input);
  const waiting = describeUnblockWaiting(descriptor);
  const passed = isUnblockExpectedByPassed(descriptor, now) && descriptor.expectedBy;
  const headlineBase = waiting ? `${waiting}.` : `Waiting on ${who}.`;
  const headline = passed ? `${headlineBase} ${datePassedSentence(daysSince(descriptor.expectedBy!, now))}` : headlineBase;
  const action = descriptor.action.trim();
  const next = action
    ? action
    : passed
      ? `Check in with ${who === "you" ? "them" : who}, or set a new date.`
      : `Waiting for ${who} to act.`;
  return {
    source: "waiting",
    headline,
    detail: null,
    whoCanUnblock: capitalize(who),
    nextStep: capitalize(/[.!?]$/.test(next) ? next : `${next}.`),
    link: null,
    ...(passed ? { datePassed: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// The server's own reading of a stuck task (list rows carry it)

function refHref(ref: IssueBlockedInboxIssueRef) {
  return openTaskLink(ref);
}

function describeAttention(attention: IssueBlockedInboxAttention, input: WhyBlockedInput): WhyBlocked | null {
  const leaf = attention.leafIssue;
  const ownerName =
    nameOf({ agentId: attention.owner.agentId, userId: attention.owner.userId }, input) ??
    (attention.owner.type === "board" ? "you" : null);
  switch (attention.reason) {
    case "pending_board_decision":
    case "pending_user_decision": {
      if (attention.approvalId) {
        return describePendingApprovals({ ...input, approvals: [{ id: attention.approvalId, status: "pending" }] });
      }
      const who = attention.reason === "pending_user_decision" ? ownerName ?? "you" : "you";
      return {
        source: "questions",
        headline: `Waiting for ${who} to answer a question on this task.`,
        detail: "The work carries on as soon as there is a reply.",
        whoCanUnblock: capitalize(who),
        nextStep: who === "you" ? "Open the question and reply." : `Nothing for you to do unless ${who} asks for help.`,
        link: attention.interactionId
          ? {
              label: "Open the question",
              href: `${taskHref(input.issue)}#interaction-${attention.interactionId}`,
            }
          : null,
      };
    }
    case "missing_successful_run_disposition": {
      const who = ownerName ?? "The agent";
      return {
        source: "missing_next_step",
        headline: `${capitalize(who)} finished a run but did not say what happens next.`,
        detail: null,
        whoCanUnblock: capitalize(ownerName ?? "you"),
        nextStep: "Mark it done, hand it on, or say what it is waiting for.",
        link: null,
      };
    }
    case "blocked_by_unassigned_issue":
    case "blocked_by_assigned_backlog_issue":
    case "blocked_by_uninvokable_assignee":
    case "blocked_by_cancelled_issue": {
      if (!leaf) break;
      if (attention.reason === "blocked_by_cancelled_issue") {
        return {
          source: "blocker_cancelled",
          headline: `It is waiting on ${taskLabel(leaf)}, which was cancelled.`,
          detail: null,
          whoCanUnblock: "You",
          nextStep: "Remove the link or replace it with the work that is still needed.",
          link: refHref(leaf),
        };
      }
      if (attention.reason === "blocked_by_uninvokable_assignee") {
        const owner = nameOf({ agentId: leaf.assigneeAgentId, userId: leaf.assigneeUserId }, input) ?? "its owner";
        return {
          source: "blocker_owner_paused",
          headline: `Waiting on ${owner} to finish ${taskLabel(leaf)}, but ${owner} is paused or cannot run.`,
          detail: null,
          whoCanUnblock: "You",
          nextStep: `Resume ${owner} or give ${shortTaskLabel(leaf)} to someone else.`,
          link: refHref(leaf),
        };
      }
      return describeOneBlocker(
        attention.reason === "blocked_by_unassigned_issue"
          ? { ...leaf, assigneeAgentId: null, assigneeUserId: null }
          : { ...leaf, status: "backlog" },
        input,
        0,
      );
    }
    case "blocked_chain_stalled": {
      const sample = leaf ? taskLabel(leaf) : attention.sampleIssueIdentifier;
      return {
        source: "chain_stalled",
        headline: sample
          ? `A task further down the chain has stalled: ${sample}.`
          : "A task further down the chain has stalled.",
        detail: "Nobody is working on it and nothing will move until someone does.",
        whoCanUnblock: "You",
        nextStep: "Open the stalled task and give it an owner or a next step.",
        link: leaf ? refHref(leaf) : null,
      };
    }
    case "blocked_without_action_path":
      return null;
    case "in_review_without_action_path":
      return {
        source: "review_path",
        headline: "Waiting for a review, but nobody is set to review it.",
        detail: null,
        whoCanUnblock: "You",
        nextStep: "Choose a reviewer, or approve it yourself.",
        link: null,
      };
    case "invalid_review_participant":
      return {
        source: "review_path",
        headline: "The reviewer set on this task cannot review it.",
        detail: null,
        whoCanUnblock: "You",
        nextStep: "Choose a different reviewer.",
        link: null,
      };
    case "open_recovery_issue": {
      const source = attention.sourceIssue && attention.sourceIssue.id !== input.issue.id ? attention.sourceIssue : null;
      const who = ownerName ?? "you";
      return {
        source: "repair",
        headline: source ? `This task repairs ${taskLabel(source)}, which got stuck.` : "A repair is open for this work.",
        detail: null,
        whoCanUnblock: capitalize(who),
        nextStep: "Get the stuck work moving again, or say why it is fine as it is.",
        link: source ? refHref(source) : null,
      };
    }
    case "external_owner_action":
      return {
        source: "outside_wait",
        headline: "Waiting on someone outside the company.",
        detail: null,
        whoCanUnblock: "Someone outside the company",
        nextStep: "Nothing to do until they reply.",
        link: null,
      };
  }
  return null;
}

// ---------------------------------------------------------------------------

function describeStoppedRun(input: WhyBlockedInput): WhyBlocked | null {
  const lastRun = input.lastRun ?? input.issue.latestRun ?? null;
  if (!runStoppedTheTask(lastRun)) return null;
  const reason = describeTaskStopReason({
    issue: {
      status: input.issue.status,
      assigneeAgentId: input.issue.assigneeAgentId,
      assigneeUserId: input.issue.assigneeUserId,
      blockedBy: [],
      unblockDescriptor: null,
      scheduledRetry: input.issue.scheduledRetry ?? null,
      activeRecoveryAction: input.issue.activeRecoveryAction ?? null,
    },
    lastRun,
    hasLiveRuns: false,
    currentUserId: input.currentUserId,
    agentNames: input.agents,
    userLabels: input.userLabels,
    now: input.now,
  });
  if (!reason) return null;
  return {
    source: "run_stopped",
    headline: `${reason.stopped}.`,
    detail: null,
    whoCanUnblock: reason.who ? capitalize(reason.who) : "Nobody, it clears itself",
    nextStep: `${reason.next}.`,
    link: null,
  };
}

function describeNoReason(input: WhyBlockedInput): WhyBlocked {
  const owner = ownerOfIssue(input);
  return {
    source: "no_reason",
    headline: "Marked blocked, but nobody has said why.",
    detail: null,
    whoCanUnblock: owner ? capitalize(owner) : "You",
    nextStep: owner
      ? owner === "you"
        ? "Say what you are waiting for, or move it back to To do."
        : `Ask ${owner} what they need, or move it back to To do.`
      : "Give it an owner, or move it back to To do.",
    link: null,
  };
}

/**
 * Explains why a task is stuck. Returns null when the task is not blocked and
 * the server has not flagged it as stuck. The checks run from what the reader
 * can act on most directly (a question waiting for them) to the least (a run
 * that stopped), and always end in a plain fallback.
 */
export function explainWhyBlocked(input: WhyBlockedInput): WhyBlocked | null {
  const { issue } = input;
  if (CLOSED.has(issue.status)) return null;
  const attention = issue.blockedInboxAttention ?? null;
  if (issue.status !== "blocked" && !attention) return null;

  return (
    describePendingInteractions(input) ??
    describePendingApprovals(input) ??
    describePauseHold(input) ??
    describeBlockedBy(input) ??
    describeRepair(input) ??
    describeWaiting(input) ??
    describeAgentPaused(input) ??
    (attention ? describeAttention(attention, input) : null) ??
    describeStoppedRun(input) ??
    describeNoReason(input)
  );
}

/** The headline and next step as one line, for list rows and tooltips. */
export function formatWhyBlocked(explanation: WhyBlocked): string {
  const parts = [
    explanation.headline,
    explanation.detail,
    `Who can clear it: ${explanation.whoCanUnblock}.`,
    explanation.nextStep,
  ];
  return parts.filter(Boolean).join(" ");
}
