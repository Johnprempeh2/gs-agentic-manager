import { describe, expect, it } from "vitest";
import type { CalendarItem } from "@greatstone/shared";
import { calendarIcsFileName, calendarToIcs, foldIcsLine, icsText } from "./calendar-ics";

function item(overrides: Partial<CalendarItem>): CalendarItem {
  return {
    kind: "task",
    id: "i1",
    date: "2026-10-31",
    title: "Send board pack",
    identifier: "GRE-7",
    status: "todo",
    closed: false,
    agentName: "Everest",
    goalTitle: null,
    times: [],
    runCount: 0,
    timeZone: null,
    ...overrides,
  };
}

const options = {
  calendarName: "Greatstone, calendar",
  itemUrl: (entry: CalendarItem) => `https://gsam.example/GRE/x/${entry.id}`,
  now: new Date("2026-10-15T23:00:00.000Z"),
};

describe("calendarToIcs", () => {
  it("writes an all-day event per open item", () => {
    const ics = calendarToIcs(
      [
        item({}),
        item({ kind: "routine", id: "r1", title: "Daily pulse", identifier: null, times: ["09:00"], runCount: 1, timeZone: "Europe/London" }),
        item({ kind: "goal", id: "g1", title: "Launch", identifier: null, closed: true }),
      ],
      options,
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("X-WR-CALNAME:Greatstone\\, calendar");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261031\r\nDTEND;VALUE=DATE:20261101");
    expect(ics).toContain("SUMMARY:Due: GRE-7 Send board pack");
    expect(ics).toContain("SUMMARY:Routine: Daily pulse");
    expect(ics).toContain("Runs at 09:00 (Europe/London)");
    expect(ics).toContain("DTSTAMP:20261015T230000Z");
    expect(ics).not.toContain("Launch");
  });

  it("keeps every line within 75 octets", () => {
    const ics = calendarToIcs([item({ title: "A very long task title ".repeat(10) })], options);
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
});

describe("ics helpers", () => {
  it("escapes text values", () => {
    expect(icsText("a,b;c\\d\ne")).toBe("a\\,b\;c\\\\d\\ne");
  });

  it("folds long lines and leaves short ones", () => {
    expect(foldIcsLine("SHORT:x")).toBe("SHORT:x");
    const folded = foldIcsLine(`SUMMARY:${"é".repeat(60)}`);
    expect(folded.split("\r\n ").join("")).toBe(`SUMMARY:${"é".repeat(60)}`);
  });

  it("names the file after the organisation and month", () => {
    expect(calendarIcsFileName("GRE", "2026-10")).toBe("gre-calendar-2026-10.ics");
    expect(calendarIcsFileName(null, "2026-10")).toBe("calendar-2026-10.ics");
  });
});
