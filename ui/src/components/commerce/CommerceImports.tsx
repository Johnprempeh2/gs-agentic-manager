import { useId, useState, type ChangeEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileUp, ShoppingBag } from "lucide-react";
import { websiteCommerceApi, type CommerceRow } from "@/api/website-commerce";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { useCommercePerson, useCommerceWrite } from "@/hooks/useCommerceWrite";
import { statusLabel, statusTone, text } from "@/lib/commerce";
import {
  MAX_IMPORT_ROWS,
  SKU_COLUMNS,
  csvToObjects,
  importCatalogueOf,
  planSkuImport,
  type ImportPlan,
} from "@/lib/commerce-import";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate } from "@/lib/router";
import { cn, formatDateTime, formatNumber } from "@/lib/utils";
import { CommerceWriteError, ConfirmButton, PeopleOnlyNote } from "./CommerceWriteParts";

// Price-book import (GRE-3972 slice 3). A dry run makes an import job on the website: the rows as GSAM planned
// them, and nothing in the catalogue changes. Anyone with Commerce rights makes one; only a person applies it.

const PAGE_SIZE = 50;
const ROW_LINK = "flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const ACTION_LABEL: Record<string, string> = { insert: "New", update: "Change", noop: "No change", skip: "Skipped", error: "Error" };
const ACTION_TONE: Record<string, string> = {
  insert: "bg-status-info-soft text-status-info-foreground",
  update: "bg-status-review-soft text-status-review-foreground",
  noop: "bg-status-neutral-soft text-status-neutral-foreground",
  skip: "bg-status-neutral-soft text-status-neutral-foreground",
  error: "bg-status-danger-soft text-status-danger-foreground",
};

function Pill({ tone, children }: { tone: string; children: string }) {
  return <span className={cn("inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", tone)}>{children}</span>;
}

function when(value: unknown) {
  const at = text(value);
  return at && !Number.isNaN(Date.parse(at)) ? formatDateTime(at) : null;
}

function summaryLine(summary: unknown) {
  const s = summary && typeof summary === "object" ? (summary as Record<string, unknown>) : {};
  const parts = [["inserts", "new"], ["updates", "to change"], ["noops", "unchanged"], ["errors", "with errors"]]
    .flatMap(([key, label]) => (typeof s[key] === "number" ? [`${s[key]} ${label}`] : []));
  return parts.join(" · ");
}

/** Every live offering with its editions, for the planner. Up to 2,000. */
function useWholeCatalogue(companyId: string, siteId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.website.commerce(companyId, siteId, "offerings", "all"),
    enabled,
    queryFn: async () => {
      const rows: CommerceRow[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await websiteCommerceApi.list(companyId, siteId, "offerings", { limit: 100, ...(cursor ? { cursor } : {}) });
        rows.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return rows;
    },
  });
}

