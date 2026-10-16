import type { BlockedWorkOwner } from "@greatstone/shared";

/** "9 days", "3 hours", "a few minutes": how long something has waited, in plain words. */
export function formatWaitingFor(since: string | null, now: number = Date.now()): string | null {
  if (!since) return null;
  const then = new Date(since).getTime();
  if (!Number.isFinite(then)) return null;
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 60) return minutes < 5 ? "a few minutes" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

export function pluralTasks(count: number): string {
  return count === 1 ? "1 task" : `${count} tasks`;
}

/** Who has to act, as a short phrase such as "Mason" or "You (the board)". */
export function blockedWorkOwnerLabel(
  owner: BlockedWorkOwner,
  names: {
    agentNameById: ReadonlyMap<string, string>;
    userLabelById?: ReadonlyMap<string, string>;
    currentUserId?: string | null;
  },
): string {
  if (owner.type === "board") return "You (the board)";
  if (owner.type === "agent" && owner.agentId) return names.agentNameById.get(owner.agentId) ?? "An agent";
  if (owner.type === "user" && owner.userId) {
    if (owner.userId === names.currentUserId) return "You";
    return names.userLabelById?.get(owner.userId) ?? "A teammate";
  }
  return "Nobody yet";
}
