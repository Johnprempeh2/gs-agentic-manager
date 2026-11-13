import type { AgentChatSummary, TeamChatSummary } from "@greatstone/shared";
import type { AvatarAgent } from "@/components/AgentAvatar";
import { formatClockTime } from "./utils";
import { formatTeamChatDay } from "./team-chat-messages";
import { teamChatLabel } from "./team-chats";

/**
 * One row in Messages: an agent chat, a direct message or a group. Agent chats
 * are keyed `agent:<agentId>` (one chat per agent per person), team chats
 * `chat:<issueId>`. The key is what pins and the hub route remember.
 */
export interface Conversation {
  key: string;
  kind: "agent" | "direct" | "group";
  name: string;
  href: string;
  /** The agent behind an agent chat (avatar, profile link). */
  agent?: AvatarAgent & { id: string; name: string; urlKey?: string | null };
  /** The chat issue, once there is one (an agent chat starts on first send). */
  issueId: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageFromMe: boolean;
  unreadCount: number;
  muted: boolean;
  /** Runs the agent has going right now, anywhere. */
  workingOn: number;
  /** A run is going in this very conversation: the agent is replying. */
  typing: boolean;
  members?: TeamChatSummary["members"];
}

export const agentConversationKey = (agentId: string) => `agent:${agentId}`;
export const chatConversationKey = (chatId: string) => `chat:${chatId}`;

type ChatAgent = NonNullable<Conversation["agent"]> & { status?: string | null };

export interface ConversationSources {
  agents: readonly ChatAgent[];
  agentChats: readonly AgentChatSummary[];
  teamChats: readonly TeamChatSummary[];
  /** Running runs by agent: their issue ids. */
  liveRuns: ReadonlyMap<string, readonly (string | null)[]>;
  currentUserId: string | null;
  leadId: string | null;
  /** Agents always listed even before a first message (the lead, pinned agents). */
  alwaysShowAgentIds: readonly string[];
  agentHref: (agent: ChatAgent) => string;
}

/** Agent chats and team chats as one list of rows (not yet ordered). */
export function buildConversations(sources: ConversationSources): Conversation[] {
  const byAgent = new Map(sources.agentChats.map((chat) => [chat.agentId, chat]));
  const live = (agentId: string, issueId: string | null) => {
    const runs = sources.liveRuns.get(agentId) ?? [];
    return { workingOn: runs.length, typing: issueId !== null && runs.includes(issueId) };
  };
  const agentRows = sources.agents
    .filter((agent) => agent.status !== "terminated")
    .filter((agent) => byAgent.has(agent.id) || agent.id === sources.leadId || sources.alwaysShowAgentIds.includes(agent.id))
    .map((agent): Conversation => {
      const chat = byAgent.get(agent.id);
      const issueId = chat?.issueId ?? null;
      return {
        key: agentConversationKey(agent.id),
        kind: "agent",
        name: agent.name,
        href: sources.agentHref(agent),
        agent,
        issueId,
        lastMessageAt: chat?.lastMessageAt ?? null,
        lastMessagePreview: chat?.lastMessagePreview ?? null,
        lastMessageFromMe: chat?.lastMessageFromMe ?? false,
        unreadCount: chat?.unreadCount ?? 0,
        muted: false,
        ...live(agent.id, issueId),
      };
    });
  const chatRows = sources.teamChats.map((chat): Conversation => {
    const agents = chat.members.filter((member) => member.type === "agent");
    return {
      key: chatConversationKey(chat.id),
      kind: chat.kind,
      name: teamChatLabel(chat, sources.currentUserId),
      href: `/messages/${chat.id}`,
      issueId: chat.id,
      lastMessageAt: chat.lastMessageAt,
      lastMessagePreview: chat.lastMessagePreview ?? null,
      lastMessageFromMe: chat.lastMessageFromMe ?? false,
      unreadCount: chat.unreadCount,
      muted: chat.muted,
      workingOn: 0,
      typing: agents.some((member) => (sources.liveRuns.get(member.id) ?? []).includes(chat.id)),
      members: chat.members,
    };
  });
  return [...agentRows, ...chatRows];
}

/** Everest first, then the reader's pins in the order they pinned them, then the newest message first. */
export function orderConversations(rows: readonly Conversation[], leadKey: string | null, pinnedKeys: readonly string[]): Conversation[] {
  const rank = (row: Conversation) => {
    if (row.key === leadKey) return -1;
    const pin = pinnedKeys.indexOf(row.key);
    return pin === -1 ? pinnedKeys.length : pin;
  };
  return [...rows].sort((a, b) =>
    rank(a) - rank(b)
    || (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "")
    || a.name.localeCompare(b.name));
}

/** The orb and the "All messages" badge: unread messages across every conversation the reader has not muted. */
export function totalUnread(rows: readonly Conversation[]): number {
  return rows.reduce((sum, row) => sum + (row.muted ? 0 : row.unreadCount), 0);
}

/** Search matches a name or the newest message, ignoring case. */
export function matchesConversation(row: Conversation, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return row.name.toLowerCase().includes(needle) || (row.lastMessagePreview ?? "").toLowerCase().includes(needle);
}

/** The list's time column: the clock today, "Yesterday", then a short date. */
export function formatConversationTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const day = formatTeamChatDay(date, now);
  return day === "Today" ? formatClockTime(date) : day;
}

/** The header line under a name: what the agent is doing, or who is in the chat. */
export function conversationStatus(row: Pick<Conversation, "kind" | "typing" | "workingOn" | "members">): string {
  if (row.typing) return "Typing";
  if (row.kind === "agent") {
    return row.workingOn > 0 ? `Working on ${row.workingOn} ${row.workingOn === 1 ? "task" : "tasks"}` : "Available";
  }
  if (row.kind === "group") return `${row.members?.length ?? 0} members`;
  return "Direct message";
}
