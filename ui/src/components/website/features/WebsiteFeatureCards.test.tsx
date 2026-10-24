// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteFeatureCard, WebsiteSite } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const featuresApiMock = vi.hoisted(() => ({ cards: vi.fn(), create: vi.fn() }));
vi.mock("../../../api/website-features", () => ({ websiteFeaturesApi: featuresApiMock }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { Link: actual.Link };
});

import { WebsiteFeaturesSection, taskLine } from "./WebsiteFeatureCards";
import { parseCollections, parseLines } from "./feature-settings";

const site = { id: "site-1", companyId: "co-1", name: "Greatstone", domain: "greatstone.example" } as WebsiteSite;

function card(key: string, overrides: Partial<WebsiteFeatureCard> = {}, feature: Partial<WebsiteFeatureCard["feature"]> = {}): WebsiteFeatureCard {
  return {
    feature: {
      id: `m-${key}`,
      companyId: "co-1",
      siteId: "site-1",
      key,
      name: key,
      purpose: "",
      icon: "blocks",
      ownerUserId: null,
      suggestedOwner: null,
      leadAgentId: null,
      projectId: null,
      routePrefixes: [],
      collections: [],
      adminScreens: [],
      enabled: true,
      sortOrder: 0,
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
      ...feature,
    },
    ownerName: null,
    leadAgentName: null,
    pageCount: 0,
    openTasks: null,
    needsPerson: null,
    lastRelease: null,
    views: null,
    health: { state: "unknown", reason: "No traffic or release data for these pages yet." },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  featuresApiMock.cards.mockReset();
  featuresApiMock.create.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(canChange: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WebsiteFeaturesSection companyId="co-1" site={site} canChange={canChange} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const cards = () => Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-testid="website-feature-card"]'));

describe("taskLine and the settings parsers", () => {
  it("says what a card's task count means", () => {
    expect(taskLine({ openTasks: null, needsPerson: null }).text).toBe("No project linked");
    expect(taskLine({ openTasks: 1, needsPerson: 0 }).text).toBe("1 open task");
    expect(taskLine({ openTasks: 4, needsPerson: 2 })).toEqual({ text: "4 open tasks · 2 need a person", needsPerson: 2 });
    expect(taskLine({ openTasks: 4, needsPerson: 1 }).text).toBe("4 open tasks · 1 needs a person");
  });

  it("reads routes one per line and collections by comma", () => {
    expect(parseLines(" /dev-tools \n\n/account/orders\n")).toEqual(["/dev-tools", "/account/orders"]);
    expect(parseCollections("product, vendor  category,")).toEqual(["product", "vendor", "category"]);
  });
});

describe("WebsiteFeaturesSection", () => {
  it("shows one card per feature, with the owner only when one is set, and links to the feature page", async () => {
    featuresApiMock.cards.mockResolvedValue([
      card("shop", {
        ownerName: "Ben",
        leadAgentName: "Lintel",
        openTasks: 5,
        needsPerson: 1,
        pageCount: 12,
        lastRelease: { id: "r9", number: 9, status: "failed", at: "2026-10-23T09:00:00.000Z" },
        health: { state: "attention", reason: "Release 9 changed these pages and failed." },
      }, { name: "Shop and licences" }),
      card("intelligence-hub", {}, { name: "Intelligence hub", enabled: false }),
    ]);
    await render(true);
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    const [shop, hub] = cards();
    expect(shop!.getAttribute("href")).toBe("/website/sites/site-1/features/m-shop");
    expect(shop!.textContent).toContain("Owner: Ben · Lead: Lintel");
    expect(shop!.textContent).toContain("5 open tasks · 1 needs a person");
    expect(shop!.textContent).toContain("Release 9");
    expect(shop!.textContent).toContain("12 pages");
    expect(shop!.querySelector('[data-testid="website-feature-health"]')?.getAttribute("data-state")).toBe("attention");
    expect(shop!.querySelector('[data-testid="website-feature-health"]')?.getAttribute("title")).toBe("Release 9 changed these pages and failed.");
    // No owner set: no empty owner line at all.
    expect(hub!.textContent).not.toContain("Owner");
    expect(hub!.textContent).toContain("Off");
    // No project: no tasks line, so the card leads with its release.
    expect(hub!.textContent).not.toContain("No project linked");
    expect(hub!.textContent).not.toContain("open task");
    expect(hub!.textContent).toContain("No release has changed it yet");
  });

  it("offers a blank feature form, with no other site's features in it, when the site has none", async () => {
    featuresApiMock.cards.mockResolvedValue([]);
    featuresApiMock.create.mockResolvedValue(card("careers").feature);
    await render(true);
    await vi.waitFor(() => expect(container.querySelector('[data-testid="website-home-features-empty"]')).not.toBeNull());
    expect(container.textContent).toContain("Add your first feature");
    expect(container.textContent).not.toMatch(/Shop and licences|Deep Dive|Intelligence hub/);
    const button = Array.from(container.querySelectorAll("button")).find((el) => el.textContent === "Add your first feature")!;
    await act(async () => { button.click(); });
    const dialog = document.body.querySelector<HTMLElement>('[data-testid="website-add-feature-dialog"]')!;
    const type = (id: string, value: string) => {
      const field = dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
      act(() => {
        setter.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    for (const id of ["new-feature-name", "new-feature-purpose", "new-feature-routes"]) {
      expect((dialog.querySelector<HTMLInputElement>(`#${id}`))!.value).toBe("");
    }
    type("new-feature-name", "Careers ");
    type("new-feature-routes", "/careers\n\n/jobs");
    await act(async () => { dialog.querySelector("form")!.requestSubmit(); });
    expect(featuresApiMock.create).toHaveBeenCalledWith("co-1", "site-1", { name: "Careers", purpose: "", icon: "blocks", routePrefixes: ["/careers", "/jobs"] });
  });

  it("tells someone without Publish rights who adds features, with no button", async () => {
    featuresApiMock.cards.mockResolvedValue([]);
    await render(false);
    await vi.waitFor(() => expect(container.textContent).toContain("A person with Publish rights adds the site's features."));
    expect(container.textContent).toContain("No features yet");
    expect(container.querySelector("button")).toBeNull();
  });
});
