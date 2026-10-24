// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteModuleCard, WebsiteSite } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modulesApiMock = vi.hoisted(() => ({ cards: vi.fn(), addStartingSet: vi.fn() }));
vi.mock("../../../api/website-modules", () => ({ websiteModulesApi: modulesApiMock }));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { Link: actual.Link };
});

import { WebsiteModulesSection, taskLine } from "./WebsiteModuleCards";
import { parseCollections, parseLines } from "./module-settings";

const site = { id: "site-1", companyId: "co-1", name: "Greatstone", domain: "greatstone.example" } as WebsiteSite;

function card(key: string, overrides: Partial<WebsiteModuleCard> = {}, module: Partial<WebsiteModuleCard["module"]> = {}): WebsiteModuleCard {
  return {
    module: {
      id: `m-${key}`,
      companyId: "co-1",
      siteId: "site-1",
      key,
      name: key,
      purpose: "",
      icon: "blocks",
      ownerUserId: null,
      leadAgentId: null,
      projectId: null,
      routePrefixes: [],
      collections: [],
      enabled: true,
      sortOrder: 0,
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:00:00.000Z",
      ...module,
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
  modulesApiMock.cards.mockReset();
  modulesApiMock.addStartingSet.mockReset();
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
          <WebsiteModulesSection companyId="co-1" site={site} canChange={canChange} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const cards = () => Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-testid="website-module-card"]'));

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

describe("WebsiteModulesSection", () => {
  it("shows one card per module, with the owner only when one is set, and links to the module page", async () => {
    modulesApiMock.cards.mockResolvedValue([
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
    expect(shop!.getAttribute("href")).toBe("/website/sites/site-1/modules/m-shop");
    expect(shop!.textContent).toContain("Owner: Ben · Lead: Lintel");
    expect(shop!.textContent).toContain("5 open tasks · 1 needs a person");
    expect(shop!.textContent).toContain("Release 9");
    expect(shop!.textContent).toContain("12 pages");
    expect(shop!.querySelector('[data-testid="website-module-health"]')?.getAttribute("data-state")).toBe("attention");
    expect(shop!.querySelector('[data-testid="website-module-health"]')?.getAttribute("title")).toBe("Release 9 changed these pages and failed.");
    // No owner set: no empty owner line at all.
    expect(hub!.textContent).not.toContain("Owner");
    expect(hub!.textContent).toContain("Off");
    // No project: no tasks line, so the card leads with its release.
    expect(hub!.textContent).not.toContain("No project linked");
    expect(hub!.textContent).not.toContain("open task");
    expect(hub!.textContent).toContain("No release has changed it yet");
  });

  it("offers the starting modules to a person with Publish rights when there are none", async () => {
    modulesApiMock.cards.mockResolvedValue([]);
    modulesApiMock.addStartingSet.mockResolvedValue([]);
    await render(true);
    await vi.waitFor(() => expect(container.querySelector('[data-testid="website-home-modules-empty"]')).not.toBeNull());
    const button = Array.from(container.querySelectorAll("button")).find((el) => el.textContent === "Add the starting modules")!;
    await act(async () => { button.click(); });
    expect(modulesApiMock.addStartingSet).toHaveBeenCalledWith("co-1", "site-1");
  });

  it("tells someone without Publish rights who adds modules, with no button", async () => {
    modulesApiMock.cards.mockResolvedValue([]);
    await render(false);
    await vi.waitFor(() => expect(container.textContent).toContain("A person with Publish rights adds the site's modules."));
    expect(container.querySelector("button")).toBeNull();
  });
});
