import { describe, expect, it } from "vitest";
import { morningSummaryText } from "./morning-summary-text";

describe("morningSummaryText", () => {
  it("writes each section with counts, late items and what is left over", () => {
    const text = morningSummaryText(
      {
        needsYou: { count: 3, items: [{ id: "1", identifier: "GRE-12", title: "Approve the hire" }] },
        dueToday: { count: 1, items: [{ id: "2", identifier: null, title: "Send the deck", dueDate: "2026-10-14" }] },
        finished: { count: 0, items: [] },
        stuck: { count: 0, items: [] },
      },
      "2026-10-16",
    );
    expect(text.split("\n")).toEqual([
      "Today, 16 Oct",
      "",
      "Needs me (3)",
      "• GRE-12 Approve the hire",
      "• and 2 more",
      "",
      "Due today (1)",
      "• Send the deck, late, due 14 Oct",
      "",
      "Finished since yesterday: nothing yet",
      "",
      "Stuck: nothing",
    ]);
  });
});
