import { describe, expect, it } from "vitest";
import { isReleaseTask } from "./release-task.js";

describe("isReleaseTask", () => {
  it("matches the release flow's tasks", () => {
    expect(isReleaseTask("Release candidate rc-2026-10-15.3: check in preview (GRE-1565)")).toBe(true);
    expect(isReleaseTask("John: release rc-2026-10-15.3 to live (by hand)")).toBe(true);
    expect(isReleaseTask("Release live-2026-10-14.2")).toBe(true);
  });

  it("leaves other tasks alone", () => {
    expect(isReleaseTask("GRE-1538: merge main (35c73fce5) into the PR #557 branch")).toBe(false);
    expect(isReleaseTask("Write the release note template")).toBe(false);
    expect(isReleaseTask("Fix the crash seen on rc-2026-10-15.3")).toBe(false);
    expect(isReleaseTask(null)).toBe(false);
  });
});
