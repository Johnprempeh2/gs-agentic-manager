import type { IssueComment } from "@greatstone/shared";

/** Consecutive messages from one sender join a group when they are this close together. */
export const TEAM_CHAT_GROUP_GAP_MS = 5 * 60 * 1000;

export type TeamChatSenderKind = "self" | "user" | "agent" | "system";

export interface TeamChatSender {
  /** Stable key: two messages with the same key come from the same sender. */
  key: string;
  kind: TeamChatSenderKind;
  agentId: string | null;
}

export type TeamChatRow =
  | { kind: "date"; key: string; date: Date }
  | { kind: "group"; key: string; sender: TeamChatSender; messages: IssueComment[] };

export function teamChatSender(comment: IssueComment, currentUserId: string | null | undefined): TeamChatSender {
  if (comment.authorAgentId) return { key: `agent:${comment.authorAgentId}`, kind: "agent", agentId: comment.authorAgentId };
  if (comment.authorType === "system" && !comment.authorUserId) return { key: "system", kind: "system", agentId: null };
  if (currentUserId && comment.authorUserId === currentUserId) return { key: "self", kind: "self", agentId: null };
  return { key: `user:${comment.authorUserId ?? "unknown"}`, kind: "user", agentId: null };
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Turns a chat's comments (oldest first) into messenger rows: a date separator
 * at each new day, and runs of messages from one sender within
 * TEAM_CHAT_GROUP_GAP_MS of each other folded into one group.
 */
export function buildTeamChatRows(comments: IssueComment[], currentUserId: string | null | undefined): TeamChatRow[] {
  const rows: TeamChatRow[] = [];
  let lastDay: string | null = null;
  let lastAt = 0;
  let group: Extract<TeamChatRow, { kind: "group" }> | null = null;
  for (const comment of comments) {
    const at = new Date(comment.createdAt);
    const day = dayKey(at);
    if (day !== lastDay) {
      rows.push({ kind: "date", key: `date:${day}`, date: at });
      lastDay = day;
      group = null;
    }
    const sender = teamChatSender(comment, currentUserId);
    if (group && group.sender.key === sender.key && sender.kind !== "system" && at.getTime() - lastAt <= TEAM_CHAT_GROUP_GAP_MS) {
      group.messages.push(comment);
    } else {
      group = { kind: "group", key: `group:${comment.id}`, sender, messages: [comment] };
      rows.push(group);
    }
    lastAt = at.getTime();
  }
  return rows;
}

/** "Today", "Yesterday", "Mon 13 Oct", or "13 Oct 2025" for another year. */
export function formatTeamChatDay(date: Date, now: Date = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatTeamChatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
