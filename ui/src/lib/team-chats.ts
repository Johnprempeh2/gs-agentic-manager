import {
  extractUserMentionIds,
  teamChatAlertReason,
  teamChatSnippet,
  type IssueComment,
  type TeamChatAlertReason,
  type TeamChatMember,
  type TeamChatSummary,
} from "@greatstone/shared";
import type { MentionOption } from "@/components/MarkdownEditor";

/** The mention picker in a team chat offers its members only, never yourself. */
export function teamChatMentionOptions(members: TeamChatMember[], currentUserId: string | null | undefined): MentionOption[] {
  return members
    .filter((member) => !(member.type === "user" && member.id === currentUserId))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((member) =>
      member.type === "agent"
        ? { id: `agent:${member.id}`, name: member.name, kind: "agent" as const, agentId: member.id }
        : { id: `user:${member.id}`, name: member.name, kind: "user" as const, userId: member.id },
    );
}

/** A direct message reads as the other person's name; a group as its title. */
export function teamChatLabel(chat: Pick<TeamChatSummary, "kind" | "title" | "members">, currentUserId: string | null | undefined): string {
  if (chat.kind !== "direct") return chat.title;
  return chat.members.find((member) => member.type === "user" && member.id !== currentUserId)?.name ?? chat.title;
}

/**
 * The chat a live `issue.comment_added` event belongs to, when it is a team
 * chat the reader is in and someone else wrote it. Null otherwise: other
 * people's chats, your own messages and system notices never alert.
 */
export function teamChatForLiveComment(
  payload: Record<string, unknown>,
  chats: readonly TeamChatSummary[] | undefined,
  currentUserId: string,
): { chat: TeamChatSummary; commentId: string } | null {
  const details = payload.details as Record<string, unknown> | null | undefined;
  if (payload.action !== "issue.comment_added" || details?.teamChat !== true) return null;
  if (typeof details.commentId !== "string") return null;
  if (payload.actorType === "system" || (payload.actorType === "user" && payload.actorId === currentUserId)) return null;
  const chat = chats?.find((entry) => entry.id === payload.entityId);
  return chat ? { chat, commentId: details.commentId } : null;
}

export interface TeamChatAlert {
  reason: TeamChatAlertReason;
  title: string;
  body: string;
}

/** The alert one message raises for the reader, or null (own message, notice, muted without a mention). */
export function buildTeamChatAlert(chat: TeamChatSummary, comment: IssueComment, currentUserId: string): TeamChatAlert | null {
  const author = comment.authorAgentId
    ? { type: "agent" as const, id: comment.authorAgentId }
    : comment.authorUserId && comment.authorType !== "system"
      ? { type: "user" as const, id: comment.authorUserId }
      : { type: "system" as const, id: null };
  const reason = teamChatAlertReason({
    recipientUserId: currentUserId,
    author,
    muted: chat.muted,
    mentionedUserIds: extractUserMentionIds(comment.body),
  });
  if (!reason) return null;
  const name = chat.members.find((member) => member.type === author.type && member.id === author.id)?.name
    ?? (author.type === "agent" ? "An agent" : "Someone");
  const direct = chat.kind === "direct";
  const title = reason === "mention"
    ? direct ? `${name} mentioned you` : `${name} mentioned you in ${chat.title}`
    : direct ? name : `${name} in ${chat.title}`;
  return { reason, title, body: teamChatSnippet(comment.body) };
}
