import { describe, expect, it } from "vitest";
import { boardAssurance, packFileName, previousQuarter, readingAgeText } from "./strategy-board";

describe("boardAssurance", () => {
  it("is strong only for a fresh checked or system reading", () => {
    expect(boardAssurance({ latestReadingSource: "agent_verified", readingAgeDays: 3 })).toBe("strong");
    expect(boardAssurance({ latestReadingSource: "system", readingAgeDays: 14 })).toBe("strong");
    expect(boardAssurance({ latestReadingSource: "system", readingAgeDays: 20 })).toBe("moderate");
  });

  it("is weak for an owner's own number, an old number or no number", () => {
    expect(boardAssurance({ latestReadingSource: "owner_reported", readingAgeDays: 0 })).toBe("weak");
    expect(boardAssurance({ latestReadingSource: "agent_verified", readingAgeDays: 31 })).toBe("weak");
    expect(boardAssurance({ latestReadingSource: null, readingAgeDays: null })).toBe("weak");
  });
});

describe("previousQuarter", () => {
  it("gives the last full quarter, across a year end", () => {
    expect(previousQuarter(new Date("2026-10-10T12:00:00Z"))).toEqual({ periodStart: "2026-07-01", periodEnd: "2026-09-30", label: "Q3 2026" });
    expect(previousQuarter(new Date("2026-02-01T12:00:00Z"))).toEqual({ periodStart: "2025-10-01", periodEnd: "2025-12-31", label: "Q4 2025" });
  });
});

describe("text helpers", () => {
  it("says how old a reading is and makes a safe file name", () => {
    expect(readingAgeText(null)).toBe("no reading");
    expect(readingAgeText(0)).toBe("today");
    expect(readingAgeText(1)).toBe("1 day old");
    expect(readingAgeText(18)).toBe("18 days old");
    expect(packFileName("Q3 2026 board pack!")).toBe("q3-2026-board-pack.md");
  });
});
