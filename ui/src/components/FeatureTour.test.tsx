// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TourDefinition } from "@/lib/feature-tours";
import { tourSeenKey } from "@/hooks/useTourSeen";
import { FeatureTour, findTourTarget } from "./FeatureTour";

const flags = vi.hoisted(() => ({ enablePipelines: true }));
// The server's copy of "seen", shared by every "device" (fresh storage + query cache) in a test.
const server = vi.hoisted(() => ({
  rows: [] as Array<{ tourKey: string; tourVersion: number; seenAt: string }>,
  fail: false,
  pending: false,
  puts: [] as Array<[string, number]>,
}));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ ...flags }) } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "ama" } }) } }));
vi.mock("@/api/tourDismissals", () => ({
  tourDismissalsApi: {
    list: async () => {
      if (server.pending) return new Promise(() => {});
      if (server.fail) throw new Error("offline");
      return server.rows.map((row) => ({ ...row }));
    },
    markSeen: async (tourKey: string, tourVersion: number) => {
      server.puts.push([tourKey, tourVersion]);
      if (server.fail) throw new Error("offline");
      if (!server.rows.some((row) => row.tourKey === tourKey && row.tourVersion === tourVersion)) {
        server.rows.push({ tourKey, tourVersion, seenAt: "2026-10-10T00:00:00.000Z" });
      }
    },
    reset: async () => { server.rows = []; },
  },
}));

const tour: TourDefinition = {
  id: "pipelines-list",
  version: 1,
  flag: "enablePipelines",
  label: "the test page",
  title: "Test",
  description: "A test tour.",
  steps: [
    { target: "one", title: "First", body: "One." },
    { target: "missing", title: "Missing", body: "Not on the page." },
    { target: "two", title: "Second", body: "Two." },
  ],
};

let root: Root | undefined;
let container: HTMLDivElement;
let search = "";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  flags.enablePipelines = true;
  server.rows = [];
  server.fail = false;
  server.pending = false;
  server.puts = [];
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function LocationProbe() {
  search = useLocation().search;
  return null;
}

/** A fresh render with a fresh query cache: a new page load (or another device, after localStorage.clear()). */
async function render(url = "/page", onClose?: () => void, shown: TourDefinition = tour) {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/page" element={(
            <>
              <div data-tour="one">one</div>
              <div data-tour="two">two</div>
              <FeatureTour tour={shown} onClose={onClose} />
              <LocationProbe />
            </>
          )} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  for (let i = 0; i < 4; i += 1) await flush();
}

const card = () => document.querySelector<HTMLElement>('[data-testid="feature-tour"]');
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === text) as HTMLButtonElement | undefined;
const press = (key: string) => act(async () => {
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
});

