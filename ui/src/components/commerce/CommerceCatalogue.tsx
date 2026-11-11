import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Pencil, Plus, ShoppingBag, Trash2 } from "lucide-react";
import type { WebsiteCommerceCatalogueResource } from "@greatstone/shared";
import { websiteCommerceApi, type CommerceRow } from "@/api/website-commerce";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useCommercePerson, useCommerceWrite } from "@/hooks/useCommerceWrite";
import { formatMinor, statusLabel, statusTone, text } from "@/lib/commerce";
import {
  CATALOGUE_COPY,
  CATALOGUE_FIELDS,
  MEDIA_FIELDS,
  SPEC_FIELDS,
  TARGET_FIELDS,
  VARIANT_FIELDS,
  catalogueCode,
  catalogueMatches,
  catalogueMeta,
  catalogueOneLine,
  offeringGaps,
  offeringPrice,
  offeringWebsiteUrl,
  rowOptionLabel,
} from "@/lib/commerce-catalogue";
import { rowVersionOf, type CommerceFieldDef } from "@/lib/commerce-write";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";
import { CommerceRulePreview } from "./CommerceRulePreview";
import { CommerceRowForm, CommerceWriteError, ConfirmButton, PeopleOnlyNote } from "./CommerceWriteParts";

// The catalogue (GRE-3972 slice 1): vendors, categories, offerings with their editions, specs and media, pricing
// rules with their targets. Customer tiers have their own list (CommerceClients, GRE-4784). Anyone with Commerce
// rights creates, edits and deletes drafts; only a person publishes or archives.
//
// A row reads as what it is: its name, a line of the site's own description, its vendor and price, and only then its
// code, small. Nothing here is made up: a product with no price says "No price set".

export type CatalogueResource = WebsiteCommerceCatalogueResource;
const ALL_ROWS_PAGES = 10;
const NO_PRICE = "No price set";
const ROW_LINK = "flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function StatusPill({ status }: { status: unknown }) {
  const value = text(status);
  if (!value) return null;
  return <span className={cn("inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", statusTone(value))}>{statusLabel(value)}</span>;
}

/** Every row of a catalogue resource, 100 a page. One cache entry feeds the list, its search and the pickers. */
function useAllRows(companyId: string, siteId: string, resource: CatalogueResource | "customer-tiers", options: { enabled?: boolean; staleTime?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.website.commerce(companyId, siteId, resource, "all"),
    queryFn: async () => {
      const items: CommerceRow[] = [];
      let cursor: string | null = null;
      // ponytail: search and filters run in the browser over at most 1,000 rows. Give the site's list route a search
      // parameter when a catalogue grows past that.
      for (let page = 0; page < ALL_ROWS_PAGES; page += 1) {
        const result = await websiteCommerceApi.list(companyId, siteId, resource, { limit: 100, ...(cursor ? { cursor } : {}) });
        items.push(...result.items);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return { items, more: Boolean(cursor) };
    },
    ...options,
  });
}

type RefOptions = Record<NonNullable<CommerceFieldDef["ref"]>, { value: string; label: string }[]>;

/** The rows a `ref` field picks from: every one, by name. */
function useRefOptions(companyId: string, siteId: string): RefOptions {
  const vendors = useAllRows(companyId, siteId, "vendors", { staleTime: 60_000 });
  const categories = useAllRows(companyId, siteId, "categories", { staleTime: 60_000 });
  const offerings = useAllRows(companyId, siteId, "offerings", { staleTime: 60_000 });
  const tiers = useAllRows(companyId, siteId, "customer-tiers", { staleTime: 60_000 });
  return useMemo(() => {
    const options = (rows: CommerceRow[] | undefined) => (rows ?? [])
      .map((row) => ({ value: text(row.id) ?? "", label: rowOptionLabel(row) }))
      .filter((option) => option.value)
      .sort((a, b) => a.label.localeCompare(b.label));
    return {
      vendors: options(vendors.data?.items),
      categories: options(categories.data?.items),
      offerings: options(offerings.data?.items),
      "customer-tiers": options(tiers.data?.items),
    };
  }, [vendors.data, categories.data, offerings.data, tiers.data]);
}

