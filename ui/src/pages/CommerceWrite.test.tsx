// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

// The Commerce write screens (GRE-3972): people-only buttons, the Idempotency-Key and expectedRowVersion, and the
// conflict, no-key and people-only answers.

const GREATSTONE = "34dad57e-b5ad-4a72-9400-9eba645c99f6";
const OFFERING_ID = "0f0f0f0f-0000-4000-8000-000000000001";
const ORDER_ID = "0d0d0d0d-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  sites: vi.fn(),
  features: vi.fn(),
  bridge: { list: vi.fn(), get: vi.fn() },
  organisations: vi.fn(),
  commerce: { list: vi.fn(), get: vi.fn(), fx: vi.fn(), payments: vi.fn(), write: vi.fn(), requestRefund: vi.fn(), putActivationSteps: vi.fn() },
  access: vi.fn(),
  approvals: vi.fn(),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: GREATSTONE }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: mocks.settings } }));
vi.mock("@/api/website", () => ({ websiteModuleApi: { sites: mocks.sites } }));
vi.mock("@/api/website-features", () => ({ websiteFeaturesApi: { list: mocks.features } }));
vi.mock("@/api/website-data-bridge", () => ({ websiteDataBridgeApi: mocks.bridge }));
vi.mock("@/api/organisations", () => ({ organisationsApi: { list: mocks.organisations } }));
vi.mock("@/api/website-commerce", () => ({ websiteCommerceApi: mocks.commerce }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: mocks.access } }));
vi.mock("@/api/approvals", () => ({ approvalsApi: { list: mocks.approvals } }));

import { CommercePage } from "./Commerce";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const offering = {
  id: OFFERING_ID, type: "product", slug: "jetbrains-all", name: "JetBrains All Products", status: "draft", featured: false,
  row_version: 3, variants: [], specs: [], media: [], updated_at: "2026-11-01T09:00:00Z",
};
const order = {
  id: ORDER_ID, reference: "GS-1001", status: "paid", currency: "GBP", subtotal_minor: "12000", total_minor: "12000",
  refunded_minor: "0", invoice_number: "INV-0042", row_version: 2, items: [], created_at: "2026-10-01T00:00:00Z",
};
const draftOrder = { ...order, status: "pending", invoice_number: null };
const LICENCE_ID = "0e0e0e0e-0000-4000-8000-000000000001";
const VENDOR_ID = "0a0a0a0a-0000-4000-8000-000000000001";
// the bridge sends a licence with its last 4 only; the full key never reaches GSAM
const licence = { id: LICENCE_ID, offering_name: "Aspose.Total for .NET", licence_key_last4: "7Q2X", status: "delivered", created_at: "2026-10-01T00:00:00Z" };
const vendor = { id: VENDOR_ID, name: "Aspose", slug: "aspose", status: "published", activation_instructions: "1. Download the file", row_version: 3 };
const otherVendor = { id: "0a0a0a0a-0000-4000-8000-000000000002", name: "JetBrains", slug: "jetbrains", status: "draft", activation_instructions: null, row_version: 1 };
const vendorsList = (rows: Record<string, unknown>[]) => (_c: string, _s: string, resource: string) =>
  Promise.resolve({ items: resource === "vendors" ? rows : [], nextCursor: null });

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const person = () => mocks.access.mockResolvedValue({ source: "session", userId: "user-1" });
const agent = () => mocks.access.mockRejectedValue(new ApiError("Board access required", 403, { error: "Board access required" }));
const conflict = (current: Record<string, unknown>) => new ApiError("The record changed on the website since it was read.", 409,
  { error: "The record changed on the website since it was read.", code: "website_bridge_conflict", details: { code: "website_bridge_conflict", current } });

