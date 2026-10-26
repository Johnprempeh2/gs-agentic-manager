import { useQueries, useQuery } from "@tanstack/react-query";
import { websiteDataBridgeApi } from "@/api/website-data-bridge";
import { ErrorState } from "@/components/ErrorState";
import { useCommerceSite } from "@/hooks/useCommerceSite";
import {
  COMMERCE_COPY,
  COMMERCE_RESOURCES,
  newestFirst,
  recordTitle,
  recordTotal,
  statusLabel,
  text,
} from "@/lib/commerce";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";

/**
 * The organisation's records in Commerce (GRE-2383): a link to each quote, order, invoice and licence of the
 * website customer whose id is the organisation's website organisation id (GRE-2609). Never matched by name or
 * domain. Links only; nothing is copied into the CRM.
 */
export function OrganisationCommerce({ companyId, websiteOrganisationId }: { companyId: string; websiteOrganisationId: string }) {
  const { commerce } = useCommerceSite(companyId);
  const siteId = commerce?.site.id ?? null;
  const customerId = websiteOrganisationId;
  const customerQuery = useQuery({
    queryKey: queryKeys.website.data(companyId, siteId ?? "", "customers", "get", customerId),
    queryFn: () => websiteDataBridgeApi.get(companyId, siteId!, "customers", customerId),
    enabled: Boolean(siteId),
  });
  const customer = customerQuery.data?.item ?? null;
  const records = useQueries({
    queries: COMMERCE_RESOURCES.map((resource) => ({
      queryKey: queryKeys.website.data(companyId, siteId ?? "", resource, "list", customerId),
      queryFn: () => websiteDataBridgeApi.list(companyId, siteId!, resource, { customer: customerId, limit: 100 }),
      enabled: Boolean(siteId),
    })),
  });
  if (!commerce) return null;

  const failed = customerQuery.error ?? records.find((query) => query.error)?.error;
  const loading = customerQuery.isLoading || records.some((query) => query.isLoading);
  const groups = COMMERCE_RESOURCES.map((resource, index) => ({
    resource,
    items: newestFirst(records[index]?.data?.items ?? []),
  })).filter((group) => group.items.length > 0);

  return (
    <section aria-label="Commerce" className="space-y-2" data-testid="organisation-commerce">
      <h2 className="text-sm font-semibold">Commerce</h2>
      {failed ? <ErrorState error={failed} compact /> : null}
      {!failed && loading ? <p className="text-sm text-muted-foreground">Loading website records…</p> : null}
      {!failed && !loading && groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{text(customer?.name) ?? "This client"} has no quotes, orders, invoices or licences on the website yet.</p>
      ) : null}
      {groups.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {groups.map(({ resource, items }) => (
            <div key={resource} className="min-w-0 rounded-lg border border-border">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <h3 className="text-xs font-medium text-muted-foreground">{COMMERCE_COPY[resource].label} ({items.length})</h3>
                <Link to={`/commerce/${resource}?customer=${encodeURIComponent(customerId)}`} className="text-xs font-medium hover:underline">
                  Open in Commerce
                </Link>
              </div>
              <ul className="divide-y divide-border">
                {items.map((record) => {
                  const id = text(record.id) ?? "";
                  const status = text(record.status);
                  const total = recordTotal(resource, record);
                  return (
                    <li key={id}>
                      <Link
                        to={`/commerce/${resource}/${encodeURIComponent(id)}`}
                        className="flex min-w-0 items-baseline gap-2 px-3 py-2 text-sm hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="min-w-0 flex-1 truncate font-medium">{recordTitle(resource, record)}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {[total, status ? statusLabel(status) : null].filter(Boolean).join(" · ")}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
