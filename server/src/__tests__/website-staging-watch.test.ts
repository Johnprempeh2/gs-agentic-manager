import { describe, expect, it, vi } from "vitest";
import { stagingWatchTaskDescription, stagingWatchTick, type StagingWatchDeps } from "../services/website/staging-watch.js";

function deps(over: Partial<StagingWatchDeps>): StagingWatchDeps {
  return {
    mainCommit: async () => "b".repeat(40),
    stagedCommit: async () => "a".repeat(40),
    openTask: async () => null,
    createTask: vi.fn(async () => undefined),
    ...over,
  };
}

describe("website staging watch", () => {
  it("does nothing when staging already holds main", async () => {
    const d = deps({ stagedCommit: async () => "b".repeat(40) });
    expect(await stagingWatchTick(d)).toBe("current");
    expect(d.createTask).not.toHaveBeenCalled();
  });

  it("hands a moved main to the team on one task", async () => {
    const d = deps({});
    expect(await stagingWatchTick(d)).toBe("created");
    expect(d.createTask).toHaveBeenCalledWith("b".repeat(40), "a".repeat(40));
  });

  it("raises no second task while one is open (single flight, a failure stays on its task)", async () => {
    const d = deps({ openTask: async () => ({ identifier: "GRE-1" }) });
    expect(await stagingWatchTick(d)).toBe("busy");
    expect(d.createTask).not.toHaveBeenCalled();
  });

  it("tells the agent to run the staging deploy from origin main and never the public site", () => {
    const text = stagingWatchTaskDescription("b".repeat(40), null);
    expect(text).toContain("npm run deploy:staging");
    expect(text).toContain("detached at origin main");
    expect(text).toContain("never touches the public site");
  });
});
