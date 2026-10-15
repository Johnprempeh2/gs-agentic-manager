import { z } from "zod";

/**
 * Team chats (enableTeamChat): direct messages between people and group chats
 * of people and agents. A team chat is an issue with this origin kind, no
 * assignee and no conversation columns, so no message wakes anyone on its own.
 * Agents wake only when @mentioned, and only when they are members.
 */
export const TEAM_CHAT_ORIGIN_KIND = "team_chat" as const;

/** Agent-to-agent mention hops allowed in a row before a person must speak. */
export const TEAM_CHAT_AGENT_HOP_LIMIT = 3;

/** Messages a woken agent receives as context. */
export const TEAM_CHAT_CONTEXT_MESSAGES = 30;

/** A direct message stores its two people, sorted, as the issue origin id. */
export function directMessageOriginId(userA: string, userB: string): string {
  return `dm:${[userA, userB].sort().join(":")}`;
}

export type TeamChatKind = "direct" | "group";

export interface TeamChatMember {
  type: "user" | "agent";
  id: string;
  name: string;
}

export interface TeamChatSummary {
  id: string;
  identifier: string | null;
  kind: TeamChatKind;
  title: string;
  members: TeamChatMember[];
  lastMessageAt: string | null;
  unreadCount: number;
  /** The reader muted this chat: no alerts except when @mentioned. */
  muted: boolean;
}

const memberIds = {
  userIds: z.array(z.string().trim().min(1)).max(50).default([]),
  agentIds: z.array(z.string().uuid()).max(20).default([]),
};

export const createTeamChatSchema = z.object({
  title: z.string().trim().min(1).max(120),
  ...memberIds,
});
export type CreateTeamChat = z.infer<typeof createTeamChatSchema>;

export const createDirectMessageSchema = z.object({ userId: z.string().trim().min(1) });
export type CreateDirectMessage = z.infer<typeof createDirectMessageSchema>;

export const addTeamChatMembersSchema = z.object(memberIds);
export type AddTeamChatMembers = z.infer<typeof addTeamChatMembersSchema>;

export const setTeamChatMuteSchema = z.object({ muted: z.boolean() });
export type SetTeamChatMute = z.infer<typeof setTeamChatMuteSchema>;

export type TeamChatAlertReason = "message" | "mention";

/**
 * Whether one new message alerts one person in the chat. Every message alerts
 * every person in it except its author; muting stops that, but an @mention
 * still gets through. Agents are not covered here: they wake only when
 * mentioned (see agentsToWake).
 */
export function teamChatAlertReason(input: {
  recipientUserId: string;
  author: { type: "user" | "agent" | "system"; id: string | null };
  muted: boolean;
  mentionedUserIds: readonly string[];
}): TeamChatAlertReason | null {
  if (input.author.type === "system") return null;
  if (input.author.type === "user" && input.author.id === input.recipientUserId) return null;
  if (input.mentionedUserIds.includes(input.recipientUserId)) return "mention";
  return input.muted ? null : "message";
}

/**
 * Loop guard. Counts agent-authored messages that mention agents since the
 * last message from a person, newest last (include the message being posted).
 * Messages from the system, and agent messages without an agent mention, do
 * not count and do not reset.
 */
export function teamChatAgentHops(
  messages: ReadonlyArray<{ authorType: "user" | "agent" | "system" | null; mentionsAgent: boolean }>,
): number {
  let hops = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.authorType === "user") break;
    if (message.authorType === "agent" && message.mentionsAgent) hops += 1;
  }
  return hops;
}