describe("FeatureTour", () => {
  it("opens by itself on the first visit and is marked seen on Skip", async () => {
    await render();
    expect(card()?.textContent).toContain("Step 1 of 2");
    expect(document.querySelector('[data-tour="one"]')?.hasAttribute("data-tour-active")).toBe(true);
    expect(server.rows).toEqual([]); // Opening alone is not "seen".

    await act(async () => button("Skip")!.click());
    await flush();
    expect(card()).toBeNull();
    expect(server.rows.map((row) => [row.tourKey, row.tourVersion])).toEqual([["pipelines-list", 1]]);

    await render();
    expect(card()).toBeNull();
  });

  it("tells the page when the tour ends, so it can put the scroll back", async () => {
    const onClose = vi.fn();
    await render("/page", onClose);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => button("Next")!.click());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => button("Done")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays seen on another device through the server", async () => {
    await render();
    await act(async () => button("Next")!.click());
    await act(async () => button("Done")!.click());
    await flush();

    localStorage.clear(); // A second device: nothing stored locally.
    await render();
    expect(card()).toBeNull();
  });

  it("does not flash the tour while the server is still answering", async () => {
    server.pending = true;
    await render();
    expect(card()).toBeNull();
    expect(button("Show me around")).toBeDefined();
  });

  it("falls back to this browser's flag when the server fails, so it never nags", async () => {
    server.fail = true;
    await render();
    expect(card()?.textContent).toContain("Step 1 of 2"); // Not seen anywhere yet.
    await act(async () => button("Skip")!.click());
    await flush();
    expect(localStorage.getItem(tourSeenKey(tour, "ama"))).toBe("1");

    await render();
    expect(card()).toBeNull();
  });

  it("moves an old localStorage flag to the server once", async () => {
    localStorage.setItem(tourSeenKey(tour, "ama"), "1");
    await render();
    expect(card()).toBeNull();
    expect(server.puts).toEqual([["pipelines-list", 1]]);
    expect(server.rows).toHaveLength(1);

    await render();
    expect(server.puts).toHaveLength(1); // Idempotent: nothing to move the second time.
  });

  it("replays from the Show me around button without resetting seen", async () => {
    server.rows = [{ tourKey: "pipelines-list", tourVersion: 1, seenAt: "2026-10-01T00:00:00.000Z" }];
    await render();
    expect(card()).toBeNull();
    await act(async () => button("Show me around")!.click());
    expect(card()?.textContent).toContain("Step 1 of 2");
    await act(async () => button("Skip")!.click());
    await flush();
    expect(server.rows).toHaveLength(1);
    expect(server.rows[0].seenAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("starts at once from ?tour= even when seen, then drops the parameter", async () => {
    server.rows = [{ tourKey: "pipelines-list", tourVersion: 1, seenAt: "2026-10-01T00:00:00.000Z" }];
    await render("/page?tour=pipelines-list");
    expect(card()?.textContent).toContain("Step 1 of 2");
    expect(search).toBe("");
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
    await render("/page?tour=pipelines-list");
    expect(card()).toBeNull();
    expect(button("Show me around")).toBeUndefined();
    expect(server.puts).toEqual([]);
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

  describe("everyday page tours", () => {
    const everyday: TourDefinition = {
      id: "dashboard",
      version: 1,
      autoStart: false,
      label: "Home",
      title: "Home",
      description: "An everyday page.",
      steps: [
        { title: "About this page", body: "General." },
        { target: "one", title: "First", body: "One." },
        { target: "missing", title: "Missing", body: "Not on the page." },
      ],
    };
    const dot = () => document.querySelector('[data-testid="feature-tour-new-dot"]');

    it("never opens by itself, and marks the button with a dot until seen", async () => {
      flags.enablePipelines = false; // No switch: always on.
      await render("/page", undefined, everyday);
      expect(card()).toBeNull();
      expect(dot()).not.toBeNull();
      expect(button("Show me around")?.getAttribute("aria-label")).toContain("not seen yet");

      await act(async () => button("Show me around")!.click());
      expect(card()?.textContent).toContain("Step 1 of 2");
      expect(card()?.textContent).toContain("About this page");
      expect(document.querySelector("[data-tour-active]")).toBeNull(); // A general card points at nothing.
      await act(async () => button("Next")!.click());
      expect(document.querySelector('[data-tour="one"]')?.hasAttribute("data-tour-active")).toBe(true);
      await act(async () => button("Done")!.click());
      await flush();
      expect(dot()).toBeNull();
      expect(server.rows.map((row) => row.tourKey)).toEqual(["dashboard"]);
    });

    it("still starts from ?tour= on an everyday page", async () => {
      await render("/page?tour=dashboard", undefined, everyday);
      expect(card()?.textContent).toContain("About this page");
      expect(search).toBe("");
    });

    it("shows the general cards when asked even if none of the page's elements are there", async () => {
      const bare: TourDefinition = { ...everyday, steps: [everyday.steps[0], everyday.steps[2]] };
      await render("/page", undefined, bare);
      await act(async () => button("Show me around")!.click());
      expect(card()?.textContent).toContain("Step 1 of 1");
    });
  });
});

describe("findTourTarget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("finds a data-tour anchor, or a page's own data-testid when there is none", () => {
    document.body.innerHTML = '<div data-testid="blocked-inbox">list</div><div data-tour="period">period</div>';
    expect(findTourTarget("period")?.textContent).toBe("period");
    expect(findTourTarget("blocked-inbox")?.textContent).toBe("list");
    expect(findTourTarget("missing")).toBeNull();
  });
});
