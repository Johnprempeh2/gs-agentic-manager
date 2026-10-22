import type { NeedsMe } from "@greatstone/shared";
import { decisionKindLabel } from "./decision-kind-label";
import { isFocusItem } from "./focus-items";

/** What a Needs you line on Today asks of the person, and where it opens. */
export interface NeedsYouAsk {
  /** The kind of ask, as Desk names it: "Review", "Question", "Confirmation"... */
  action: string;
  /** The ask in one sentence, when there is one beyond the task title. */
  prompt: string | null;
  /** The exact request (a question opens on its card in the thread), or null for the task. */
  href: string | null;
}

/**
 * The ask behind each Needs you line, keyed the way the morning summary keys
 * its lines (the task id, or the card id for a card with no task), so the
 * first card for a task wins, as on the server.
 */
export function needsYouAsks(needsMe: NeedsMe | null | undefined): Map<string, NeedsYouAsk> {
  const asks = new Map<string, NeedsYouAsk>();
  if (!needsMe) return asks;
  const add = (id: string, ask: NeedsYouAsk) => {
    if (!asks.has(id)) asks.set(id, ask);
  };
  for (const card of needsMe.decisions) {
    if (card.kind === "outage") continue;
    const question = card.items.find(isFocusItem);
    add(card.task?.id ?? card.id, {
      action: decisionKindLabel(card, card.kind),
      prompt: card.decision || null,
      href: question?.subject.href ?? card.task?.href ?? null,
    });
  }
  for (const task of needsMe.assignedTasks) add(task.id, { action: "Your task", prompt: null, href: null });
  for (const wait of needsMe.overdueWaits) add(wait.id, { action: "Waiting on you", prompt: wait.action || null, href: null });
  return asks;
}
