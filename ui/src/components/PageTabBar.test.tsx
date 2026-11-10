// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Tabs } from "@/components/ui/tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const screen = vi.hoisted(() => ({ isMobile: true }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ ...screen }) }));

const { PageTabBar } = await import("./PageTabBar");

const items = [
  { value: "general", label: "General" },
  { value: "security", label: "Security" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  screen.isMobile = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(<Tabs value="general">{node}</Tabs>));
}

it("labels the phone picker when a page stacks two of them", () => {
  render(<PageTabBar items={items} value="general" onValueChange={() => {}} mobileLabel="Section of this page" />);
  const select = container.querySelector("select")!;
  expect(select.closest("label")?.textContent).toContain("Section of this page");
});

it("keeps the phone picker unlabelled by default", () => {
  render(<PageTabBar items={items} value="general" onValueChange={() => {}} />);
  expect(container.querySelector("label")).toBeNull();
  expect(container.querySelector("select")?.getAttribute("aria-label")).toBe("Page section");
});

it("names the tab list on a computer, so a tour can point at it", () => {
  screen.isMobile = false;
  render(<PageTabBar items={items} value="general" onValueChange={() => {}} ariaLabel="Website section" />);
  expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Website section");
});
