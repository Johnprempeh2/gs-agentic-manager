// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsitePage } from "@greatstone/shared";
import { pagesLookup, type Tree } from "./model";
import { SitemapBoardView } from "./SitemapBoard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = { menu: "none" as const, menuOrder: 0, pageId: null };
const start: Tree = {
  nodes: [
    { ...base, id: "home", title: "Home", path: "/", parentId: null, order: 0 },
    { ...base, id: "services", title: "Services", path: "/services", parentId: "home", order: 0 },
    { ...base, id: "audit", title: "Website audit", path: "/services/audit", parentId: "services", order: 0 },
    { ...base, id: "about", title: "About", path: "/about", parentId: "home", order: 1 },
  ],
  journeys: [],
};

let container: HTMLDivElement;
let root: Root;
let latest: Tree;

function Board({ readOnly = false }: { readOnly?: boolean }) {
  const [tree, setTree] = useState(start);
  latest = tree;
  return <SitemapBoardView tree={tree} onChange={setTree} pagesById={pagesLookup([])} readOnly={readOnly} storageKey="test-board" />;
}

const cards = () => [...container.querySelectorAll("[data-board-node]")].map((el) => el.getAttribute("data-board-node"));
const card = (id: string) => container.querySelector(`[data-board-node="${id}"]`) as HTMLElement;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label) as HTMLButtonElement;
const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init })); });

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Sitemap board navigation", () => {
  it("moves between cards with the arrow keys and nudges a card with Alt", () => {
    act(() => root.render(<Board />));
    card("home").focus();
    press(card("home"), "ArrowDown");
    expect(document.activeElement).toBe(card("services"));
    press(card("services"), "ArrowRight");
    expect(document.activeElement).toBe(card("audit"));
    press(card("audit"), "ArrowLeft");
    expect(document.activeElement).toBe(card("services"));
    // The board stays tidy: Alt with the arrows no longer drags cards out of place.
    press(card("services"), "ArrowDown", { altKey: true });
    expect(latest).toBe(start);
  });

  it("lays out top to bottom: sections in a row under Home, pages stacked under their section (GRE-2542)", () => {
    act(() => root.render(<Board />));
    const at = (id: string) => {
      const li = card(id).parentElement as HTMLElement;
      return { x: parseFloat(li.style.left), y: parseFloat(li.style.top) };
    };
    expect(at("services").y).toBe(at("about").y);
    expect(at("services").y).toBeGreaterThan(at("home").y);
    expect(at("audit").y).toBeGreaterThan(at("services").y);
    expect(at("audit").x).toBeGreaterThan(at("services").x);
    expect(at("audit").x).toBeLessThan(at("about").x);
  });

  it("opens sections of more than 8 pages folded behind +N pages, and a click shows them", () => {
    const pages = Array.from({ length: 9 }, (_, i) => ({ ...base, id: `p${i}`, title: `Guide ${i}`, path: `/services/guide-${i}`, parentId: "services", order: i + 1 }));
    function Big() {
      const [tree, setTree] = useState<Tree>({ ...start, nodes: [...start.nodes, ...pages] });
      return <SitemapBoardView tree={tree} onChange={setTree} pagesById={pagesLookup([])} readOnly={false} storageKey="test-board" />;
    }
    act(() => root.render(<Big />));
    expect(cards()).toEqual(["home", "services", "about"]);
    const more = container.querySelector('[data-board-more="services"]') as HTMLButtonElement;
    expect(more.textContent).toBe("+10 pages");
    act(() => more.click());
    expect(cards()).toContain("p8");
    expect(container.querySelector('[data-board-more="services"]')).toBeNull();
  });

  it("opens a page that exists in the editor", () => {
    const onEditPage = vi.fn();
    const page = { id: "page-audit", slug: "/services/audit", status: "draft" } as unknown as WebsitePage;
    act(() => root.render(<SitemapBoardView tree={start} onChange={() => {}} pagesById={pagesLookup([page])} readOnly={false} onEditPage={onEditPage} />));
    const open = () => [...container.querySelectorAll("button")].filter((el) => el.textContent?.trim() === "Open in editor");
    // Only the card with a page offers it.
    expect(open()).toHaveLength(1);
    act(() => open()[0]!.click());
    expect(onEditPage).toHaveBeenCalledWith("page-audit");
  });

  it("folds a branch from its card, collapses and expands all, and remembers it", () => {
    act(() => root.render(<Board />));
    act(() => button("Fold the sub-pages of Services").click());
    expect(cards()).toEqual(["home", "services", "about"]);
    expect(JSON.parse(window.localStorage.getItem("gsam.diagram.test-board")!).collapsed).toEqual(["services"]);
    act(() => button("Expand all").click());
    expect(cards()).toContain("audit");
    act(() => button("Collapse all").click());
    expect(cards()).toEqual(["home", "services", "about"]);
  });

  it("finds a page by name, unfolding the way to it and highlighting it", () => {
    act(() => root.render(<Board readOnly />));
    act(() => button("Collapse all").click());
    expect(cards()).not.toContain("audit");
    const input = container.querySelector("[data-diagram-find]") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "audit");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    press(input, "Enter");
    expect(card("audit").hasAttribute("data-found")).toBe(true);
    expect(document.activeElement).toBe(card("audit"));
  });

  it("goes full screen with the toolbar", async () => {
    const request = vi.fn(async () => {});
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
    try {
      act(() => root.render(<Board />));
      await act(async () => button("Full screen").click());
      const frame = container.querySelector("[data-diagram-frame]")!;
      expect(frame.getAttribute("aria-label")).toBe("Sitemap board");
      expect(frame.getAttribute("data-fullscreen")).toBe("native");
      expect(frame.querySelector('[data-testid="sitemap-board-canvas"]')).not.toBeNull();
      expect(button("Exit full screen")).toBeTruthy();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    }
  });
});
