import { describe, expect, it, vi } from "vitest";
import { cachedDeployChanges, lastProdCommit, loadDeployChanges } from "../services/website/deploy-changes.js";

const live = "0117d3e".padEnd(40, "0");
const sha = (n: number) => String(n).repeat(40);

describe("website deploy changes", () => {
  it("takes the newest ready guarded production deploy as what is live", () => {
    expect(lastProdCommit([
      { state: "ready", title: "draft: carousel" },
      { state: "error", title: `gsam-source:prod:${sha(9)}` },
      { state: "ready", title: `gsam-source:prod:${live}` },
      { state: "ready", title: `gsam-source:prod:${sha(1)}` },
    ])).toBe(live);
  });

  it("lists main since that commit, newest first, with only the first line of each message", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.startsWith("https://api.netlify.com/api/v1/sites/site-1/deploys")) return Response.json([{ state: "ready", title: `gsam-source:prod:${live}` }]);
      if (u === `https://api.github.com/repos/Johnprempeh2/greatstone-website/compare/${live}...main`)
        return Response.json({ commits: [{ sha: sha(2), commit: { message: "Older\n\nbody" } }, { sha: sha(3), commit: { message: "Newer" } }] });
      return new Response("", { status: 404 });
    });
    await expect(loadDeployChanges({ netlifySiteId: "site-1", netlifyToken: "n", githubToken: "g" }, fetchImpl as typeof fetch)).resolves.toEqual({
      liveCommit: live,
      mainCommit: sha(3),
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
    const ok = vi.fn(async () => ({ liveCommit: live, mainCommit: live, commits: [] }));
    await cachedDeployChanges("k-ok", ok, 0);
    await cachedDeployChanges("k-ok", ok, 59_000);
    expect(ok).toHaveBeenCalledTimes(1);
    await cachedDeployChanges("k-ok", ok, 61_000);
    expect(ok).toHaveBeenCalledTimes(2);
  });
});
