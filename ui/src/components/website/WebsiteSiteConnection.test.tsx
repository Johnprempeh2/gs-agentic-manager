// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteProperty, WebsiteSite } from "@greatstone/shared";
import { ApiError } from "../../api/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moduleMock = vi.hoisted(() => ({ sites: vi.fn(), access: vi.fn(), tokenSecrets: vi.fn(), createSite: vi.fn(), updateSite: vi.fn(), pages: vi.fn() }));
vi.mock("../../api/website", async () => {
  const actual = await vi.importActual<typeof import("../../api/website")>("../../api/website");
  return { ...actual, websiteModuleApi: moduleMock };
});

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
    netlifyTokenSource: "own",
    netlifyTokenSecretName: "Website Netlify token site-1",
    blobsStoreName: "gsam-content",
    engineVersion: null,
    releaseSchemaVersion: 1,
    propertyId: "prop-1",
    editorOrigins: [],
    editorFrameOrigin: null,
    livePreviewUrl: null,
    devPreviewUrl: null,
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
    vi.clearAllMocks();
    moduleMock.access.mockResolvedValue({ view: true, edit: true, publish: true });
    moduleMock.tokenSecrets.mockResolvedValue([]);
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

  it("says which saved secret a site uses, by name only", async () => {
    moduleMock.sites.mockResolvedValue([site({ netlifyTokenSource: "shared", netlifyTokenSecretName: "Netlify PAT (agents)" })]);
    await render();
    expect(container.textContent).toContain("Saved secret Netlify PAT (agents). GSAM reads it and never changes it.");
  });

  it("links a saved secret instead of a pasted token", async () => {
    moduleMock.sites.mockResolvedValue([site()]);
    moduleMock.tokenSecrets.mockResolvedValue([{ id: "secret-1", name: "Netlify PAT (agents)" }]);
    moduleMock.updateSite.mockResolvedValue(site({ netlifyTokenSource: "shared", netlifyTokenSecretName: "Netlify PAT (agents)" }));
    await render();
    await act(async () => container.querySelector("button")!.click());
    const saved = [...container.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((button) => button.textContent?.includes("Use a saved secret"))!;
    await act(async () => saved.click());
    await flush();
    const select = container.querySelector<HTMLSelectElement>("#website-site-prop-1-token-secret")!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Choose a secret", "Netlify PAT (agents)"]);
    await act(async () => {
      select.value = "secret-1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(moduleMock.updateSite).toHaveBeenCalledWith("co-1", "site-1", expect.objectContaining({ netlifyTokenSecretId: "secret-1" }));
    expect(moduleMock.updateSite.mock.calls[0]![2]).not.toHaveProperty("netlifyToken");
  });

  it("sets the editor address, sending it only when it changes", async () => {
    moduleMock.sites.mockResolvedValue([site()]);
    moduleMock.updateSite.mockResolvedValue(site({ editorFrameOrigin: "https://editor.greatstone.example" }));
    await render();
    expect(container.textContent).toContain("Not set. Editing pages needs it.");
    const change = [...container.querySelectorAll("button")].find((button) => button.textContent === "Change")!;
    await act(async () => change.click());
    await act(async () => {
      setValue(container.querySelector<HTMLInputElement>("#website-site-prop-1-editor")!, "https://editor.greatstone.example");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(moduleMock.updateSite).toHaveBeenCalledWith("co-1", "site-1", expect.objectContaining({ editorFrameOrigin: "https://editor.greatstone.example" }));
  });

  it("sets the two preview addresses as https addresses, sending only what changed, with the exact-copy rule in the help", async () => {
    moduleMock.sites.mockResolvedValue([site({ editorFrameOrigin: "https://editor.greatstone.example" })]);
    moduleMock.updateSite.mockResolvedValue(site());
    await render();
    expect(container.textContent).toContain("Live site viewThe live address");
    expect(container.textContent).toContain("In developmentThe editor address");
    const change = [...container.querySelectorAll("button")].find((button) => button.textContent === "Change")!;
    await act(async () => change.click());
    const live = container.querySelector<HTMLInputElement>("#website-site-prop-1-live-preview")!;
    const dev = container.querySelector<HTMLInputElement>("#website-site-prop-1-dev-preview")!;
    expect(live.type).toBe("url");
    expect(live.pattern).toBe("https://.*");
    expect(dev.placeholder).toBe("https://editor.greatstone.example");
    expect(container.querySelector("#website-site-prop-1-live-preview-help")!.textContent).toContain("must be an exact copy of the live deploy");
    await act(async () => setValue(live, "https://abc--greatstone.netlify.app/"));
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    const sent = moduleMock.updateSite.mock.calls[0]![2];
    expect(sent).toMatchObject({ livePreviewUrl: "https://abc--greatstone.netlify.app/" });
    expect(sent).not.toHaveProperty("devPreviewUrl");
  });

  async function replaceToken(token: string) {
    const change = [...container.querySelectorAll("button")].find((button) => button.textContent === "Change")!;
    await act(async () => change.click());
    await act(async () => setValue(container.querySelector<HTMLInputElement>("#website-site-prop-1-token")!, token));
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  it("GRE-2137: says it is checking the site while the server checks Netlify, then shows the site version", async () => {
    moduleMock.sites.mockResolvedValue([site()]);
    let finish!: (value: WebsiteSite) => void;
    moduleMock.updateSite.mockReturnValue(new Promise<WebsiteSite>((resolve) => { finish = resolve; }));
    await render();
    expect(container.textContent).toContain("Site versionNot checked yet. Saving a token checks it.");
    await replaceToken("nfp_new_token_value");
    await flush();
    expect(container.textContent).toContain("Checking the site. This takes a few seconds.");
    expect(container.querySelector("button[type=submit]")!.textContent).toBe("Checking");
    moduleMock.sites.mockResolvedValue([site({ engineVersion: "0.2.0" })]);
    await act(async () => finish(site({ engineVersion: "0.2.0" })));
    await flush();
    expect(container.textContent).toContain("Greatstone is connected.");
    expect(container.textContent).toContain("Details: site version 0.2.0.");
    expect(container.textContent).toContain("Site version0.2.0");
  });

  it("GRE-2137: shows the connect.err copy and its details line, and keeps the form open", async () => {
    moduleMock.sites.mockResolvedValue([site()]);
    const message = "This site needs an update before it can connect. Ask your website team to update it.";
    moduleMock.updateSite.mockRejectedValue(new ApiError(message, 422, {
      error: message,
      details: { code: "website_connect_engine_old", messageKey: "connect.err.engine_old", detail: "Details: site version 0.0.9. GSAM needs 0.1.0 or later." },
    }));
    await render();
    await replaceToken("nfp_new_token_value");
    await flush();
    const alert = container.querySelector("[role=alert]")!;
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain("Details: site version 0.0.9. GSAM needs 0.1.0 or later.");
    expect(container.querySelector("[data-testid=website-site-form]")).not.toBeNull();
  });

  it("GRE-2137: a save that changes no token or address says Saving, not Checking", async () => {
    moduleMock.sites.mockResolvedValue([site()]);
    moduleMock.updateSite.mockReturnValue(new Promise(() => {}));
    await render();
    const change = [...container.querySelectorAll("button")].find((button) => button.textContent === "Change")!;
    await act(async () => change.click());
    await act(async () => setValue(container.querySelector<HTMLInputElement>("#website-site-prop-1-name")!, "Renamed"));
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(container.querySelector("button[type=submit]")!.textContent).toBe("Saving");
    expect(container.textContent).not.toContain("Checking the site.");
  });

  it("tells people without Publish rights who can connect it", async () => {
    moduleMock.access.mockResolvedValue({ view: true, edit: true, publish: false });
    moduleMock.sites.mockResolvedValue([]);
    await render();
    expect(moduleMock.access).toHaveBeenCalledWith("co-1", null);
    expect(container.textContent).toContain("Only people with Publish rights can change site settings, the theme and the token.");
    expect(container.querySelector("button")).toBeNull();
  });

  // GRE-2136: the buttons follow the server's website:publish decision, not the owner/admin role.
  it("offers Connect a site to someone granted website:publish for the company", async () => {
    moduleMock.access.mockResolvedValue({ view: true, edit: true, publish: true });
    moduleMock.sites.mockResolvedValue([]);
    await render();
    expect(moduleMock.access).toHaveBeenCalledWith("co-1", null);
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Connect a site"]);
  });

  it("shows Change from the grant for this site, and hides it when the grant is for another site", async () => {
    moduleMock.sites.mockResolvedValue([site()]);
    moduleMock.access.mockImplementation(async (_companyId: string, siteId: string | null) => ({ view: true, edit: true, publish: siteId === "site-1" }));
    await render();
    expect(moduleMock.access).toHaveBeenCalledWith("co-1", "site-1");
    expect(container.querySelector("button")?.textContent).toBe("Change");

    act(() => root.unmount());
    root = createRoot(container);
    vi.clearAllMocks();
    moduleMock.sites.mockResolvedValue([site()]);
    moduleMock.access.mockImplementation(async (_companyId: string, siteId: string | null) => ({ view: true, edit: true, publish: siteId === "other-site" }));
    await render();
    expect(container.querySelector("button")).toBeNull();
  });
});
