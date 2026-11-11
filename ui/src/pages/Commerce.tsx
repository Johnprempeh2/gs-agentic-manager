import { useEffect, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Building2, ExternalLink, ShoppingBag, X } from "lucide-react";
import { organisationsApi } from "@/api/organisations";
import { websiteDataBridgeApi } from "@/api/website-data-bridge";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { PageTabBar } from "@/components/PageTabBar";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { LicenceActivationSteps } from "@/components/commerce/CommerceActivationSteps";
import { CatalogueList, CatalogueRecord, type CatalogueResource } from "@/components/commerce/CommerceCatalogue";
import { ClientList, ClientRecord, CustomerTierList, EnquiryList, OrderLineLicences, ReceiptList } from "@/components/commerce/CommerceClients";
import { CommerceCurrency } from "@/components/commerce/CommerceCurrency";
import { CommerceImportJob, CommerceImports } from "@/components/commerce/CommerceImports";
import { CommercePayments } from "@/components/commerce/CommercePayments";
import { DraftInvoiceActions, QuoteActions, RefundRequest, isDraftInvoice } from "@/components/commerce/CommerceSalesActions";
import { LicenceActions, OrderStatusActions } from "@/components/commerce/CommerceSettingsActions";
import { useCommerceCustomers, useCommerceSite } from "@/hooks/useCommerceSite";
import { CATALOGUE_COPY } from "@/lib/commerce-catalogue";
import {
  COMMERCE_COPY,
  COMMERCE_RESOURCES,
  formatMinor,
  invoiceWebsiteUrl,
  isCommerceResource,
  maskedLicenceKey,
  newestFirst,
  organisationFor,
  recordTime,
  recordCode,
  recordTitle,
  recordTotal,
  statusLabel,
  statusTone,
  text,
  type CommerceRecord,
  type CommerceResource,
} from "@/lib/commerce";
import { queryKeys } from "@/lib/queryKeys";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { cn, formatDate, formatDateTime } from "@/lib/utils";

// The Commerce area (GRE-2383, Phase A of GRE-2326): the website's quotes, orders, invoices and licences, read
// through the admin bridge. Phase C (GRE-3972) adds the catalogue, currency, price-book import and the payment
// report, and the changes the bridge allows: drafts for anyone with Commerce rights, the rest for a person. Nothing
// here moves money or calls Stripe; a refund is a request a person decides on a card.

const PAGE_SIZE = 50;
const RECORD_LINK = "inline-flex w-fit items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const CATALOGUE_SECTIONS = ["offerings", "vendors", "categories", "pricing-rules", "customer-tiers", "currency", "imports"] as const;
type CatalogueSection = (typeof CATALOGUE_SECTIONS)[number];
// Clients, enquiries and portal receipts (GRE-4784): the website admin's settings beside sales and the catalogue.
const CLIENT_SECTIONS = ["customers", "enquiries", "portal-acceptances"] as const;
type ClientSection = (typeof CLIENT_SECTIONS)[number];
type CommerceSection = CommerceResource | "payments" | CatalogueSection | ClientSection;
type CommerceArea = "sales" | "catalogue" | "clients";

const SECTION_LABEL: Record<CommerceSection, string> = {
  ...Object.fromEntries(COMMERCE_RESOURCES.map((value) => [value, COMMERCE_COPY[value].label])) as Record<CommerceResource, string>,
  payments: "Payments",
  offerings: CATALOGUE_COPY.offerings.label,
  vendors: CATALOGUE_COPY.vendors.label,
  categories: CATALOGUE_COPY.categories.label,
  "pricing-rules": CATALOGUE_COPY["pricing-rules"].label,
  "customer-tiers": CATALOGUE_COPY["customer-tiers"].label,
  currency: "Currency",
  imports: "Price-book import",
  customers: "Client companies",
  enquiries: "Enquiries and leads",
  "portal-acceptances": "Portal receipts",
};
const AREA_SECTIONS: Record<CommerceArea, readonly CommerceSection[]> = {
  sales: [...COMMERCE_RESOURCES, "payments"],
  catalogue: CATALOGUE_SECTIONS,
  clients: CLIENT_SECTIONS,
};
const AREA_TABS = [{ value: "sales", label: "Sales" }, { value: "catalogue", label: "Catalogue" }, { value: "clients", label: "Clients" }];
const AREA_COPY: Record<CommerceArea, string> = {
  sales: "The website's quotes, orders, invoices, licences and Stripe payments",
  catalogue: "The website's offerings, vendors, categories, pricing, currency and price-book imports",
  clients: "The website's client companies, enquiries and leads, and portal receipts",
};

