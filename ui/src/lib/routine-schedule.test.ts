import { describe, expect, it } from "vitest";
import { lastRunLabel, nextRunLabel, nextScheduledRun } from "./routine-schedule";

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
