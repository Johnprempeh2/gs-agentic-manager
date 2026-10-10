// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TourDefinition } from "@/lib/feature-tours";
import { FeatureTour, tourSeenKey } from "./FeatureTour";

const flags = vi.hoisted(() => ({ enablePipelines: true }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ ...flags }) } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "ama" } }) } }));

const tour: TourDefinition = {
  id: "test",
  version: 1,
  flag: "enablePipelines",
  label: "the test page",
  steps: [
    { target: "one", title: "First", body: "One." },
    { target: "missing", title: "Missing", body: "Not on the page." },
    { target: "two", title: "Second", body: "Two." },
  ],
};

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  flags.enablePipelines = true;
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function render() {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <QueryClientProvider client={new QueryClient()}>
      <div data-tour="one">one</div>
      <div data-tour="two">two</div>
      <FeatureTour tour={tour} />
    </QueryClientProvider>,
  ));
  await flush();
  await flush();
}

const card = () => document.querySelector<HTMLElement>('[data-testid="feature-tour"]');
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === text) as HTMLButtonElement | undefined;
const press = (key: string) => act(async () => {
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
});

describe("FeatureTour", () => {
  it("opens by itself on the first visit only", async () => {
    await render();
    expect(card()?.textContent).toContain("Step 1 of 2");
    expect(card()?.textContent).toContain("First");
    expect(document.querySelector('[data-tour="one"]')?.hasAttribute("data-tour-active")).toBe(true);
    expect(localStorage.getItem(tourSeenKey(tour, "ama"))).toBe("1");

    await render();
    expect(card()).toBeNull();
  });

  it("replays from the Show me around button", async () => {
    localStorage.setItem(tourSeenKey(tour, "ama"), "1");
    await render();
    expect(card()).toBeNull();
    await act(async () => button("Show me around")!.click());
    expect(card()?.textContent).toContain("Step 1 of 2");
  });

  it("skips steps whose element is not on the page", async () => {
    await render();
    await act(async () => button("Next")!.click());
    expect(card()?.textContent).toContain("Step 2 of 2");
    expect(card()?.textContent).toContain("Second");
    expect(card()?.textContent).not.toContain("Missing");
    await act(async () => button("Done")!.click());
    expect(card()).toBeNull();
    expect(document.querySelector("[data-tour-active]")).toBeNull();
  });

  it("shows no tour and no button while the feature is switched off", async () => {
    flags.enablePipelines = false;
    await render();
    expect(card()).toBeNull();
    expect(button("Show me around")).toBeUndefined();
    expect(localStorage.getItem(tourSeenKey(tour, "ama"))).toBeNull();
  });

  it("works from the keyboard", async () => {
    await render();
    expect(document.activeElement).toBe(button("Next"));
    await press("ArrowRight");
    expect(card()?.textContent).toContain("Step 2 of 2");
    expect(document.activeElement).toBe(button("Done"));
    await press("ArrowLeft");
    expect(card()?.textContent).toContain("Step 1 of 2");
    await press("Escape");
    expect(card()).toBeNull();
    expect(document.activeElement?.textContent).toContain("Show me around");
  });
});
