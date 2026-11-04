import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { websiteCommerceApi, type CommerceRow } from "@/api/website-commerce";
import { ErrorState } from "@/components/ErrorState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCommercePerson, useCommerceWrite } from "@/hooks/useCommerceWrite";
import { text } from "@/lib/commerce";
import { rowVersionOf } from "@/lib/commerce-write";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { CommerceWriteError, PeopleOnlyNote } from "./CommerceWriteParts";

// Currency (GRE-3972 slice 2): the website's USD to GBP display rate and its last 50 changes. Prices are kept in
// USD; the site shows GBP at this rate. Only a person changes it.

const RATE = /^\d{1,6}(\.\d{1,6})?$/;

function when(value: unknown) {
  const at = text(value);
  return at && !Number.isNaN(Date.parse(at)) ? formatDateTime(at) : null;
}

export function CommerceCurrency({ companyId, siteId }: { companyId: string; siteId: string }) {
  const queryClient = useQueryClient();
  const isPerson = useCommercePerson();
  const key = queryKeys.website.commerce(companyId, siteId, "fx");
  const fx = useQuery({ queryKey: key, queryFn: () => websiteCommerceApi.fx(companyId, siteId) });
  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const write = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => {
      if (item) queryClient.setQueryData(key, { item });
      setEditing(false);
    },
  });

  if (fx.isLoading) return <PageSkeleton variant="detail" />;
  if (fx.error || !fx.data) return <ErrorState error={fx.error ?? new Error("The website sent no rate.")} onRetry={() => void fx.refetch()} retrying={fx.isFetching} />;
  const item = fx.data.item;
  const current = text(item.usd_to_gbp_display_rate);
  const history = Array.isArray(item.history) ? (item.history as CommerceRow[]) : [];

  const startEditing = () => {
    setRate(current ?? "");
    setProblem(null);
    write.reset();
    setEditing(true);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const value = rate.trim();
    if (!RATE.test(value) || Number(value) <= 0 || Number(value) > 100) return setProblem("Enter a rate like 0.79.");
    if (value === current) return setProblem("That is the rate now.");
    setProblem(null);
    write.mutate({ method: "PATCH", parts: ["fx"], body: { usdToGbpDisplayRate: value, expectedRowVersion: rowVersionOf(item) } });
  };
  const loadCurrent = (row: CommerceRow) => {
    queryClient.setQueryData(key, { item: { ...item, ...row } });
    setRate(text(row.usd_to_gbp_display_rate) ?? "");
    write.reset();
    void fx.refetch();
  };

  return (
    <div className="space-y-6" data-testid="commerce-currency">
      <section className="space-y-4 rounded-xl border border-border bg-card p-4" aria-label="Display rate">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">USD to GBP display rate</p>
            <p className="text-2xl font-semibold tabular-nums" data-testid="commerce-fx-rate">
              {current ? `1 USD = ${current} GBP` : "Not set"}
            </p>
            <p className="text-sm text-muted-foreground">
              Prices are kept in USD. The website shows GBP at this rate.{when(item.updated_at) ? ` Changed ${when(item.updated_at)}.` : ""}
            </p>
          </div>
          {isPerson && !editing ? <Button size="sm" variant="outline" onClick={startEditing}>Change rate</Button> : null}
        </div>
        {isPerson ? null : <PeopleOnlyNote>Only a person changes the rate, in GSAM.</PeopleOnlyNote>}
        {editing ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={save} noValidate>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="commerce-fx-input" className="text-sm font-medium">New rate (GBP for 1 USD)</label>
              <Input id="commerce-fx-input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)}
                className="w-40 tabular-nums" disabled={write.isPending} />
            </div>
            <Button type="submit" size="sm" disabled={write.isPending}>{write.isPending ? "Saving" : "Save rate"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); write.reset(); }} disabled={write.isPending}>Cancel</Button>
          </form>
        ) : null}
        {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
        <CommerceWriteError error={write.error} onUseCurrent={loadCurrent} />
      </section>

      <section className="space-y-2" aria-label="Rate history">
        <h2 className="text-sm font-semibold">History</h2>
        {history.length === 0 ? <p className="text-sm text-muted-foreground">No changes recorded yet.</p> : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card" data-testid="commerce-fx-history">
            {history.map((change, index) => (
              <li key={text(change.id) ?? index} className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                <span className="tabular-nums">
                  {text(change.old_rate) ?? "None"} <span aria-hidden="true">→</span><span className="sr-only">to</span> <span className="font-medium">{text(change.new_rate)}</span>
                </span>
                <span className="text-xs text-muted-foreground">{when(change.changed_at)}</span>
                {text(change.note) ? <span className="min-w-0 basis-full break-words text-xs text-muted-foreground sm:basis-auto">{text(change.note)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
