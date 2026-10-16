import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CrmProduct, CrmRecordField } from "@greatstone/shared";
import { organisationsApi } from "@/api/organisations";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { formatNumber } from "@/lib/utils";

function moneyText(amount: number | null, currency: string | null) {
  if (amount === null) return "No price";
  const value = formatNumber(amount, { maximumFractionDigits: 2 });
  return currency ? `${currency} ${value}` : value;
}

function fieldText(value: CrmRecordField["value"]) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function matches(product: CrmProduct, q: string) {
  if (!q) return true;
  const haystack = [product.name, product.code, product.description, ...product.fields.map((field) => fieldText(field.value))]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function ProductRow({ product }: { product: CrmProduct }) {
  const prices = product.prices.filter((price) => price.price !== null);
  return (
    <li className="px-3 py-2 text-sm">
      <details>
        <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium">{product.name}</span>
          {product.code ? <span className="text-muted-foreground">{product.code}</span> : null}
          {!product.active ? <Badge variant="outline">Inactive</Badge> : null}
          <span className="text-muted-foreground">
            {prices.length ? prices.map((price) => moneyText(price.price, price.currency)).join(", ") : "No price"}
            {product.unit ? ` per ${product.unit}` : ""}
          </span>
          <span className="text-xs text-muted-foreground">
            {product.deals.length === 1 ? "On 1 deal" : `On ${product.deals.length} deals`}
          </span>
        </summary>
        <div className="mt-2 space-y-3 pl-2">
          {product.description ? <p className="whitespace-pre-wrap text-muted-foreground">{product.description}</p> : null}
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {product.ownerName ? (
              <div><dt className="text-xs text-muted-foreground">Owner</dt><dd>{product.ownerName}</dd></div>
            ) : null}
            {product.tax !== null ? (
              <div><dt className="text-xs text-muted-foreground">Tax</dt><dd>{formatNumber(product.tax)}%</dd></div>
            ) : null}
            {product.prices.filter((price) => price.cost !== null).map((price) => (
              <div key={`cost-${price.currency}`}>
                <dt className="text-xs text-muted-foreground">Cost ({price.currency})</dt>
                <dd>{moneyText(price.cost, price.currency)}</dd>
              </div>
            ))}
            {product.fields.map((field) => (
              <div key={field.key} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{field.label}</dt>
                <dd className="whitespace-pre-wrap break-words">{fieldText(field.value)}</dd>
              </div>
            ))}
          </dl>
          {product.deals.length ? (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground">Deals</h3>
              <ul className="mt-1 space-y-1">
                {product.deals.map((deal, index) => (
                  <li key={`${deal.caseId}-${index}`} className="flex flex-wrap justify-between gap-2">
                    <Link to={`/pipelines/${deal.pipelineId}/items/${deal.caseId}`} className="min-w-0 break-words hover:underline">
                      {deal.title}
                    </Link>
                    <span className="text-muted-foreground">
                      {deal.quantity !== null ? `${formatNumber(deal.quantity)} × ` : ""}
                      {moneyText(deal.sum, deal.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/** The product catalogue a CRM import brought, searchable, each product with the deals it is on. Hidden when empty. */
export function CrmProductCatalogue({ companyId }: { companyId: string }) {
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: queryKeys.organisations.products(companyId),
    queryFn: () => organisationsApi.products(companyId),
  });
  if (query.error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        Could not load products. {query.error instanceof Error ? query.error.message : "Try again."}
      </p>
    );
  }
  const products = query.data ?? [];
  if (products.length === 0) return null;
  const q = search.trim().toLowerCase();
  const shown = products.filter((product) => matches(product, q));
  return (
    <section aria-label="Products" className="space-y-2">
      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Products ({products.length})</summary>
        <div className="border-t border-border px-3 py-2">
          <Input
            aria-label="Search products"
            placeholder="Search name, code or field"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="sm:w-80"
          />
        </div>
        {shown.length === 0 ? (
          <p className="border-t border-border px-3 py-2 text-sm text-muted-foreground">No products match this search.</p>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {shown.map((product) => <ProductRow key={product.id} product={product} />)}
          </ul>
        )}
      </details>
    </section>
  );
}