function NewDryRun({ companyId, siteId }: { companyId: string; siteId: string }) {
  const navigate = useNavigate();
  const inputId = useId();
  const [file, setFile] = useState<{ name: string; objects: Record<string, string>[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const catalogue = useWholeCatalogue(companyId, siteId, file !== null);
  const write = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => { if (text(item?.id)) navigate(`/commerce/imports/${encodeURIComponent(text(item.id)!)}`); },
  });
  const plan: ImportPlan | null = file && catalogue.data ? planSkuImport(file.objects, importCatalogueOf(catalogue.data)) : null;

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = "";
    write.reset();
    setFile(null);
    if (!chosen) return;
    const objects = csvToObjects(await chosen.text());
    if (!objects.length) return setProblem("That file has no rows under its header.");
    if (!("sku" in objects[0]!)) return setProblem("The file needs a sku column. Use the columns listed below.");
    if (objects.length > MAX_IMPORT_ROWS) return setProblem(`The website takes ${formatNumber(MAX_IMPORT_ROWS)} rows at most in one import.`);
    setProblem(null);
    setFile({ name: chosen.name.slice(0, 200), objects });
  };
  const send = () => {
    if (!file || !plan) return;
    write.mutate({ method: "POST", parts: ["imports"], body: { filename: file.name, type: "variants", rows: plan.rows } });
  };

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label="New dry run" data-testid="commerce-import-new">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">New dry run</h2>
        <p className="text-sm text-muted-foreground">
          Choose a price book as CSV. GSAM compares it with the catalogue and sends the plan to the website as a dry run.
          Nothing in the catalogue changes until a person applies it.
        </p>
        <p className="break-words text-xs text-muted-foreground">
          Columns: <span className="font-mono">{SKU_COLUMNS.join(", ")}</span>. The sku matches an edition; prices are USD.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent focus-within:ring-2 focus-within:ring-ring">
          <FileUp className="size-4" aria-hidden="true" />
          {file ? "Choose another file" : "Choose CSV file"}
          <input id={inputId} type="file" accept=".csv,text/csv" className="sr-only" onChange={(event) => void choose(event)} />
        </label>
        {file ? <span className="min-w-0 truncate text-sm">{file.name}</span> : null}
      </div>
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      {file && catalogue.isLoading ? <p className="text-sm text-muted-foreground">Reading the catalogue to compare</p> : null}
      {catalogue.error ? <ErrorState compact error={catalogue.error} onRetry={() => void catalogue.refetch()} retrying={catalogue.isFetching} /> : null}
      {plan ? (
        <div className="space-y-3" data-testid="commerce-import-plan">
          <ul className="flex flex-wrap gap-2 text-sm">
            <li><Pill tone={ACTION_TONE.insert!}>{`${plan.counts.insert} new`}</Pill></li>
            <li><Pill tone={ACTION_TONE.update!}>{`${plan.counts.update} to change`}</Pill></li>
            <li><Pill tone={ACTION_TONE.noop!}>{`${plan.counts.noop} unchanged`}</Pill></li>
            <li><Pill tone={ACTION_TONE.error!}>{`${plan.counts.error} with errors`}</Pill></li>
          </ul>
          {plan.counts.error ? (
            <p className="text-sm text-muted-foreground">A dry run with errors can be sent so the website keeps it, but it cannot be applied. Fix the file to apply it.</p>
          ) : null}
          <Button size="sm" onClick={send} disabled={write.isPending}>{write.isPending ? "Sending" : "Send dry run to the website"}</Button>
        </div>
      ) : null}
      <CommerceWriteError error={write.error} />
    </section>
  );
}

