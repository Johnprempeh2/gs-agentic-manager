import { describe, expect, it } from "vitest";
import type { AgentChatSummary, TeamChatSummary } from "@greatstone/shared";
import {
  buildConversations,
  conversationStatus,
  formatConversationTime,
  matchesConversation,
  orderConversations,
  totalUnread,
  type Conversation,
} from "./conversations";

const agents = [
  { id: "everest", name: "Everest" },
  { id: "mica", name: "Mica" },
  { id: "flint", name: "Flint" },
  { id: "quiet", name: "Quiet" },
  { id: "gone", name: "Gone", status: "terminated" },
];
const agentChats: AgentChatSummary[] = [
  { agentId: "mica", issueId: "i-mica", lastMessageAt: "2026-11-13T09:00:00.000Z", lastMessagePreview: "Draft ready", lastMessageFromMe: false, unreadCount: 2 },
  { agentId: "flint", issueId: "i-flint", lastMessageAt: "2026-11-13T11:00:00.000Z", lastMessagePreview: "Shipped", lastMessageFromMe: true, unreadCount: 0 },
  { agentId: "gone", issueId: "i-gone", lastMessageAt: "2026-11-13T12:00:00.000Z", lastMessagePreview: "Bye", lastMessageFromMe: false, unreadCount: 4 },
];
const teamChats: TeamChatSummary[] = [
  {
    id: "c-ops", identifier: null, kind: "group", title: "Ops room", lastMessageAt: "2026-11-13T10:00:00.000Z",
    lastMessagePreview: "Standup at ten", unreadCount: 3, muted: false,
    members: [{ type: "user", id: "me", name: "Riley" }, { type: "agent", id: "mica", name: "Mica" }],
  },
  {
    id: "c-dm", identifier: null, kind: "direct", title: "DM", lastMessageAt: "2026-11-12T10:00:00.000Z",
    lastMessagePreview: "Lunch?", unreadCount: 5, muted: true,
    members: [{ type: "user", id: "me", name: "Riley" }, { type: "user", id: "sam", name: "Sam Okafor" }],
  },
];

function build(live: Record<string, (string | null)[]> = {}) {
  return buildConversations({
    agents,
    agentChats,
    teamChats,
    liveRuns: new Map(Object.entries(live)),
    currentUserId: "me",
    leadId: "everest",
    alwaysShowAgentIds: [],
    agentHref: (agent) => `/chats/${agent.id}`,
  });
}
const keys = (rows: readonly Conversation[]) => rows.map((row) => row.key);

describe("Messages conversations", () => {
  it("lists agent chats, team chats and the lead even before a first message; never removed agents", () => {
    const rows = build();
    expect(keys(rows).sort()).toEqual(["agent:everest", "agent:flint", "agent:mica", "chat:c-dm", "chat:c-ops"]);
    expect(rows.find((row) => row.key === "chat:c-dm")?.name).toBe("Sam Okafor");
    expect(rows.find((row) => row.key === "agent:everest")).toMatchObject({ issueId: null, lastMessageAt: null, unreadCount: 0 });
  });

  it("orders Everest first, then pins in pin order, then the newest message", () => {
    const ordered = orderConversations(build(), "agent:everest", ["chat:c-dm", "agent:mica"]);
    expect(keys(ordered)).toEqual(["agent:everest", "chat:c-dm", "agent:mica", "agent:flint", "chat:c-ops"]);
    expect(keys(orderConversations(build(), "agent:everest", []))).toEqual([
      "agent:everest", "agent:flint", "chat:c-ops", "agent:mica", "chat:c-dm",
    ]);
  });

  it("counts unread across conversations, leaving out muted ones", () => {
    expect(totalUnread(build())).toBe(5);
  });

  it("shows typing for a run in this conversation and the agent's other work", () => {
    const rows = build({ mica: ["i-mica", "other-task", null], flint: ["c-ops"] });
    expect(rows.find((row) => row.key === "agent:mica")).toMatchObject({ typing: true, workingOn: 3 });
    expect(rows.find((row) => row.key === "agent:flint")).toMatchObject({ typing: false, workingOn: 1 });
    expect(rows.find((row) => row.key === "chat:c-ops")?.typing).toBe(false);
    expect(build({ mica: ["c-ops"] }).find((row) => row.key === "chat:c-ops")?.typing).toBe(true);
    expect(conversationStatus({ kind: "agent", typing: false, workingOn: 3 })).toBe("Working on 3 tasks");
    expect(conversationStatus({ kind: "agent", typing: false, workingOn: 1 })).toBe("Working on 1 task");
    expect(conversationStatus({ kind: "agent", typing: true, workingOn: 1 })).toBe("Typing");
    expect(conversationStatus({ kind: "group", typing: false, workingOn: 0, members: teamChats[0]!.members })).toBe("2 members");
  });

  it("searches names and the newest message", () => {
    const rows = build();
    expect(keys(rows.filter((row) => matchesConversation(row, "standup")))).toEqual(["chat:c-ops"]);
    expect(keys(rows.filter((row) => matchesConversation(row, "SAM")))).toEqual(["chat:c-dm"]);
    expect(rows.filter((row) => matchesConversation(row, "  ")).length).toBe(rows.length);
  });

  it("shows the clock for today and a day name before that", () => {
    const now = new Date(2026, 10, 13, 15, 0);
    expect(formatConversationTime(new Date(2026, 10, 13, 9, 5).toISOString(), now)).toMatch(/09:05|9:05/);
    expect(formatConversationTime(new Date(2026, 10, 12, 9, 5).toISOString(), now)).toBe("Yesterday");
  });
});
