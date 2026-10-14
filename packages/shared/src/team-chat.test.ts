import { describe, expect, it } from "vitest";
import { directMessageOriginId, teamChatAgentHops } from "./team-chat.js";

const user = { authorType: "user" as const, mentionsAgent: true };
const agentHop = { authorType: "agent" as const, mentionsAgent: true };
const agentReply = { authorType: "agent" as const, mentionsAgent: false };
const system = { authorType: "system" as const, mentionsAgent: false };

describe("teamChatAgentHops", () => {
  it("counts agent mentions since the last person, ignoring replies and notices", () => {
    expect(teamChatAgentHops([])).toBe(0);
    expect(teamChatAgentHops([user])).toBe(0);
    expect(teamChatAgentHops([user, agentHop, agentReply, system, agentHop])).toBe(2);
    expect(teamChatAgentHops([agentHop, agentHop, user, agentHop])).toBe(1);
  });

  it("names a direct message the same way from either side", () => {
    expect(directMessageOriginId("b", "a")).toBe(directMessageOriginId("a", "b"));
  });
});
