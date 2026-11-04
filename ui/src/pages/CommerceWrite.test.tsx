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
  commerce: { list: vi.fn(), get: vi.fn(), fx: vi.fn(), payments: vi.fn(), write: vi.fn(), requestRefund: vi.fn() },
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
    mocks.commerce.fx.mockResolvedValue({ item: { usd_to_gbp_display_rate: "0.7900", row_version: 4, history: [] } });
    render("/commerce/currency");
    await flush();
    expect(byTestId("commerce-fx-rate")?.textContent).toBe("1 USD = 0.7900 GBP");
    expect(buttonNamed("Change rate")).toBeUndefined();
    expect(byTestId("commerce-people-only-note")?.textContent).toContain("Only a person changes the rate");
  });

  it("shows the server's people-only refusal when it comes back", async () => {
    person();
    mocks.commerce.fx.mockResolvedValue({ item: { usd_to_gbp_display_rate: "0.7900", row_version: 4, history: [] } });
    const message = "Only a person can do this, by clicking in GSAM. Agents draft; people publish, archive, change FX, apply imports, issue invoices and decide refunds.";
    mocks.commerce.write.mockRejectedValueOnce(new ApiError(message, 403, { error: message, code: "website_commerce_people_only" }));
    render("/commerce/currency");
    await flush();
    act(() => buttonNamed("Change rate")!.click());
    const input = container.querySelector<HTMLInputElement>("#commerce-fx-input")!;
    type(input, "0.81");
    submitForm(input);
    await flush();
    expect(mocks.commerce.write.mock.calls[0]![2]).toEqual({ method: "PATCH", parts: ["fx"], body: { usdToGbpDisplayRate: "0.81", expectedRowVersion: 4 } });
    expect(byTestId("commerce-people-only-error")?.textContent).toBe(message);
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
    expect(byTestId("commerce-people-only-note")?.textContent).toContain("A person issues invoices");
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
});
