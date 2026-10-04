import { describe, expect, it } from "vitest";
import { decisionsCountOf } from "./useDecisionsFeed";

describe("decisionsCountOf (GRE-586)", () => {
  it("leaves tasks assigned to the user out of the Decisions count", () => {
    expect(decisionsCountOf({ count: 2, assignedTaskCount: 2 })).toBe(0);
  });

  it("keeps decision cards and overdue waits", () => {
    // 1 card + 2 overdue waits + 3 assigned tasks.
    expect(decisionsCountOf({ count: 6, assignedTaskCount: 3 })).toBe(3);
  });
});