function sectionOf(value: string | undefined): CommerceSection | null {
  return value && value in SECTION_LABEL ? (value as CommerceSection) : null;
}
const areaOf = (section: CommerceSection): CommerceArea => ((CATALOGUE_SECTIONS as readonly string[]).includes(section) ? "catalogue"
  : (CLIENT_SECTIONS as readonly string[]).includes(section) ? "clients" : "sales");
const isCatalogueResource = (section: CommerceSection): section is CatalogueResource =>
  ["offerings", "vendors", "categories", "pricing-rules"].includes(section);

function StatusPill({ status }: { status: unknown }) {
  const value = text(status);
  if (!value) return null;
  return (
    <span className={cn("inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", statusTone(value))}>
      {statusLabel(value)}
    </span>
  );
}

function when(value: unknown, withTime = false) {
  const at = text(value);
  if (!at || Number.isNaN(Date.parse(at))) return null;
  return withTime ? formatDateTime(at) : formatDate(at);
}

function customerName(record: CommerceRecord, customers: Map<string, CommerceRecord>) {
  const customer = customers.get(text(record.customer_id) ?? "");
  return text(customer?.name) ?? text(record.contact_company) ?? text(record.contact_name) ?? text(record.customer_email);
}

/** The second line of a row: who, and when. */
function rowMeta(resource: CommerceResource, record: CommerceRecord, customers: Map<string, CommerceRecord>) {
  const parts = [customerName(record, customers)];
  if (resource === "invoices") parts.unshift(text(record.reference) ? `Order ${text(record.reference)}` : null);
  if (resource === "licences") {
    parts.push(maskedLicenceKey(record));
    const expires = when(record.expires_at);
    parts.push(expires ? `Expires ${expires}` : null);
  } else {
    parts.push(when(recordTime(record)));
  }
  return parts.filter(Boolean).join(" · ");
}

function useCustomerMap(companyId: string, siteId: string) {
  const customers = useCommerceCustomers(companyId, siteId);
  return new Map((customers.data ?? []).map((customer) => [text(customer.id) ?? "", customer]));
}

