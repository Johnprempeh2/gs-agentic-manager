import { describe, expect, it } from "vitest";
import type { TeamChatMember } from "@greatstone/shared";
import { teamChatLabel, teamChatMentionOptions } from "./team-chats";

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
