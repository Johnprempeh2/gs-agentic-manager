import { describe, expect, it } from "vitest";
import { WEEKLY_REPORT_FIXTURE as report } from "./weekly-report.fixture";
import { pipelineSummary, stuckForLabel, weeklyHeadline, weeklyReportFileName, weeklyReportPdf, weeklyReportSections } from "./weekly-report";

describe("weekly report wording", () => {
  it("sums the week up in plain sentences", () => {
    expect(weeklyHeadline(report)).toBe(
      "The agents finished 3 tasks. 2 tasks are stuck, the longest for 9 days. Client pipeline: 1 new, 2 moves, 1 won. 6 things need you. Recorded spend was $13.00.",
    );
  });

  it("says when it was a quiet week", () => {
    const quiet = {
      ...report,
      finished: { count: 0, agents: [] },
      stuck: { count: 0, items: [] },
      pipeline: { added: 0, moved: 0, won: 0, lost: 0, moves: [] },
      needsYou: { count: 0, items: [] },
      costs: { totalCents: 0, agents: [] },
    };
    expect(weeklyHeadline(quiet)).toBe("No tasks were finished this week. Nothing is stuck. Nothing needs you.");
    expect(pipelineSummary(quiet.pipeline)).toBe("No changes in the client pipeline this week.");
    expect(weeklyReportSections(quiet).find((section) => section.title === "Cost by agent")?.lines).toEqual(["No spend was recorded this week."]);
  });

  it("says how long a task has been stuck", () => {
    expect(stuckForLabel("2026-10-10T07:00:00.000Z", "2026-10-19T07:00:00.000Z")).toBe("stuck for 9 days");
    expect(stuckForLabel("2026-10-18T06:00:00.000Z", "2026-10-19T07:00:00.000Z")).toBe("stuck for 1 day");
    expect(stuckForLabel("2026-10-19T05:00:00.000Z", "2026-10-19T07:00:00.000Z")).toBe("stuck since today");
  });

  it("lists each section, with a count of what it leaves out", () => {
    const sections = weeklyReportSections(report);
    expect(sections.map((section) => section.title)).toEqual([
      "Needs you",
      "What the agents finished",
      "What is stuck",
      "Client pipeline",
      "Cost by agent",
    ]);
    expect(sections[0]!.lines).toEqual(["GRE-6 Approve the brief", "and 5 more"]);
    expect(sections[1]!.lines).toEqual(["Ridge: 2 tasks", "  GRE-1 Booking page", "  GRE-2 Client deck", "Nova: 1 task", "  GRE-3 Venue shortlist"]);
    expect(sections[2]!.lines[0]).toBe("GRE-4 Pipedrive import, stuck for 9 days (Ridge)");
    expect(sections[3]!.lines).toEqual([
      "1 new, 2 moves, 1 won.",
      "Acme: Proposal to Won (Client journey)",
      "Beta Ltd: Lead to Proposal (Client journey)",
    ]);
    expect(sections[4]!.lines).toEqual(["Nova: $9.00", "Ridge: $4.00", "Total: $13.00"]);
  });
});

describe("weekly report PDF", () => {
  it("names the file after the company and the day", () => {
    expect(weeklyReportFileName(report)).toBe("this-week-at-greatstone-2026-10-19.pdf");
  });

  it("carries the title and every section", () => {
    const pdf = weeklyReportPdf(report);
    const hex = (text: string) => Array.from(text, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    for (const text of ["This week at Greatstone", "Needs you", "What is stuck", "Cost by agent"]) {
      expect(pdf).toContain(hex(text));
    }
  });
});
