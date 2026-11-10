// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebsitePage, WebsiteSite } from "@greatstone/shared";
import { SitemapNow, pageViewUrl, type SitemapFraming } from "./SitemapNow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const site = { id: "site-1", domain: "www.example.test", livePreviewUrl: null, devPreviewUrl: "https://preview.example.test/", editorFrameOrigin: null, liveReleaseId: null } as WebsiteSite;
const page = (id: string, slug: string, title: string, status: string) =>
  ({ id, slug, title, status, menu: "none", menuOrder: null, parentPageId: null, navOrder: 0, seo: {}, archivedAt: null, updatedAt: "2026-11-09T10:00:00.000Z" }) as unknown as WebsitePage;
const pages = [page("p1", "/", "Home", "approved"), page("p2", "/about", "About", "approved"), page("p3", "/pricing", "Pricing", "planned")];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function show(framing?: SitemapFraming | null, at: WebsiteSite = site) {
  act(() => root.render(<SitemapNow site={at} pages={pages} approvedTree={null} framing={framing} />));
  return [...container.querySelectorAll("iframe")];
}

describe("page previews on Site now", () => {
  it("shows one still, lazy preview per built page when the server says the address may be framed", () => {
    const frames = show({ devFraming: "allowed", liveFraming: "refused" });
    expect(frames.map((frame) => frame.getAttribute("src"))).toEqual(["https://preview.example.test/", "https://preview.example.test/about"]);
    for (const frame of frames) {
      expect(frame.getAttribute("loading")).toBe("lazy");
      expect(frame.tabIndex).toBe(-1);
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
      expect(frame.className).toContain("pointer-events-none");
      expect(frame.closest("[aria-hidden='true']")).not.toBeNull();
    }
    // A suggestion is not a page: it never gets a preview.
    expect(container.querySelector("[data-testid='sitemap-now-suggestion'] iframe")).toBeNull();
  });

  it("falls back to the text rows when the check is missing, unknown or refused, and says why when refused", () => {
    expect(show(undefined)).toHaveLength(0);
    expect(show({ devFraming: "unknown", liveFraming: "allowed" })).toHaveLength(0);
    expect(container.textContent).not.toContain("Small previews are off");
    expect(show({ devFraming: "refused", liveFraming: "allowed" })).toHaveLength(0);
    expect(container.textContent).toContain("Small previews are off");
    expect(container.querySelectorAll("[data-testid='sitemap-now-page']")).toHaveLength(2);
    expect(container.querySelector("a[href='https://preview.example.test/about']")?.textContent).toContain("View");
  });

  it("reads the check of the address it frames: the live one when there is no development preview", () => {
    const liveOnly = { ...site, devPreviewUrl: null } as WebsiteSite;
    expect(show({ devFraming: "allowed", liveFraming: "unknown" }, liveOnly)).toHaveLength(0);
    expect(show({ devFraming: "unknown", liveFraming: "allowed" }, liveOnly).map((frame) => frame.getAttribute("src"))).toEqual(["https://www.example.test/", "https://www.example.test/about"]);
  });
});

describe("pageViewUrl", () => {
  it("uses the development preview, then the editor preview, then the live address", () => {
    expect(pageViewUrl(site, "/about")).toBe("https://preview.example.test/about");
    expect(pageViewUrl({ ...site, devPreviewUrl: null, editorFrameOrigin: "https://editor.example.test" }, "/a/b")).toBe("https://editor.example.test/a/b");
    expect(pageViewUrl({ ...site, devPreviewUrl: null }, "/")).toBe("https://www.example.test/");
  });
});

describe("dismissing a suggestion from the keyboard", () => {
  const ideas = [...pages, page("p4", "/pricing/teams", "Teams", "planned"), page("p5", "/pricing/schools", "Schools", "planned")];
  const press = (label: string) => {
    const target = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    target.focus();
    act(() => target.click());
  };
  const focused = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.getAttribute("data-testid");
  beforeEach(() => {
    window.localStorage.clear();
    act(() => root.render(<SitemapNow site={site} pages={ideas} approvedTree={null} />));
  });

  it("hands the keyboard to the next suggestion, then the one before, then the group, and says what happened", () => {
    // Rows sort by address: Pricing, Schools, Teams.
    press("Dismiss the suggestion Schools");
    expect(focused()).toBe("Dismiss the suggestion Teams");
    expect(container.querySelector("[role='status']")?.textContent).toBe("Schools dismissed.");
    press("Dismiss the suggestion Teams");
    expect(focused()).toBe("Dismiss the suggestion Pricing");
    press("Dismiss the suggestion Pricing");
    expect(focused()).toBe("sitemap-now-suggested");
  });

  it("keeps the keyboard on the same button when the row stays: Bring back, then Dismiss again", () => {
    press("Dismiss the suggestion Schools");
    act(() => [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Show 1 dismissed suggestion")!.click());
    press("Bring back the suggestion Schools");
    expect(focused()).toBe("Dismiss the suggestion Schools");
    expect(container.querySelector("[role='status']")?.textContent).toBe("Schools is back in the suggestions.");
    press("Dismiss the suggestion Schools");
    expect(focused()).toBe("Bring back the suggestion Schools");
  });
});
