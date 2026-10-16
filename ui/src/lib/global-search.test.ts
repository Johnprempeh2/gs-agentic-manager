import { describe, expect, it } from "vitest";
import { plainTaskStatus, rankByText, scoreTextMatch } from "./global-search";

describe("global search helpers", () => {
  it("says task status in plain words", () => {
    expect(plainTaskStatus("in_progress")).toBe("Being worked on");
    expect(plainTaskStatus("blocked")).toBe("Stuck");
    expect(plainTaskStatus("in_review")).toBe("Waiting for review");
  });

  it("needs every word to match somewhere", () => {
    expect(scoreTextMatch("indago pitch", ["Indago Capital", "pitch deck"])).not.toBeNull();
    expect(scoreTextMatch("indago pitch", ["Indago Capital", null])).toBeNull();
  });

  it("ranks title matches above description matches", () => {
    const items = [
      { title: "Weekly report", description: "covers indago" },
      { title: "Indago kick-off", description: null },
    ];
    expect(rankByText(items, "indago", (item) => [item.title, item.description], 5).map((item) => item.title)).toEqual([
      "Indago kick-off",
      "Weekly report",
    ]);
  });
});
