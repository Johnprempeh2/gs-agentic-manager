import { describe, expect, it } from "vitest";
import { buildClosedCardAgentMessage, closedCardMakersToWake, closedCardQuestion } from "./closed-card-wake.js";

describe("closedCardMakersToWake", () => {
  const cards = [
    { id: "c1", createdByAgentId: "ridge" },
    { id: "c2", createdByAgentId: "keystone" },
    { id: "c3", createdByAgentId: null },
  ];

  it("wakes the maker when another agent closes the task", () => {
    expect(closedCardMakersToWake(cards, { agentId: "keystone" })).toEqual([{ interactionId: "c1", agentId: "ridge" }]);
  });

  it("wakes every agent maker when the system closes the task", () => {
    expect(closedCardMakersToWake(cards, {})).toEqual([
      { interactionId: "c1", agentId: "ridge" },
      { interactionId: "c2", agentId: "keystone" },
    ]);
  });

  it("wakes no one when a person closes the task", () => {
    expect(closedCardMakersToWake(cards, { userId: "john" })).toEqual([]);
  });
});

describe("closedCardQuestion", () => {
  it("prefers the title, then the prompt, then the first question", () => {
    expect(closedCardQuestion({ title: "Remove 3 holds", payload: { prompt: "x" } } as never)).toBe("Remove 3 holds");
    expect(closedCardQuestion({ title: null, payload: { prompt: "Send it?" } } as never)).toBe("Send it?");
    expect(closedCardQuestion({ title: null, payload: { questions: [{ prompt: "Which tone?" }] } } as never)).toBe("Which tone?");
    expect(closedCardQuestion({ title: null, payload: {} } as never)).toBeNull();
  });
});

describe("buildClosedCardAgentMessage", () => {
  it("names the card, the task and who closed it", () => {
    const text = buildClosedCardAgentMessage({ question: "Remove 3 holds", issueLabel: "GRE-1560", closerName: "Keystone" });
    expect(text).toContain('Your card "Remove 3 holds" on GRE-1560 expired before anyone answered it.');
    expect(text).toContain("Keystone closed GRE-1560");
    expect(text).toContain("ask again with a new card on a task that is still open");
  });
});
