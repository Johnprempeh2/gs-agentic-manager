import { describe, expect, it } from "vitest";
import { formatCalendarDay, formatDate, formatDateTime, formatShortDate, formatTime } from "./utils";

describe("formatDateTime", () => {
  // Local construction avoids assuming the test runner's timezone.
  const timestamp = new Date(2026, 8, 7, 13, 2, 54);

  it("uses British day-month order and the 24-hour clock", () => {
    expect(formatDateTime(timestamp)).toBe("7 Sept 2026, 13:02");
  });

  it("distinguishes activity in the same minute when seconds are requested", () => {
    expect(formatDateTime(timestamp, { includeSeconds: true })).toBe(
      "7 Sept 2026, 13:02:54",
    );
    expect(
      formatDateTime(new Date(2026, 8, 7, 13, 2, 55), { includeSeconds: true }),
    ).toBe("7 Sept 2026, 13:02:55");
  });

  it("formats serialized server timestamps identically to Date values", () => {
    expect(
      formatDateTime(timestamp.toISOString(), { includeSeconds: true }),
    ).toBe(formatDateTime(timestamp, { includeSeconds: true }));
  });
});

describe("British dates", () => {
  const timestamp = new Date(2026, 8, 30, 21, 28);

  it("puts the day before the month", () => {
    expect(formatDate(timestamp)).toBe("30 Sept 2026");
    expect(formatShortDate(timestamp)).toBe("30 Sept");
  });
});

describe("formatTime", () => {
  it("uses the 24-hour clock with seconds", () => {
    expect(formatTime(new Date(2026, 8, 7, 13, 2, 54))).toBe("13:02:54");
  });

  it("shows midnight as 00, not 24", () => {
    expect(formatTime(new Date(2026, 8, 7, 0, 5, 9))).toBe("00:05:09");
  });

  it("formats serialized server timestamps identically to Date values", () => {
    const timestamp = new Date(2026, 8, 7, 9, 4, 1);
    expect(formatTime(timestamp.toISOString())).toBe(formatTime(timestamp));
  });
});

describe("formatCalendarDay", () => {
  it("reads YYYY-MM-DD as the same calendar day in every time zone", () => {
    expect(formatCalendarDay("2026-10-01")).toBe("1 Oct");
    expect(formatCalendarDay("2026-12-31", { includeYear: true })).toBe("31 Dec 2026");
  });
});
