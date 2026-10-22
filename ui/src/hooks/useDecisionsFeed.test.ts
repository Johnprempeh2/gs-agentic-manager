import { describe, expect, it } from "vitest";
import { decisionsCountOf } from "./useDecisionsFeed";

describe("decisionsCountOf (one count everywhere)", () => {
  it("is the server's decisionCount, never the assigned tasks", () => {
    expect(decisionsCountOf({ decisionCount: 0 })).toBe(0);
    expect(decisionsCountOf({ decisionCount: 3 })).toBe(3);
  });
});
