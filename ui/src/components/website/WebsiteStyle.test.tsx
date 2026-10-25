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
    { cssVar: "--gs-bg", aliases: [], token: null, name: "Bg", value: "#0b0b0c", hex: "#0b0b0c", alpha: 1, role: "background", usedFor: ["background"], usedIn: ["body"], unused: false, source: "stylesheet" },
    { cssVar: "--gs-text", aliases: ["--gs-ink"], token: null, name: "Text", value: "#f5f5f0", hex: "#f5f5f0", alpha: 1, role: "text", usedFor: ["text"], usedIn: ["body"], unused: false, source: "stylesheet" },
    { cssVar: "--gs-muted", aliases: [], token: null, name: "Muted", value: "#3a3a3a", hex: "#3a3a3a", alpha: 1, role: "text", usedFor: ["text"], usedIn: ["small"], unused: false, source: "stylesheet" },
    { cssVar: "--gs-accent", aliases: [], token: "gs.accent", name: "Accent", value: "#c8ff00", hex: "#c8ff00", alpha: 1, role: "accent", usedFor: ["background"], usedIn: [".btn--primary"], unused: false, source: "release" },
    { cssVar: "--teal", aliases: [], token: null, name: "Teal", value: "#20c997", hex: "#20c997", alpha: 1, role: "other", usedFor: [], usedIn: [], unused: true, source: "stylesheet" },
  ],
  contrast: [
    { text: "#f5f5f0", textName: "Text", background: "#0b0b0c", backgroundName: "Bg", usedIn: ["body", "a"], ratio: 18.1, rating: "AAA" },
    { text: "#3a3a3a", textName: "Muted", background: "#0b0b0c", backgroundName: "Bg", usedIn: ["small"], ratio: 1.6, rating: "Fail" },
  ],
  fonts: [{ family: "Montserrat", stack: "\"Montserrat\", sans-serif", weights: [400, 700], usedIn: ["body"], loadedFrom: "google" }],
  textStyles: [
    { selector: "h1", label: "Heading 1", fontFamily: "Montserrat", fontSize: "4rem", fontWeight: "700", lineHeight: "1.05", letterSpacing: null, textTransform: null, color: null },
  ],
  components: [
    { kind: "button", selector: ".btn", className: "btn", label: "Btn", declarations: { padding: "12px 20px", border: "1px solid transparent", "border-radius": "999px" }, inPage: true },
    { kind: "button", selector: ".btn--primary", className: "btn btn--primary", label: "Btn primary", declarations: { background: "#c8ff00", color: "#0b0b0c", "border-radius": "999px" }, inPage: true },
    { kind: "button", selector: ".btn-danger", className: "btn btn-danger", label: "Btn danger", declarations: { background: "#e74c3c" }, inPage: false },
  ],
  tokens: [
    { name: "--gs-radius", token: null, value: "14px", kind: "radius", source: "stylesheet", framework: false },
    { name: "--breakpoint-md", token: null, value: "768px", kind: "other", source: "stylesheet", framework: true },
    { name: "@keyframes spinner-grow", token: null, value: "animation", kind: "motion", source: "stylesheet", framework: true },
  ],
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
  it("shows the palette by role, the contrast pairs as the read orders them, fonts, blocks and tokens", () => {
    act(() => root.render(<WebsiteStyleView style={style} siteName="Greatstone" onAsk={vi.fn()} />));
    const text = container.textContent ?? "";
    expect(text).toContain("Backgrounds");
    expect(text).toContain("Accents");
    expect(container.querySelectorAll("[data-testid='website-style-colour']")).toHaveLength(4);
    expect(text).toContain("Theme"); // the release token badge on Accent
    // One swatch per colour, with its other variables beside it.
    expect(container.querySelectorAll("[data-testid='website-style-colour']")[1]?.textContent).toContain("--gs-ink");
    expect(text).toContain("1 release theme override");

    // Body text first, as the read orders it (most of the page first), not worst first.
    const ratings = [...container.querySelectorAll("[data-testid='website-style-contrast-pair']")].map((row) => row.textContent);
    expect(ratings[0]).toContain("Text on Bg");
    expect(ratings[0]).toContain("body, a");
    expect(ratings[0]).toContain("AAA");
    expect(ratings[1]).toContain("Fail");
    expect(text).toContain("1 of 2 pairs are below AA.");

    expect(container.querySelector("[data-testid='website-style-font']")?.textContent).toContain("Weights 400, 700");
    expect(container.querySelector("[data-testid='website-style-type-scale']")?.textContent).toContain("4rem · weight 700 · line 1.05");
    const blocks = container.querySelectorAll("[data-testid='website-style-block']");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.textContent).toContain("No fill (base class)");
    expect(blocks[1]?.textContent).toContain("class=\"btn btn--primary\"");
    expect(blocks[1]?.textContent).not.toContain("No fill");
    expect(container.querySelectorAll("[data-testid='website-style-token']")).toHaveLength(1);
    expect(container.querySelector("[data-testid='website-style-token']")?.textContent).toContain("--gs-radius");
    expect(text).not.toContain("Motion the page runs");
    // The site's Google Fonts load while the tab is open.
    expect(document.head.querySelector("link[data-website-style-font]")?.getAttribute("href")).toContain("Montserrat");
  });

  it("folds unused colours, unused block variants and framework tokens until asked", () => {
    act(() => root.render(<WebsiteStyleView style={style} siteName="Greatstone" onAsk={vi.fn()} />));
    const open = (testId: string, label: string) => {
      const button = container.querySelector<HTMLButtonElement>(`[data-testid='${testId}'] button`);
      expect(button?.textContent).toBe(label);
      expect(button?.getAttribute("aria-expanded")).toBe("false");
      act(() => button!.click());
      expect(button?.getAttribute("aria-expanded")).toBe("true");
      return container.querySelector(`[data-testid='${testId}']`)?.textContent ?? "";
    };
    expect(container.textContent).not.toContain("#20c997");
    expect(open("website-style-unused-colours", "Defined but unused (1)")).toContain("Not used on the page");
    expect(open("website-style-more-blocks", "More variants the stylesheet defines (1)")).toContain("Btn danger");
    const framework = open("website-style-framework-tokens", "From frameworks or not used on the page (2)");
    expect(framework).toContain("--breakpoint-md");
    expect(framework).not.toContain("Ask an agent");
  });

  it("says when the release theme sets nothing", () => {
    act(() => root.render(<WebsiteStyleView style={{ ...style, releaseTokenCount: 0 }} siteName="Greatstone" onAsk={vi.fn()} />));
    expect(container.textContent).toContain("No release theme overrides");
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
