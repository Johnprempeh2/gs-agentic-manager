// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteProperty, WebsiteSite } from "@greatstone/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moduleMock = vi.hoisted(() => ({ sites: vi.fn(), createSite: vi.fn(), updateSite: vi.fn(), pages: vi.fn() }));
const canManage = vi.hoisted(() => ({ value: true }));
vi.mock("../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../api/website")>("../../api/website");
  return { ...actual, websiteModuleApi: moduleMock };
});
vi.mock("./WebsiteSetup", () => ({ useCanManageWebsite: () => ({ canManage: canManage.value, isLoading: false }) }));

import { WebsiteSiteConnection, domainFromSiteUrl } from "./WebsiteSiteConnection";

const property: WebsiteProperty = {
  id: "prop-1",
  companyId: "co-1",
  name: "Greatstone",
  siteUrl: "https://www.greatstone.example/",
  ga4PropertyId: null,
  projectId: null,
  connectionStatus: "not_connected",
  connectedAt: null,
  lastPullAt: null,
  lastPullStatus: null,
  lastPullErrors: [],
  nextPullDueAt: null,
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
};

function site(overrides: Partial<WebsiteSite> = {}): WebsiteSite {
  return {
    id: "site-1",
    companyId: "co-1",
    name: "Greatstone",
    domain: "www.greatstone.example",
    repoUrl: "https://github.com/acme/site",
    netlifySiteId: "netlify-123",
    hasNetlifyToken: true,
    blobsStoreName: "gsam-content",
    engineVersion: null,
    releaseSchemaVersion: 1,
    propertyId: "prop-1",
    editorOrigins: [],
    checkPaths: ["/"],
    liveReleaseId: null,
    archivedAt: null,
    createdAt: "2026-10-23T09:00:00.000Z",
    updatedAt: "2026-10-23T09:00:00.000Z",
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("WebsiteSiteConnection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    canManage.value = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <WebsiteSiteConnection companyId="co-1" property={property} />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("reads the domain from a site address or a Search Console domain", () => {
    expect(domainFromSiteUrl("https://www.example.com/")).toBe("www.example.com");
    expect(domainFromSiteUrl("sc-domain:Example.com")).toBe("example.com");
  });

  it("shows the connected site and says a token is stored, without any token value", async () => {
    moduleMock.sites.mockResolvedValue([site()]);
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("netlify-123");
    expect(text).toContain("Token saved.");
    expect(text).toContain("Live address");
    expect(container.querySelector("button")?.textContent).toBe("Change");
  });

  it("connects a site for the property, with the domain filled from its address", async () => {
    moduleMock.sites.mockResolvedValue([]);
    moduleMock.createSite.mockResolvedValue(site());
    await render();
    const connect = [...container.querySelectorAll("button")].find((button) => button.textContent === "Connect a site")!;
    expect(container.textContent).toContain("Connect your website");
    expect(container.textContent).not.toMatch(/published/i);
    await act(async () => connect.click());
    const domain = container.querySelector<HTMLInputElement>("#website-site-prop-1-domain")!;
    expect(domain.value).toBe("www.greatstone.example");
    await act(async () => {
      setValue(container.querySelector<HTMLInputElement>("#website-site-prop-1-netlify")!, "netlify-123");
      setValue(container.querySelector<HTMLInputElement>("#website-site-prop-1-token")!, "nfp_secret_token");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(moduleMock.createSite).toHaveBeenCalledWith("co-1", {
      name: "Greatstone",
      domain: "www.greatstone.example",
      repoUrl: null,
      netlifySiteId: "netlify-123",
      netlifyToken: "nfp_secret_token",
      propertyId: "prop-1",
    });
  });

  it("tells people without Publish rights who can connect it", async () => {
    canManage.value = false;
    moduleMock.sites.mockResolvedValue([]);
    await render();
    expect(container.textContent).toContain("Only people with Publish rights can change site settings, the theme and the token.");
    expect(container.querySelector("button")).toBeNull();
  });
});