const namesById = (rows: CommerceRow[] | undefined) => new Map((rows ?? []).map((row) => [text(row.id) ?? "", rowOptionLabel(row)]));

export function CatalogueList({ companyId, siteId, resource }: { companyId: string; siteId: string; resource: CatalogueResource }) {
  const copy = CATALOGUE_COPY[resource];
  const isOfferings = resource === "offerings";
  const rows = useAllRows(companyId, siteId, resource);
  const vendors = useAllRows(companyId, siteId, "vendors", { enabled: isOfferings, staleTime: 60_000 });
  const categories = useAllRows(companyId, siteId, "categories", { enabled: isOfferings, staleTime: 60_000 });
  const vendorNames = useMemo(() => namesById(vendors.data?.items), [vendors.data]);
  const categoryNames = useMemo(() => namesById(categories.data?.items), [categories.data]);

  // the search and filters live in the address, so Back from a record returns to the same narrowed list
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const category = params.get("category") ?? "";
  const attention = params.get("attention") === "1";
  const setParam = (name: string, value: string) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value) next.set(name, value);
    else next.delete(name);
    return next;
  }, { replace: true });

  const all = rows.data?.items ?? [];
  const categoryOf = (row: CommerceRow) => text(row.category_id) ?? "";
  const categoryLabel = (id: string) => (id ? categoryNames.get(id) ?? "Category" : "No category");
  const byName = (a: CommerceRow, b: CommerceRow) => rowOptionLabel(a).localeCompare(rowOptionLabel(b));
  const needing = isOfferings ? all.filter((row) => offeringGaps(row).length).length : 0;
  const shown = all.filter((row) =>
    catalogueMatches(row, search, [vendorNames.get(text(row.vendor_id) ?? ""), isOfferings ? categoryLabel(categoryOf(row)) : null])
    && (!category || categoryOf(row) === (category === "none" ? "" : category))
    && (!attention || offeringGaps(row).length > 0));
  const grouped = (list: CommerceRow[]) => {
    const groups = new Map<string, CommerceRow[]>();
    for (const row of list) groups.set(categoryOf(row), [...(groups.get(categoryOf(row)) ?? []), row]);
    // "No category" first: it is the one that needs a person
    return [...groups].map(([id, items]) => ({ id, name: categoryLabel(id), items: items.sort(byName) }))
      .sort((a, b) => Number(Boolean(a.id)) - Number(Boolean(b.id)) || a.name.localeCompare(b.name));
  };
  const groups = isOfferings ? grouped(shown) : [{ id: "", name: copy.label, items: shown }];
  const narrowed = Boolean(search || category || attention);
  const noun = (count: number) => (count === 1 ? copy.singular : copy.label).toLowerCase();

  return (
    <section className="space-y-3" aria-label={copy.label} data-testid="commerce-catalogue-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">New records start as drafts. Only published records show on the website.</p>
        <Button asChild size="sm">
          <Link to={`/commerce/${resource}/new`}>
            <Plus aria-hidden="true" />
            New {copy.singular.toLowerCase()}
          </Link>
        </Button>
      </div>
      {rows.isLoading ? <PageSkeleton variant="list" /> : null}
      {rows.error ? <ErrorState error={rows.error} onRetry={() => void rows.refetch()} retrying={rows.isFetching} /> : null}
      {rows.data && all.length === 0 ? <EmptyState icon={ShoppingBag} message={copy.empty} /> : null}
      {all.length ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              aria-label={`Search ${copy.label.toLowerCase()}`}
              placeholder={isOfferings ? "Search name, vendor, category, code" : "Search name or code"}
              value={search}
              onChange={(event) => setParam("q", event.target.value)}
              className="min-w-48 flex-1 sm:max-w-sm"
            />
            {isOfferings ? (
              <NativeSelect aria-label="Category" value={category} onChange={(event) => setParam("category", event.target.value)} className="w-auto max-w-full">
                <option value="">All categories ({all.length})</option>
                {grouped(all).map((group) => (
                  <option key={group.id} value={group.id || "none"}>{group.name} ({group.items.length})</option>
                ))}
              </NativeSelect>
            ) : null}
            {needing || attention ? (
              <Button type="button" size="sm" variant={attention ? "secondary" : "outline"} aria-pressed={attention}
                title="No price, no short description or no category" onClick={() => setParam("attention", attention ? "" : "1")}>
                Needs attention ({needing})
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="commerce-catalogue-count">
            {narrowed ? `${shown.length} of ${all.length} ${noun(all.length)}` : `${all.length} ${noun(all.length)}`}
            {rows.data?.more ? ". Only the first 1,000 are listed here." : ""}
          </p>
        </>
      ) : null}
      {all.length && shown.length === 0 ? (
        <div className="space-y-2 rounded-xl border border-border bg-card px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">No {copy.label.toLowerCase()} match. Try fewer words, or clear the search and filters.</p>
          <Button type="button" size="sm" variant="outline" onClick={() => setParams({}, { replace: true })}>Clear search and filters</Button>
        </div>
      ) : null}
      {groups.map((group) => (group.items.length ? (
        <div key={group.id} className="overflow-hidden rounded-xl border border-border bg-card">
          {isOfferings ? (
            <h3 className="flex items-center gap-2 bg-muted/50 px-4 py-2 text-sm font-medium">
              {group.name}
              <span className="text-xs font-normal text-muted-foreground">{group.items.length}</span>
            </h3>
          ) : null}
          <ul className="divide-y divide-border">
            {group.items.map((row) => {
              const id = text(row.id) ?? "";
              const oneLine = catalogueOneLine(row);
              const meta = catalogueMeta(resource, row, { vendor: vendorNames.get(text(row.vendor_id) ?? "") });
              const code = catalogueCode(row);
              const price = offeringPrice(row);
              const gaps = attention ? offeringGaps(row) : [];
              return (
                <li key={id}>
                  <Link to={`/commerce/${resource}/${encodeURIComponent(id)}`} className={ROW_LINK}>
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="block break-words text-sm font-medium">{rowOptionLabel(row)}</span>
                      {oneLine ? <span className="line-clamp-2 text-xs text-muted-foreground">{oneLine}</span> : null}
                      {meta || code ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {meta}{meta && code ? " · " : ""}{code ? <span className="font-mono">{code}</span> : null}
                        </span>
                      ) : null}
                      {gaps.length ? <span className="block text-xs text-status-warning-foreground">{gaps.join(" · ")}</span> : null}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      {isOfferings ? (
                        <span className={cn("text-xs", price ? "text-foreground" : "text-status-warning-foreground")}>{price ?? NO_PRICE}</span>
                      ) : null}
                      <StatusPill status={row.status} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null))}
    </section>
  );
}

interface ChildSpec {
  sub: "variants" | "specs" | "media" | "targets";
  title: string;
  addLabel: string;
  fields: readonly CommerceFieldDef[];
  /** Has a row version: it can be edited, and is soft deleted at its version. */
  versioned: boolean;
  /** `code` is the row's SKU or id: shown small, after what the row is. */
  describe: (row: CommerceRow, refOptions: RefOptions) => { title: string; meta: string; code?: string | null };
}

const refName = (options: { value: string; label: string }[], id: unknown) => {
  const value = text(id);
  // a row that is gone has no name; a piece of its id would tell a person nothing
  return value ? options.find((option) => option.value === value)?.label ?? "(no longer in the catalogue)" : null;
};

const CHILDREN: Partial<Record<WebsiteCommerceCatalogueResource, ChildSpec[]>> = {
  offerings: [
    { sub: "variants", title: "Editions", addLabel: "Add edition", fields: VARIANT_FIELDS, versioned: true,
      describe: (row) => ({
        title: text(row.name) ?? "Edition",
        meta: [formatMinor(row.base_price_minor, row.currency) ?? "Price on request",
          text(row.billing_period) ? statusLabel(text(row.billing_period)!) : null].filter(Boolean).join(" · "),
        code: text(row.sku),
      }) },
    { sub: "specs", title: "Specs", addLabel: "Add spec", fields: SPEC_FIELDS, versioned: false,
      describe: (row) => ({ title: text(row.label) ?? "Spec", meta: text(row.value) ?? "" }) },
    { sub: "media", title: "Media", addLabel: "Add media", fields: MEDIA_FIELDS, versioned: false,
      // the site gives an image no name here, only its id
      describe: (row) => ({ title: "Image", meta: text(row.sort_order) ? `Sort order ${text(row.sort_order)}` : "", code: text(row.asset_id) }) },
  ],
  "pricing-rules": [
    { sub: "targets", title: "Targets", addLabel: "Add target", fields: TARGET_FIELDS, versioned: false,
      describe: (row, refs) => {
        const parts = [
          refName(refs.vendors, row.vendor_id) && `Vendor ${refName(refs.vendors, row.vendor_id)}`,
          refName(refs.categories, row.category_id) && `Category ${refName(refs.categories, row.category_id)}`,
          refName(refs.offerings, row.offering_id) && `Offering ${refName(refs.offerings, row.offering_id)}`,
          refName(refs["customer-tiers"], row.tier_id) && `Tier ${refName(refs["customer-tiers"], row.tier_id)}`,
        ].filter(Boolean);
        return { title: parts[0] || "Target", meta: parts.slice(1).join(" · ") };
      } },
  ],
};

function ChildRow({ companyId, siteId, resource, parentId, spec, row, refOptions }: {
  companyId: string; siteId: string; resource: WebsiteCommerceCatalogueResource; parentId: string;
  spec: ChildSpec; row: CommerceRow; refOptions: RefOptions;
}) {
  const [editing, setEditing] = useState(false);
  const write = useCommerceWrite(companyId, siteId, { onSuccess: () => setEditing(false) });
  const id = text(row.id) ?? "";
  const described = spec.describe(row, refOptions);
  const version = rowVersionOf(row);
  const parts = [resource, parentId, spec.sub, id];
  return (
    <li className="space-y-3 px-4 py-3" data-testid={`commerce-child-${spec.sub}`}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{described.title}</span>
          {described.meta ? <span className="block truncate text-xs text-muted-foreground">{described.meta}</span> : null}
          {described.code ? <span className="block truncate font-mono text-xs text-muted-foreground">{described.code}</span> : null}
        </span>
        {spec.versioned && !editing ? (
          <Button type="button" size="icon-xs" variant="ghost" onClick={() => setEditing(true)} aria-label={`Edit ${described.title}`}>
            <Pencil aria-hidden="true" />
          </Button>
        ) : null}
        <ConfirmButton
          label={<Trash2 aria-hidden="true" />}
          ariaLabel={`Remove ${described.title}`}
          variant="ghost"
          title={`Remove ${described.title}?`}
          description="It comes off this record on the website."
          confirmLabel="Remove"
          destructive
          disabled={write.isPending}
          onConfirm={() => write.mutate({ method: "DELETE", parts, body: spec.versioned && version ? { expectedRowVersion: version } : undefined })}
          testId={`commerce-child-delete-${id}`}
        />
      </div>
      {editing ? (
        <CommerceRowForm
          key={text(row.row_version) ?? id}
          idPrefix={`child-${id}`}
          fields={spec.fields}
          base={row}
          refOptions={refOptions}
          saving={write.isPending}
          submitLabel="Save edition"
          onSave={(body) => write.mutate({ method: "PATCH", parts, body: { ...body, expectedRowVersion: version } })}
          onCancel={() => { setEditing(false); write.reset(); }}
        />
      ) : null}
      <CommerceWriteError error={write.error} />
    </li>
  );
}

function ChildSection({ companyId, siteId, resource, parent, spec, refOptions }: {
  companyId: string; siteId: string; resource: WebsiteCommerceCatalogueResource; parent: CommerceRow;
  spec: ChildSpec; refOptions: RefOptions;
}) {
  const [adding, setAdding] = useState(false);
  const write = useCommerceWrite(companyId, siteId, { onSuccess: () => setAdding(false) });
  const parentId = text(parent.id) ?? "";
  const rows = Array.isArray(parent[spec.sub]) ? (parent[spec.sub] as CommerceRow[]) : [];
  return (
    <section className="space-y-2" aria-label={spec.title}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{spec.title}</h3>
        {adding ? null : (
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            {spec.addLabel}
          </Button>
        )}
      </div>
      {rows.length ? (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {rows.map((row) => (
            <ChildRow key={text(row.id) ?? ""} companyId={companyId} siteId={siteId} resource={resource} parentId={parentId}
              spec={spec} row={row} refOptions={refOptions} />
          ))}
        </ul>
      ) : adding ? null : <p className="text-sm text-muted-foreground">None yet.</p>}
      {adding ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <CommerceRowForm
            idPrefix={`new-${spec.sub}`}
            fields={spec.fields}
            base={null}
            refOptions={refOptions}
            saving={write.isPending}
            submitLabel={spec.addLabel}
            onSave={(body) => write.mutate({ method: "POST", parts: [resource, parentId, spec.sub], body })}
            onCancel={() => { setAdding(false); write.reset(); }}
          />
        </div>
      ) : null}
      <CommerceWriteError error={write.error} />
    </section>
  );
}

export function CatalogueRecord({ companyId, siteId, resource, recordId, domain }: {
  companyId: string; siteId: string; resource: WebsiteCommerceCatalogueResource; recordId: string;
  /** The website's address, for the link to a published product's page. */
  domain?: string | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isPerson = useCommercePerson();
  const refOptions = useRefOptions(companyId, siteId);
  const copy = CATALOGUE_COPY[resource];
  const creating = recordId === "new";
  const itemKey = queryKeys.website.commerce(companyId, siteId, resource, "item", recordId);
  const query = useQuery({
    queryKey: itemKey,
    queryFn: () => websiteCommerceApi.get(companyId, siteId, resource, recordId),
    enabled: !creating,
  });
  const write = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => {
      if (creating && text(item?.id)) navigate(`/commerce/${resource}/${encodeURIComponent(text(item.id)!)}`, { replace: true });
      else if (item && text(item.id) === recordId) queryClient.setQueryData(itemKey, { item });
    },
  });
  const publishing = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => { if (item && text(item.id) === recordId) queryClient.setQueryData(itemKey, { item }); },
  });
  const remove = useCommerceWrite(companyId, siteId, { onSuccess: () => navigate(`/commerce/${resource}`) });
  const back = (
    <Link to={`/commerce/${resource}`} className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <ArrowLeft className="size-4" aria-hidden="true" />
      All {copy.label.toLowerCase()}
    </Link>
  );

  if (creating) {
    return (
      <div className="space-y-6" data-testid="commerce-catalogue-record">
        {back}
        <header className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{copy.singular}</p>
          <h2 className="text-xl font-bold">New {copy.singular.toLowerCase()}</h2>
          <p className="text-sm text-muted-foreground">It starts as a draft. A person publishes it.</p>
        </header>
        <section className="rounded-xl border border-border bg-card p-4">
          <CommerceRowForm idPrefix={`new-${resource}`} fields={CATALOGUE_FIELDS[resource]} base={null} refOptions={refOptions}
            saving={write.isPending} submitLabel={`Create draft ${copy.singular.toLowerCase()}`}
            onSave={(body) => write.mutate({ method: "POST", parts: [resource], body })} />
        </section>
        <CommerceWriteError error={write.error} />
      </div>
    );
  }

  if (query.isLoading) return <PageSkeleton variant="detail" />;
  if (query.error || !query.data) {
    return <ErrorState error={query.error ?? new Error("The website has no such record.")} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  }
  const row = query.data.item;
  const version = rowVersionOf(row);
  const status = text(row.status) ?? "draft";
  const loadCurrent = (current: CommerceRow) => {
    write.reset();
    publishing.reset();
    remove.reset();
    queryClient.setQueryData(itemKey, { item: { ...row, ...current } });
    void query.refetch();
  };
  const statusChange = (sub: "publish" | "archive") =>
    publishing.mutate({ method: "POST", parts: [resource, recordId, sub], body: version ? { expectedRowVersion: version } : undefined });
  const oneLine = catalogueOneLine(row);
  const summary = resource === "offerings"
    ? [refName(refOptions.vendors, row.vendor_id), refName(refOptions.categories, row.category_id) ?? "No category", offeringPrice(row) ?? NO_PRICE].filter(Boolean).join(" · ")
    : catalogueMeta(resource, row);
  const code = catalogueCode(row);
  const websiteUrl = resource === "offerings" ? offeringWebsiteUrl(row, domain) : null;

  return (
    <div className="space-y-6" data-testid="commerce-catalogue-record">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{copy.singular}</p>
          <h2 className="flex flex-wrap items-center gap-2 break-words text-xl font-bold">
            {rowOptionLabel(row)}
            <StatusPill status={status} />
          </h2>
          {oneLine ? <p className="max-w-prose text-sm text-muted-foreground">{oneLine}</p> : null}
          {summary || code ? (
            <p className="text-xs text-muted-foreground" data-testid="commerce-catalogue-summary">
              {summary}{summary && code ? " · " : ""}{code ? <span className="font-mono">{code}</span> : null}
            </p>
          ) : null}
          {websiteUrl ? (
            <a href={websiteUrl} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-sm text-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              View on the website
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          ) : null}
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex flex-wrap gap-2">
            {isPerson && status !== "published" ? (
              <ConfirmButton label="Publish" variant="default" title={`Publish ${rowOptionLabel(row)}?`}
                description="It shows on the public website straight away." confirmLabel="Publish"
                disabled={publishing.isPending} onConfirm={() => statusChange("publish")} testId="commerce-publish" />
            ) : null}
            {isPerson && status !== "archived" ? (
              <ConfirmButton label="Archive" title={`Archive ${rowOptionLabel(row)}?`}
                description="It comes off the public website. You can publish it again later." confirmLabel="Archive"
                disabled={publishing.isPending} onConfirm={() => statusChange("archive")} testId="commerce-archive" />
            ) : null}
            <ConfirmButton label="Delete" variant="ghost" destructive title={`Delete ${rowOptionLabel(row)}?`}
              description="It is removed from the website's catalogue." confirmLabel="Delete"
              disabled={remove.isPending}
              onConfirm={() => remove.mutate({ method: "DELETE", parts: [resource, recordId], body: version ? { expectedRowVersion: version } : undefined })}
              testId="commerce-delete" />
          </div>
          {isPerson ? null : <PeopleOnlyNote>A person publishes and archives, in GSAM.</PeopleOnlyNote>}
        </div>
      </header>

      {/* publish, archive and delete answer up here, by their buttons; a save answers under the form */}
      <CommerceWriteError error={publishing.error} onUseCurrent={loadCurrent} />
      <CommerceWriteError error={remove.error} onUseCurrent={loadCurrent} />

      <section className="rounded-xl border border-border bg-card p-4" aria-label="Details">
        <CommerceRowForm key={`${recordId}:${text(row.row_version) ?? ""}:${text(row.updated_at) ?? ""}`} idPrefix={`edit-${resource}`}
          fields={CATALOGUE_FIELDS[resource]} base={row} refOptions={refOptions} saving={write.isPending} submitLabel="Save changes"
          onSave={(body) => write.mutate({ method: "PATCH", parts: [resource, recordId], body: { ...body, expectedRowVersion: version } })} />
        <CommerceWriteError error={write.error} onUseCurrent={loadCurrent} className="mt-4" />
      </section>

      {(CHILDREN[resource] ?? []).map((spec) => (
        <ChildSection key={spec.sub} companyId={companyId} siteId={siteId} resource={resource} parent={row} spec={spec} refOptions={refOptions} />
      ))}
      {resource === "pricing-rules" ? <CommerceRulePreview companyId={companyId} siteId={siteId} rule={row} /> : null}
    </div>
  );
}
