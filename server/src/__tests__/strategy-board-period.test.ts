import { describe, expect, it } from "vitest";
import {
  addMonths,
  boardPeriodView,
  calendarMonthPeriod,
  chairAlertPeriod,
  nextBoardPeriod,
  periodLabel,
} from "../services/strategy-board-period.js";

describe("board period dates (GRE-3472)", () => {
  it("adds months and clamps to the month's end", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-01", 3)).toBe("2027-02-01");
  });

  it("rolls over to the next period from the day after the old end", () => {
    const stored = { periodStart: "2026-10-01", periodEnd: "2026-10-31", periodMonths: 1 };
    expect(nextBoardPeriod(stored, "2026-10-31")).toBeNull();
    expect(nextBoardPeriod(stored, "2026-11-01")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(nextBoardPeriod({ ...stored, periodMonths: 3 }, "2026-11-05")).toEqual({ start: "2026-11-01", end: "2027-01-31" });
    // Missed periods are skipped to the one holding today.
    expect(nextBoardPeriod(stored, "2027-01-10")).toEqual({ start: "2027-01-01", end: "2027-01-31" });
  });

  it("does not roll over without a period length; the period shows as ended", () => {
    const stored = { periodStart: "2026-10-01", periodEnd: "2026-10-31", periodMonths: null };
    expect(nextBoardPeriod(stored, "2026-11-15")).toBeNull();
    expect(boardPeriodView(stored, "2026-11-15")).toEqual({ start: "2026-10-01", end: "2026-10-31", ended: true });
    expect(chairAlertPeriod(stored, "2026-11-15")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
  });

  it("groups chair alerts by calendar month when no period is set", () => {
    const none = { periodStart: null, periodEnd: null, periodMonths: null };
    expect(boardPeriodView(none, "2026-02-10")).toBeNull();
    expect(chairAlertPeriod(none, "2026-02-10")).toEqual(calendarMonthPeriod("2026-02-10"));
    expect(calendarMonthPeriod("2026-02-10")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });

  it("labels a period for task titles", () => {
    expect(periodLabel({ start: "2026-10-01", end: "2026-10-31" })).toBe("1 Oct to 31 Oct 2026");
    expect(periodLabel({ start: "2026-12-01", end: "2027-02-28" })).toBe("1 Dec 2026 to 28 Feb 2027");
  });
});
