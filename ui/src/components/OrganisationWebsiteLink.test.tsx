// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GREATSTONE = "34dad57e-b5ad-4a72-9400-9eba645c99f6";
const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  sites: vi.fn(),
  features: vi.fn(),
  list: vi.fn(),
  setWebsiteLink: vi.fn(),
}));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: mocks.settings } }));
vi.mock("@/api/website", () => ({ websiteModuleApi: { sites: mocks.sites } }));
vi.mock("@/api/website-features", () => ({ websiteFeaturesApi: { list: mocks.features } }));
vi.mock("@/api/website-data-bridge", () => ({ websiteDataBridgeApi: { list: mocks.list } }));
vi.mock("@/api/organisations", () => ({ organisationsApi: { setWebsiteLink: mocks.setWebsiteLink } }));

import { OrganisationWebsiteLink } from "./OrganisationWebsiteLink";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function buttonNamed(container: HTMLElement, name: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (!button) throw new Error(`No button "${name}"`);
  return button;
}

describe("OrganisationWebsiteLink", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.settings.mockResolvedValue({ enableWebsiteView: true });
    mocks.sites.mockResolvedValue([{ id: "site-1", domain: "greatstone.example" }]);
    mocks.features.mockResolvedValue([{ id: "f-shop", key: "shop", enabled: true }]);
    mocks.list.mockResolvedValue({
      items: [
        { id: "cust-1", name: "Acme Ltd", domain: "acme.co.uk" },
        { id: "cust-2", name: "Borealis Health", domain: null },
      ],
      nextCursor: null,
    });
    mocks.setWebsiteLink.mockResolvedValue({});
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  function render(companyId: string, websiteOrganisationId: string | null) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <OrganisationWebsiteLink companyId={companyId} organisation={{ id: "org-1", websiteOrganisationId }} />
      </QueryClientProvider>,
    ));
  }

  it("links the organisation to the website organisation the person picks, on the commerce site", async () => {
    render(GREATSTONE, null);
    await flush();
    expect(container.textContent).toContain("Not linked to a website organisation.");
    act(() => buttonNamed(container, "Link website organisation").click());
    const select = container.querySelector("select")!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Pick a website organisation",
      "Acme Ltd (acme.co.uk)",
      "Borealis Health",
    ]);
    expect(buttonNamed(container, "Link").disabled).toBe(true);
    act(() => {
      select.value = "cust-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => buttonNamed(container, "Link").click());
    await flush();
    expect(mocks.setWebsiteLink).toHaveBeenCalledWith(GREATSTONE, "org-1", { websiteOrganisationId: "cust-2", siteId: "site-1" });
  });

  it("shows the linked website organisation by name and unlinks it", async () => {
    render(GREATSTONE, "cust-1");
    await flush();
    expect(container.textContent).toContain("Linked to Acme Ltd (cust-1)");
    await act(async () => buttonNamed(container, "Unlink").click());
    await flush();
    expect(mocks.setWebsiteLink).toHaveBeenCalledWith(GREATSTONE, "org-1", { websiteOrganisationId: null });
  });

  it("shows the server's answer when the link is refused", async () => {
    mocks.setWebsiteLink.mockRejectedValue(new Error("This website organisation is already linked to Borealis"));
    render(GREATSTONE, null);
    await flush();
    act(() => buttonNamed(container, "Link website organisation").click());
    const select = container.querySelector("select")!;
    act(() => {
      select.value = "cust-1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => buttonNamed(container, "Link").click());
    await flush();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("This website organisation is already linked to Borealis");
  });

  it("renders nothing without a commerce site", async () => {
    render("00000000-0000-4000-8000-000000000001", null);
    await flush();
    expect(container.querySelector("[data-testid=organisation-website-link]")).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
