import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { CommercePage } from "@/pages/Commerce";
import { GREATSTONE_COMPANY_ID } from "@/lib/commerce";
import { queryKeys } from "@/lib/queryKeys";
import { Route, Routes, useNavigate } from "@/lib/router";
import { storybookCompanies } from "../fixtures/paperclipData";

// The commerce settings screens (GRE-4784) on the real Commerce page, with the website bridge answered from synthetic
// rows. Layout review only: no client names, keys or claims.

const G = GREATSTONE_COMPANY_ID;
const SITE = "site-commerce";
const CLIENT = "0c0c0c0c-0000-4000-8000-000000000001";
const ORDER = "0d0d0d0d-0000-4000-8000-000000000001";
const LICENCE = "0e0e0e0e-0000-4000-8000-000000000001";
const TIER_GOLD = "0b0b0b0b-0000-4000-8000-000000000001";
const TIER_SILVER = "0b0b0b0b-0000-4000-8000-000000000002";

const tiers = [
  { id: TIER_GOLD, slug: "gold", name: "Gold", rank: 3, description: "Partners with an annual agreement." },
  { id: TIER_SILVER, slug: "silver", name: "Silver", rank: 2, description: "Repeat buyers." },
  { id: "0b0b0b0b-0000-4000-8000-000000000003", slug: "standard", name: "Standard", rank: 1, description: null },
];
const clients = [
  { id: CLIENT, name: "Example Engineering Ltd", slug: "example-engineering", tier_id: TIER_GOLD, domain: "example-engineering.test",
    billing_currency: "GBP", notes: "Renewals in March. Prefers invoices by email.", created_at: "2026-03-02T10:00:00Z", row_version: 5,
    users: [{ id: "u1", full_name: "Jo Example", email: "jo@example-engineering.test", is_primary: true }, { id: "u2", full_name: "Sam Example", email: "sam@example-engineering.test" }] },
  { id: "0c0c0c0c-0000-4000-8000-000000000002", name: "Sample Analytics", slug: "sample-analytics", tier_id: TIER_SILVER, domain: "sample-analytics.test", row_version: 2, users: [] },
  { id: "0c0c0c0c-0000-4000-8000-000000000003", name: "Demo Studio with a much longer company name to check wrapping", slug: "demo-studio", tier_id: null, domain: null, row_version: 1, users: [{ id: "u3", email: "a@demo.test" }] },
];
const engagements = [
  { id: "e1", customer_id: CLIENT, kind: "kickoff", status: "shared", title: "Kickoff workshop", summary: "Agreed scope and the first two milestones.", occurred_on: "2026-10-02", phase: "Discovery", owner_name: "John", pinned: true, row_version: 3 },
  { id: "e2", customer_id: CLIENT, kind: "recap", status: "shared", title: "Week 3 recap", summary: "Data model signed off.", occurred_on: "2026-10-20", external_url: "https://example.test/recap", row_version: 2 },
  { id: "e3", customer_id: CLIENT, kind: "note", status: "draft", title: "Notes for the review call", occurred_on: "2026-11-06", row_version: 1 },
];
const licences = [
  { id: LICENCE, customer_id: CLIENT, order_id: ORDER, offering_name: "Aspose.Total for .NET", variant_name: "Developer OEM", licence_key_last4: "7Q2X", seats: 2, status: "issued", delivered_at: "2026-10-05T09:00:00Z", expires_at: "2027-10-05T00:00:00Z", created_at: "2026-10-05T09:00:00Z", row_version: 2 },
  { id: "0e0e0e0e-0000-4000-8000-000000000002", customer_id: CLIENT, offering_name: "JetBrains All Products", licence_key_last4: "K9P1", status: "revoked", created_at: "2026-06-01T09:00:00Z", row_version: 4 },
];
const orders = [
  { id: ORDER, reference: "GS-1001", customer_id: CLIENT, customer_email: "jo@example-engineering.test", status: "confirmed", currency: "GBP",
    subtotal_minor: "129900", total_minor: "129900", refunded_minor: "0", invoice_number: "INV-0042", placed_at: "2026-10-04T12:00:00Z",
    created_at: "2026-10-04T12:00:00Z", row_version: 4,
    items: [{ id: "i1", offering_name: "Aspose.Total for .NET", variant_name: "Developer OEM", qty: 1, unit_price_minor: "129900", line_total_minor: "129900", currency: "GBP" }] },
];
const enquiries = [
  { id: "fd-02020202-0000-4000-8000-000000000002", name: "Alex Example", email: "alex@example-retail.test", organisationName: "Example Retail", source: "front-door", status: "new", createdAt: "2026-11-08T15:12:00Z" },
  { id: "si-01010101-0000-4000-8000-000000000001", name: "Jo Example", email: "jo@example-engineering.test", organisationName: "Example Engineering Ltd", source: "service-enquiry", status: "contacted",
    message: "We want help choosing between two document SDKs for a new reporting service. Could we book a call next week?", createdAt: "2026-11-05T09:30:00Z" },
  { id: "si-01010101-0000-4000-8000-000000000003", name: "Sam Example", email: "sam@sample-analytics.test", source: "service-enquiry", status: "closed", createdAt: "2026-10-28T11:00:00Z" },
];
const receipts = [
  { id: "a1", customer_id: CLIENT, signer_name: "Jo Example", signer_title: "Head of IT", signer_email: "jo@example-engineering.test", action: "accept", document_version: 2, accepted_at: "2026-11-03T10:00:00Z" },
  { id: "a2", customer_id: "0c0c0c0c-0000-4000-8000-000000000002", signer_name: "Sam Example", signer_email: "sam@sample-analytics.test", action: "sign", document_version: 1, accepted_at: "2026-10-21T16:40:00Z" },
];

