import type { TeamChatMember, TeamChatSummary } from "@greatstone/shared";
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
