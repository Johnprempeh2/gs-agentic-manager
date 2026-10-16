import { describe, expect, it } from "vitest";
import type { CalendarItem } from "@greatstone/shared";
import { calendarItemHref, canReschedule, rescheduleOptions, weekOf, weekTitle, dayTitle, isOverdue, monthGrid, monthTitle, routineTimesLabel, shiftMonth } from "./calendar";

function item(overrides: Partial<CalendarItem>): CalendarItem {
  return {
    kind: "task",
    id: "id-1",
    date: "2026-10-20",
    title: "Send the proposal",
    identifier: "GRE-1",
    status: "todo",
    closed: false,
    agentName: null,
    goalTitle: null,
    times: [],
    runCount: 0,
    timeZone: null,
    ...overrides,
  };
}

describe("calendar helpers", () => {
  it("finds the Monday to Sunday week of a day and names it", () => {
    expect(weekOf("2026-10-16")).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
    expect(weekOf("2026-10-12")[0]).toBe("2026-10-12");
    expect(weekOf("2026-10-18")[0]).toBe("2026-10-12");
    expect(weekTitle(weekOf("2026-10-16"))).toBe("12 to 18 October 2026");
    expect(weekTitle(weekOf("2026-10-01"))).toBe("28 September to 4 October 2026");
    expect(weekTitle(weekOf("2026-12-31"))).toBe("28 December 2026 to 3 January 2027");
  });

  it("offers today, tomorrow and next Monday, without the current day", () => {
    // 2026-10-16 is a Friday.
    expect(rescheduleOptions("2026-10-10", "2026-10-16")).toEqual([
      { label: "Today", date: "2026-10-16" },
      { label: "Tomorrow", date: "2026-10-17" },
      { label: "Next Monday", date: "2026-10-19" },
    ]);
    expect(rescheduleOptions("2026-10-16", "2026-10-16").map((option) => option.label)).toEqual(["Tomorrow", "Next Monday"]);
    // On a Sunday, tomorrow is next Monday, so it shows once.
    expect(rescheduleOptions("2026-10-01", "2026-10-18")).toEqual([
      { label: "Today", date: "2026-10-18" },
      { label: "Tomorrow", date: "2026-10-19" },
    ]);
    // On a Monday, next Monday is a week away.
    expect(rescheduleOptions("2026-10-01", "2026-10-19").at(-1)).toEqual({ label: "Next Monday", date: "2026-10-26" });
  });

  it("lets only open tasks move to another day", () => {
    expect(canReschedule(item({}))).toBe(true);
    expect(canReschedule(item({ closed: true }))).toBe(false);
    expect(canReschedule(item({ kind: "routine" }))).toBe(false);
    expect(canReschedule(item({ kind: "goal" }))).toBe(false);
  });

  it("lays a month out in whole weeks, Monday first", () => {
    const weeks = monthGrid("2026-10");
    expect(weeks[0]![0]).toBe("2026-09-28");
    expect(weeks.at(-1)![6]).toBe("2026-11-01");
    expect(weeks).toHaveLength(5);
    expect(monthGrid("2026-02").flat()).toContain("2026-02-28");
  });

  it("moves between months across a year end", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthTitle("2026-10")).toBe("October 2026");
    expect(dayTitle("2026-10-20")).toBe("Tuesday 20 October");
  });

  it("marks only open tasks and goals with a past date as overdue", () => {
    expect(isOverdue(item({ date: "2026-10-14" }), "2026-10-15")).toBe(true);
    expect(isOverdue(item({ date: "2026-10-14", closed: true }), "2026-10-15")).toBe(false);
    expect(isOverdue(item({ date: "2026-10-15" }), "2026-10-15")).toBe(false);
    expect(isOverdue(item({ kind: "routine", date: "2026-10-14" }), "2026-10-15")).toBe(false);
  });

  it("links each kind to its page", () => {
    expect(calendarItemHref(item({}))).toBe("/issues/GRE-1");
    expect(calendarItemHref(item({ kind: "routine", id: "r1" }))).toBe("/routines/r1");
    expect(calendarItemHref(item({ kind: "goal", id: "g1" }))).toBe("/goals/g1");
  });

  it("describes routine run times in plain words", () => {
    const run = item({ kind: "routine", times: ["09:00"], runCount: 1, timeZone: "Europe/London" });
    expect(routineTimesLabel(run, "Europe/London")).toBe("Runs at 09:00");
    expect(routineTimesLabel(run, "Africa/Accra")).toBe("Runs at 09:00 (Europe/London)");
    expect(routineTimesLabel({ ...run, times: ["08:00", "12:00", "17:00"], runCount: 3 }, "Europe/London")).toBe(
      "Runs at 08:00, 12:00 and 17:00",
    );
    expect(routineTimesLabel({ ...run, times: ["00:00"], runCount: 24 }, "Europe/London")).toBe("Runs 24 times");
  });
});
