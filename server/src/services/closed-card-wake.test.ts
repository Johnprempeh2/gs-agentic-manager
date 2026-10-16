import { describe, expect, it, vi } from "vitest";
import {
  buildClosedCardAgentMessage,
  buildExpiredCardAgentMessage,
  closedCardMakersToWake,
  closedCardQuestion,
  expiredCardMakersToWake,
  wakeMakersOfExpiredCards,
} from "./closed-card-wake.js";

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

describe("expiredCardMakersToWake", () => {
  const card = (id: string, maker: string | null, result: unknown, kind = "request_confirmation") =>
    ({ id, kind, status: "expired", result, createdByAgentId: maker }) as never;

  it("wakes the maker when a person's comment expires its card on someone else's task", () => {
    const cards = [card("c1", "ridge", { outcome: "superseded_by_comment", commentId: "m1" })];
    expect(expiredCardMakersToWake(cards, { assigneeAgentId: "keystone" })).toEqual([
      { interactionId: "c1", agentId: "ridge", cause: "comment" },
    ]);
  });

  it("leaves the assignee to the comment wake it already gets", () => {
    const cards = [card("c1", "ridge", { expirationReason: "superseded_by_comment" }, "ask_user_questions")];
    expect(expiredCardMakersToWake(cards, { assigneeAgentId: "ridge" })).toEqual([]);
  });

  it("wakes the maker when another agent's document edit makes its card stale", () => {
    const cards = [card("c1", "ridge", { outcome: "stale_target" })];
    expect(expiredCardMakersToWake(cards, { actorAgentId: "keystone", assigneeAgentId: "ridge" })).toEqual([
      { interactionId: "c1", agentId: "ridge", cause: "stale_target" },
    ]);
  });

  it("does not wake a maker that expired or replaced its own card", () => {
    expect(expiredCardMakersToWake([card("c1", "ridge", { outcome: "stale_target" })], { actorAgentId: "ridge" })).toEqual([]);
    expect(expiredCardMakersToWake([card("c2", "ridge", { outcome: "superseded_by_newer_request" })], {})).toEqual([]);
    expect(
      expiredCardMakersToWake(
        [card("c3", "ridge", { expirationReason: "superseded_by_newer_interaction" }, "ask_user_questions")],
        {},
      ),
    ).toEqual([]);
  });

  it("leaves closed-task cards to the close wake, and skips cards with no agent maker", () => {
    expect(expiredCardMakersToWake([card("c1", "ridge", { outcome: "issue_closed" })], {})).toEqual([]);
    expect(expiredCardMakersToWake([card("c2", null, { outcome: "stale_target" })], {})).toEqual([]);
  });
});

describe("wakeMakersOfExpiredCards", () => {
  const issue = { id: "i1", companyId: "co", identifier: "GRE-1", status: "todo", assigneeAgentId: "keystone" };
  const interaction = {
    id: "c1",
    kind: "request_confirmation",
    status: "expired",
    title: "Publish the plan?",
    payload: {},
    result: { outcome: "stale_target" },
    createdByAgentId: "ridge",
  } as never;

  it("wakes the maker once per card with reason interaction_expired", async () => {
    const wakeup = vi.fn(async () => ({}));
    const woken = await wakeMakersOfExpiredCards({ wakeup }, { issue, interactions: [interaction], source: "test" });
    expect(woken).toBe(1);
    expect(wakeup).toHaveBeenCalledWith(
      "ridge",
      expect.objectContaining({
        reason: "interaction_expired",
        idempotencyKey: "interaction:c1:expired",
        payload: expect.objectContaining({ interactionId: "c1", expiredCardIssueId: "i1" }),
      }),
    );
  });

  it("wakes no one on a closed task, and a failed wake does not throw", async () => {
    const wakeup = vi.fn(async () => {
      throw new Error("down");
    });
    const closed = { ...issue, status: "done" };
    expect(await wakeMakersOfExpiredCards({ wakeup }, { issue: closed, interactions: [interaction], source: "test" })).toBe(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(await wakeMakersOfExpiredCards({ wakeup }, { issue, interactions: [interaction], source: "test" })).toBe(0);
  });
});

describe("buildExpiredCardAgentMessage", () => {
  it("says why the card expired and what to do", () => {
    const text = buildExpiredCardAgentMessage({ question: "Which tone?", issueLabel: "GRE-1", cause: "comment" });
    expect(text).toContain('Your card "Which tone?" on GRE-1 expired.');
    expect(text).toContain("Read their comment");
    expect(text).toContain("do not act as if it was");
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