export function CommerceImports({ companyId, siteId }: { companyId: string; siteId: string }) {
  const jobs = useInfiniteQuery({
    queryKey: queryKeys.website.commerce(companyId, siteId, "imports", "list"),
    queryFn: ({ pageParam }) => websiteCommerceApi.list(companyId, siteId, "imports", { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor || undefined,
  });
  const items = [...(jobs.data?.pages.flatMap((page) => page.items) ?? [])]
    .sort((a, b) => (text(b.created_at) ?? "").localeCompare(text(a.created_at) ?? ""));
  return (
    <div className="space-y-6" data-testid="commerce-imports">
      <NewDryRun companyId={companyId} siteId={siteId} />
      <section className="space-y-2" aria-label="Import jobs">
        <h2 className="text-sm font-semibold">Import jobs</h2>
        {jobs.isLoading ? <PageSkeleton variant="list" /> : null}
        {jobs.error ? <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} retrying={jobs.isFetching} /> : null}
        {jobs.data && items.length === 0 ? <EmptyState icon={ShoppingBag} message="No imports yet." /> : null}
        {items.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {items.map((job) => {
              const id = text(job.id) ?? "";
              const status = text(job.status) ?? "pending";
              return (
                <li key={id}>
                  <Link to={`/commerce/imports/${encodeURIComponent(id)}`} className={ROW_LINK}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{text(job.filename) ?? "Import"}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[summaryLine(job.diff_summary) || (text(job.total_rows) ? `${text(job.total_rows)} rows` : null), when(job.created_at)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <Pill tone={statusTone(status)}>{statusLabel(status)}</Pill>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
        {jobs.hasNextPage ? (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => void jobs.fetchNextPage()} disabled={jobs.isFetchingNextPage}>
              {jobs.isFetchingNextPage ? "Loading" : "Load more"}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function CommerceImportJob({ companyId, siteId, jobId }: { companyId: string; siteId: string; jobId: string }) {
  const isPerson = useCommercePerson();
  const job = useInfiniteQuery({
    queryKey: queryKeys.website.commerce(companyId, siteId, "imports", "item", jobId),
    queryFn: ({ pageParam }) => websiteCommerceApi.get(companyId, siteId, "imports", jobId, { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (last) => {
      const rows = last.item.rows as { nextCursor?: string | null } | undefined;
      return rows?.nextCursor || undefined;
    },
  });
  const apply = useCommerceWrite(companyId, siteId);

  if (job.isLoading) return <PageSkeleton variant="detail" />;
  if (job.error || !job.data) return <ErrorState error={job.error ?? new Error("The website has no such import.")} onRetry={() => void job.refetch()} retrying={job.isFetching} />;
  const item = job.data.pages[0]!.item;
  const rows = job.data.pages.flatMap((page) => {
    const pageRows = page.item.rows as { items?: CommerceRow[] } | undefined;
    return pageRows?.items ?? [];
  });
  const status = text(item.status) ?? "pending";
  const result = apply.data && "result" in apply.data ? (apply.data.result as Record<string, unknown> | null) : null;

  return (
    <div className="space-y-6" data-testid="commerce-import-job">
      <Link to="/commerce/imports" className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ArrowLeft className="size-4" aria-hidden="true" />
        All imports
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{item.dry_run === false ? "Import" : "Dry run"}</p>
          <h2 className="flex flex-wrap items-center gap-2 break-words text-xl font-bold">
            {text(item.filename) ?? "Import"}
            <Pill tone={statusTone(status)}>{statusLabel(status)}</Pill>
          </h2>
          <p className="text-sm text-muted-foreground">
            {[summaryLine(item.diff_summary), when(item.created_at) ? `Made ${when(item.created_at)}` : null,
              when(item.applied_at) ? `Applied ${when(item.applied_at)}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          {isPerson && status === "validated" ? (
            <ConfirmButton label="Apply to the catalogue" variant="default" title="Apply this import?"
              description="New editions are added and changed prices are saved on the website. New products start as drafts unless the file says otherwise."
              confirmLabel="Apply" disabled={apply.isPending} testId="commerce-import-apply"
              onConfirm={() => apply.mutate({ method: "POST", parts: ["imports", jobId, "apply"] })} />
          ) : null}
          {!isPerson && status === "validated" ? <PeopleOnlyNote>A person applies imports, in GSAM.</PeopleOnlyNote> : null}
          {status === "failed" ? <p className="text-xs text-muted-foreground">Rows have errors, so it cannot be applied.</p> : null}
        </div>
      </header>
      <CommerceWriteError error={apply.error} />
      {result ? (
        <p role="status" className="rounded-lg border border-status-success/40 bg-status-success-soft p-3 text-sm text-status-success-foreground">
          Applied: {text(result.created) ?? "0"} new, {text(result.updated) ?? "0"} changed.
        </p>
      ) : null}
      <section className="space-y-2" aria-label="Rows">
        <h3 className="text-sm font-semibold">Rows</h3>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No rows.</p> : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card" data-testid="commerce-import-rows">
            {rows.map((row) => {
              const action = text(row.action) ?? "noop";
              const errors = Array.isArray(row.errors) ? row.errors.map(String) : [];
              return (
                <li key={text(row.id) ?? text(row.row_number)} className="flex min-w-0 items-start gap-3 px-4 py-2.5 text-sm">
                  <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">Line {text(row.row_number)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{text(row.match_key) ?? "No SKU"}</span>
                    {errors.length ? <span className="block break-words text-xs text-destructive">{errors.join("; ")}</span> : null}
                  </span>
                  <Pill tone={ACTION_TONE[action] ?? ACTION_TONE.noop!}>{ACTION_LABEL[action] ?? statusLabel(action)}</Pill>
                </li>
              );
            })}
          </ul>
        )}
        {job.hasNextPage ? (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => void job.fetchNextPage()} disabled={job.isFetchingNextPage}>
              {job.isFetchingNextPage ? "Loading" : "More rows"}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
