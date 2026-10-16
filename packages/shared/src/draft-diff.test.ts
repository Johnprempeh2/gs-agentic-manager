import { describe, expect, it } from "vitest";
import { describeDraftEdit, diffDraftWords } from "./draft-diff.js";

describe("diffDraftWords", () => {
  it("reports no changes for identical text", () => {
    const diff = diffDraftWords("Hello Indago team", "Hello Indago team");
    expect(diff.changeCount).toBe(0);
    expect(diff.segments).toEqual([{ type: "same", text: "Hello Indago team" }]);
    expect(describeDraftEdit(diff)).toBe("No changes.");
  });

  it("counts a replaced word as one change and keeps the rest", () => {
    const diff = diffDraftWords("Dear Martyn, thanks for the call", "Hi Martyn, thanks for the call");
    expect(diff.changeCount).toBe(1);
    expect(diff.removedWords).toBe(1);
    expect(diff.addedWords).toBe(1);
    expect(diff.segments[0]).toEqual({ type: "removed", text: "Dear" });
    expect(diff.segments[1]).toEqual({ type: "added", text: "Hi" });
    // The rebuilt sides match the inputs exactly.
    const rebuild = (skip: "added" | "removed") =>
      diff.segments.filter((segment) => segment.type !== skip).map((segment) => segment.text).join("");
    expect(rebuild("added")).toBe("Dear Martyn, thanks for the call");
    expect(rebuild("removed")).toBe("Hi Martyn, thanks for the call");
  });

  it("counts separate edits separately", () => {
    const diff = diffDraftWords("one two three four five", "one 2 three four 5 six");
    expect(diff.changeCount).toBe(2);
    expect(describeDraftEdit(diff)).toBe("2 changes, 2 words removed, 3 words added.");
  });

  it("treats a very long draft as one replacement", () => {
    const long = Array.from({ length: 2_500 }, (_, index) => `w${index}`).join(" ");
    const diff = diffDraftWords(long, `${long} extra`);
    expect(diff.changeCount).toBe(1);
  });
});
