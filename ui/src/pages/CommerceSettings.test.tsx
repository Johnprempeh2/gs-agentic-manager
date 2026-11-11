// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

// The commerce settings screens (GRE-4784): order status and the licence email, licence keys, clients and their
// timeline, enquiries and leads, portal receipts and customer tiers. People-only buttons show for a person only, and
// each change is the GRE-4782 route with its row version.

const GREATSTONE = "34dad57e-b5ad-4a72-9400-9eba645c99f6";
const ORDER_ID = "0d0d0d0d-0000-4000-8000-000000000001";
const LICENCE_ID = "0e0e0e0e-0000-4000-8000-000000000001";
const CLIENT_ID = "0c0c0c0c-0000-4000-8000-000000000001";
const TIER_ID = "0b0b0b0b-0000-4000-8000-000000000001";
const SI_ID = "si-01010101-0000-4000-8000-000000000001";
const FD_ID = "fd-02020202-0000-4000-8000-000000000002";
const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  sites: vi.fn(),
  features: vi.fn(),
  bridge: { list: vi.fn(), get: vi.fn(), fileUrl: vi.fn() },
  organisations: vi.fn(),
  commerce: { list: vi.fn(), get: vi.fn(), write: vi.fn(), requestRefund: vi.fn(), putActivationSteps: vi.fn() },
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

const order = {
  id: ORDER_ID, reference: "GS-1001", status: "confirmed", currency: "GBP", total_minor: "0", invoice_number: "INV-1",
  customer_email: "ana@acme.example", row_version: 4, items: [], created_at: "2026-10-01T00:00:00Z",
};
const licence = { id: LICENCE_ID, offering_name: "Aspose.Total", licence_key_last4: "7Q2X", status: "issued", row_version: 2, created_at: "2026-10-01T00:00:00Z" };
const client = { id: CLIENT_ID, name: "Acme Ltd", slug: "acme", tier_id: TIER_ID, domain: "acme.example", row_version: 5, users: [] };
const tier = { id: TIER_ID, slug: "gold", name: "Gold", rank: 2 };
const draftItem = { id: "e1e1e1e1-0000-4000-8000-000000000001", customer_id: CLIENT_ID, kind: "note", status: "draft", title: "Kickoff notes", row_version: 1 };
const sharedItem = { id: "e1e1e1e1-0000-4000-8000-000000000002", customer_id: CLIENT_ID, kind: "recap", status: "shared", title: "Week 1 recap", row_version: 3 };
const enquiry = { id: SI_ID, name: "Ana", email: "ana@acme.example", source: "service-enquiry", status: "new", createdAt: "2026-11-01T09:00:00Z" };
const lead = { id: FD_ID, name: "Ben", email: "ben@beta.example", source: "front-door", status: "contacted", createdAt: "2026-11-02T09:00:00Z" };
const receipt = { id: "a1a1a1a1-0000-4000-8000-000000000001", customer_id: CLIENT_ID, signer_name: "Ana", signer_email: "ana@acme.example", action: "accept", accepted_at: "2026-11-03T09:00:00Z" };

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

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const person = () => mocks.access.mockResolvedValue({ source: "session", userId: "user-1" });
const agent = () => mocks.access.mockRejectedValue(new ApiError("Board access required", 403, { error: "Board access required" }));
/** Data reads by resource. */
const bridgeRows = (rows: Record<string, Record<string, unknown>[]>) => (_c: string, _s: string, resource: string) =>
  Promise.resolve({ items: rows[resource] ?? [], nextCursor: null });

