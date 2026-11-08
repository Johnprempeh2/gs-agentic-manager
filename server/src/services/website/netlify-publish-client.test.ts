import { describe, expect, it } from "vitest";
import { createNetlifyPublishClient, netlifyBlobUrl } from "./netlify-publish-client.js";

function recorder(answers: Array<{ status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body });
    const answer = answers.shift() ?? { status: 200, json: {} };
    return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

// GRE-2108: the request shapes the publish job relies on.
describe("netlify publish client", () => {
  it("writes a Blobs key in the site store through a signed URL, with the site's own token", async () => {
    const { calls, fetchImpl } = recorder([{ json: { url: "https://signed.example/put" } }, { status: 200 }]);
    const client = createNetlifyPublishClient({ netlifySiteId: "site-1", storeName: "gsam-content", token: "tok", fetchImpl });
    await client.putBlob("releases/42.json", "{}", "application/json");
    expect(calls[0]).toMatchObject({
      url: "https://api.netlify.com/api/v1/blobs/site-1/site:gsam-content/releases/42.json",
      method: "PUT",
      headers: { authorization: "Bearer tok", accept: "application/json;type=signed-url" },
    });
    expect(calls[1]).toMatchObject({ url: "https://signed.example/put", method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(calls[1]!.headers.authorization).toBeUndefined();
  });

  // GRE-4477: @netlify/blobs 11.1.6 sends the store as `site:<name>` with the colon as is.
  // `site%3A...` is a different store, so the site and the Next build never saw a release.
  it("names the store site:<name> on every Blobs call, the way @netlify/blobs does", async () => {
    const { calls, fetchImpl } = recorder([{ status: 200 }, { json: { url: "https://signed.example/put" } }, { status: 200 }]);
    const client = createNetlifyPublishClient({ netlifySiteId: "site-1", storeName: "gsam-content", token: "tok", fetchImpl });
    await client.blobExists("media/a b.png");
    await client.putBlob("current", "{}", "application/json");
    expect(calls.map((call) => [call.method, call.url]).slice(0, 2)).toEqual([
      ["HEAD", "https://api.netlify.com/api/v1/blobs/site-1/site:gsam-content/media/a%20b.png"],
      ["PUT", "https://api.netlify.com/api/v1/blobs/site-1/site:gsam-content/current"],
    ]);
    expect(netlifyBlobUrl("site-1", "gsam-content", "releases/42.json")).toBe("https://api.netlify.com/api/v1/blobs/site-1/site:gsam-content/releases/42.json");
  });

  it("reads a missing key as absent and a missing deploy as gone", async () => {
    const { fetchImpl } = recorder([{ status: 404 }, { status: 404 }]);
    const client = createNetlifyPublishClient({ netlifySiteId: "site-1", storeName: "gsam-content", token: "tok", fetchImpl });
    expect(await client.blobExists("media/abc.png")).toBe(false);
    expect(await client.getDeploy("old-deploy")).toBeNull();
  });

  it("starts one build, maps deploy states and restores an earlier deploy", async () => {
    const { calls, fetchImpl } = recorder([
      { json: { id: "build-1", deploy_id: "deploy-1" } },
      { json: { id: "deploy-1", state: "enqueued", commit_ref: "abc" } },
      { json: { id: "deploy-1", state: "error", error_message: "exit 2" } },
      { json: { id: "deploy-0", state: "ready", commit_ref: "abc" } },
    ]);
    const client = createNetlifyPublishClient({ netlifySiteId: "site-1", storeName: "gsam-content", token: "tok", fetchImpl });
    expect(await client.startBuild()).toEqual({ deployId: "deploy-1" });
    expect(calls[0]).toMatchObject({ url: "https://api.netlify.com/api/v1/sites/site-1/builds", method: "POST" });
    expect((await client.getDeploy("deploy-1"))?.state).toBe("building");
    expect(await client.getDeploy("deploy-1")).toMatchObject({ state: "error", errorMessage: "exit 2" });
    expect(await client.restoreDeploy("deploy-0")).toMatchObject({ id: "deploy-0", state: "ready", commitRef: "abc" });
    expect(calls[3]).toMatchObject({ url: "https://api.netlify.com/api/v1/sites/site-1/deploys/deploy-0/restore", method: "POST" });
  });

  // GRE-4485: greatstone-home has no linked repository; `/deploys/:id` answers for any site the token reads.
  it("reads build settings, a deploy's own site, and skips failed deploys only when asked", async () => {
    const since = "2026-11-08T00:00:00.000Z";
    const rows = [
      { id: "d-2", state: "canceled", context: "production", created_at: "2026-11-08T00:02:00.000Z", site_id: "site-1" },
      { id: "d-1", state: "building", context: "production", created_at: "2026-11-08T00:01:00.000Z", site_id: "site-1" },
    ];
    const { calls, fetchImpl } = recorder([
      { json: { id: "site-1", build_settings: {} } },
      { json: { id: "site-1", build_settings: { repo_url: "https://github.com/acme/site" } } },
      { json: { id: "d-9", state: "ready", site_id: "site-2" } },
      { json: rows },
      { json: rows },
    ]);
    const client = createNetlifyPublishClient({ netlifySiteId: "site-1", storeName: "gsam-content", token: "tok", fetchImpl });
    expect(await client.hasBuildSettings()).toBe(false);
    expect(await client.hasBuildSettings()).toBe(true);
    expect(calls[0]).toMatchObject({ url: "https://api.netlify.com/api/v1/sites/site-1", method: "GET" });
    expect(await client.getDeploy("d-9")).toMatchObject({ id: "d-9", siteId: "site-2" });
    expect(await client.findProductionDeploySince(new Date(since))).toMatchObject({ id: "d-2", state: "error" });
    expect(await client.findProductionDeploySince(new Date(since), { skipFailed: true })).toMatchObject({ id: "d-1", state: "building", siteId: "site-1" });
  });
});