describe("Commerce write screens", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.settings.mockResolvedValue({ enableWebsiteView: true });
    mocks.sites.mockResolvedValue([{ id: "site-1", companyId: GREATSTONE, domain: "stg.greatstone.example", name: "Greatstone" }]);
    mocks.features.mockResolvedValue([{ id: "f-shop", key: "shop", enabled: true, siteId: "site-1" }]);
    mocks.organisations.mockResolvedValue([]);
    mocks.bridge.list.mockResolvedValue({ items: [], nextCursor: null });
    mocks.commerce.list.mockResolvedValue({ items: [], nextCursor: null });
    mocks.commerce.get.mockResolvedValue({ item: offering });
    mocks.approvals.mockResolvedValue([]);
    agent();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.resetAllMocks();
  });

  function render(path: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/commerce/:resource" element={<CommercePage />} />
            <Route path="/commerce/:resource/:recordId" element={<CommercePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));
  }

  const byTestId = (id: string) => container.querySelector(`[data-testid=${id}]`);
  const buttonNamed = (name: string) => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === name);
  const submitForm = (input: Element) => act(() => { input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });

  it("hides publish and archive from an agent, and says a person does them", async () => {
    render(`/commerce/offerings/${OFFERING_ID}`);
    await flush();
    expect(container.textContent).toContain("JetBrains All Products");
    expect(byTestId("commerce-publish")).toBeNull();
    expect(byTestId("commerce-archive")).toBeNull();
    expect(byTestId("commerce-people-only-note")?.textContent).toContain("A person publishes and archives");
    // drafting stays open to agents
    expect(byTestId("commerce-delete")).not.toBeNull();
    expect(buttonNamed("Save changes")).toBeDefined();
  });

  it("shows publish and archive to a person signed in to GSAM", async () => {
    person();
    render(`/commerce/offerings/${OFFERING_ID}`);
    await flush();
    expect(byTestId("commerce-publish")).not.toBeNull();
    expect(byTestId("commerce-archive")).not.toBeNull();
    expect(byTestId("commerce-people-only-note")).toBeNull();
  });

  it("sends only what changed, with expectedRowVersion and an Idempotency-Key it keeps for a retry after a 5xx", async () => {
    mocks.commerce.write
      .mockRejectedValueOnce(new ApiError("The website's data bridge had an error. Try again later.", 502, { error: "x" }))
      .mockResolvedValueOnce({ item: { ...offering, name: "JetBrains All Products Pack", row_version: 4 } });
    render(`/commerce/offerings/${OFFERING_ID}`);
    await flush();
    const name = container.querySelector<HTMLInputElement>("#edit-offerings-name")!;
    type(name, "JetBrains All Products Pack");
    submitForm(name);
    await flush();
    expect(mocks.commerce.write).toHaveBeenCalledTimes(1);
    const [company, site, change, key] = mocks.commerce.write.mock.calls[0]!;
    expect([company, site]).toEqual([GREATSTONE, "site-1"]);
    expect(change).toEqual({ method: "PATCH", parts: ["offerings", OFFERING_ID], body: { name: "JetBrains All Products Pack", expectedRowVersion: 3 } });
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(byTestId("commerce-write-error")?.textContent).toContain("Try again later");

    submitForm(container.querySelector("#edit-offerings-name")!);
    await flush();
    expect(mocks.commerce.write).toHaveBeenCalledTimes(2);
    expect(mocks.commerce.write.mock.calls[1]![3]).toBe(key);
  });

  it("on a conflict, shows the row as it is now and starts again from it", async () => {
    mocks.commerce.write.mockRejectedValueOnce(conflict({ ...offering, name: "JetBrains Toolbox", row_version: 5 }));
    render(`/commerce/offerings/${OFFERING_ID}`);
    await flush();
    const name = container.querySelector<HTMLInputElement>("#edit-offerings-name")!;
    type(name, "My new name");
    submitForm(name);
    await flush();
    const panel = byTestId("commerce-conflict");
    expect(panel?.textContent).toContain("Someone changed this on the website");
    expect(byTestId("commerce-conflict-current")?.textContent).toContain("JetBrains Toolbox");
    expect(byTestId("commerce-conflict-current")?.textContent).toContain("5");

    mocks.commerce.get.mockResolvedValue({ item: { ...offering, name: "JetBrains Toolbox", row_version: 5 } });
    act(() => buttonNamed("Use the current version")!.click());
    await flush();
    expect(byTestId("commerce-conflict")).toBeNull();
    expect(container.querySelector<HTMLInputElement>("#edit-offerings-name")!.value).toBe("JetBrains Toolbox");
  });

  it("with no write key, says so and links to the bridge key settings", async () => {
    mocks.commerce.write.mockRejectedValueOnce(new ApiError("Commerce changes are off for this site: no write key is set up", 409, {
      error: "Commerce changes are off for this site: no write key is set up", code: "capability_not_configured",
      details: { code: "capability_not_configured", capability: "write" },
    }));
    render("/commerce/vendors/new");
    await flush();
    type(container.querySelector<HTMLInputElement>("#new-vendors-name")!, "JetBrains");
    type(container.querySelector<HTMLInputElement>("#new-vendors-slug")!, "jetbrains");
    submitForm(container.querySelector("#new-vendors-name")!);
    await flush();
    expect(mocks.commerce.write.mock.calls[0]![2]).toEqual({ method: "POST", parts: ["vendors"], body: { name: "JetBrains", slug: "jetbrains" } });
    const notice = byTestId("commerce-no-key");
    expect(notice?.textContent).toContain("No write key yet");
    expect(notice?.querySelector("a")?.getAttribute("href")).toBe("/website?tab=releases");
  });

  it("hides the rate change from an agent", async () => {
    mocks.commerce.fx.mockResolvedValue({ item: { usd_to_gbp_display_rate: "1.300000", row_version: 4, history: [] } });
    render("/commerce/currency");
    await flush();
    // the site divides dollars by this rate: it is dollars for one pound, never pounds for one dollar
    expect(byTestId("commerce-fx-rate")?.textContent).toBe("£1 = $1.30");
    expect(buttonNamed("Change rate")).toBeUndefined();
    expect(byTestId("commerce-people-only-note")?.textContent).toContain("Only a person changes the rate");
  });

  it("switches the shop currency only after a confirm, and lists the switch in the history", async () => {
    person();
    mocks.commerce.fx.mockResolvedValue({ item: { usd_to_gbp_display_rate: "1.320000", shop_currency: "GBP", row_version: 4, history: [
      { id: "h2", old_rate: "1.320000", new_rate: "1.320000", old_currency: "USD", new_currency: "GBP", changed_at: "2026-11-10T00:00:00Z" },
      { id: "h1", old_rate: "1.300000", new_rate: "1.320000", old_currency: "GBP", new_currency: "GBP", changed_at: "2026-11-01T00:00:00Z" }] } });
    const switched = { usd_to_gbp_display_rate: "1.320000", shop_currency: "USD", row_version: 5, history: [] };
    mocks.commerce.write.mockResolvedValue({ item: switched });
    mocks.commerce.list.mockImplementation(async (_c: string, _s: string, resource: string) => resource === "offerings"
      ? { items: [{ id: "o1", name: "Aspose.Total", status: "published", from_price_minor: "100099", from_price_currency: "USD",
          variants: [{ base_price_minor: "100099", currency: "USD" }] }], nextCursor: null }
      : { items: [], nextCursor: null });
    render("/commerce/currency");
    await flush();
    expect(byTestId("commerce-shop-currency-value")?.textContent).toBe("Pounds (GBP)");
    expect(byTestId("commerce-fx-preview")?.textContent).toContain("£758");
    expect(byTestId("commerce-fx-history-currency")?.textContent).toMatch(/^Shop currency US dollars \(USD\) →\s*to Pounds \(GBP\)$/);
    expect(byTestId("commerce-fx-history")?.textContent).toContain("$1.30");
    act(() => byTestId("commerce-shop-currency-switch")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(mocks.commerce.write).not.toHaveBeenCalled();
    const dialog = document.body.querySelector("[role=alertdialog]")!;
    expect(dialog.textContent).toContain("The website will show and charge prices in US dollars (USD)");
    mocks.commerce.fx.mockResolvedValue({ item: switched });
    act(() => { [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Switch to US dollars (USD)")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(mocks.commerce.write.mock.calls[0]![2]).toEqual({ method: "PATCH", parts: ["fx"], body: { shopCurrency: "USD", expectedRowVersion: 4 } });
    expect(byTestId("commerce-shop-currency-value")?.textContent).toBe("US dollars (USD)");
    // in dollars the shop sells the stored prices, cents and all
    expect(byTestId("commerce-fx-preview")?.textContent).toContain("US$1,000.99");
  });

  it("offers no switch to an agent", async () => {
    mocks.commerce.fx.mockResolvedValue({ item: { usd_to_gbp_display_rate: "1.300000", shop_currency: "GBP", row_version: 4, history: [] } });
    render("/commerce/currency");
    await flush();
    expect(byTestId("commerce-shop-currency-switch")).toBeNull();
    expect(byTestId("commerce-people-only-note")?.textContent).toContain("Only a person changes the rate or the shop currency");
  });

  it("offers no switch on a site that does not report its currency yet, and says it stays in pounds", async () => {
    person();
    mocks.commerce.fx.mockResolvedValue({ item: { usd_to_gbp_display_rate: "1.300000", row_version: 4, history: [] } });
    render("/commerce/currency");
    await flush();
    expect(byTestId("commerce-shop-currency-value")?.textContent).toBe("Pounds (GBP)");
    expect(byTestId("commerce-shop-currency-switch")).toBeNull();
    expect(byTestId("commerce-shop-currency-unavailable")?.textContent).toContain("stays in pounds");
  });

  it("shows how stale the rate is and previews real prices at the new rate before a person saves", async () => {
    person();
    mocks.commerce.fx.mockResolvedValue({ item: { usd_to_gbp_display_rate: "1.320000", row_version: 4, updated_at: "2026-01-01T00:00:00Z", history: [
      { id: "h1", old_rate: "1.300000", new_rate: "1.320000", changed_at: "2026-01-01T00:00:00Z" }] } });
    mocks.commerce.list.mockImplementation(async (_c: string, _s: string, resource: string) => resource === "offerings"
      ? { items: [{ id: "o1", name: "Aspose.Total", status: "published", from_price_minor: "100000", from_price_currency: "USD",
          variants: [{ base_price_minor: "100000", currency: "USD" }] }], nextCursor: null }
      : { items: [], nextCursor: null });
    render("/commerce/currency");
    await flush();
    expect(byTestId("commerce-fx-staleness")?.textContent).toContain("Check it still matches the market");
    expect(byTestId("commerce-fx-history")?.textContent).toMatch(/^\$1\.30 .*\$1\.32 to the pound/);
    const preview = byTestId("commerce-fx-preview")!;
    expect(preview.textContent).toContain("Aspose.Total");
    expect(preview.textContent).toContain("£758");
    act(() => buttonNamed("Change rate")!.click());
    type(container.querySelector<HTMLInputElement>("#commerce-fx-input")!, "1.25");
    await flush();
    expect(preview.textContent).toContain("£800");
    expect(container.textContent).toContain("a $1,000 product shows as £800");
    act(() => byTestId("commerce-fx-save")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(document.body.querySelector("[role=alertdialog]")?.textContent).toContain("1 dollar price on 1 product changes on the website");
  });

  it("shows what a pricing rule does to real prices, in pounds at the display rate", async () => {
    mocks.commerce.get.mockResolvedValue({ item: { id: "r1", name: "Aspose sale", status: "draft", scope_type: "vendor", adjustment_type: "percentage",
      adjustment_value_pct: "10", audience: "tier", targets: [{ id: "t1", vendor_id: VENDOR_ID }], row_version: 1 } });
    mocks.commerce.fx.mockResolvedValue({ item: { usd_to_gbp_display_rate: "1.320000", row_version: 4, history: [] } });
    mocks.commerce.list.mockImplementation(async (_c: string, _s: string, resource: string) => ({ nextCursor: null,
      items: resource === "offerings" ? [
        { id: "o1", name: "Aspose.Total", type: "product", vendor_id: VENDOR_ID, status: "published", from_price_minor: "132000", from_price_currency: "USD" },
        { id: "o2", name: "JetBrains", type: "product", vendor_id: "other", status: "published", from_price_minor: "132000", from_price_currency: "USD" },
      ] : resource === "vendors" ? [vendor] : [] }));
    render("/commerce/pricing-rules/r1");
    await flush();
    const preview = byTestId("commerce-rule-preview")!;
    expect(preview.textContent).toContain("It lowers the from price of 1 published product, in pounds at $1.32 to the pound. Only clients in its tier see it.");
    expect(preview.textContent).toContain("Aspose.Total");
    expect(preview.textContent).toContain("£1,000");
    expect(preview.textContent).toContain("£900");
    expect(preview.textContent).not.toContain("JetBrains");
  });

  it("shows the server's people-only refusal when it comes back", async () => {
    person();
    mocks.commerce.fx.mockResolvedValue({ item: { usd_to_gbp_display_rate: "1.300000", row_version: 4, history: [] } });
    const message = "Only a person can do this, by clicking in GSAM. Agents draft; people publish, archive, change FX, apply imports, issue invoices and decide refunds.";
    mocks.commerce.write.mockRejectedValueOnce(new ApiError(message, 403, { error: message, code: "website_commerce_people_only" }));
    render("/commerce/currency");
    await flush();
    act(() => buttonNamed("Change rate")!.click());
    const input = container.querySelector<HTMLInputElement>("#commerce-fx-input")!;
    type(input, "1.25");
    submitForm(input);
    await flush();
    expect(mocks.commerce.write).not.toHaveBeenCalled(); // Enter never reprices: the confirm does
    act(() => byTestId("commerce-fx-save")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => { [...document.body.querySelectorAll("[role=alertdialog] button")].find((b) => b.textContent === "Save rate")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(mocks.commerce.write.mock.calls[0]![2]).toEqual({ method: "PATCH", parts: ["fx"], body: { usdToGbpDisplayRate: "1.25", expectedRowVersion: 4 } });
    expect(byTestId("commerce-people-only-error")?.textContent).toBe(message);
  });

  it("exports the catalogue as a price book in the import's own columns", async () => {
    const files: Blob[] = [];
    Object.assign(URL, { createObjectURL: vi.fn((blob: Blob) => { files.push(blob); return "blob:price-book"; }), revokeObjectURL: vi.fn() });
    mocks.commerce.list.mockImplementation(async (_c: string, _s: string, resource: string) => ({
      nextCursor: null,
      items: resource === "offerings"
        ? [{ id: "o1", slug: "aspose-total", name: "Aspose.Total", vendor_id: "v1", category_id: null, status: "published", featured: false,
            variants: [{ id: "x1", sku: "AT-1", name: "Developer", billing_period: "annual", base_price_minor: "290000", currency: "USD" },
              { id: "x2", sku: null, name: "No sku" }] }]
        : resource === "vendors" ? [{ id: "v1", name: "Aspose" }] : [],
    }));
    render("/commerce/imports");
    await flush();
    act(() => buttonNamed("Export SKUs as CSV")!.click());
    await flush();
    expect(files).toHaveLength(1);
    const csv = await files[0]!.text();
    expect(csv).toContain("sku,offering_slug,offering_name,vendor,category,edition_name,license_type,billing_period,list_price_usd,status,featured");
    expect(csv).toContain("AT-1,aspose-total,Aspose.Total,Aspose,,Developer,,annual,2900.00,published,false");
    expect(byTestId("commerce-export-skus")?.textContent).toContain("Exported 1 edition. 1 edition with no SKU is left out");
  });

  it("links an invoiced order to the website's printable invoice", async () => {
    mocks.bridge.get.mockResolvedValue({ item: order });
    render(`/commerce/invoices/${ORDER_ID}`);
    await flush();
    expect(byTestId("commerce-invoice-website")?.getAttribute("href")).toBe(`https://stg.greatstone.example/invoice/${ORDER_ID}`);

    act(() => root.unmount());
    root = createRoot(container);
    mocks.bridge.get.mockResolvedValue({ item: draftOrder });
    render(`/commerce/orders/${ORDER_ID}`);
    await flush();
    expect(byTestId("commerce-invoice-website")).toBeNull(); // no invoice number, no invoice
  });

  it("issues a licence from an order line, filled in from the line, and marks lines already licensed", async () => {
    person();
    const CUSTOMER = "0c0c0c0c-0000-4000-8000-000000000001";
    const items = [
      { id: "i1", offering_name: "Aspose.Total for .NET", variant_name: "Developer OEM", qty: 2, unit_price_minor: "100", line_total_minor: "200", currency: "GBP" },
      { id: "i2", offering_name: "JetBrains All Products", variant_name: null, qty: 1, unit_price_minor: "100", line_total_minor: "100", currency: "GBP" },
    ];
    mocks.bridge.get.mockResolvedValue({ item: { ...order, customer_id: CUSTOMER, status: "confirmed", items } });
    mocks.bridge.list.mockImplementation(async (_c: string, _s: string, resource: string) => ({ nextCursor: null,
      items: resource === "licences" ? [{ id: "l1", order_id: ORDER_ID, offering_name: "JetBrains All Products", variant_name: null, status: "delivered" }] : [] }));
    mocks.commerce.write.mockResolvedValue({ item: { id: "l2" } });
    render(`/commerce/orders/${ORDER_ID}`);
    await flush();
    const section = byTestId("commerce-order-licences")!;
    expect(section.querySelectorAll("li")[0]!.textContent).toContain("No licence yet");
    expect(section.querySelectorAll("li")[1]!.textContent).toContain("Issue another");
    act(() => (byTestId("commerce-order-licence-0") as HTMLButtonElement).click());
    expect(container.querySelector<HTMLInputElement>("#issue-product")!.value).toBe("Aspose.Total for .NET");
    expect(container.querySelector<HTMLInputElement>("#issue-seats")!.value).toBe("2");
    type(container.querySelector<HTMLInputElement>("#issue-secret")!, "KEY-1234");
    submitForm(container.querySelector("#issue-secret")!);
    await flush();
    expect(mocks.commerce.write.mock.calls[0]![2]).toEqual({ method: "POST", parts: ["customers", CUSTOMER, "licences"], body: {
      offeringName: "Aspose.Total for .NET", variantName: "Developer OEM", licenceKey: "KEY-1234", orderId: ORDER_ID, seats: 2 } });
  });

  it("filters client companies by how recently they had a timeline item, and puts the quietest first", async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    mocks.bridge.list.mockImplementation(async (_c: string, _s: string, resource: string) => ({ nextCursor: null,
      items: resource === "customers"
        ? [{ id: "c1", name: "Alpha" }, { id: "c2", name: "Bravo" }, { id: "c3", name: "Charlie" }]
        : resource === "engagements"
          ? [{ customer_id: "c1", occurred_on: day(3) }, { customer_id: "c2", occurred_on: day(45) }, { customer_id: "c2", occurred_on: day(90) }]
          : [] }));
    render("/commerce/customers");
    await flush();
    const names = () => [...container.querySelectorAll("[data-testid=commerce-clients] li")].map((li) => li.textContent);
    expect(names()[1]).toContain("Last item 45 days ago");
    expect(buttonNamed("Quiet 1")).toBeDefined();
    act(() => buttonNamed("Quiet 1")!.click());
    await flush();
    expect(names()).toHaveLength(1);
    expect(names()[0]).toContain("Bravo");
    act(() => buttonNamed("Quiet 1")!.click());
    act(() => buttonNamed("Quietest first")!.click());
    await flush();
    expect(names().map((n) => n?.slice(0, 5))).toEqual(["Charl", "Bravo", "Alpha"]);
  });

  it("starts a timeline item from a template, still as a draft a person adds", async () => {
    const CLIENT = "0c0c0c0c-0000-4000-8000-000000000001";
    mocks.bridge.get.mockResolvedValue({ item: { id: CLIENT, name: "Example Engineering Ltd", row_version: 1 } });
    mocks.commerce.write.mockResolvedValue({ item: { id: "e9" } });
    render(`/commerce/customers/${CLIENT}`);
    await flush();
    act(() => buttonNamed("Add item")!.click());
    act(() => buttonNamed("Kickoff")!.click());
    expect(container.querySelector<HTMLInputElement>("#engagement-new-title")!.value).toBe("Kickoff: mapping the climb");
    submitForm(container.querySelector("#engagement-new-title")!);
    await flush();
    const body = mocks.commerce.write.mock.calls[0]![2].body;
    expect(body).toMatchObject({ title: "Kickoff: mapping the climb", kind: "kickoff", phase: "Discovery" });
    expect(body.occurredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("hides apply on a validated import and issue on a draft invoice from an agent", async () => {
    mocks.commerce.get.mockResolvedValue({ item: { id: "job-1", filename: "prices.csv", status: "validated", dry_run: true, rows: { items: [], nextCursor: null } } });
    render("/commerce/imports/job-1");
    await flush();
    expect(container.textContent).toContain("prices.csv");
    expect(byTestId("commerce-import-apply")).toBeNull();
    expect(byTestId("commerce-people-only-note")?.textContent).toContain("A person applies imports");

    act(() => root.unmount());
    root = createRoot(container);
    mocks.bridge.get.mockResolvedValue({ item: draftOrder });
    render(`/commerce/orders/${ORDER_ID}`);
    await flush();
    expect(byTestId("commerce-draft-invoice")).not.toBeNull();
    expect(buttonNamed("Edit draft")).toBeDefined();
    expect(byTestId("commerce-invoice-issue")).toBeNull();
    expect(byTestId("commerce-draft-invoice")?.querySelector("[data-testid=commerce-people-only-note]")?.textContent).toContain("A person issues invoices");
  });

  it("shows apply and issue to a person", async () => {
    person();
    mocks.commerce.get.mockResolvedValue({ item: { id: "job-1", filename: "prices.csv", status: "validated", dry_run: true, rows: { items: [], nextCursor: null } } });
    render("/commerce/imports/job-1");
    await flush();
    expect(byTestId("commerce-import-apply")).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    mocks.bridge.get.mockResolvedValue({ item: draftOrder });
    render(`/commerce/orders/${ORDER_ID}`);
    await flush();
    expect(byTestId("commerce-invoice-issue")).not.toBeNull();
  });

  it("asks for a refund with an Idempotency-Key, shows the request state, and never offers to move money", async () => {
    mocks.bridge.get.mockResolvedValue({ item: order });
    mocks.commerce.requestRefund.mockResolvedValue({
      approval: { id: "appr-1", type: "commerce_refund_request", status: "pending", payload: {}, createdAt: "2026-11-04T10:00:00Z" },
      request: { id: "req-1", status: "requested" },
    });
    render(`/commerce/orders/${ORDER_ID}`);
    await flush();
    expect(byTestId("commerce-draft-invoice")).toBeNull();
    act(() => (byTestId("commerce-refund-open") as HTMLButtonElement).click());
    const amount = container.querySelector<HTMLInputElement>("#refund-amount")!;
    expect(amount.value).toBe("120.00");
    type(amount, "20");
    type(container.querySelector<HTMLTextAreaElement>("#refund-reason")!, "Two seats not used");
    submitForm(amount);
    await flush();
    const [, site, input, key] = mocks.commerce.requestRefund.mock.calls[0]!;
    expect(site).toBe("site-1");
    expect(input).toEqual({ orderId: ORDER_ID, amountMinor: 2000, reason: "Two seats not used" });
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const sent = byTestId("commerce-refund-sent");
    expect(sent?.textContent).toContain("Refund request sent");
    expect(sent?.querySelector("a")?.getAttribute("href")).toBe("/approvals/appr-1");
    expect(container.textContent).not.toMatch(/refund now|issue refund|stripe refund/i);
  });

  it("lists an order's refund requests from their cards", async () => {
    mocks.bridge.get.mockResolvedValue({ item: order });
    mocks.approvals.mockResolvedValue([
      { id: "appr-2", type: "commerce_refund_request", status: "approved", createdAt: "2026-11-02T10:00:00Z",
        payload: { siteId: "site-1", orderId: ORDER_ID, amountMinor: 5000, currency: "GBP", requestStatus: "approved" } },
      { id: "appr-3", type: "commerce_refund_request", status: "pending", createdAt: "2026-11-03T10:00:00Z",
        payload: { siteId: "site-1", orderId: "another-order", amountMinor: 100 } },
    ]);
    render(`/commerce/orders/${ORDER_ID}`);
    await flush();
    const cards = byTestId("commerce-refund-cards");
    expect(cards?.querySelectorAll("li")).toHaveLength(1);
    expect(cards?.textContent).toContain("£50.00");
    expect(cards?.textContent).toContain("Approved");
    expect(cards?.textContent).toContain("On the website: Approved");
  });

  it("labels the payment report's Stripe mode and has no action buttons on it", async () => {
    mocks.commerce.payments.mockResolvedValue({ report: { from: null, to: null, stripeMode: "test", totals: [], refundRequests: [], items: [] } });
    render("/commerce/payments");
    await flush();
    expect(byTestId("commerce-stripe-mode")?.textContent).toBe("Test mode");
    const buttons = [...container.querySelectorAll("[data-testid=commerce-payments] button")].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(["Show"]);
  });

  describe("activation steps on a licence (GRE-3983)", () => {
    beforeEach(() => {
      mocks.bridge.get.mockResolvedValue({ item: licence });
      mocks.commerce.list.mockImplementation(vendorsList([otherVendor, vendor]));
    });

    it("shows the masked key and the matched vendor's steps, and saves with expectedRowVersion and an Idempotency-Key", async () => {
      person();
      mocks.commerce.putActivationSteps
        .mockRejectedValueOnce(new ApiError("The website's data bridge had an error. Try again later.", 502, { error: "x" }))
        .mockResolvedValueOnce({ item: { vendorId: VENDOR_ID, vendorName: "Aspose", status: "published",
          activationSteps: "1. Download the file\n2. Open it", rowVersion: 4, updatedAt: "2026-11-04T10:00:00Z", licencesInRange: 12 } });
      render(`/commerce/licences/${LICENCE_ID}`);
      await flush();
      const section = byTestId("commerce-activation-steps")!;
      expect(byTestId("commerce-activation-key")?.textContent).toBe("•••• 7Q2X");
      expect(container.querySelector<HTMLSelectElement>("#activation-vendor")!.value).toBe(VENDOR_ID);
      expect(byTestId("commerce-activation-current")?.textContent).toBe("1. Download the file");

      act(() => (byTestId("commerce-activation-edit") as HTMLButtonElement).click());
      const steps = container.querySelector<HTMLTextAreaElement>("#activation-steps")!;
      expect(steps.value).toBe("1. Download the file");
      type(steps, "  1. Download the file\n2. Open it  ");
      submitForm(steps);
      await flush();
      const [company, site, vendorId, input, key] = mocks.commerce.putActivationSteps.mock.calls[0]!;
      expect([company, site, vendorId]).toEqual([GREATSTONE, "site-1", VENDOR_ID]);
      expect(input).toEqual({ activationSteps: "1. Download the file\n2. Open it", expectedRowVersion: 3 });
      expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(byTestId("commerce-write-error")?.textContent).toContain("Try again later");

      // the refetch after the save reads the site as it is now
      mocks.commerce.list.mockImplementation(vendorsList([otherVendor, { ...vendor, activation_instructions: "1. Download the file\n2. Open it", row_version: 4 }]));
      submitForm(container.querySelector("#activation-steps")!);
      await flush();
      expect(mocks.commerce.putActivationSteps.mock.calls[1]![4]).toBe(key);
      expect(byTestId("commerce-activation-saved")?.textContent).toBe("Saved Aspose's steps. Shows on 12 licences.");
      expect(byTestId("commerce-activation-current")?.textContent).toBe("1. Download the file\n2. Open it");
      expect(section.textContent).not.toMatch(/licence_key(?!_last4)/);
    });

    it("hides the change from an agent on a published vendor, and lets an agent change a draft one", async () => {
      render(`/commerce/licences/${LICENCE_ID}`);
      await flush();
      expect(byTestId("commerce-activation-edit")).toBeNull();
      expect(byTestId("commerce-activation-steps")?.querySelector("[data-testid=commerce-people-only-note]")?.textContent).toContain("a person changes its steps");

      const select = container.querySelector<HTMLSelectElement>("#activation-vendor")!;
      act(() => { select.value = otherVendor.id; select.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(byTestId("commerce-activation-empty")?.textContent).toContain("JetBrains has no activation steps yet");
      expect(byTestId("commerce-activation-edit")?.textContent).toBe("Add steps");
      expect(container.textContent).toContain("The website matches this licence to Aspose");
    });

    it("says when the website refuses steps that hold a licence key, without repeating the text", async () => {
      person();
      mocks.commerce.putActivationSteps.mockRejectedValueOnce(new ApiError("The activation steps hold a licence key.", 400,
        { error: "The activation steps hold a licence key.", code: "website_bridge_licence_key_in_text" }));
      render(`/commerce/licences/${LICENCE_ID}`);
      await flush();
      act(() => (byTestId("commerce-activation-edit") as HTMLButtonElement).click());
      const steps = container.querySelector<HTMLTextAreaElement>("#activation-steps")!;
      type(steps, "Paste TEST-KEY-ABCD-1234 into the box");
      submitForm(steps);
      await flush();
      const refusal = byTestId("commerce-licence-key-in-text");
      expect(refusal?.textContent).toContain("The steps hold a full licence key");
      expect(refusal?.textContent).not.toContain("TEST-KEY");
      expect(byTestId("commerce-activation-saved")).toBeNull();
    });

    it("on a conflict, starts again from the vendor's steps as they are now", async () => {
      person();
      mocks.commerce.putActivationSteps.mockRejectedValueOnce(conflict({ vendorId: VENDOR_ID, vendorName: "Aspose", status: "published",
        activationSteps: "Steps someone else saved", rowVersion: 5, updatedAt: "2026-11-04T11:00:00Z", licencesInRange: 12 }));
      render(`/commerce/licences/${LICENCE_ID}`);
      await flush();
      act(() => (byTestId("commerce-activation-edit") as HTMLButtonElement).click());
      type(container.querySelector<HTMLTextAreaElement>("#activation-steps")!, "My steps");
      submitForm(container.querySelector("#activation-steps")!);
      await flush();
      expect(byTestId("commerce-conflict")).not.toBeNull();
      act(() => buttonNamed("Use the current version")!.click());
      await flush();
      expect(byTestId("commerce-conflict")).toBeNull();
      expect(container.querySelector<HTMLTextAreaElement>("#activation-steps")!.value).toBe("Steps someone else saved");

      mocks.commerce.putActivationSteps.mockResolvedValueOnce({ item: { vendorId: VENDOR_ID, vendorName: "Aspose", status: "published",
        activationSteps: "Steps someone else saved", rowVersion: 6, updatedAt: "2026-11-04T11:05:00Z", licencesInRange: 12 } });
      submitForm(container.querySelector("#activation-steps")!);
      await flush();
      expect(mocks.commerce.putActivationSteps.mock.calls[1]![3]).toEqual({ activationSteps: "Steps someone else saved", expectedRowVersion: 5 });
    });

    it("clears the steps after asking", async () => {
      person();
      mocks.commerce.putActivationSteps.mockResolvedValueOnce({ item: { vendorId: VENDOR_ID, vendorName: "Aspose", status: "published",
        activationSteps: null, rowVersion: 4, updatedAt: "2026-11-04T10:00:00Z", licencesInRange: 12 } });
      render(`/commerce/licences/${LICENCE_ID}`);
      await flush();
      act(() => (byTestId("commerce-activation-edit") as HTMLButtonElement).click());
      act(() => (byTestId("commerce-activation-clear") as HTMLButtonElement).click());
      await flush();
      expect(mocks.commerce.putActivationSteps).not.toHaveBeenCalled();
      mocks.commerce.list.mockImplementation(vendorsList([otherVendor, { ...vendor, activation_instructions: null, row_version: 4 }]));
      act(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Clear")!.click());
      await flush();
      expect(mocks.commerce.putActivationSteps.mock.calls[0]![3]).toEqual({ activationSteps: null, expectedRowVersion: 3 });
      expect(byTestId("commerce-activation-saved")?.textContent).toContain("Cleared Aspose's steps");
      expect(byTestId("commerce-activation-empty")).not.toBeNull();
    });
  });
});
