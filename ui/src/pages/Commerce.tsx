import { useEffect, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Building2, ShoppingBag, X } from "lucide-react";
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
import { useCommerceCustomers, useCommerceSite } from "@/hooks/useCommerceSite";
import {
  COMMERCE_COPY,
  COMMERCE_RESOURCES,
  formatMinor,
  isCommerceResource,
  maskedLicenceKey,
  newestFirst,
  organisationFor,
  recordTime,
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
// through the admin bridge. Read only: there is no button here that changes the site, moves money or calls Stripe.

const PAGE_SIZE = 50;
const RECORD_LINK = "inline-flex w-fit items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const TABS = COMMERCE_RESOURCES.map((value) => ({ value, label: COMMERCE_COPY[value].label }));

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
                    <span className="block truncate text-xs text-muted-foreground">{rowMeta(resource, record, customers)}</span>
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
          const name = [text(item.offering_name), text(item.variant_name)].filter(Boolean).join(", ") || "Item";
          const unit = formatMinor(item.unit_price_minor ?? item.captured_price_minor ?? item.list_price_minor, item.currency);
          const line = formatMinor(item.line_total_minor, item.currency);
          return (
            <li key={text(item.id) ?? index} className="flex min-w-0 items-baseline gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 break-words sm:truncate">{name}</span>
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

export function CommerceRecordView({ companyId, siteId, resource, recordId }: {
  companyId: string;
  siteId: string;
  resource: CommerceResource;
  recordId: string;
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
        </div>
        {total ? <p className="text-xl font-semibold tabular-nums">{total}</p> : null}
      </header>

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
  const resource = isCommerceResource(param) ? param : null;

  useEffect(() => {
    const crumbs: { label: string; href?: string }[] = [{ label: "Commerce", href: "/commerce" }];
    if (resource) crumbs.push({ label: COMMERCE_COPY[resource].label, href: recordId ? `/commerce/${resource}` : undefined });
    if (recordId) crumbs.push({ label: resource ? COMMERCE_COPY[resource].singular : "Record" });
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, resource, recordId]);

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
  if (!resource) return <Navigate to={`/commerce/quotes${searchParams.toString() ? `?${searchParams}` : ""}`} replace />;

  const customer = searchParams.get("customer");
  const openTab = (next: string) => navigate(`/commerce/${next}${customer ? `?customer=${encodeURIComponent(customer)}` : ""}`);

  return (
    <div className="w-full max-w-5xl space-y-6" data-testid="commerce-page">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <ShoppingBag className="size-5 text-muted-foreground" aria-hidden="true" />
          Commerce
        </h1>
        {recordId ? null : (
          <p className="text-sm text-muted-foreground">
            The website's quotes, orders, invoices and licences, read from {commerce.site.domain}. Read only: changes are still made on the site.
          </p>
        )}
      </header>
      <Tabs value={resource} onValueChange={openTab}>
        <PageTabBar items={TABS} value={resource} onValueChange={openTab} align="start" ariaLabel="Commerce records" />
      </Tabs>
      {recordId ? (
        <CommerceRecordView key={`${resource}:${recordId}`} companyId={companyId} siteId={commerce.site.id} resource={resource} recordId={recordId} />
      ) : (
        <CommerceList key={resource} companyId={companyId} siteId={commerce.site.id} resource={resource} />
      )}
    </div>
  );
}

export default CommercePage;
