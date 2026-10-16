import { describe, expect, it } from "vitest";
import { isUnblockExpectedByPassed, needsUnblockWaitingDateWake, utcCalendarDay } from "./unblock-waiting.js";

const on = (iso: string) => new Date(iso);

describe("waiting on someone until a date", () => {
  it("reads today as the UTC calendar day", () => {
    expect(utcCalendarDay(on("2026-10-20T23:30:00Z"))).toBe("2026-10-20");
  });

  it("is not passed before or during the expected day, and is passed the day after", () => {
    const descriptor = { expectedBy: "2026-10-20" };
    expect(isUnblockExpectedByPassed(descriptor, on("2026-10-19T12:00:00Z"))).toBe(false);
    expect(isUnblockExpectedByPassed(descriptor, on("2026-10-20T23:59:59Z"))).toBe(false);
    expect(isUnblockExpectedByPassed(descriptor, on("2026-10-21T00:00:00Z"))).toBe(true);
  });

  it("is never passed without a date", () => {
    expect(isUnblockExpectedByPassed(null, on("2030-01-01T00:00:00Z"))).toBe(false);
    expect(isUnblockExpectedByPassed({ waitingOn: "client" }, on("2030-01-01T00:00:00Z"))).toBe(false);
    expect(isUnblockExpectedByPassed({ expectedBy: "soon" }, on("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("is due once per date: not again for the same date, again for a new date", () => {
    const now = on("2026-10-22T09:00:00Z");
    expect(needsUnblockWaitingDateWake({ expectedBy: "2026-10-20" }, now)).toBe(true);
    expect(needsUnblockWaitingDateWake({ expectedBy: "2026-10-20", expectedByWokenFor: "2026-10-20" }, now)).toBe(false);
    expect(needsUnblockWaitingDateWake({ expectedBy: "2026-10-21", expectedByWokenFor: "2026-10-20" }, now)).toBe(true);
    expect(needsUnblockWaitingDateWake({ expectedBy: "2026-10-25", expectedByWokenFor: "2026-10-20" }, now)).toBe(false);
  });
});
