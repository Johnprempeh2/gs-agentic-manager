import { describe, expect, it } from "vitest";
import type { IssueComment, TeamChatMember, TeamChatSummary } from "@greatstone/shared";
import { buildTeamChatAlert, teamChatForLiveComment, teamChatLabel, teamChatMentionOptions } from "./team-chats";

const members: TeamChatMember[] = [
  { type: "user", id: "me", name: "John" },
  { type: "user", id: "u-ben", name: "Ben" },
  { type: "agent", id: "a-atlas", name: "Atlas" },
];

describe("team chat mention picker", () => {
  it("offers only the chat's members, people and agents, never yourself", () => {
    expect(teamChatMentionOptions(members, "me")).toEqual([
      { id: "agent:a-atlas", name: "Atlas", kind: "agent", agentId: "a-atlas" },
      { id: "user:u-ben", name: "Ben", kind: "user", userId: "u-ben" },
    ]);
  });

  it("names a direct message after the other person", () => {
    expect(teamChatLabel({ kind: "direct", title: "Direct message", members: members.slice(0, 2) }, "me")).toBe("Ben");
    expect(teamChatLabel({ kind: "group", title: "Launch", members }, "me")).toBe("Launch");
  });
});

describe("team chat alerts", () => {
  // Ben is reading; John and Atlas write.
  const people: TeamChatMember[] = [
    { type: "user", id: "u-john", name: "John" },
    { type: "user", id: "u-ben", name: "Ben" },
    { type: "agent", id: "a-atlas", name: "Atlas" },
  ];
  const chat = (over: Partial<TeamChatSummary> = {}): TeamChatSummary => ({
    id: "chat-1", identifier: "GRE-9", kind: "group", title: "Launch", members: people,
    lastMessageAt: null, unreadCount: 0, muted: false, ...over,
  });
  const live = (over: Record<string, unknown> = {}) => ({
    action: "issue.comment_added", entityType: "issue", entityId: "chat-1",
    actorType: "user", actorId: "u-john", details: { commentId: "c1", teamChat: true }, ...over,
  });
  const comment = (body: string, author: Partial<IssueComment> = { authorUserId: "u-john", authorType: "user" }) =>
    ({ id: "c1", issueId: "chat-1", body, authorAgentId: null, authorUserId: null, ...author }) as IssueComment;

  it("picks up messages from others in a chat the reader is in", () => {
    expect(teamChatForLiveComment(live(), [chat()], "u-ben")).toEqual({ chat: chat(), commentId: "c1" });
  });

  it("ignores the reader's own messages, system notices, other chats and ordinary issues", () => {
    expect(teamChatForLiveComment(live({ actorId: "u-ben" }), [chat()], "u-ben")).toBeNull();
    expect(teamChatForLiveComment(live({ actorType: "system", actorId: "team_chat" }), [chat()], "u-ben")).toBeNull();
    expect(teamChatForLiveComment(live({ entityId: "chat-2" }), [chat()], "u-ben")).toBeNull();
    expect(teamChatForLiveComment(live({ details: { commentId: "c1" } }), [chat()], "u-ben")).toBeNull();
  });

  it("names the sender and chat, and quotes the message", () => {
    expect(buildTeamChatAlert(chat(), comment("Ship **today**"), "u-ben")).toEqual({
      reason: "message", title: "John in Launch", body: "Ship today",
    });
    expect(buildTeamChatAlert(chat({ kind: "direct" }), comment("lunch?"), "u-ben")?.title).toBe("John");
    expect(buildTeamChatAlert(chat(), comment("done", { authorAgentId: "a-atlas", authorType: "agent" }), "u-ben")?.title).toBe("Atlas in Launch");
  });

  it("stays quiet in a muted chat unless the reader is @mentioned", () => {
    expect(buildTeamChatAlert(chat({ muted: true }), comment("anyone?"), "u-ben")).toBeNull();
    expect(buildTeamChatAlert(chat({ muted: true }), comment("[@Ben](user://u-ben) you?"), "u-ben")).toEqual({
      reason: "mention", title: "John mentioned you in Launch", body: "@Ben you?",
    });
  });
});
