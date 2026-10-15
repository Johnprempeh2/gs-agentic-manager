import { describe, expect, it } from "vitest";
import { teamChatAlertReason } from "./team-chat.js";

describe("teamChatAlertReason", () => {
  const john = { type: "user" as const, id: "john" };
  const reason = (recipientUserId: string, opts: { muted?: boolean; mentioned?: string[]; author?: Parameters<typeof teamChatAlertReason>[0]["author"] } = {}) =>
    teamChatAlertReason({ recipientUserId, author: opts.author ?? john, muted: opts.muted ?? false, mentionedUserIds: opts.mentioned ?? [] });

  it("alerts every other person in the chat", () => {
    expect(reason("ben")).toBe("message");
  });

  it("never alerts the author about their own message", () => {
    expect(reason("john")).toBeNull();
    expect(reason("john", { mentioned: ["john"] })).toBeNull();
  });

  it("stays quiet for a muted chat unless the person is @mentioned", () => {
    expect(reason("ben", { muted: true })).toBeNull();
    expect(reason("ben", { muted: true, mentioned: ["ben"] })).toBe("mention");
  });

  it("marks an @mention as a mention", () => {
    expect(reason("ben", { mentioned: ["ben"] })).toBe("mention");
    expect(reason("ann", { mentioned: ["ben"] })).toBe("message");
  });

  it("alerts people about agent messages but not system notices", () => {
    expect(reason("ben", { author: { type: "agent", id: "agent-1" } })).toBe("message");
    expect(reason("ben", { author: { type: "system", id: null } })).toBeNull();
  });
});
