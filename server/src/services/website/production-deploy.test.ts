import { describe, expect, it } from "vitest";
import { productionClient, retryOnce, rollbackTarget, supportsDirect, toProductionRun } from "./production-deploy.js";

describe("production deploy helpers", () => {
  it("rolls back to the newest other production deploy that was published, never a draft, a failure or the live one", () => {
    const sha = "a".repeat(40);
    const deploys = [
      { id: "live", state: "ready", context: "production", published_at: "2026-11-09T06:04:22Z", title: `gsam-source:prod:${sha}` },
      { id: "draft", state: "ready", context: "branch-deploy", published_at: null },
      { id: "broken", state: "error", context: "production", published_at: "2026-11-08T12:00:00Z" },
      { id: "older", state: "ready", context: "production", published_at: "2026-11-07T09:00:00Z" },
      { id: "before", state: "ready", context: "production", published_at: "2026-11-08T10:00:00Z", title: `gsam-source:prod:${sha}` },
    ];
    expect(rollbackTarget(deploys, "live")).toEqual({ deployId: "before", commit: sha, publishedAt: "2026-11-08T10:00:00Z" });
    expect(rollbackTarget([deploys[0]!], "live")).toBeNull();
  });

  it("reads only runs this workflow named", () => {
    const id = "3f0c2b9e-1d2a-4b8c-9e7f-0a1b2c3d4e5f";
    expect(toProductionRun({ id: 7, display_title: `Website rollback ${id}`, status: "in_progress", conclusion: null, created_at: "t", html_url: "u" }))
      .toEqual({ id: 7, action: "rollback", request: id, status: "in_progress", conclusion: null, createdAt: "t", url: "u" });
    expect(toProductionRun({ id: 8, display_title: "Deploy production", status: "completed", created_at: "t", html_url: "u" })).toBeNull();
  });
  it("retries a Netlify read once, so a site waking from sleep does not block Deploy", async () => {
    let calls = 0;
    await expect(retryOnce(async () => { calls += 1; if (calls === 1) throw new Error("aborted"); return "ok"; })).resolves.toBe("ok");
    expect(calls).toBe(2);
    let always = 0;
    await expect(retryOnce(async () => { always += 1; throw new Error("down"); })).rejects.toThrow("down");
    expect(always).toBe(2);
  });

  it("follows Deploy straight to live runs, and reads direct support only from deploy-ticket.mjs's TICKET_MODES", () => {
    const id = "3f0c2b9e-1d2a-4b8c-9e7f-0a1b2c3d4e5f";
    expect(toProductionRun({ id: 9, display_title: `Website direct ${id}`, status: "queued", created_at: "t", html_url: "u" })?.action).toBe("direct");
    expect(supportsDirect("export const TICKET_MODES = ['staging', 'direct'];")).toBe(true);
    expect(supportsDirect("export const TICKET_MODES = ['staging'];")).toBe(false);
    expect(supportsDirect("// a direct ticket one day")).toBe(false);
  });

  it("reads staging's commit page by page (a 100-deploy page times out), and the live commit from the deploy that is live", async () => {
    const staged = "a".repeat(40);
    const live = "d".repeat(40);
    const newer = "e".repeat(40);
    const rebuild = (n: number) => ({ id: `r${n}`, state: "ready", title: null });
    const urls: string[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fake = (async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/sites/STAGING") || url.includes("6689e558")) {
        if (url.includes("/deploys")) {
          const page = Number(new URL(url).searchParams.get("page"));
          return json(page === 1 ? Array.from({ length: 10 }, (_, n) => rebuild(n)) : [{ id: "s", state: "ready", title: `gsam-source:staging:${staged}`, published_at: "2026-11-12T15:02:00Z" }]);
        }
      }
      if (url.endsWith("/sites/prod-site")) return json({ published_deploy: { id: "live", published_at: "2026-11-09T06:04:22Z" } });
      if (url.includes("/sites/prod-site/deploys")) return json([
        { id: "rolledback", state: "ready", context: "production", published_at: "2026-11-10T00:00:00Z", title: `gsam-source:prod:${newer}` },
        { id: "live", state: "ready", context: "production", published_at: "2026-11-11T00:00:00Z", title: `gsam-source:prod:${live}` },
      ]);
      if (url.includes("/blobs/")) return new Response("", { status: 404 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const status = await productionClient({ netlifySiteId: "prod-site", netlifyToken: "t", githubToken: "g", storeName: "gsam-content" }, fake).status();
    expect(status.staging.commit).toBe(staged);
    expect(status.staging.changedAt).toBe("2026-11-12T15:02:00Z");
    expect(status.live.commit).toBe(live);
    expect(urls.filter((u) => u.includes("per_page=100"))).toEqual([]);
  });
});
