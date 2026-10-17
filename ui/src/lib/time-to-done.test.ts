import { describe, expect, it } from "vitest";
import { shortDuration, taskTimeLine } from "./time-to-done";

const H = 3_600_000;

describe("shortDuration", () => {
  it("reads naturally at each scale", () => {
    expect(shortDuration(30_000)).toBe("1 min");
    expect(shortDuration(45 * 60_000)).toBe("45 min");
    expect(shortDuration(5 * H)).toBe("5 h");
    expect(shortDuration(52 * H)).toBe("2 days 4 h");
    expect(shortDuration(48 * H)).toBe("2 days");
    expect(shortDuration(21 * 24 * H)).toBe("3 weeks");
  });
});

describe("taskTimeLine", () => {
  const now = new Date("2026-10-10T12:00:00Z");

  it("measures a done task from when work started", () => {
    expect(
      taskTimeLine({
        status: "done",
        createdAt: "2026-10-01T00:00:00Z",
        startedAt: "2026-10-02T00:00:00Z",
        completedAt: "2026-10-02T06:00:00Z",
      }),
    ).toEqual({ label: "Took", value: "6 h" });
  });

  it("falls back to the creation time when work never formally started", () => {
    expect(
      taskTimeLine({ status: "done", createdAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T00:20:00Z" }),
    ).toEqual({ label: "Took", value: "20 min" });
  });

  it("shows how long an open task has waited and nothing for cancelled ones", () => {
    expect(taskTimeLine({ status: "in_progress", createdAt: "2026-10-09T12:00:00Z" }, now)).toEqual({
      label: "Open for",
      value: "1 day",
    });
    expect(taskTimeLine({ status: "cancelled", createdAt: "2026-10-09T12:00:00Z" }, now)).toBeNull();
  });
});