const DATA: Record<string, Record<string, unknown>[]> = {
  customers: clients, engagements, licences, orders, enquiries, "portal-acceptances": receipts,
  quotes: [], invoices: [], "customer-tiers": tiers, vendors: [],
};

function installCommerceFixtures() {
  const current = window as typeof window & { __commerceSettingsFixtures?: boolean };
  if (current.__commerceSettingsFixtures) return;
  current.__commerceSettingsFixtures = true;
  const previous = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    const path = url.pathname;
    if (path === "/api/companies" && (init?.method ?? "GET").toUpperCase() === "GET") {
      return Response.json([...storybookCompanies, { ...storybookCompanies[0], id: G, name: "Greatstone", issuePrefix: "GRE" }]);
    }
    const match = path.match(new RegExp(`^/api/companies/${G}/website/sites/${SITE}/(?:data|commerce)/([^/]+)(?:/([^/]+))?$`));
    if (match) {
      const rows = DATA[match[1]!] ?? [];
      if (match[2]) {
        const item = rows.find((row) => row.id === decodeURIComponent(match[2]!));
        return item ? Response.json({ item }) : Response.json({ error: "Not found" }, { status: 404 });
      }
      const customer = url.searchParams.get("customer");
      return Response.json({ items: customer ? rows.filter((row) => row.customer_id === customer) : rows, nextCursor: null });
    }
    if (path.startsWith(`/api/companies/${G}/`)) return Response.json([]);
    return previous(input, init);
  };
}
if (typeof window !== "undefined") installCommerceFixtures();

function CommerceAt({ path, person = true }: { path: string; person?: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    queryClient.setQueryData(queryKeys.instance.experimentalSettings, { enableWebsiteView: true });
    queryClient.setQueryData(queryKeys.website.sites(G), [{ id: SITE, companyId: G, domain: "greatstone.example", name: "Greatstone" }]);
    queryClient.setQueryData(queryKeys.website.features(G, SITE), [{ id: "f-shop", key: "shop", enabled: true, siteId: SITE }]);
    queryClient.setQueryData(queryKeys.access.currentBoardAccess, person ? { source: "session", userId: "user-board" } : null);
    queryClient.setQueryData(queryKeys.organisations.list(G, {}), []);
    setSelectedCompanyId(G);
    navigate(`/GRE${path}`, { replace: true });
    setReady(true);
  }, [path, person, navigate, queryClient, setSelectedCompanyId]);
  if (!ready || selectedCompanyId !== G) return null;
  return (
    <div className="p-4 sm:p-6">
      <Routes>
        <Route path="/:companyPrefix/commerce/:resource" element={<CommercePage />} />
        <Route path="/:companyPrefix/commerce/:resource/:recordId" element={<CommercePage />} />
      </Routes>
    </div>
  );
}

const meta = {
  title: "Commerce/Settings (GRE-4784)",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ClientCompanies: Story = { render: () => <CommerceAt path="/commerce/customers" /> };
export const ClientPage: Story = { render: () => <CommerceAt path={`/commerce/customers/${CLIENT}`} /> };
export const EnquiriesAndLeads: Story = { render: () => <CommerceAt path="/commerce/enquiries" /> };
export const PortalReceipts: Story = { render: () => <CommerceAt path="/commerce/portal-acceptances" /> };
export const CustomerTiers: Story = { render: () => <CommerceAt path="/commerce/customer-tiers" /> };
export const OrderStatus: Story = { render: () => <CommerceAt path={`/commerce/orders/${ORDER}`} /> };
export const LicenceKey: Story = { render: () => <CommerceAt path={`/commerce/licences/${LICENCE}`} /> };
export const ClientPageAsAgent: Story = { render: () => <CommerceAt path={`/commerce/customers/${CLIENT}`} person={false} /> };
