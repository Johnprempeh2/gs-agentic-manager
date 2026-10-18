import { describe, expect, it } from "vitest";
import { projectProgress } from "./project-progress";

describe("projectProgress", () => {
  it("reads done of total with a percentage", () => {
    expect(projectProgress({ taskCount: 24, doneTaskCount: 7 })).toEqual({ label: "7 of 24 done", percent: 29 });
  });

  it("falls back to a task count when finished work is unknown or there are no tasks", () => {
    expect(projectProgress({ taskCount: 1 })).toEqual({ label: "1 task", percent: null });
    expect(projectProgress({ taskCount: 0, doneTaskCount: 0 })).toEqual({ label: "0 tasks", percent: null });
  });

  it("never reads more than the total", () => {
    expect(projectProgress({ taskCount: 2, doneTaskCount: 5 }).label).toBe("2 of 2 done");
  });
});
