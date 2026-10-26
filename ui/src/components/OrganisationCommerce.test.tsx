// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GREATSTONE = "34dad57e-b5ad-4a72-9400-9eba645c99f6";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), sites: vi.fn(), features: vi.fn(), list: vi.fn(), get: vi.fn() }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: GREATSTONE }) }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: mocks.settings } }));
vi.mock("@/api/website", () => ({ websiteModuleApi: { sites: mocks.sites } }));
vi.mock("@/api/website-features", () => ({ websiteFeaturesApi: { list: mocks.features } }));
vi.mock("@/api/website-data-bridge", () => ({ websiteDataBridgeApi: { list: mocks.list, get: mocks.get } }));

import { OrganisationCommerce } from "./OrganisationCommerce";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("OrganisationCommerce", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.settings.mockResolvedValue({ enableWebsiteView: true });
    mocks.sites.mockResolvedValue([{ id: "site-1", domain: "greatstone.example" }]);
    mocks.features.mockResolvedValue([{ id: "f-shop", key: "shop", enabled: true }]);
    mocks.get.mockResolvedValue({ item: { id: "cust-1", name: "Acme Ltd", domain: "acme.co.uk" } });
    mocks.list.mockImplementation((_c: string, _s: string, resource: string) => Promise.resolve({
      items: resource === "orders"
        ? [{ id: "ord-1", reference: "ORD-7", status: "paid", currency: "GBP", total_minor: 4500, created_at: "2026-10-03T00:00:00Z" }]
        : [],
      nextCursor: null,
    }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  function render(companyId: string, websiteOrganisationId = "cust-1") {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter><OrganisationCommerce companyId={companyId} websiteOrganisationId={websiteOrganisationId} /></MemoryRouter>
      </QueryClientProvider>,
    ));
  }

  it("links each record of the website organisation, read by its id through the bridge", async () => {
    render(GREATSTONE);
    await flush();
    expect(mocks.get).toHaveBeenCalledWith(GREATSTONE, "site-1", "customers", "cust-1");
    expect(mocks.list).toHaveBeenCalledWith(GREATSTONE, "site-1", "orders", { customer: "cust-1", limit: 100 });
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/commerce/orders/ord-1");
    expect(links).toContain("/commerce/orders?customer=cust-1");
    expect(container.textContent).toContain("ORD-7");
  });

  it("says so when the website organisation has no records yet", async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });
    render(GREATSTONE);
    await flush();
    expect(container.textContent).toContain("Acme Ltd has no quotes, orders, invoices or licences on the website yet.");
  });

  it("renders nothing for another company", async () => {
    render("00000000-0000-4000-8000-000000000001");
    await flush();
    expect(container.querySelector("[data-testid=organisation-commerce]")).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
