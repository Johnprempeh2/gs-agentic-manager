import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plus, ShoppingBag, Trash2 } from "lucide-react";
import type { WebsiteCommerceCatalogueResource } from "@greatstone/shared";
import { websiteCommerceApi, type CommerceRow } from "@/api/website-commerce";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { useCommercePerson, useCommerceWrite } from "@/hooks/useCommerceWrite";
import { formatMinor, statusLabel, statusTone, text } from "@/lib/commerce";
import {
  CATALOGUE_COPY,
  CATALOGUE_FIELDS,
  MEDIA_FIELDS,
  SPEC_FIELDS,
  TARGET_FIELDS,
  VARIANT_FIELDS,
  catalogueMeta,
  rowOptionLabel,
} from "@/lib/commerce-catalogue";
import { rowVersionOf, type CommerceFieldDef } from "@/lib/commerce-write";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { CommerceRowForm, CommerceWriteError, ConfirmButton, PeopleOnlyNote } from "./CommerceWriteParts";

// The catalogue (GRE-3972 slice 1): vendors, categories, offerings with their editions, specs and media, pricing
// rules with their targets, and customer tiers (read only). Anyone with Commerce rights creates, edits and deletes
// drafts; only a person publishes or archives.

export type CatalogueResource = WebsiteCommerceCatalogueResource | "customer-tiers";
const PAGE_SIZE = 50;
const ROW_LINK = "flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function StatusPill({ status }: { status: unknown }) {
  const value = text(status);
  if (!value) return null;
  return <span className={cn("inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", statusTone(value))}>{statusLabel(value)}</span>;
}

type RefOptions = Record<NonNullable<CommerceFieldDef["ref"]>, { value: string; label: string }[]>;

/** The rows a `ref` field picks from: the first 100 of each, by name. */
function useRefOptions(companyId: string, siteId: string): RefOptions {
  const read = (resource: "vendors" | "categories" | "offerings" | "customer-tiers") => ({
    queryKey: queryKeys.website.commerce(companyId, siteId, resource, "options"),
    queryFn: () => websiteCommerceApi.list(companyId, siteId, resource, { limit: 100 }),
    staleTime: 60_000,
  });
  const vendors = useQuery(read("vendors"));
  const categories = useQuery(read("categories"));
  const offerings = useQuery(read("offerings"));
  const tiers = useQuery(read("customer-tiers"));
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

export function CatalogueList({ companyId, siteId, resource }: { companyId: string; siteId: string; resource: CatalogueResource }) {
  const copy = CATALOGUE_COPY[resource];
  const rows = useInfiniteQuery({
    queryKey: queryKeys.website.commerce(companyId, siteId, resource, "list"),
    queryFn: ({ pageParam }) => websiteCommerceApi.list(companyId, siteId, resource, { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor || undefined,
  });
  const items = rows.data?.pages.flatMap((page) => page.items) ?? [];
  const readOnly = resource === "customer-tiers";

  return (
    <section className="space-y-3" aria-label={copy.label} data-testid="commerce-catalogue-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {readOnly
            ? "Read only. Tiers are set on the website."
            : "New records start as drafts. Only published records show on the website."}
        </p>
        {readOnly ? null : (
          <Button asChild size="sm">
            <Link to={`/commerce/${resource}/new`}>
              <Plus aria-hidden="true" />
              New {copy.singular.toLowerCase()}
            </Link>
          </Button>
        )}
      </div>
      {rows.isLoading ? <PageSkeleton variant="list" /> : null}
      {rows.error ? <ErrorState error={rows.error} onRetry={() => void rows.refetch()} retrying={rows.isFetching} /> : null}
      {rows.data && items.length === 0 ? <EmptyState icon={ShoppingBag} message={copy.empty} /> : null}
      {items.length ? (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {items.map((row) => {
            const id = text(row.id) ?? "";
            const body = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{rowOptionLabel(row)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{catalogueMeta(resource, row) || " "}</span>
                  {readOnly && text(row.description) ? <span className="mt-1 block text-xs text-muted-foreground">{text(row.description)}</span> : null}
                </span>
                <StatusPill status={row.status} />
              </>
            );
            return (
              <li key={id}>
                {readOnly ? <div className="flex min-w-0 items-center gap-3 px-4 py-3">{body}</div> : (
                  <Link to={`/commerce/${resource}/${encodeURIComponent(id)}`} className={ROW_LINK}>{body}</Link>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {rows.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
            {rows.isFetchingNextPage ? "Loading" : "Load more"}
          </Button>
        </div>
      ) : null}
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
  describe: (row: CommerceRow, refOptions: RefOptions) => { title: string; meta: string };
}

const refName = (options: { value: string; label: string }[], id: unknown) => {
  const value = text(id);
  return value ? options.find((option) => option.value === value)?.label ?? value.slice(0, 8) : null;
};

const CHILDREN: Partial<Record<WebsiteCommerceCatalogueResource, ChildSpec[]>> = {
  offerings: [
    { sub: "variants", title: "Editions", addLabel: "Add edition", fields: VARIANT_FIELDS, versioned: true,
      describe: (row) => ({
        title: text(row.name) ?? "Edition",
        meta: [text(row.sku), text(row.billing_period) ? statusLabel(text(row.billing_period)!) : null,
          formatMinor(row.base_price_minor, row.currency) ?? "Price on request"].filter(Boolean).join(" · "),
      }) },
    { sub: "specs", title: "Specs", addLabel: "Add spec", fields: SPEC_FIELDS, versioned: false,
      describe: (row) => ({ title: text(row.label) ?? "Spec", meta: text(row.value) ?? "" }) },
    { sub: "media", title: "Media", addLabel: "Add media", fields: MEDIA_FIELDS, versioned: false,
      describe: (row) => ({ title: `Asset ${text(row.asset_id) ?? ""}`, meta: text(row.sort_order) ? `Sort ${text(row.sort_order)}` : "" }) },
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

export function CatalogueRecord({ companyId, siteId, resource, recordId }: {
  companyId: string; siteId: string; resource: WebsiteCommerceCatalogueResource; recordId: string;
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
    </div>
  );
}
