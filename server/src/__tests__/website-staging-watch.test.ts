import { describe, expect, it, vi } from "vitest";
import {
  STAGING_DEPLOYS_CAP,
  STAGING_DEPLOYS_PER_PAGE,
  STAGING_WATCH_CALL_TIMEOUT_MS,
  STAGING_WATCH_FAILURES_BEFORE_ALERT,
  StagingWatchError,
  latestStagingWindow,
  pagedStagedCommit,
  stagingWatchSweep,
  stagingWatchTaskDescription,
  stagingWatchTaskTitle,
  stagingWatchTick,
  watchCall,
  type StagingWatchDeps,
} from "../services/website/staging-watch.js";

function deps(over: Partial<StagingWatchDeps>): StagingWatchDeps {
  return {
    mainCommit: async () => "b".repeat(40),
    stagedCommit: async () => "a".repeat(40),
    openTask: async () => null,
    taskExists: async () => false,
    lastTaskAt: async () => null,
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

  it("never raises a second task for a commit and release that already had one (8 Nov: 109 tasks, 75 deploys)", async () => {
    // Staging's pages never showed the release its store held, so every finished task was raised again.
    const titles: string[] = [];
    const d = deps({
      stagedCommit: async () => "b".repeat(40),
      storeRelease: async () => 7,
      builtRelease: async () => 6,
      taskExists: async (title) => titles.includes(title),
      createTask: vi.fn(async (sha: string, _staged: string | null, content: number | null) => { titles.push(stagingWatchTaskTitle(sha, content)); }),
    });
    expect(await stagingWatchTick(d)).toBe("created");
    for (let i = 0; i < 5; i += 1) expect(await stagingWatchTick(d)).toBe("duplicate");
    expect(d.createTask).toHaveBeenCalledTimes(1);
    expect(titles).toEqual([`Put website main on staging (bbbbbbb, content release 7)`]);
  });

  it("puts code on staging at most once per UK window (07:00 and 15:00), but a Publish goes at once", async () => {
    const at = (iso: string) => new Date(iso);
    let last: Date | null = at("2026-11-12T07:05:00Z"); // 12 Nov is GMT, so UK 07:05
    const d = deps({ lastTaskAt: async () => last });
    expect(await stagingWatchTick(d, at("2026-11-12T11:00:00Z"))).toBe("waiting");
    expect(await stagingWatchTick(d, at("2026-11-12T14:59:00Z"))).toBe("waiting");
    expect(await stagingWatchTick(d, at("2026-11-12T15:00:00Z"))).toBe("created");
    last = at("2026-11-12T15:00:00Z");
    expect(await stagingWatchTick(d, at("2026-11-13T06:59:00Z"))).toBe("waiting");
    expect(await stagingWatchTick(d, at("2026-11-13T07:01:00Z"))).toBe("created");
    expect(d.createTask).toHaveBeenCalledTimes(2);
    const publish = deps({ lastTaskAt: async () => at("2026-11-12T11:00:00Z"), storeRelease: async () => 8, builtRelease: async () => 7 });
    expect(await stagingWatchTick(publish, at("2026-11-12T11:30:00Z"))).toBe("created");
  });

  it("finds the latest UK window in GMT and in BST", () => {
    expect(latestStagingWindow(new Date("2026-11-12T10:00:00Z")).toISOString()).toBe("2026-11-12T07:00:00.000Z");
    expect(latestStagingWindow(new Date("2026-11-12T16:30:00Z")).toISOString()).toBe("2026-11-12T15:00:00.000Z");
    expect(latestStagingWindow(new Date("2026-11-12T05:00:00Z")).toISOString()).toBe("2026-11-11T15:00:00.000Z");
    expect(latestStagingWindow(new Date("2026-07-01T07:30:00Z")).toISOString()).toBe("2026-07-01T06:00:00.000Z");
    expect(latestStagingWindow(new Date("2026-07-01T05:30:00Z")).toISOString()).toBe("2026-06-30T14:00:00.000Z");
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

  describe("each GitHub or Netlify call (GRE-5060)", () => {
    // Waits for the call's own signal, as a fetch does on a service that does not answer in time.
    const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

    it("tries a timed-out call once more and keeps its answer", async () => {
      let calls = 0;
      const sha = await watchCall("Netlify", "staging deploy list", async (signal) => {
        calls += 1;
        return calls === 1 ? hang(signal) : "b".repeat(40);
      }, 10);
      expect(sha).toBe("b".repeat(40));
      expect(calls).toBe(2);
    });

    it("tries a dropped connection once more", async () => {
      let calls = 0;
      const sha = await watchCall("GitHub", "website main commit", async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return "b".repeat(40);
      });
      expect(sha).toBe("b".repeat(40));
      expect(calls).toBe(2);
    });

    it("names the service and step when both tries time out", async () => {
      let calls = 0;
      const err = await watchCall("Netlify", "staging deploy list", (signal) => { calls += 1; return hang(signal); }, 10).catch(e => e);
      expect(calls).toBe(2);
      expect(err).toBeInstanceOf(StagingWatchError);
      expect(err.service).toBe("Netlify");
      expect(err.message).toBe("Netlify: staging deploy list timed out after 0.01 s, tried 2 times");
    });

    it("does not retry a service's own answer", async () => {
      let calls = 0;
      const err = await watchCall("Netlify", "staging deploy list", async () => {
        calls += 1;
        throw new StagingWatchError("Netlify", "Netlify answered 401 for the staging site's deploys");
      }).catch(e => e);
      expect(calls).toBe(1);
      expect(err.message).toContain("401");
    });

    it("gives every call 20 s", () => {
      expect(STAGING_WATCH_CALL_TIMEOUT_MS).toBe(20_000);
    });

    it("raises the alert on Netlify alone when only its deploy list times out (GRE-5056, GRE-5057)", async () => {
      const d = deps({
        mainCommit: () => watchCall("GitHub", "website main commit", async () => "b".repeat(40), 10),
        stagedCommit: () => watchCall("Netlify", "staging deploy list", hang, 10),
      });
      const state = { failures: 0 };
      for (let i = 0; i < STAGING_WATCH_FAILURES_BEFORE_ALERT; i += 1) await expect(stagingWatchSweep(d, state)).rejects.toThrow();
      expect(d.createAlert).toHaveBeenCalledTimes(1);
      expect(d.createAlert).toHaveBeenCalledWith("Netlify", "Netlify: staging deploy list timed out after 0.01 s, tried 2 times");
    });
  });

  describe("staging's deploy list, read in pages (GRE-5062)", () => {
    const guarded = (sha: string) => ({ state: "ready", title: `gsam-source:staging:${sha}` });
    const other = { state: "ready", title: "manual deploy" };
    const full = (deploy: { state: string; title: string }) => Array.from({ length: STAGING_DEPLOYS_PER_PAGE }, () => deploy);

    it("reads only page 1 when it holds the guarded commit", async () => {
      const readPage = vi.fn(async () => [guarded("b".repeat(40)), ...full(other).slice(1)]);
      expect(await pagedStagedCommit(readPage)).toBe("b".repeat(40));
      expect(readPage).toHaveBeenCalledTimes(1);
      expect(readPage).toHaveBeenCalledWith(1);
    });

    it("reads page 2 when page 1 holds no guarded deploy", async () => {
      const readPage = vi.fn(async (page: number) => (page === 1 ? full(other) : [other, guarded("c".repeat(40))]));
      expect(await pagedStagedCommit(readPage)).toBe("c".repeat(40));
      expect(readPage.mock.calls.map(([page]) => page)).toEqual([1, 2]);
    });

    it("stops at the last 100 deploys and returns null", async () => {
      const readPage = vi.fn(async () => full(other));
      expect(await pagedStagedCommit(readPage)).toBeNull();
      expect(readPage).toHaveBeenCalledTimes(STAGING_DEPLOYS_CAP / STAGING_DEPLOYS_PER_PAGE);
    });

    it("stops when the list ends before the cap", async () => {
      const readPage = vi.fn(async (page: number) => (page === 1 ? full(other) : [other]));
      expect(await pagedStagedCommit(readPage)).toBeNull();
      expect(readPage).toHaveBeenCalledTimes(2);
    });
  });
});
