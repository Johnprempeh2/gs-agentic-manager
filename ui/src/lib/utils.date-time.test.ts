import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatShortDate } from "./utils";

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
