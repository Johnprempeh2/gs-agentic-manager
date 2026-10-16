import { describe, expect, it } from "vitest";
import { lastRunLabel, nextRunLabel, nextScheduledRun, routinesScheduleText, scheduleSummary } from "./routine-schedule";

const NOW = new Date(2026, 9, 16, 14, 0);

describe("nextScheduledRun", () => {
  it("picks the soonest enabled schedule and ignores webhooks and paused schedules", () => {
    const soonest = nextScheduledRun([
      { kind: "schedule", enabled: true, nextRunAt: new Date(2026, 9, 17, 9, 0) },
      { kind: "schedule", enabled: false, nextRunAt: new Date(2026, 9, 16, 15, 0) },
      { kind: "webhook", enabled: true, nextRunAt: new Date(2026, 9, 16, 14, 30) },
      { kind: "schedule", enabled: true, nextRunAt: new Date(2026, 9, 16, 17, 0).toISOString() },
    ]);
    expect(soonest?.getHours()).toBe(17);
  });

  it("returns null with no schedules", () => {
    expect(nextScheduledRun(undefined)).toBeNull();
    expect(nextScheduledRun([{ kind: "schedule", enabled: true, nextRunAt: null }])).toBeNull();
  });
});

describe("nextRunLabel", () => {
  it("says when the next run is in plain words", () => {
    expect(nextRunLabel(new Date(2026, 9, 16, 14, 1), NOW)).toBe("Next run any moment");
    expect(nextRunLabel(new Date(2026, 9, 16, 14, 20), NOW)).toBe("Next run in 20 minutes");
    expect(nextRunLabel(new Date(2026, 9, 16, 17, 5), NOW)).toBe("Next run today at 17:05");
    expect(nextRunLabel(new Date(2026, 9, 17, 9, 0), NOW)).toBe("Next run tomorrow at 09:00");
    expect(nextRunLabel(new Date(2026, 9, 20, 9, 0), NOW)).toMatch(/^Next run 20 Oct/);
  });
});

describe("lastRunLabel", () => {
  it("says never run when there is no run", () => {
    expect(lastRunLabel(null)).toBe("Never run yet");
    expect(lastRunLabel(new Date(Date.now() - 2 * 3_600_000))).toBe("Last run 2h ago");
  });
});

describe("routinesScheduleText", () => {
  it("lists each routine with its schedule, next run and agent", () => {
    const text = routinesScheduleText(
      [
        {
          title: "Weekly report",
          status: "active",
          assigneeAgentId: "a1",
          triggers: [{ kind: "schedule", enabled: true, cronExpression: "0 9 * * 1", nextRunAt: new Date(2026, 9, 17, 9, 0) }],
        },
        { title: "Daily check", status: "paused", assigneeAgentId: null, triggers: [] },
        { title: "Old", status: "archived", assigneeAgentId: null, triggers: [] },
      ],
      (id) => (id === "a1" ? "Ridge" : null),
      NOW,
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("Routines, 16 Oct");
    expect(lines[1]).toBe("2 routines: 1 on, 1 paused.");
    expect(lines[3]).toMatch(/^• Weekly report: Every Monday at 09:00, next run tomorrow at 09:00, Ridge$/);
    expect(lines[4]).toBe("• Daily check: Paused");
  });
});

describe("scheduleSummary", () => {
  it("describes enabled schedules and skips the rest", () => {
    expect(
      scheduleSummary([
        { kind: "schedule", enabled: true, nextRunAt: null, cronExpression: "0 9 * * 1" },
        { kind: "schedule", enabled: false, nextRunAt: null, cronExpression: "0 9 * * 2" },
        { kind: "webhook", enabled: true, nextRunAt: null },
      ]),
    ).toBe("Every Monday at 09:00");
    expect(scheduleSummary([])).toBeNull();
  });
});