describe("Commerce settings screens", () => {
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
    mocks.commerce.list.mockImplementation((_c: string, _s: string, resource: string) =>
      Promise.resolve({ items: resource === "customer-tiers" ? [tier] : [], nextCursor: null }));
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

  const byTestId = (id: string, scope: ParentNode = container) => scope.querySelector(`[data-testid=${id}]`);
  const buttonNamed = (name: string, scope: ParentNode = container) =>
    [...scope.querySelectorAll("button")].find((button) => button.textContent?.trim() === name || button.getAttribute("aria-label") === name);
  const confirm = (label: string) => act(() => { buttonNamed(label, document.body.querySelector("[role=alertdialog]")!)!.click(); });
  const submitForm = (input: Element) => act(() => { input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  const lastWrite = () => mocks.commerce.write.mock.calls.at(-1)!;

  it("shows the Clients area with clients, enquiries and receipts", async () => {
    render("/commerce/customers");
    await flush();
    const tabs = [...container.querySelectorAll("[role=tab]")].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Sales", "Catalogue", "Clients", "Client companies", "Enquiries and leads", "Portal receipts"]);
  });

  it("lets anyone set an order's status, at its row version, and only a person email the licence", async () => {
    mocks.bridge.get.mockResolvedValue({ item: order });
    render(`/commerce/orders/${ORDER_ID}`);
    await flush();
    const section = byTestId("commerce-order-status")!;
    expect(byTestId("commerce-order-notify", section)).toBeNull();
    expect(byTestId("commerce-people-only-note", section)?.textContent).toContain("A person sends client emails");

    mocks.commerce.write.mockResolvedValue({ item: { ...order, status: "fulfilled", row_version: 5 } });
    act(() => { buttonNamed("Change status", section)!.click(); });
    const select = container.querySelector<HTMLSelectElement>("#order-status")!;
    choose(select, "fulfilled");
    submitForm(select);
    await flush();
    expect(lastWrite()[2]).toEqual({ method: "PATCH", parts: ["orders", ORDER_ID], body: { status: "fulfilled", expectedRowVersion: 4 } });
  });

  it("sends the licence email for a person and says how it went", async () => {
    person();
    mocks.bridge.get.mockResolvedValue({ item: order });
    mocks.commerce.write.mockResolvedValue({ item: order, email: "not_configured" });
    render(`/commerce/orders/${ORDER_ID}`);
    await flush();
    act(() => { (byTestId("commerce-order-notify") as HTMLButtonElement).click(); });
    confirm("Send email");
    await flush();
    expect(lastWrite()[2]).toEqual({ method: "POST", parts: ["orders", ORDER_ID, "notify-licence"] });
    expect(byTestId("commerce-order-notify-result")?.textContent).toContain("no email service");
  });

  it("does not offer a status change on a cancelled order", async () => {
    mocks.bridge.get.mockResolvedValue({ item: { ...order, status: "cancelled" } });
    render(`/commerce/orders/${ORDER_ID}`);
    await flush();
    expect(byTestId("commerce-order-status")?.textContent).toContain("Its status does not change");
    expect(buttonNamed("Change status")).toBeUndefined();
  });

  it("hides key, revoke and re-issue from an agent, and revokes for a person at the row version", async () => {
    mocks.bridge.get.mockResolvedValue({ item: licence });
    render(`/commerce/licences/${LICENCE_ID}`);
    await flush();
    const section = byTestId("commerce-licence-actions")!;
    expect(byTestId("commerce-licence-revoke", section)).toBeNull();
    expect(byTestId("commerce-licence-rekey", section)).toBeNull();
    expect(buttonNamed("Edit details", section)).toBeDefined();

    act(() => root.unmount());
    root = createRoot(container);
    person();
    mocks.commerce.write.mockResolvedValue({ item: { ...licence, status: "revoked", row_version: 3 } });
    render(`/commerce/licences/${LICENCE_ID}`);
    await flush();
    act(() => { (byTestId("commerce-licence-revoke") as HTMLButtonElement).click(); });
    confirm("Revoke");
    await flush();
    expect(lastWrite()[2]).toEqual({ method: "POST", parts: ["licences", LICENCE_ID, "revoke"], body: { expectedRowVersion: 2 } });
  });

  it("replaces a key for a person with only the key in the body", async () => {
    person();
    mocks.bridge.get.mockResolvedValue({ item: licence });
    mocks.commerce.write.mockResolvedValue({ item: { ...licence, licence_key_last4: "ZZ99", row_version: 3 } });
    render(`/commerce/licences/${LICENCE_ID}`);
    await flush();
    act(() => { (byTestId("commerce-licence-rekey") as HTMLButtonElement).click(); });
    const input = container.querySelector<HTMLInputElement>("#licence-secret-value")!;
    expect(input.type).toBe("password");
    type(input, "AAAA-BBBB-ZZ99");
    submitForm(input);
    await flush();
    expect(lastWrite()[2]).toEqual({ method: "PATCH", parts: ["licences", LICENCE_ID], body: { licenceKey: "AAAA-BBBB-ZZ99", expectedRowVersion: 2 } });
  });

  it("leaves the tier out of an agent's client form and puts it in a person's", async () => {
    mocks.bridge.get.mockResolvedValue({ item: client });
    render(`/commerce/customers/${CLIENT_ID}`);
    await flush();
    expect(container.textContent).toContain("Gold");
    act(() => { buttonNamed("Edit client")!.click(); });
    expect(container.querySelector("#client-tierId")).toBeNull();
    expect(container.textContent).toContain("A person sets a client's tier");

    act(() => root.unmount());
    root = createRoot(container);
    person();
    mocks.commerce.write.mockResolvedValue({ item: { ...client, tier_id: null, row_version: 6 } });
    render(`/commerce/customers/${CLIENT_ID}`);
    await flush();
    act(() => { buttonNamed("Edit client")!.click(); });
    const tierSelect = container.querySelector<HTMLSelectElement>("#client-tierId")!;
    choose(tierSelect, "");
    submitForm(tierSelect);
    await flush();
    expect(lastWrite()[2]).toEqual({ method: "PATCH", parts: ["customers", CLIENT_ID], body: { tierId: null, expectedRowVersion: 5 } });
  });

  it("lets an agent change a draft timeline item but not a shared one, and a person share", async () => {
    mocks.bridge.get.mockResolvedValue({ item: client });
    mocks.bridge.list.mockImplementation(bridgeRows({ engagements: [draftItem, sharedItem] }));
    render(`/commerce/customers/${CLIENT_ID}`);
    await flush();
    const timeline = byTestId("commerce-timeline")!;
    expect(buttonNamed("Edit Kickoff notes", timeline)).toBeDefined();
    expect(buttonNamed("Edit Week 1 recap", timeline)).toBeUndefined();
    expect(buttonNamed("Delete Week 1 recap", timeline)).toBeUndefined();
    expect(byTestId("commerce-timeline-share", timeline)).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    person();
    mocks.commerce.write.mockResolvedValue({ item: { ...draftItem, status: "shared", row_version: 2 } });
    render(`/commerce/customers/${CLIENT_ID}`);
    await flush();
    act(() => { (byTestId("commerce-timeline-share") as HTMLButtonElement).click(); });
    confirm("Share");
    await flush();
    expect(lastWrite()[2]).toEqual({ method: "POST", parts: ["engagements", draftItem.id, "share"], body: { expectedRowVersion: 1 } });
  });

  it("sets an enquiry's status, and offers delete on a front door lead to a person only", async () => {
    mocks.bridge.list.mockImplementation(bridgeRows({ enquiries: [enquiry, lead] }));
    mocks.commerce.write.mockResolvedValue({ item: { id: SI_ID, status: "contacted", rowVersion: 2 } });
    render("/commerce/enquiries");
    await flush();
    expect(container.querySelectorAll("[data-testid=commerce-enquiry]")).toHaveLength(2);
    expect(byTestId("commerce-enquiry-delete")).toBeNull();
    choose(container.querySelector<HTMLSelectElement>(`#enquiry-status-${SI_ID}`)!, "contacted");
    await flush();
    expect(lastWrite()[2]).toEqual({ method: "PATCH", parts: ["enquiries", SI_ID], body: { status: "contacted" } });

    act(() => root.unmount());
    root = createRoot(container);
    person();
    mocks.commerce.write.mockResolvedValue({ id: FD_ID, deleted: true });
    render("/commerce/enquiries");
    await flush();
    // only the front door lead can be deleted
    expect(container.querySelectorAll("[data-testid=commerce-enquiry-delete]")).toHaveLength(1);
    act(() => { (byTestId("commerce-enquiry-delete") as HTMLButtonElement).click(); });
    confirm("Delete lead");
    await flush();
    expect(lastWrite()[2]).toEqual({ method: "DELETE", parts: ["enquiries", FD_ID] });
  });

  it("sends a portal receipt again for a person, and shows it queued", async () => {
    person();
    mocks.bridge.list.mockImplementation(bridgeRows({ "portal-acceptances": [receipt], customers: [client] }));
    mocks.commerce.write.mockResolvedValue({ item: { acceptanceId: receipt.id, status: "queued", attempts: 0 } });
    render("/commerce/portal-acceptances");
    await flush();
    expect(byTestId("commerce-receipt")?.textContent).toContain("Acme Ltd");
    act(() => { (byTestId("commerce-receipt-resend") as HTMLButtonElement).click(); });
    confirm("Send again");
    await flush();
    expect(lastWrite()[2]).toEqual({ method: "POST", parts: ["portal-acceptances", receipt.id, "resend"] });
    expect(byTestId("commerce-receipt-resend")).toBeNull();
    expect(byTestId("commerce-receipt")?.textContent).toContain("Queued");
  });

  it("adds a customer tier", async () => {
    mocks.commerce.write.mockResolvedValue({ item: { id: "t2", slug: "silver", name: "Silver" } });
    render("/commerce/customer-tiers");
    await flush();
    expect(byTestId("commerce-tier")?.textContent).toContain("Gold");
    act(() => { buttonNamed("New customer tier")!.click(); });
    type(container.querySelector<HTMLInputElement>("#tier-new-name")!, "Silver");
    type(container.querySelector<HTMLInputElement>("#tier-new-slug")!, "silver");
    submitForm(container.querySelector("#tier-new-slug")!);
    await flush();
    expect(lastWrite()[2]).toEqual({ method: "POST", parts: ["customer-tiers"], body: { name: "Silver", slug: "silver" } });
  });

  // ---- admin parity round 2 ----
  const seatRequest = { id: "5e5e5e5e-0000-4000-8000-000000000001", customer_id: CLIENT_ID, full_name: "Nia Mensah", email: "nia@acme.example",
    role: "member", note: "Finance lead", status: "pending", created_at: "2026-11-05T09:00:00Z" };
  const decided = { ...seatRequest, id: "5e5e5e5e-0000-4000-8000-000000000002", full_name: "Kofi", email: "kofi@acme.example", status: "declined",
    handled_at: "2026-11-06T09:00:00Z" };

  it("shows a client's seat requests; an agent cannot decide, a person approves after a confirm", async () => {
    mocks.bridge.get.mockResolvedValue({ item: client });
    mocks.bridge.list.mockImplementation(bridgeRows({ "invite-requests": [decided, seatRequest] }));
    render(`/commerce/customers/${CLIENT_ID}`);
    await flush();
    const section = byTestId("commerce-client-seat-requests")!;
    expect(section.textContent).toContain("Seat requests (1 waiting)");
    const rows = section.querySelectorAll("[data-testid=commerce-seat-request]");
    expect([...rows].map((row) => row.textContent?.includes("Nia Mensah"))).toEqual([true, false]);
    expect(rows[1]!.textContent).toContain("Declined");
    expect(byTestId("commerce-seat-approve")).toBeNull();
    expect(section.textContent).toContain("A person approves or declines a seat");
    expect(mocks.bridge.list).toHaveBeenCalledWith(GREATSTONE, "site-1", "invite-requests", expect.objectContaining({ customer: CLIENT_ID }));

    act(() => root.unmount());
    root = createRoot(container);
    person();
    mocks.commerce.write.mockResolvedValue({ item: { ...seatRequest, status: "provisioned" } });
    render(`/commerce/customers/${CLIENT_ID}`);
    await flush();
    act(() => { (byTestId("commerce-seat-approve") as HTMLButtonElement).click(); });
    expect(document.body.querySelector("[role=alertdialog]")?.textContent).toContain("nia@acme.example");
    confirm("Approve and add");
    await flush();
    expect(lastWrite()[2]).toEqual({ method: "POST", parts: ["invite-requests", seatRequest.id, "decision"], body: { decision: "approve" } });
  });

  it("lists the seat requests waiting across clients on Clients, and hides the panel when none wait", async () => {
    mocks.bridge.list.mockImplementation(bridgeRows({ customers: [client], "invite-requests": [seatRequest, decided] }));
    render("/commerce/customers");
    await flush();
    const waiting = byTestId("commerce-seat-requests-waiting")!;
    expect(waiting.textContent).toContain("1 seat request is waiting");
    expect(waiting.textContent).toContain("Nia Mensah for Acme Ltd");
    expect(waiting.querySelector("a")?.getAttribute("href")).toBe(`/commerce/customers/${CLIENT_ID}`);

    act(() => root.unmount());
    root = createRoot(container);
    mocks.bridge.list.mockImplementation(bridgeRows({ customers: [client], "invite-requests": [decided] }));
    render("/commerce/customers");
    await flush();
    expect(byTestId("commerce-seat-requests-waiting")).toBeNull();
  });

  it("offers the buyer's PO on an order that has one, and says plainly when the download fails", async () => {
    mocks.bridge.fileUrl.mockReturnValue(`/api/x/orders/${ORDER_ID}/po-document`);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "The website has no such record." }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.bridge.get.mockResolvedValue({ item: { ...order, has_po_document: true } });
    render(`/commerce/orders/${ORDER_ID}`);
    await flush();
    expect(mocks.bridge.fileUrl).toHaveBeenCalledWith(GREATSTONE, "site-1", "orders", ORDER_ID, "po-document");
    act(() => { (byTestId("commerce-po-download") as HTMLButtonElement).click(); });
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(`/api/x/orders/${ORDER_ID}/po-document`, expect.objectContaining({ credentials: "same-origin" }));
    expect(container.querySelector("[role=alert]")?.textContent).toBe("The website has no such record.");
    vi.unstubAllGlobals();

    act(() => root.unmount());
    root = createRoot(container);
    mocks.bridge.get.mockResolvedValue({ item: order });
    render(`/commerce/orders/${ORDER_ID}`);
    await flush();
    expect(byTestId("commerce-po-download")).toBeNull();
  });

  it("offers the agent package on a front door lead that has one, not on a service enquiry", async () => {
    mocks.bridge.list.mockImplementation(bridgeRows({ enquiries: [{ ...enquiry, agentPackage: true }, { ...lead, agentPackage: true }] }));
    render("/commerce/enquiries");
    await flush();
    expect(container.querySelectorAll("[data-testid=commerce-agent-package]")).toHaveLength(1);
    expect(mocks.bridge.fileUrl).toHaveBeenCalledWith(GREATSTONE, "site-1", "enquiries", FD_ID, "agent-package");
  });
});
