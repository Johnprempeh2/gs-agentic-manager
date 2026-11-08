import { describe, expect, it } from "vitest";
import { applyChromeRefresh } from "../services/website/publish.js";

const page = (status: number, body: unknown) => ({ status, headers: new Headers(), body: typeof body === "string" ? body : JSON.stringify(body) });
const parts = () => new Map<string, Record<string, unknown>>([["stylesheet", { css: ".old{}" }], ["footer", { html: "<footer>old</footer>", css: "" }], ["header", { html: "<header>h</header>", css: "" }]]);

describe("Publish refreshes the shared stylesheet and footer from the site", () => {
  it("takes the site's /_chrome.json and leaves the header alone", () => {
    const chrome = parts();
    const check = applyChromeRefresh(chrome, page(200, { version: 1, stylesheet: ".new{}", footer: { html: "<footer>new</footer>", css: ".f{}" } }));
    expect(check).toMatchObject({ name: "chrome_refresh", ok: true, message: expect.stringContaining("refreshed") });
    expect(chrome.get("stylesheet")).toEqual({ css: ".new{}" });
    expect(chrome.get("footer")).toEqual({ html: "<footer>new</footer>", css: ".f{}" });
    expect(chrome.get("header")).toEqual({ html: "<header>h</header>", css: "" });
  });

  it("keeps GSAM's copy, without failing Publish, when the site has no usable file", () => {
    for (const fetched of [null, page(404, "Not found"), page(200, "<html></html>"), page(200, { version: 2, stylesheet: ".x{}", footer: { html: "<footer/>" } }), page(200, { version: 1, stylesheet: "", footer: { html: "<footer/>" } })]) {
      const chrome = parts();
      const check = applyChromeRefresh(chrome, fetched);
      expect(check).toMatchObject({ name: "chrome_refresh", ok: true, message: expect.stringContaining("Kept") });
      expect(chrome.get("stylesheet")).toEqual({ css: ".old{}" });
      expect(chrome.get("footer")).toEqual({ html: "<footer>old</footer>", css: "" });
    }
  });
});
