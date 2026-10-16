import type { Approval } from "@greatstone/shared";

/** How long sign-offs have waited, so the oldest ones are not forgotten. */

const DAY_MS = 86_400_000;

export function isAwaitingDecision(approval: Pick<Approval, "status">): boolean {
  return approval.status === "pending" || approval.status === "revision_requested";
}

/** Whole days since the request, or 0 when it is less than a day old. */
export function daysWaiting(createdAt: Date | string, now: Date = new Date()): number {
  const ms = now.getTime() - new Date(createdAt).getTime();
  return ms > 0 ? Math.floor(ms / DAY_MS) : 0;
}

/** "Waiting 3 days" once a request is a day old; nothing before that. */
export function waitingLabel(approval: Pick<Approval, "status" | "createdAt">, now: Date = new Date()): string | null {
  if (!isAwaitingDecision(approval)) return null;
  const days = daysWaiting(approval.createdAt, now);
  if (days < 1) return null;
  return `Waiting ${days} ${days === 1 ? "day" : "days"}`;
}

/** "3 waiting for you, the oldest for 4 days." for the Pending tab. */
export function pendingSummary(approvals: readonly Pick<Approval, "status" | "createdAt">[], now: Date = new Date()): string | null {
  const waiting = approvals.filter(isAwaitingDecision);
  if (waiting.length === 0) return null;
  const oldest = Math.max(...waiting.map((approval) => daysWaiting(approval.createdAt, now)));
  const count = `${waiting.length} waiting for you`;
  if (oldest < 1) return `${count}, ${waiting.length === 1 ? "from" : "all from"} today.`;
  return `${count}, the oldest for ${oldest} ${oldest === 1 ? "day" : "days"}.`;
}

/**
 * "Copy as a list" on the Pending tab: each sign-off with who asked, how long
 * it has waited and a link, ready to paste.
 */
export function pendingListText(
  approvals: readonly (Pick<Approval, "id" | "status" | "createdAt"> & { label: string; requester?: string | null })[],
  linkFor: (id: string) => string,
  now: Date = new Date(),
): string {
  const waiting = approvals.filter(isAwaitingDecision);
  const lines = ["Sign-offs waiting for me", pendingSummary(waiting, now) ?? "Nothing is waiting."];
  if (waiting.length > 0) lines.push("");
  for (const approval of waiting) {
    const detail = [approval.requester ? `from ${approval.requester}` : null, waitingLabel(approval, now)?.toLowerCase() ?? "today"]
      .filter(Boolean)
      .join(", ");
    lines.push(`• ${approval.label} (${detail}) ${linkFor(approval.id)}`);
  }
  return lines.join("\n");
}
