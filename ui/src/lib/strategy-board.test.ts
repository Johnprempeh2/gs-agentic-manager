import { describe, expect, it } from "vitest";
import { boardAssurance, defaultPackPeriod, meetingPackId, nextMeetingText, packFileName, readingAgeText, boardUpdateText } from "./strategy-board";

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

describe("defaultPackPeriod (monthly board)", () => {
  it("runs from the day after the last pack to the next meeting", () => {
    expect(defaultPackPeriod({ lastPackEnd: "2026-10-12", nextMeetingDate: "2026-11-09", today: "2026-10-20" })).toEqual({
      periodStart: "2026-10-13",
      periodEnd: "2026-11-09",
      title: "November 2026 board pack",
    });
  });

  it("goes one month back with no pack, and ends today with no meeting set", () => {
    expect(defaultPackPeriod({ lastPackEnd: null, nextMeetingDate: null, today: "2026-03-31" })).toEqual({
      periodStart: "2026-02-28",
      periodEnd: "2026-03-31",
      title: "March 2026 board pack",
    });
    expect(defaultPackPeriod({ lastPackEnd: null, nextMeetingDate: "2026-01-15", today: "2026-01-02" }).periodStart).toBe("2025-12-15");
  });

  it("falls back to one month when the last pack ends after the meeting", () => {
    expect(defaultPackPeriod({ lastPackEnd: "2026-11-20", nextMeetingDate: "2026-11-09", today: "2026-10-20" }).periodStart).toBe("2026-10-09");
  });
});

describe("nextMeetingText", () => {
  it("counts the days to the next meeting, and is null when none is set or it has passed", () => {
    expect(nextMeetingText("2026-11-09", "2026-10-20")).toBe("Next board meeting: 9 Nov (in 20 days)");
    expect(nextMeetingText("2026-10-21", "2026-10-20")).toBe("Next board meeting: 21 Oct (tomorrow)");
    expect(nextMeetingText("2026-10-20", "2026-10-20")).toBe("Next board meeting: 20 Oct (today)");
    expect(nextMeetingText("2026-10-01", "2026-10-20")).toBeNull();
    expect(nextMeetingText(null, "2026-10-20")).toBeNull();
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
