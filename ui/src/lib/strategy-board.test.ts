import { describe, expect, it } from "vitest";
import { boardAssurance, meetingPackId, packFileName, previousQuarter, readingAgeText, boardUpdateText } from "./strategy-board";

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

describe("meetingPackId", () => {
  it("is the newest accepted pack; a newer draft does not replace it", () => {
    expect(meetingPackId([
      { id: "draft", status: "draft", createdAt: new Date("2026-10-09") },
      { id: "q3", status: "accepted", createdAt: new Date("2026-10-01") },
      { id: "q2", status: "accepted", createdAt: new Date("2026-07-01") },
    ])).toBe("q3");
  });

  it("is null when there are only drafts or no packs", () => {
    expect(meetingPackId([{ id: "draft", status: "draft", createdAt: new Date("2026-10-09") }])).toBeNull();
    expect(meetingPackId([])).toBeNull();
  });
});

describe("boardUpdateText", () => {
  it("gives the headline, the KPIs needing attention and overdue actions", () => {
    const text = boardUpdateText(
      {
        asOf: "2026-10-16",
        attention: [
          { title: "Revenue", status: "red", gapPercent: 12.4, owner: { type: "user", id: "u", name: "John" } },
          { title: "NPS", status: null, gapPercent: null, owner: null, notMeasuredReason: "No reading yet" },
        ] as never,
        overdueActions: [{ title: "Hire a sales lead", daysOverdue: 5, owner: { type: "agent", id: "a", name: "Ridge" } }] as never,
      },
      "On course 2 · Watch 1 · Off course 1",
    );
    expect(text.split("\n")).toEqual([
      "Board update, as of 16 Oct",
      "On course 2 · Watch 1 · Off course 1",
      "",
      "Needs board attention",
      "• Revenue: Off course, 12% behind plan, John",
      "• NPS: Not measured (no reading yet), No owner",
      "",
      "Overdue actions",
      "• Hire a sales lead: 5 days overdue, Ridge",
    ]);
  });
});
