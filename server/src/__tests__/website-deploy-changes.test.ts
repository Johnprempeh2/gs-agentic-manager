import { describe, expect, it, vi } from "vitest";
import { cachedDeployChanges, lastGuardedCommit, loadDeployChanges } from "../services/website/deploy-changes.js";

const live = "0117d3e".padEnd(40, "0");
const sha = (n: number) => String(n).repeat(40);

describe("website deploy changes", () => {
  it("takes the newest ready guarded deploy on each channel", () => {
    expect(lastGuardedCommit([{ state: "ready", title: `gsam-source:prod:${sha(4)}` }, { state: "ready", title: `gsam-source:staging:${sha(5)}` }], "staging")).toBe(sha(5));
    expect(lastGuardedCommit([
      { state: "ready", title: "draft: carousel" },
      { state: "error", title: `gsam-source:prod:${sha(9)}` },
      { state: "ready", title: `gsam-source:prod:${live}` },
      { state: "ready", title: `gsam-source:prod:${sha(1)}` },
    ], "prod")).toBe(live);
  });

  it("lists staging's commits that the public site lacks, newest first, first line of each message", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.startsWith("https://api.netlify.com/api/v1/sites/site-1/deploys")) return Response.json([{ state: "ready", title: `gsam-source:prod:${live}` }]);
      if (u.startsWith("https://api.netlify.com/api/v1/sites/6689e558-855b-40b1-be45-c530531fed45/deploys")) return Response.json([{ state: "ready", title: `gsam-source:staging:${sha(3)}` }]);
      if (u === `https://api.github.com/repos/Johnprempeh2/greatstone-website/compare/${live}...${sha(3)}`)
        return Response.json({ commits: [{ sha: sha(2), commit: { message: "Older\n\nbody" } }, { sha: sha(3), commit: { message: "Newer" } }] });
      return new Response("", { status: 404 });
    });
    await expect(loadDeployChanges({ netlifySiteId: "site-1", netlifyToken: "n", githubToken: "g" }, fetchImpl as typeof fetch)).resolves.toEqual({
      liveCommit: live,
      stagingCommit: sha(3),
      commits: [{ sha: sha(3), title: "Newer" }, { sha: sha(2), title: "Older" }],
    });
  });

  it("fails when Netlify cannot say, and does not cache the failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    await expect(loadDeployChanges({ netlifySiteId: "s", netlifyToken: "n", githubToken: "g" }, fetchImpl as typeof fetch)).rejects.toThrow(/401/);
    const failing = vi.fn(() => Promise.reject(new Error("down")));
    await expect(cachedDeployChanges("k-fail", failing, 0)).rejects.toThrow("down");
    await Promise.resolve();
    await expect(cachedDeployChanges("k-fail", failing, 1)).rejects.toThrow("down");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("keeps a good answer for a minute", async () => {
    const ok = vi.fn(async () => ({ liveCommit: live, stagingCommit: live, commits: [] }));
    await cachedDeployChanges("k-ok", ok, 0);
    await cachedDeployChanges("k-ok", ok, 59_000);
    expect(ok).toHaveBeenCalledTimes(1);
    await cachedDeployChanges("k-ok", ok, 61_000);
    expect(ok).toHaveBeenCalledTimes(2);
  });
});
