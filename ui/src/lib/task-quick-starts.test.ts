import { describe, expect, it } from "vitest";
import { TASK_QUICK_STARTS, firstPlaceholderRange } from "./task-quick-starts";

describe("task quick starts", () => {
  it("gives every quick start a title to fill in and a done-when line", () => {
    for (const quickStart of TASK_QUICK_STARTS) {
      expect(firstPlaceholderRange(quickStart.title)).not.toBeNull();
      expect(quickStart.description).toContain("## Done when");
    }
    expect(new Set(TASK_QUICK_STARTS.map((quickStart) => quickStart.id)).size).toBe(TASK_QUICK_STARTS.length);
  });

  it("finds the first placeholder", () => {
    expect(firstPlaceholderRange("Meeting brief: [who] on [date]")).toEqual({ start: 15, end: 20 });
    expect(firstPlaceholderRange("No blanks")).toBeNull();
  });
});