export function CommerceList({ companyId, siteId, resource }: { companyId: string; siteId: string; resource: CommerceResource }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const customer = searchParams.get("customer") ?? undefined;
  const customers = useCustomerMap(companyId, siteId);
  const records = useInfiniteQuery({
    queryKey: queryKeys.website.data(companyId, siteId, resource, "list", customer ?? ""),
    queryFn: ({ pageParam }) => websiteDataBridgeApi.list(companyId, siteId, resource, {
      limit: PAGE_SIZE,
      ...(customer ? { customer } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor || undefined,
  });
  const copy = COMMERCE_COPY[resource];
  const filteredName = customer ? text(customers.get(customer)?.name) ?? "one customer" : null;
  const rows = newestFirst(records.data?.pages.flatMap((page) => page.items) ?? []);
  const clearCustomer = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("customer");
    setSearchParams(next, { replace: true });
  };

  return (
    <section className="space-y-3" aria-label={copy.label} data-testid="commerce-list">
      {filteredName ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Showing</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 font-medium">
            {filteredName}
            <button
              type="button"
              onClick={clearCustomer}
              className="rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Show every customer"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </span>
        </div>
      ) : null}
      {records.isLoading ? <PageSkeleton variant="list" /> : null}
      {records.error ? <ErrorState error={records.error} onRetry={() => void records.refetch()} retrying={records.isFetching} /> : null}
      {records.data && rows.length === 0 ? (
        <EmptyState icon={ShoppingBag} message={customer ? `No ${copy.label.toLowerCase()} for ${filteredName}.` : copy.empty} />
      ) : null}
      {rows.length ? (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {rows.map((record) => {
            const id = text(record.id) ?? "";
            const total = recordTotal(resource, record);
            const params = customer ? `?customer=${encodeURIComponent(customer)}` : "";
            return (
              <li key={id}>
                <Link
                  to={`/commerce/${resource}/${encodeURIComponent(id)}${params}`}
                  className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{recordTitle(resource, record)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {recordCode(resource, record) ? <span className="font-mono">{recordCode(resource, record)} · </span> : null}
                      {rowMeta(resource, record, customers)}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
                    {total ? <span className="text-sm font-medium tabular-nums">{total}</span> : null}
                    <StatusPill status={record.status} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      {records.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void records.fetchNextPage()} disabled={records.isFetchingNextPage}>
            {records.isFetchingNextPage ? "Loading" : "Load more"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

type FieldKind = "text" | "money" | "date" | "datetime";
type FieldDef = [label: string, key: string, kind?: FieldKind];

const DETAIL_FIELDS: Record<CommerceResource, FieldDef[]> = {
  quotes: [
    ["Reference", "reference"], ["Contact", "contact_name"], ["Email", "contact_email"], ["Company", "contact_company"],
    ["Phone", "contact_phone"], ["Source", "source"], ["Indicative total", "indicative_total_minor", "money"],
    ["Quoted total", "quoted_total_minor", "money"], ["PO reference", "po_reference"], ["Valid until", "valid_until", "date"],
    ["Created", "created_at", "datetime"], ["Updated", "updated_at", "datetime"],
  ],
  orders: [
    ["Reference", "reference"], ["Email", "customer_email"], ["Subtotal", "subtotal_minor", "money"], ["Total", "total_minor", "money"],
    ["Refunded", "refunded_minor", "money"], ["PO reference", "po_reference"], ["Invoice number", "invoice_number"],
    ["Placed", "placed_at", "datetime"], ["Created", "created_at", "datetime"], ["Updated", "updated_at", "datetime"],
  ],
  invoices: [
    ["Invoice number", "invoice_number"], ["Order reference", "reference"], ["Email", "customer_email"],
    ["Subtotal", "subtotal_minor", "money"], ["Total", "total_minor", "money"], ["Refunded", "refunded_minor", "money"],
    ["PO reference", "po_reference"], ["Placed", "placed_at", "datetime"], ["Updated", "updated_at", "datetime"],
  ],
  licences: [
    ["Product", "offering_name"], ["Edition", "variant_name"], ["Seats", "seats"], ["File", "file_name"],
    ["Delivered", "delivered_at", "datetime"], ["Expires", "expires_at", "date"], ["Created", "created_at", "datetime"],
  ],
};

function fieldValue(record: CommerceRecord, key: string, kind: FieldKind = "text") {
  if (kind === "money") return formatMinor(record[key], record.currency);
  if (kind === "date") return when(record[key]);
  if (kind === "datetime") return when(record[key], true);
  return text(record[key]);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

function LineItems({ record }: { record: CommerceRecord }) {
  const items = Array.isArray(record.items) ? (record.items as CommerceRecord[]) : [];
  if (items.length === 0) return null;
  return (
    <section className="space-y-2" aria-label="Items">
      <h2 className="text-sm font-semibold">Items</h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {items.map((item, index) => {
          const name = [text(item.offering_name), text(item.variant_name)].filter(Boolean).join(", ") || text(item.sku) || "Item";
          const code = text(item.sku) && text(item.sku) !== name ? text(item.sku) : null;
          const unit = formatMinor(item.unit_price_minor ?? item.captured_price_minor ?? item.list_price_minor, item.currency);
          const line = formatMinor(item.line_total_minor, item.currency);
          return (
            <li key={text(item.id) ?? index} className="flex min-w-0 items-baseline gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block break-words font-medium sm:truncate">{name}</span>
                {code ? <span className="block truncate font-mono text-xs text-muted-foreground">{code}</span> : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {text(item.qty) ?? "1"} × {unit ?? "No price"}
              </span>
              {line ? <span className="w-24 shrink-0 text-right font-medium tabular-nums">{line}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Links to the records this one points at: a link to each, never a copy. */
function relatedLinks(resource: CommerceResource, record: CommerceRecord) {
  const links: { to: string; label: string }[] = [];
  const id = text(record.id);
  const quoteId = text(record.quote_id);
  const orderId = text(record.order_id);
  if (resource === "orders" && quoteId) links.push({ to: `/commerce/quotes/${encodeURIComponent(quoteId)}`, label: "Open its quote" });
  if (resource === "orders" && id && text(record.invoice_number)) links.push({ to: `/commerce/invoices/${encodeURIComponent(id)}`, label: "Open its invoice" });
  if (resource === "invoices" && id) links.push({ to: `/commerce/orders/${encodeURIComponent(id)}`, label: "Open its order" });
  if (resource === "licences" && orderId) links.push({ to: `/commerce/orders/${encodeURIComponent(orderId)}`, label: "Open its order" });
  return links;
}

export function CommerceRecordView({ companyId, siteId, resource, recordId, domain }: {
  companyId: string;
  siteId: string;
  resource: CommerceResource;
  recordId: string;
  /** The website's address, for the printable invoice. */
  domain?: string | null;
}) {
  const [searchParams] = useSearchParams();
  const customers = useCustomerMap(companyId, siteId);
  const query = useQuery({
    queryKey: queryKeys.website.data(companyId, siteId, resource, "item", recordId),
    queryFn: () => websiteDataBridgeApi.get(companyId, siteId, resource, recordId),
  });
  const organisations = useQuery({
    queryKey: queryKeys.organisations.list(companyId, {}),
    queryFn: () => organisationsApi.list(companyId),
    retry: false,
  });
  const copy = COMMERCE_COPY[resource];
  const back = `/commerce/${resource}${searchParams.get("customer") ? `?customer=${encodeURIComponent(searchParams.get("customer")!)}` : ""}`;

  if (query.isLoading) return <PageSkeleton variant="detail" />;
  if (query.error || !query.data) {
    return <ErrorState error={query.error ?? new Error("The website has no such record.")} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  }
  const record = query.data.item;
  const customerId = text(record.customer_id);
  const customer = customerId ? customers.get(customerId) ?? null : null;
  const organisation = organisationFor(customer, organisations.data ?? []);
  const title = recordTitle(resource, record);
  // The heading already shows the reference (or invoice number); repeating it as the first fact only pushes the record down.
  const facts = DETAIL_FIELDS[resource].flatMap(([label, key, kind]) => {
    const value = fieldValue(record, key, kind);
    return value && value !== title ? [{ label, value }] : [];
  });
  const total = recordTotal(resource, record);
  const related = relatedLinks(resource, record);
  const invoiceUrl = resource === "invoices" || resource === "orders" ? invoiceWebsiteUrl(record, domain) : null;

  return (
    <div className="space-y-6" data-testid="commerce-record">
      <Link to={back} className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ArrowLeft className="size-4" aria-hidden="true" />
        All {copy.label.toLowerCase()}
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{copy.singular}</p>
          <h2 className="flex flex-wrap items-center gap-2 break-words text-xl font-bold">
            {title}
            <StatusPill status={record.status} />
          </h2>
          {recordCode(resource, record) ? <p className="font-mono text-xs text-muted-foreground">{recordCode(resource, record)}</p> : null}
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          {total ? <p className="text-xl font-semibold tabular-nums">{total}</p> : null}
          {invoiceUrl ? (
            <a href={invoiceUrl} target="_blank" rel="noreferrer" className={cn(RECORD_LINK, "gap-1.5")} data-testid="commerce-invoice-website">
              <ExternalLink className="size-3.5" aria-hidden="true" />
              Print or save the invoice on the website
            </a>
          ) : null}
        </div>
      </header>
      {invoiceUrl ? <p className="text-xs text-muted-foreground">The website's printable VAT invoice opens in a new tab. You sign in there as staff.</p> : null}

      {resource === "licences" ? (
        <section className="rounded-xl border border-border bg-card p-4" aria-label="Licence key">
          <p className="text-xs text-muted-foreground">Licence key</p>
          <p className="mt-1 font-mono text-base" data-testid="commerce-licence-key">{maskedLicenceKey(record)}</p>
          <p className="mt-1 text-xs text-muted-foreground">Masked by the website. The full key stays on the site.</p>
        </section>
      ) : null}

      <section className="rounded-xl border border-border bg-card p-4" aria-label="Details">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {facts.map((fact) => <Fact key={fact.label} label={fact.label}>{fact.value}</Fact>)}
        </dl>
        {resource === "quotes" && text(record.message) ? (
          <p className="mt-4 whitespace-pre-wrap border-t border-border pt-4 text-sm">{text(record.message)}</p>
        ) : null}
      </section>

      <LineItems record={record} />

      {resource === "licences" ? <LicenceActions companyId={companyId} siteId={siteId} licence={record} /> : null}
      {resource === "licences" ? <LicenceActivationSteps companyId={companyId} siteId={siteId} licence={record} /> : null}
      {resource === "quotes" ? <QuoteActions companyId={companyId} siteId={siteId} quote={record} /> : null}
      {resource === "orders" ? <OrderStatusActions companyId={companyId} siteId={siteId} order={record} /> : null}
      {resource === "orders" && !isDraftInvoice(record) ? <OrderLineLicences companyId={companyId} siteId={siteId} order={record} /> : null}
      {resource === "orders" && isDraftInvoice(record) ? <DraftInvoiceActions companyId={companyId} siteId={siteId} order={record} /> : null}
      {resource === "orders" && !isDraftInvoice(record) && Number(record.total_minor ?? 0) > 0 ? (
        <RefundRequest companyId={companyId} siteId={siteId} order={record} />
      ) : null}

      <section className="space-y-2" aria-label="Customer">
        <h2 className="text-sm font-semibold">Customer</h2>
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-sm sm:flex-row sm:items-center sm:gap-4">
          <span className="min-w-0 break-words font-medium sm:flex-1">{customerName(record, customers) ?? "No customer account"}</span>
          {organisation ? (
            <Link to={`/organisations/${organisation.id}`} className={cn(RECORD_LINK, "gap-1.5 sm:shrink-0")}>
              <Building2 className="size-4" aria-hidden="true" />
              {organisation.name} in Organisations
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          ) : customer ? (
            <span className="text-xs text-muted-foreground">No organisation in GSAM has this customer's domain or name.</span>
          ) : null}
          {customerId ? (
            <Link to={`/commerce/customers/${encodeURIComponent(customerId)}`} className={cn(RECORD_LINK, "sm:shrink-0")}>
              Open client
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          ) : null}
          {customerId ? (
            <Link to={`/commerce/${resource}?customer=${encodeURIComponent(customerId)}`} className={cn(RECORD_LINK, "sm:shrink-0")}>
              Their {copy.label.toLowerCase()}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      </section>

      {related.length ? (
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Linked records">
          {related.map((link) => (
            <Link key={link.to} to={link.to} className={RECORD_LINK}>
              {link.label}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

export function CommercePage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { resource: param, recordId } = useParams<{ resource?: string; recordId?: string }>();
  const companyId = selectedCompanyId ?? "";
  const { commerce, isLoading } = useCommerceSite(companyId);
  const section = sectionOf(param);
  const resource = isCommerceResource(param) ? param : null;

  useEffect(() => {
    const crumbs: { label: string; href?: string }[] = [{ label: "Commerce", href: "/commerce" }];
    if (section) crumbs.push({ label: SECTION_LABEL[section], href: recordId ? `/commerce/${section}` : undefined });
    if (recordId) {
      crumbs.push({
        label: resource ? COMMERCE_COPY[resource].singular
          : section && isCatalogueResource(section) ? (recordId === "new" ? "New" : CATALOGUE_COPY[section].singular)
            : section === "imports" ? "Import" : section === "customers" ? "Client" : "Record",
      });
    }
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, section, resource, recordId]);

  if (!selectedCompanyId) return <EmptyState icon={ShoppingBag} message="Choose an organisation to see its Commerce area." />;
  if (isLoading) return <PageSkeleton variant="list" />;
  if (!commerce) {
    return (
      <EmptyState
        icon={ShoppingBag}
        title="Commerce is not available here"
        message="The Commerce area shows for Greatstone only, while its website's Shop feature is on."
      />
    );
  }
  if (!section) return <Navigate to={`/commerce/quotes${searchParams.toString() ? `?${searchParams}` : ""}`} replace />;

  const siteId = commerce.site.id;
  const area = areaOf(section);
  const customer = searchParams.get("customer");
  const openSection = (next: string) => navigate(`/commerce/${next}${customer && isCommerceResource(next) ? `?customer=${encodeURIComponent(customer)}` : ""}`);
  const openArea = (next: string) => navigate(`/commerce/${AREA_SECTIONS[next as CommerceArea][0]}`);
  const tabs = AREA_SECTIONS[area].map((value) => ({ value, label: SECTION_LABEL[value] }));

  let body: ReactNode;
  if (resource) {
    body = recordId
      ? <CommerceRecordView key={`${resource}:${recordId}`} companyId={companyId} siteId={siteId} resource={resource} recordId={recordId} domain={commerce.site?.domain} />
      : <CommerceList key={resource} companyId={companyId} siteId={siteId} resource={resource} />;
  } else if (isCatalogueResource(section)) {
    body = recordId
      ? <CatalogueRecord key={`${section}:${recordId}`} companyId={companyId} siteId={siteId} resource={section} recordId={recordId} domain={commerce.site?.domain} />
      : <CatalogueList key={section} companyId={companyId} siteId={siteId} resource={section} />;
  } else if (section === "customer-tiers") {
    body = <CustomerTierList companyId={companyId} siteId={siteId} />;
  } else if (section === "customers") {
    body = recordId
      ? <ClientRecord key={recordId} companyId={companyId} siteId={siteId} clientId={recordId} />
      : <ClientList companyId={companyId} siteId={siteId} />;
  } else if (section === "enquiries") {
    body = <EnquiryList companyId={companyId} siteId={siteId} />;
  } else if (section === "portal-acceptances") {
    body = <ReceiptList companyId={companyId} siteId={siteId} />;
  } else if (section === "imports") {
    body = recordId
      ? <CommerceImportJob key={recordId} companyId={companyId} siteId={siteId} jobId={recordId} />
      : <CommerceImports companyId={companyId} siteId={siteId} />;
  } else if (section === "currency") {
    body = <CommerceCurrency companyId={companyId} siteId={siteId} />;
  } else {
    body = <CommercePayments companyId={companyId} siteId={siteId} />;
  }

  return (
    <div className="w-full max-w-5xl space-y-6" data-testid="commerce-page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <ShoppingBag className="size-5 text-muted-foreground" aria-hidden="true" />
            Commerce
          </h1>
          {recordId ? null : (
            <p className="text-sm text-muted-foreground">{AREA_COPY[area]}, from {commerce.site.domain}.</p>
          )}
        </div>
        <Tabs value={area} onValueChange={openArea}>
          <PageTabBar items={AREA_TABS} value={area} onValueChange={openArea} align="start" ariaLabel="Commerce area" mobileLabel="Area" />
        </Tabs>
      </header>
      <Tabs value={section} onValueChange={openSection}>
        <PageTabBar items={tabs} value={section} onValueChange={openSection} align="start" ariaLabel="Commerce records" mobileLabel="Section" />
      </Tabs>
      {body}
    </div>
  );
}

export default CommercePage;
