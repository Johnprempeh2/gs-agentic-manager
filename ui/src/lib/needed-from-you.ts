import type { DecisionCard, DecisionCardKind, NeedsMe } from "@greatstone/shared";
import { formatShortDate } from "@/lib/utils";

/** The kinds of thing the team can need from a person, in the order the page shows them. */
export type NeededGroupId = "answer" | "sign-off" | "unblock" | "fix" | "overdue";

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
    explain: "Tasks an agent handed back to you more than 24 hours ago, and questions that ran out of time unanswered. They stay still until you act.",
    allHref: "/decisions",
    allLabel: "Open decisions",
  },
};

export const NEEDED_GROUP_ORDER: NeededGroupId[] = ["answer", "sign-off", "unblock", "fix", "overdue"];

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
 * have to do: exactly the items behind the one "needs you" number
 * (NeedsMe.decisionCount): every decision card outside "At your desk", every
 * overdue wait and every expired question, each once. Tasks merely assigned to them are on the Desk.
 * Empty groups are left out.
 */
export function buildNeededFromYou(input: {
  cards: DecisionCard[];
  needsMe: Pick<NeedsMe, "overdueWaits" | "expiredCards"> | null | undefined;
}): NeededGroup[] {
  const buckets = new Map<NeededGroupId, NeededItem[]>(NEEDED_GROUP_ORDER.map((id) => [id, []]));
  const taskIds = new Set<string>();

  for (const card of input.cards) {
    // "At your desk" cards are outside the count (GRE-450): on the Desk and in Focus.
    if (card.atDesk) continue;
    const group = card.setup ? "fix" : GROUP_OF_KIND[card.kind] ?? "answer";
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

  for (const card of input.needsMe?.expiredCards ?? []) {
    if (taskIds.has(card.id)) continue;
    taskIds.add(card.id);
    buckets.get("overdue")!.push({
      id: `expired:${card.interactionId}`,
      title: card.title,
      reason: card.question ? `Unanswered: ${card.question}` : "A question ran out of time unanswered",
      waiting: null,
      since: card.expiredAt,
      href: taskHref(card),
    });
  }

  return NEEDED_GROUP_ORDER.flatMap((id) => {
    const items = buckets.get(id)!;
    return items.length > 0 ? [{ id, ...GROUP_COPY[id], items }] : [];
  });
}

/**
 * The page's opening line: how many things, and how long the oldest has
 * waited. `putAway` rows still count (the number is the same everywhere), so
 * the line says how many of them are hidden until later.
 */
export function neededSummary(groups: NeededGroup[], now = Date.now(), putAway = 0): string {
  const listed = groups.reduce((sum, group) => sum + group.items.length, 0);
  const total = listed + putAway;
  if (total === 0) return "Nothing needs you right now. The agents are getting on with the work.";
  const away = putAway > 0 ? ` (${putAway} put away for later)` : "";
  const oldest = groups
    .flatMap((group) => group.items.map((item) => (item.since ? new Date(item.since).getTime() : NaN)))
    .filter((time) => Number.isFinite(time))
    .reduce((min, time) => Math.min(min, time), Infinity);
  const things = (total === 1 ? "1 thing needs you" : `${total} things need you`) + away;
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

/** The inbox-dismissal key that puts a Needed from you row away for later. */
export function neededLaterKey(itemId: string): string {
  return `attention:needed:${itemId}`;
}

/** Drops rows put away for later (still snoozed at `now`), and any group left empty. */
export function withoutPutAway(
  groups: NeededGroup[],
  dismissals: ReadonlyArray<{ kind: string; itemKey: string; snoozedUntil?: string | Date | null }>,
  now: number = Date.now(),
): NeededGroup[] {
  const away = new Set<string>();
  for (const dismissal of dismissals) {
    if (dismissal.kind !== "snooze" || !dismissal.snoozedUntil) continue;
    if (new Date(dismissal.snoozedUntil).getTime() <= now) continue;
    away.add(dismissal.itemKey);
  }
  if (away.size === 0) return groups;
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => !away.has(neededLaterKey(item.id))) }))
    .filter((group) => group.items.length > 0);
}

/**
 * "Copy as a list" on Needed from you: every row, grouped as on the page,
 * with who is waiting, for how long and a link, ready to paste into notes or
 * a message to an assistant.
 */
export function neededListText(groups: NeededGroup[], linkFor: (href: string) => string = () => "", now = Date.now()): string {
  const day = formatShortDate(new Date(now));
  const lines = [`What needs me, ${day}`, neededSummary(groups, now)];
  for (const group of groups) {
    if (group.items.length === 0) continue;
    lines.push("", group.title);
    for (const item of group.items) {
      const who = [
        item.waiting,
        item.since ? `waiting ${waitedFor(now - new Date(item.since).getTime())}` : null,
      ].filter(Boolean);
      const detail = item.reason ? `: ${item.reason}` : "";
      const tail = who.length > 0 ? ` (${who.join(", ")})` : "";
      const link = linkFor(item.href);
      lines.push(`• ${item.title}${detail}${tail}${link ? ` ${link}` : ""}`);
    }
  }
  return lines.join("\n");
}
