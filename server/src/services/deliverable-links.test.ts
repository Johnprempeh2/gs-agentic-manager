import { describe, expect, it } from "vitest";
import { checkLinkStatus, classifyLinkStatus, enqueueScreenshot } from "./deliverable-links.js";

// Link health check: what each status means, redirects, HEAD fallback.

function response(status: number, location?: string) {
  return new Response(null, { status, headers: location ? { location } : {} });
}

describe("classifyLinkStatus", () => {
  it("maps statuses to ok, broken and restricted", () => {
    expect(classifyLinkStatus(200)).toEqual({ ok: true, restricted: false });
    expect(classifyLinkStatus(304)).toEqual({ ok: true, restricted: false });
    expect(classifyLinkStatus(401)).toEqual({ ok: true, restricted: true });
    expect(classifyLinkStatus(403)).toEqual({ ok: true, restricted: true });
    expect(classifyLinkStatus(429)).toEqual({ ok: true, restricted: false });
    expect(classifyLinkStatus(404)).toEqual({ ok: false, restricted: false });
    expect(classifyLinkStatus(410)).toEqual({ ok: false, restricted: false });
    expect(classifyLinkStatus(500)).toEqual({ ok: false, restricted: false });
    expect(classifyLinkStatus(503)).toEqual({ ok: false, restricted: false });
    expect(classifyLinkStatus(null)).toEqual({ ok: false, restricted: false });
  });
});

describe("checkLinkStatus", () => {
  it("follows redirects to the final status", async () => {
    const seen: string[] = [];
    const status = await checkLinkStatus("https://old.example.com/", async (url, method) => {
      seen.push(`${method} ${url.href}`);
      return url.hostname === "old.example.com" ? response(301, "https://new.example.com/home") : response(200);
    });
    expect(status).toBe(200);
    expect(seen).toEqual(["HEAD https://old.example.com/", "HEAD https://new.example.com/home"]);
  });

  it("asks again with GET when HEAD is refused", async () => {
    const methods: string[] = [];
    const status = await checkLinkStatus("https://example.com", async (_url, method) => {
      methods.push(method);
      return method === "HEAD" ? response(405) : response(404);
    });
    expect(status).toBe(404);
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("is null when the site cannot be reached or redirects forever", async () => {
    expect(await checkLinkStatus("https://example.com", async () => { throw new Error("ECONNREFUSED"); })).toBeNull();
    expect(await checkLinkStatus("https://example.com", async (url) => response(302, `${url.href}x`))).toBeNull();
  });

  it("refuses private addresses through the real guard", async () => {
    expect(await checkLinkStatus("https://127.0.0.1/")).toBeNull();
    expect(await checkLinkStatus("https://localhost/")).toBeNull();
  });
});

describe("enqueueScreenshot", () => {
  it("runs one capture at a time, even after a failure", async () => {
    let running = 0;
    let most = 0;
    const job = (fail: boolean) => async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (fail) throw new Error("boom");
      return "done";
    };
    const results = await Promise.allSettled([enqueueScreenshot(job(true)), enqueueScreenshot(job(false)), enqueueScreenshot(job(false))]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(most).toBe(1);
  });
});
