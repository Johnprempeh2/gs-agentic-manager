import { describe, expect, it } from "vitest";
import type { CalendarItem } from "@greatstone/shared";
import { weekAheadText } from "./calendar-text";

function item(overrides: Partial<CalendarItem>): CalendarItem {
  return {
    kind: "task",
    id: "t1",
    date: "2026-10-16",
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

describe("weekAheadText", () => {
  it("lists open items by day for the next seven days", () => {
    const text = weekAheadText(
      [
        item({ agentName: "Ridge" }),
        item({ id: "done", title: "Old thing", closed: true }),
        item({
          kind: "routine",
          id: "r1",
          date: "2026-10-16",
          title: "Market brief",
          identifier: null,
          times: ["16:30"],
          runCount: 1,
          timeZone: "Europe/London",
        }),
        item({ kind: "goal", id: "g1", date: "2026-10-20", title: "Launch", identifier: null }),
        item({ id: "late", date: "2026-10-23", title: "Too far" }),
      ],
      { from: "2026-10-16", timeZone: "Europe/London" },
    );
    expect(text).toBe(
      [
        "The week ahead, Friday 16 October to Thursday 22 October",
        "Friday 16 October\n• Due: GRE-1 Send the proposal (Ridge)\n• Market brief: runs at 16:30",
        "Tuesday 20 October\n• Goal date: Launch",
      ].join("\n\n"),
    );
  });

  it("says so when nothing is on", () => {
    expect(weekAheadText([], { from: "2026-10-16" })).toBe(
      "The week ahead, Friday 16 October to Thursday 22 October\n\nNothing is scheduled.",
    );
  });
});
