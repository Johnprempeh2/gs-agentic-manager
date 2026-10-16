import { describe, expect, it } from "vitest";
import type { CalendarItem } from "@greatstone/shared";
import { calendarItemHref, dayTitle, isOverdue, monthGrid, monthTitle, routineTimesLabel, shiftMonth } from "./calendar";

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
