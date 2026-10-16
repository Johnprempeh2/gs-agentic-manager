import type { DecisionCard, DecisionCardKind, NeedsMe } from "@greatstone/shared";
import type { PipelineAttentionFeed } from "@/api/pipelines";

/** The kinds of thing the team can need from a person, in the order the page shows them. */
export type NeededGroupId = "answer" | "sign-off" | "unblock" | "fix" | "overdue" | "tasks" | "clients";

export interface NeededItem {
  id: string;
  title: string;
  /** Why it needs you, in a line. */
  reason: string | null;
  /** Who is waiting: an agent's name, or null. */
  waiting: string | null;
  /** When the wait started, for "waiting 2d". */
  since: string | null;
  href: string;
  /** The Decisions card behind this item, so it can be acted on in place. */
  cardId?: string;
}

export interface NeededGroup {
  id: NeededGroupId;
  title: string;
  /** One plain sentence on what this kind of item asks of you. */
  explain: string;
  /** Where to see and act on every item in the group. */
  allHref: string;
  allLabel: string;
  items: NeededItem[];
}

const GROUP_OF_KIND: Record<DecisionCardKind, NeededGroupId> = {
  question: "answer",
  decision: "answer",
  approval: "sign-off",
  review: "sign-off",
  budget: "sign-off",
  join_request: "sign-off",
  blocked: "unblock",
  recovery: "unblock",
  failed_run: "unblock",
  connection: "fix",
  agent_error: "fix",
  outage: "fix",
};

const GROUP_COPY: Record<NeededGroupId, Omit<NeededGroup, "id" | "items">> = {
  answer: {
    title: "Answer a question",
    explain: "An agent has stopped to ask you something. The work carries on as soon as you answer.",
    allHref: "/decisions",
    allLabel: "Open decisions",
  },
  "sign-off": {
    title: "Give a sign-off",
    explain: "A step that needs a person's yes, such as a review, a hire or more budget.",
    allHref: "/decisions",
    allLabel: "Open decisions",
  },
  unblock: {
    title: "Unblock stuck work",
    explain: "Work that stopped and cannot go on by itself. Give the agent a steer or hand it to someone else.",
    allHref: "/decisions",
    allLabel: "Open decisions",
  },
  fix: {
    title: "Fix a connection or setup",
    explain: "Something the agents rely on needs you at your computer, such as signing in to an account again.",
    allHref: "/decisions",
    allLabel: "Open decisions",
  },
  overdue: {
    title: "Waiting on you for over a day",
    explain: "Tasks an agent handed back to you more than 24 hours ago. They stay still until you act.",
    allHref: "/my-tasks",
    allLabel: "Open my tasks",
  },
  tasks: {
    title: "Tasks only you can do",
    explain: "Work assigned to you rather than to an agent.",
    allHref: "/my-tasks",
    allLabel: "Open my tasks",
  },
  clients: {
    title: "Clients waiting on you",
    explain: "Client cases ready for your review, or an agent suggesting a client moves to the next stage.",
    allHref: "/review-queue",
    allLabel: "Open review queue",
  },
};

export const NEEDED_GROUP_ORDER: NeededGroupId[] = ["answer", "sign-off", "unblock", "fix", "overdue", "tasks", "clients"];

function taskHref(task: { id: string; identifier: string | null }) {
  return `/issues/${task.identifier ?? task.id}`;
}

function cardItem(card: DecisionCard): NeededItem {
  return {
    id: card.id,
    title: card.title,
    reason: card.reason && card.reason !== card.title ? card.reason : null,
    waiting: card.waiting?.name ?? null,
    since: card.createdAt,
    href: card.task ? taskHref(card.task) : card.setup?.fixHref ?? "/decisions",
    cardId: card.id,
  };
}

/**
 * Everything the team needs from the signed-in person, grouped by what they
 * have to do. A task shows once: decision cards first, then overdue waits,
 * then plain assigned tasks. Empty groups are left out.
 */
export function buildNeededFromYou(input: {
  cards: DecisionCard[];
  needsMe: Pick<NeedsMe, "assignedTasks" | "overdueWaits"> | null | undefined;
  clients: PipelineAttentionFeed | null | undefined;
}): NeededGroup[] {
  const buckets = new Map<NeededGroupId, NeededItem[]>(NEEDED_GROUP_ORDER.map((id) => [id, []]));
  const taskIds = new Set<string>();

  for (const card of input.cards) {
    const group = card.atDesk || card.setup ? "fix" : GROUP_OF_KIND[card.kind] ?? "answer";
    buckets.get(group)!.push(cardItem(card));
    if (card.task) taskIds.add(card.task.id);
  }

  for (const wait of input.needsMe?.overdueWaits ?? []) {
    if (taskIds.has(wait.id)) continue;
    taskIds.add(wait.id);
    buckets.get("overdue")!.push({
      id: `wait:${wait.id}`,
      title: wait.title,
      reason: wait.action || null,
      waiting: null,
      since: wait.waitingSinceAt,
      href: taskHref(wait),
    });
  }

  for (const task of input.needsMe?.assignedTasks ?? []) {
    if (taskIds.has(task.id)) continue;
    taskIds.add(task.id);
    buckets.get("tasks")!.push({
      id: `task:${task.id}`,
      title: task.title,
      reason: null,
      waiting: null,
      since: task.updatedAt,
      href: taskHref(task),
    });
  }

  const clientItems = buckets.get("clients")!;
  for (const review of input.clients?.reviews ?? []) {
    clientItems.push({
      id: `review:${review.case.id}`,
      title: review.case.title,
      reason: `Ready for your review in ${review.case.stage.name}`,
      waiting: null,
      since: String(review.case.updatedAt),
      href: `/pipelines/${review.case.pipeline.id}/items/${review.case.id}`,
    });
  }
  for (const { case: item, suggestion } of input.clients?.suggestions ?? []) {
    clientItems.push({
      id: `suggestion:${suggestion.id}`,
      title: item.title,
      reason: `${suggestion.suggestedBy?.agentName ?? "An agent"} suggests moving it to ${suggestion.toStageName ?? "the next stage"}`,
      waiting: suggestion.suggestedBy?.agentName ?? null,
      since: String(suggestion.createdAt),
      href: `/pipelines/${item.pipeline.id}/items/${item.id}`,
    });
  }

  return NEEDED_GROUP_ORDER.flatMap((id) => {
    const items = buckets.get(id)!;
    return items.length > 0 ? [{ id, ...GROUP_COPY[id], items }] : [];
  });
}

/** The page's opening line: how many things, and how long the oldest has waited. */
export function neededSummary(groups: NeededGroup[], now = Date.now()): string {
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  if (total === 0) return "Nothing needs you right now. The agents are getting on with the work.";
  const oldest = groups
    .flatMap((group) => group.items.map((item) => (item.since ? new Date(item.since).getTime() : NaN)))
    .filter((time) => Number.isFinite(time))
    .reduce((min, time) => Math.min(min, time), Infinity);
  const things = total === 1 ? "1 thing needs you" : `${total} things need you`;
  if (!Number.isFinite(oldest)) return `${things}.`;
  return `${things}. The oldest has waited ${waitedFor(now - oldest)}.`;
}

/** "3 hours", "2 days": a wait in plain words. */
export function waitedFor(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return minutes <= 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "a day" : `${days} days`;
}
