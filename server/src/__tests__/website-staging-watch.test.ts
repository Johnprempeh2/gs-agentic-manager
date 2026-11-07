import { describe, expect, it, vi } from "vitest";
import { StagingWatchError, stagingWatchSweep, stagingWatchTaskDescription, stagingWatchTick, type StagingWatchDeps } from "../services/website/staging-watch.js";

function deps(over: Partial<StagingWatchDeps>): StagingWatchDeps {
  return {
    mainCommit: async () => "b".repeat(40),
    stagedCommit: async () => "a".repeat(40),
    openTask: async () => null,
    contentWaiting: async () => null,
    createTask: vi.fn(async () => undefined),
    openAlert: async () => null,
    createAlert: vi.fn(async () => undefined),
    closeAlert: vi.fn(async () => undefined),
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
    expect(d.createTask).toHaveBeenCalledWith("b".repeat(40), "a".repeat(40), null);
  });

  it("hands a published content release to the team even when staging already holds main", async () => {
    const d = deps({ stagedCommit: async () => "b".repeat(40), contentWaiting: async () => 7 });
    expect(await stagingWatchTick(d)).toBe("created");
    expect(d.createTask).toHaveBeenCalledWith("b".repeat(40), "b".repeat(40), 7);
    expect(stagingWatchTaskDescription("b".repeat(40), "b".repeat(40), 7)).toContain("GSAM_CONTENT_RELEASE=7 npm run deploy:staging");
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

  it("raises one task naming the service after 3 failed sweeps in a row, and closes it when a sweep works", async () => {
    const secret = "nfp_secret_value";
    let alert: { id: string } | null = null;
    let failing = true;
    const d = deps({
      stagedCommit: async () => {
        if (failing) throw new StagingWatchError("Netlify", "Netlify answered 401 for the staging site's deploys (check the website site's Netlify token)");
        return "b".repeat(40);
      },
      openAlert: async () => alert,
      createAlert: vi.fn(async () => { alert = { id: "alert-1" }; }),
      closeAlert: vi.fn(async () => { alert = null; }),
    });
    const state = { failures: 0 };
    for (let i = 0; i < 2; i += 1) await expect(stagingWatchSweep(d, state)).rejects.toThrow();
    expect(d.createAlert).not.toHaveBeenCalled();
    await expect(stagingWatchSweep(d, state)).rejects.toThrow();
    await expect(stagingWatchSweep(d, state)).rejects.toThrow();
    expect(d.createAlert).toHaveBeenCalledTimes(1);
    const [service, reason] = (d.createAlert as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(service).toBe("Netlify");
    expect(reason).toContain("401");
    expect(reason).not.toContain(secret);
    failing = false;
    expect(await stagingWatchSweep(d, state)).toBe("current");
    expect(d.closeAlert).toHaveBeenCalledWith("alert-1");
    expect(state.failures).toBe(0);
  });
});
