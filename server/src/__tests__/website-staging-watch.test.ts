import { describe, expect, it, vi } from "vitest";
import { StagingWatchError, stagingWatchSweep, stagingWatchTaskDescription, stagingWatchTick, type StagingWatchDeps } from "../services/website/staging-watch.js";

function deps(over: Partial<StagingWatchDeps>): StagingWatchDeps {
  return {
    mainCommit: async () => "b".repeat(40),
    stagedCommit: async () => "a".repeat(40),
    openTask: async () => null,
    storeRelease: async () => null,
    builtRelease: async () => null,
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
    const d = deps({ stagedCommit: async () => "b".repeat(40), storeRelease: async () => 7, builtRelease: async () => 6 });
    expect(await stagingWatchTick(d)).toBe("created");
    expect(d.createTask).toHaveBeenCalledWith("b".repeat(40), "b".repeat(40), 7);
    expect(stagingWatchTaskDescription("b".repeat(40), "b".repeat(40), 7)).toContain("GSAM_CONTENT_RELEASE=7 npm run deploy:staging");
  });

  it("raises nothing more once staging's pages were built with the release its store holds (GRE-4664)", async () => {
    // GRE-4635..GRE-4662: each task deployed release 1 and closed done, and the next sweep raised it again.
    let built: number | null = 6;
    let open: { identifier: string } | null = null;
    const d = deps({
      stagedCommit: async () => "b".repeat(40),
      storeRelease: async () => 7,
      builtRelease: async () => built,
      openTask: async () => open,
      createTask: vi.fn(async () => { open = { identifier: "GRE-1" }; }),
    });
    expect(await stagingWatchTick(d)).toBe("created");
    expect(await stagingWatchTick(d)).toBe("busy");
    built = 7; // the task ran GSAM_CONTENT_RELEASE=7 npm run deploy:staging and closed done
    open = null;
    expect(await stagingWatchTick(d)).toBe("current");
    expect(await stagingWatchTick(d)).toBe("current");
    expect(d.createTask).toHaveBeenCalledTimes(1);
  });

  it("names the release staging's store holds, never an older one (GSAM's release rows are not read)", async () => {
    // Staging's store holds release 2 while its pages show release 1 (release 1's row still switched).
    const d = deps({ stagedCommit: async () => "b".repeat(40), storeRelease: async () => 2, builtRelease: async () => 1 });
    expect(await stagingWatchTick(d)).toBe("created");
    expect(d.createTask).toHaveBeenCalledWith("b".repeat(40), "b".repeat(40), 2);
    const built = deps({ stagedCommit: async () => "b".repeat(40), storeRelease: async () => 2, builtRelease: async () => 2 });
    expect(await stagingWatchTick(built)).toBe("current");
    expect(built.createTask).not.toHaveBeenCalled();
  });

  it("hands over the store's release when staging's pages name none, and nothing when the store is empty", async () => {
    const unnamed = deps({ stagedCommit: async () => "b".repeat(40), storeRelease: async () => 3 });
    expect(await stagingWatchTick(unnamed)).toBe("created");
    expect(unnamed.createTask).toHaveBeenCalledWith("b".repeat(40), "b".repeat(40), 3);
    const empty = deps({ stagedCommit: async () => "b".repeat(40), builtRelease: async () => 3 });
    expect(await stagingWatchTick(empty)).toBe("current");
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
