import { describe, expect, it } from "vitest";
import { toQueue } from "../services/decision-queues.js";

type QueueRow = Parameters<typeof toQueue>[0];

function queueRow(overrides: Partial<QueueRow>): QueueRow {
  return {
    id: "queue-1",
    companyId: "company-1",
    key: "questions",
    title: "Questions",
    description: "Structured questions waiting for a board response.",
    createdByType: "system",
    createdByAgentId: null,
    createdByUserId: null,
    createdByRunId: null,
    retentionDays: null,
    seedRules: [{
      key: "ask-user-questions",
      signal: "ask_user_questions",
      description: "Pending ask_user_questions interactions.",
    }],
    seedRulesEnabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as QueueRow;
}

describe("decision queue copy", () => {
  it("shows today's plain wording on queues seeded before the copy changed", () => {
    const queue = toQueue(queueRow({}), 0);
    expect(queue.description).toBe("Questions agents asked you.");
    expect(queue.seedRules.map((rule) => rule.description)).toEqual([
      "Questions an agent is waiting for you to answer.",
    ]);
  });

  it("keeps a description edited on a seeded queue", () => {
    const queue = toQueue(queueRow({ description: "Anything Ben needs to answer" }), 0);
    expect(queue.description).toBe("Anything Ben needs to answer");
  });

  it("keeps the owner's own wording on a queue they created", () => {
    const queue = toQueue(queueRow({ createdByType: "user", description: "My shortlist" }), 0);
    expect(queue.description).toBe("My shortlist");
  });
});
