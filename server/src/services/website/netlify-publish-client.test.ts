import { describe, expect, it } from "vitest";
import { createNetlifyPublishClient } from "./netlify-publish-client.js";

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
      url: "https://api.netlify.com/api/v1/blobs/site-1/site%3Agsam-content/releases/42.json",
      method: "PUT",
      headers: { authorization: "Bearer tok", accept: "application/json;type=signed-url" },
    });
    expect(calls[1]).toMatchObject({ url: "https://signed.example/put", method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(calls[1]!.headers.authorization).toBeUndefined();
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
});
