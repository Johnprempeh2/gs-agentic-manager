import { describe, expect, it } from "vitest";
import { mergeSectionOrder, moveSection } from "./sidebar-section-order";

const DEFAULTS = ["work", "team", "build", "company"];

describe("mergeSectionOrder", () => {
  it("uses the default order when nothing is saved", () => {
    expect(mergeSectionOrder(DEFAULTS, [])).toEqual(DEFAULTS);
  });

  it("keeps the saved order and drops removed or duplicate ids", () => {
    expect(mergeSectionOrder(DEFAULTS, ["company", "gone", "work", "company", "build", "team"]))
      .toEqual(["company", "work", "build", "team"]);
  });

  it("places a new section in its default slot", () => {
    const withNew = ["work", "team", "insights", "build", "company"];
    expect(mergeSectionOrder(withNew, ["company", "build", "team", "work"]))
      .toEqual(["company", "build", "team", "insights", "work"]);
    expect(mergeSectionOrder(["first", ...DEFAULTS], ["team", "work", "build", "company"]))
      .toEqual(["first", "team", "work", "build", "company"]);
  });
});

describe("moveSection", () => {
  it("swaps with the neighbour and ignores moves past the ends", () => {
    expect(moveSection(DEFAULTS, "team", -1)).toEqual(["team", "work", "build", "company"]);
    expect(moveSection(DEFAULTS, "work", -1)).toEqual(DEFAULTS);
    expect(moveSection(DEFAULTS, "company", 1)).toEqual(DEFAULTS);
  });
});
