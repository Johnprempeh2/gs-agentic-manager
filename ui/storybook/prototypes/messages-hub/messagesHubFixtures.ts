import type { AgentChatSummary, TeamChatSummary } from "@greatstone/shared";
import { pendingRequestConfirmationInteraction } from "@/fixtures/issueThreadInteractionFixtures";

/**
 * Demo data for Messages (no client names): the board user Riley, two
 * colleagues, a pinned group and a direct message, and agent chats with
 * previews and unread counts. Agent chats reuse the agent-chat prototype's
 * own in-memory issues; these fixtures add only what Messages lists.
 */

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export const OPS_ROOM_ID = "6f1d2c3b-0a4e-4b8f-9c11-000000000101";
export const SAM_DM_ID = "6f1d2c3b-0a4e-4b8f-9c11-000000000102";
const LAUNCH_ID = "6f1d2c3b-0a4e-4b8f-9c11-000000000103";

/** The lead is "Everest" in Greatstone's team: the fixture CTO plays the part. */
export function asMessagesTeam<T extends { id: string; name: string }>(agents: T[]): T[] {
  return agents.map((agent) => (agent.id === "agent-cto" ? { ...agent, name: "Everest", role: "ceo", urlKey: "everest" } : agent));
}

export function messagesAgentChats(chatIssueId: (agentId: string) => string): AgentChatSummary[] {
  return [
    { agentId: "agent-cto", issueId: chatIssueId("agent-cto"), lastMessageAt: minutesAgo(3), lastMessagePreview: "Morning brief: three decisions wait on you, the first is the hiring plan.", lastMessageFromMe: false, unreadCount: 2 },
    { agentId: "agent-codex", issueId: chatIssueId("agent-codex"), lastMessageAt: minutesAgo(12), lastMessagePreview: "I saved the launch plan and onboarding notes alongside this conversation.", lastMessageFromMe: false, unreadCount: 0 },
    { agentId: "chat-design", issueId: chatIssueId("chat-design"), lastMessageAt: daysAgo(1), lastMessagePreview: "Can you try the lighter header?", lastMessageFromMe: true, unreadCount: 0 },
    { agentId: "agent-qa", issueId: chatIssueId("agent-qa"), lastMessageAt: daysAgo(3), lastMessagePreview: "All 214 checks passed on the release candidate.", lastMessageFromMe: false, unreadCount: 1 },
  ];
}

const riley = { type: "user" as const, id: "user-board", name: "Riley Board" };
const sam = { type: "user" as const, id: "user-sam", name: "Sam Okafor" };
const ama = { type: "user" as const, id: "user-ama", name: "Ama Mensah" };

export const messagesTeamChats: TeamChatSummary[] = [
  {
    id: OPS_ROOM_ID, identifier: null, kind: "group", title: "Ops room",
    members: [riley, sam, { type: "agent", id: "agent-codex", name: "CodexCoder" }],
    lastMessageAt: minutesAgo(6), lastMessagePreview: "Sam: the vendor call moved to Thursday", lastMessageFromMe: false, unreadCount: 4, muted: false,
  },
  {
    id: SAM_DM_ID, identifier: null, kind: "direct", title: "Direct message", members: [riley, sam],
    lastMessageAt: minutesAgo(48), lastMessagePreview: "Thanks, I will review it tonight.", lastMessageFromMe: true, unreadCount: 0, muted: false,
  },
  {
    id: LAUNCH_ID, identifier: null, kind: "group", title: "Launch crew", members: [riley, ama, sam],
    lastMessageAt: daysAgo(2), lastMessagePreview: "Slides are in the shared folder", lastMessageFromMe: false, unreadCount: 0, muted: true,
  },
];

function teamComment(id: string, chatId: string, body: string, author: { userId?: string; agentId?: string }, at: string) {
  return {
    id, companyId: "company-storybook", issueId: chatId, body,
    authorType: author.agentId ? "agent" : "user", authorAgentId: author.agentId ?? null, authorUserId: author.userId ?? null,
    createdAt: at, updatedAt: at, deletedAt: null, presentation: null, metadata: null,
  };
}

const teamThreads: Record<string, ReturnType<typeof teamComment>[]> = {
  [OPS_ROOM_ID]: [
    teamComment("ops-1", OPS_ROOM_ID, "Morning all. Where are we on the vendor review?", { userId: "user-board" }, minutesAgo(70)),
    teamComment("ops-2", OPS_ROOM_ID, "Two of three quotes are in. The third arrives today.", { userId: "user-sam" }, minutesAgo(64)),
    teamComment("ops-3", OPS_ROOM_ID, "@CodexCoder can you compare the two we have?", { userId: "user-board" }, minutesAgo(30)),
    teamComment("ops-4", OPS_ROOM_ID, "On it. The cheaper quote leaves out support hours, so the real gap is smaller than it looks.", { agentId: "agent-codex" }, minutesAgo(28)),
    teamComment("ops-5", OPS_ROOM_ID, "The vendor call moved to Thursday", { userId: "user-sam" }, minutesAgo(6)),
  ],
  [SAM_DM_ID]: [
    teamComment("dm-1", SAM_DM_ID, "Sent you the draft budget.", { userId: "user-sam" }, minutesAgo(55)),
    teamComment("dm-2", SAM_DM_ID, "Thanks, I will review it tonight.", { userId: "user-board" }, minutesAgo(48)),
  ],
};

const people = [
  { principalId: "user-sam", status: "active", user: { id: "user-sam", name: "Sam Okafor", email: "sam@example.test" } },
  { principalId: "user-ama", status: "active", user: { id: "user-ama", name: "Ama Mensah", email: "ama@example.test" } },
];

/**
 * Answers the Messages endpoints, or null for everything else. `typingIssueId`
 * is the chat with a running run (the typing state).
 */
export function messagesHubResponse(path: string, chatIssueId: (agentId: string) => string): Response | null {
  if (/\/companies\/[^/]+\/chats$/.test(path)) return Response.json(messagesAgentChats(chatIssueId));
  if (/\/companies\/[^/]+\/team-chats$/.test(path)) return Response.json(messagesTeamChats);
  const chat = path.match(/^\/api\/team-chats\/([^/]+)$/)?.[1];
  if (chat) return Response.json(messagesTeamChats.find((entry) => entry.id === chat) ?? null);
  const thread = path.match(/^\/api\/issues\/([^/]+)\/comments$/)?.[1];
  if (thread && teamThreads[thread]) return Response.json([...teamThreads[thread]!].reverse());
  if (thread && messagesTeamChats.some((entry) => entry.id === thread)) return Response.json([]);
  if (path.endsWith("/sidebar-preferences/me/layout"))
    return Response.json({ layout: { pinnedChats: [`chat:${OPS_ROOM_ID}`] }, updatedAt: null });
  if (/\/companies\/[^/]+\/user-directory$/.test(path)) return Response.json({ users: people });
  return null;
}

/** The agent's approval request in the open agent chat. */
export function messagesHubInteractions(issueId: string) {
  return [{ ...pendingRequestConfirmationInteraction, issueId }];
}
