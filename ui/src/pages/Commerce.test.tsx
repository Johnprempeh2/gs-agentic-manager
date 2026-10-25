// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GREATSTONE = "34dad57e-b5ad-4a72-9400-9eba645c99f6";
const mocks = vi.hoisted(() => ({
  companyId: "",
  settings: vi.fn(),
  sites: vi.fn(),
  features: vi.fn(),
  bridge: { list: vi.fn(), get: vi.fn(), status: vi.fn(), createKey: vi.fn() },
  organisations: vi.fn(),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mocks.companyId }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: mocks.settings } }));
vi.mock("@/api/website", () => ({ websiteModuleApi: { sites: mocks.sites } }));
vi.mock("@/api/website-features", () => ({ websiteFeaturesApi: { list: mocks.features } }));
vi.mock("@/api/website-data-bridge", () => ({ websiteDataBridgeApi: mocks.bridge }));
vi.mock("@/api/organisations", () => ({ organisationsApi: { list: mocks.organisations } }));

import { CommercePage } from "./Commerce";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const site = { id: "site-1", companyId: GREATSTONE, domain: "stg.greatstone.example", name: "Greatstone" };
const shop = { id: "f-shop", key: "shop", enabled: true, siteId: "site-1" };
const customers = [{ id: "cust-1", name: "Acme Ltd", domain: "acme.co.uk" }];
const quotes = [
  { id: "q-old", reference: "Q-001", customer_id: "cust-1", status: "requested", currency: "GBP", indicative_total_minor: 50000, created_at: "2026-10-01T09:00:00Z" },
  { id: "q-new", reference: "Q-002", customer_id: "cust-1", status: "quoted", currency: "GBP", quoted_total_minor: 129900, created_at: "2026-10-20T09:00:00Z" },
];
const licence = {
  id: "lic-1", customer_id: "cust-1", order_id: "ord-1", offering_name: "JetBrains All Products", variant_name: "Annual",
  licence_key_last4: "9F2A", seats: 5, status: "delivered", expires_at: "2027-10-01T00:00:00Z", created_at: "2026-10-02T00:00:00Z",
};

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("CommercePage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.companyId = GREATSTONE;
    mocks.settings.mockResolvedValue({ enableWebsiteView: true });
    mocks.sites.mockResolvedValue([site]);
    mocks.features.mockResolvedValue([{ id: "f-public", key: "public-site", enabled: true }, shop]);
    mocks.organisations.mockResolvedValue([{ id: "org-1", name: "Acme", domain: "acme.co.uk", website: null }]);
    mocks.bridge.list.mockImplementation((_company: string, _site: string, resource: string) => Promise.resolve({
      items: resource === "customers" ? customers : resource === "quotes" ? quotes : [],
      nextCursor: null,
    }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  function render(path: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/commerce" element={<CommercePage />} />
            <Route path="/commerce/:resource" element={<CommercePage />} />
            <Route path="/commerce/:resource/:recordId" element={<CommercePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));
  }

  it("lists the site's quotes from the bridge, newest first, with the customer's name and no action buttons", async () => {
    render("/commerce/quotes");
    await flush();
    expect(mocks.bridge.list).toHaveBeenCalledWith(GREATSTONE, "site-1", "quotes", { limit: 50 });
    const rows = [...container.querySelectorAll("[data-testid=commerce-list] li")].map((row) => row.textContent);
    expect(rows[0]).toContain("Q-002");
    expect(rows[0]).toContain("£1,299.00");
    expect(rows[0]).toContain("Acme Ltd");
    expect(rows[1]).toContain("Q-001");
    // Read only: nothing on the list can change the site.
    expect(container.querySelectorAll("[data-testid=commerce-list] button")).toHaveLength(0);
  });

  it("shows the four record tabs", async () => {
    render("/commerce");
    await flush();
    const tabs = [...container.querySelectorAll("[role=tab]")].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Quotes", "Orders", "Invoices", "Licences"]);
  });

  it("filters a list by customer", async () => {
    render("/commerce/quotes?customer=cust-1");
    await flush();
    expect(mocks.bridge.list).toHaveBeenCalledWith(GREATSTONE, "site-1", "quotes", { limit: 50, customer: "cust-1" });
    expect(container.textContent).toContain("Showing");
    expect(container.querySelector("[aria-label='Show every customer']")).not.toBeNull();
  });

  it("shows a licence with its key masked as the bridge returns it, and links to the organisation and order", async () => {
    mocks.bridge.get.mockResolvedValue({ item: licence });
    render("/commerce/licences/lic-1");
    await flush();
    expect(mocks.bridge.get).toHaveBeenCalledWith(GREATSTONE, "site-1", "licences", "lic-1");
    expect(container.querySelector("[data-testid=commerce-licence-key]")?.textContent).toBe("•••• 9F2A");
    const links = [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toContainEqual(["Acme in Organisations", "/organisations/org-1"]);
    expect(links).toContainEqual(["Open its order", "/commerce/orders/ord-1"]);
  });

  it("shows the bridge's error when the site cannot be read", async () => {
    mocks.bridge.list.mockRejectedValue(new Error("Website data is not set up for this site yet."));
    render("/commerce/orders");
    await flush();
    expect(container.textContent).toContain("Website data is not set up for this site yet.");
  });

  it("is not available for another company, and never reads its website", async () => {
    mocks.companyId = "00000000-0000-4000-8000-000000000001";
    render("/commerce/quotes");
    await flush();
    expect(container.textContent).toContain("Commerce is not available here");
    expect(mocks.sites).not.toHaveBeenCalled();
    expect(mocks.bridge.list).not.toHaveBeenCalled();
  });

  it("is not available while Greatstone's Shop feature is off", async () => {
    mocks.features.mockResolvedValue([{ ...shop, enabled: false }]);
    render("/commerce/quotes");
    await flush();
    expect(container.textContent).toContain("Commerce is not available here");
    expect(mocks.bridge.list).not.toHaveBeenCalled();
  });
});
