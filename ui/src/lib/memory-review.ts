import { ApiError } from "../api/client";
import {
  MEMORY_REVIEW_AGE_FLAGS,
  type MemoryActorLabel,
  type MemoryReviewAgeFlag,
  type MemoryReviewQueueItem,
  type MemoryStewardAction,
} from "@greatstone/shared";
import type { MemoryReviewFilters } from "../api/memoryReview";

/** Review queue filters live in the URL so a steward can share a filtered view. */
export function readReviewFilters(params: URLSearchParams): MemoryReviewFilters {
  const age = params.get("age");
  const conflict = params.get("conflict");
  const person = params.get("person");
  return {
    scopeId: params.get("scope") || undefined,
    person: person && /^(user|agent):.+/.test(person) ? person : undefined,
    app: params.get("app") || undefined,
    age: MEMORY_REVIEW_AGE_FLAGS.includes(age as MemoryReviewAgeFlag) ? (age as MemoryReviewAgeFlag) : undefined,
    conflict: conflict === "true" || conflict === "false" ? conflict : undefined,
  };
}

export function hasReviewFilters(filters: MemoryReviewFilters) {
  return Boolean(filters.scopeId || filters.person || filters.app || filters.age || filters.conflict);
}

/** The person first; the app is a label. "John · via ChatGPT". */
export function personWithApp(actor: MemoryActorLabel | null | undefined): string {
  if (!actor) return "Unknown";
  return actor.app ? `${actor.name} · via ${actor.app}` : actor.name;
}

export function ageText(days: number): string {
  if (days < 1) return "Today";
  return days === 1 ? "1 day" : `${days} days`;
}

export const ageFlagMeta: Record<MemoryReviewAgeFlag, { label: string | null; hint: string; tone: string }> = {
  fresh: { label: null, hint: "Waiting for review.", tone: "" },
  overdue: {
    label: "Over 7 days",
    hint: "Nobody has reviewed this for 7 days or more.",
    tone: "bg-status-warning-soft text-status-warning-foreground",
  },
  expired: {
    label: "Expired",
    hint: "Unreviewed for 30 days or more. Not deleted; still searchable, ranked last.",
    tone: "bg-muted text-muted-foreground",
  },
};

/**
 * Expired last, then oldest first. The server already sends this order; the
 * screen keeps it if a list is merged or refetched out of order.
 */
export function sortQueue(items: MemoryReviewQueueItem[]): MemoryReviewQueueItem[] {
  return [...items].sort((a, b) => {
    const expired = Number(a.ageFlag === "expired") - Number(b.ageFlag === "expired");
    return expired !== 0 ? expired : b.ageDays - a.ageDays;
  });
}

export const stewardActionLabel: Record<MemoryStewardAction, string> = {
  confirm: "Confirm",
  edit_and_confirm: "Edit and confirm",
  reject: "Reject",
  merge: "Merge",
};

/** What each action does, shown in its dialog so the steward knows before they act. */
export const stewardActionHint: Record<MemoryStewardAction, string> = {
  confirm: "The card goes live for everyone and ranks first in search.",
  edit_and_confirm: "Your edit becomes a new version. Another steward must confirm it; you cannot.",
  reject: "The proposal is kept in history with your reason. It does not go live.",
  merge: "The proposal joins another card. Its history is kept.",
};

/** Plain words for a refused action. The server reason wins when it gives one. */
export function actionErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "This card changed since you opened it. Check the new version, then try again.";
    if (error.status === 403) return error.message || "You cannot do this on this card.";
    return error.message || "The action failed. Try again.";
  }
  return error instanceof Error ? error.message : "The action failed. Try again.";
}

/** Cards a proposal can merge into: the confirmed card it changes, then other proposals in the same scope. */
export function mergeTargets(item: MemoryReviewQueueItem, queue: MemoryReviewQueueItem[]) {
  const targets: Array<{ id: string; label: string }> = [];
  if (item.current) targets.push({ id: item.current.id, label: `Confirmed: ${cardTitle(item.current)}` });
  for (const other of queue) {
    if (other.proposal.id === item.proposal.id || other.scope.id !== item.scope.id) continue;
    targets.push({ id: other.proposal.id, label: `Proposal: ${cardTitle(other.proposal)}` });
  }
  return targets;
}

export function cardTitle(record: { title: string | null; content: string | null }) {
  return record.title?.trim() || record.content?.trim().slice(0, 80) || "Untitled card";
}
