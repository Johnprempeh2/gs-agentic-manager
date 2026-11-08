import { describe, expect, it } from "vitest";
import { describePageChanges } from "./page-changes.js";

const page = (content: unknown[], root: Record<string, unknown> = {}) => JSON.stringify({ root: { props: root }, content });

describe("describePageChanges", () => {
  it("names added, edited, removed and reordered sections", () => {
    const live = page([
      { type: "Hero", props: { id: "a", title: "Old" } },
      { type: "Cards", props: { id: "b", title: "Work" } },
      { type: "Quote", props: { id: "c", text: "x" } },
    ]);
    const next = page([
      { type: "Cards", props: { id: "b", title: "Work" } },
      { type: "Hero", props: { id: "a", title: "New" } },
      { type: "Cta", props: { id: "d", heading: "Talk to us" } },
    ], { title: "Home" });
    expect(describePageChanges(live, next)).toEqual({
      lines: ["Page settings: title", "Edited Hero \"New\": title", "Added Cta \"Talk to us\"", "Removed Quote", "Sections reordered"],
      firstChangedBlockId: "a",
    });
  });

  it("reads a page with nothing live as new, and no change as empty", () => {
    expect(describePageChanges(null, page([])).lines).toEqual(["New page: not on the live site yet"]);
    expect(describePageChanges(page([]), page([])).lines).toEqual([]);
  });
});
