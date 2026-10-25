// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteSiteStyle } from "@greatstone/shared";
import { WebsiteStyleView, blockStyle, styleTaskDefaults } from "./WebsiteStyle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const style: WebsiteSiteStyle = {
  siteId: "site-1",
  siteUrl: "https://www.greatstone.example/",
  readAt: new Date().toISOString(),
  stylesheets: ["https://www.greatstone.example/site.css"],
  fontStylesheets: ["https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700"],
  releaseTokenCount: 1,
  problem: null,
  colours: [
    { cssVar: "--gs-bg", token: null, name: "Bg", value: "#0b0b0c", hex: "#0b0b0c", alpha: 1, role: "background", usedFor: ["background"], usedIn: ["body"], source: "stylesheet" },
    { cssVar: "--gs-text", token: null, name: "Text", value: "#f5f5f0", hex: "#f5f5f0", alpha: 1, role: "text", usedFor: ["text"], usedIn: ["body"], source: "stylesheet" },
    { cssVar: "--gs-muted", token: null, name: "Muted", value: "#3a3a3a", hex: "#3a3a3a", alpha: 1, role: "text", usedFor: ["text"], usedIn: ["small"], source: "stylesheet" },
    { cssVar: "--gs-accent", token: "gs.accent", name: "Accent", value: "#c8ff00", hex: "#c8ff00", alpha: 1, role: "accent", usedFor: ["background"], usedIn: [".btn--primary"], source: "release" },
  ],
  contrast: [
    { text: "--gs-text", background: "--gs-bg", ratio: 18.1, rating: "AAA" },
    { text: "--gs-muted", background: "--gs-bg", ratio: 1.6, rating: "Fail" },
  ],
  fonts: [{ family: "Montserrat", stack: "\"Montserrat\", sans-serif", weights: [400, 700], usedIn: ["body"], loadedFrom: "google" }],
  textStyles: [
    { selector: "h1", label: "Heading 1", fontFamily: "Montserrat", fontSize: "4rem", fontWeight: "700", lineHeight: "1.05", letterSpacing: null, textTransform: null, color: null },
  ],
  components: [
    { kind: "button", selector: ".btn--primary", className: "btn btn--primary", label: "Btn primary", declarations: { background: "#c8ff00", color: "#0b0b0c", "border-radius": "999px" } },
  ],
  tokens: [{ name: "--gs-radius", token: null, value: "14px", kind: "radius", source: "stylesheet" }],
  surfaces: [{ selector: "body", label: "Page", background: "#0b0b0c" }],
};

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
  document.head.querySelectorAll("link[data-website-style-font]").forEach((link) => link.remove());
});

describe("WebsiteStyleView", () => {
  it("shows the palette by role, the contrast ratings with failures first, fonts, blocks and tokens", () => {
    act(() => root.render(<WebsiteStyleView style={style} siteName="Greatstone" onAsk={vi.fn()} />));
    const text = container.textContent ?? "";
    expect(text).toContain("Backgrounds");
    expect(text).toContain("Accents");
    expect(container.querySelectorAll("[data-testid='website-style-colour']")).toHaveLength(4);
    expect(text).toContain("Theme"); // the release token badge on Accent

    const ratings = [...container.querySelectorAll("[data-testid='website-style-contrast-pair']")].map((row) => row.textContent);
    expect(ratings[0]).toContain("Fail");
    expect(ratings[1]).toContain("AAA");
    expect(text).toContain("1 of 2 pairs are below AA.");

    expect(container.querySelector("[data-testid='website-style-font']")?.textContent).toContain("Weights 400, 700");
    expect(container.querySelector("[data-testid='website-style-type-scale']")?.textContent).toContain("4rem · weight 700 · line 1.05");
    expect(container.querySelector("[data-testid='website-style-block']")?.textContent).toContain("class=\"btn btn--primary\"");
    expect(container.querySelector("[data-testid='website-style-token']")?.textContent).toContain("--gs-radius");
    // The site's Google Fonts load while the tab is open.
    expect(document.head.querySelector("link[data-website-style-font]")?.getAttribute("href")).toContain("Montserrat");
  });

  it("Ask an agent opens a task with the token attached", () => {
    const onAsk = vi.fn();
    act(() => root.render(<WebsiteStyleView style={style} siteName="Greatstone" onAsk={onAsk} />));
    const ask = container.querySelector<HTMLButtonElement>("button[aria-label='Ask an agent about Accent']");
    act(() => ask!.click());
    expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ title: "Style: Accent colour (--gs-accent)" }));
    const { description } = onAsk.mock.calls[0]![0] as { description: string };
    expect(description).toContain("`--gs-accent` (release theme token `gs.accent`)");
    expect(description).toContain("Value now: `#c8ff00`");
    expect(description).toContain("`.btn--primary`");
  });

  it("says when the site could not be read, and keeps the theme tokens", () => {
    act(() => root.render(<WebsiteStyleView style={{ ...style, problem: "The site could not be read: timeout" }} siteName="Greatstone" onAsk={vi.fn()} />));
    expect(container.querySelector("[role='alert']")?.textContent).toContain("The theme tokens below still show.");
  });

  it("shows an empty state when nothing was found", () => {
    act(() => root.render(
      <WebsiteStyleView style={{ ...style, colours: [], contrast: [], fonts: [], textStyles: [], components: [], tokens: [], surfaces: [] }} siteName="Greatstone" onAsk={vi.fn()} />,
    ));
    expect(container.querySelector("[data-testid='website-style-empty']")).not.toBeNull();
  });
});

describe("blockStyle", () => {
  it("keeps what draws the block and drops layout, motion and relative files", () => {
    expect(blockStyle({
      background: "#c8ff00", "border-radius": "999px", position: "absolute", transition: "all .2s",
      "background-image": "url(/img/x.png)", "font-weight": "600",
    })).toEqual({ background: "#c8ff00", borderRadius: "999px", fontWeight: "600" });
  });
});

describe("styleTaskDefaults", () => {
  it("leaves out the release token and uses when there are none", () => {
    const task = styleTaskDefaults("Greatstone", { label: "--gs-radius", name: "--gs-radius", token: null, value: "14px" });
    expect(task.description).not.toContain("release theme token");
    expect(task.description).not.toContain("Used in");
  });
});
