import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { websiteCommerceApi, type CommerceRow } from "@/api/website-commerce";
import { ErrorState } from "@/components/ErrorState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCommercePerson, useCommerceWrite } from "@/hooks/useCommerceWrite";
import { formatMinor, text } from "@/lib/commerce";
import { parseRate, poundsPerDollar, showRate, previewRows, priceCounts, rateStaleness, usdToGbpMinor } from "@/lib/commerce-currency";
import { rowVersionOf } from "@/lib/commerce-write";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatDateTime, formatNumber } from "@/lib/utils";
import { useWholeCatalogue } from "./CommerceImports";
import { CommerceWriteError, ConfirmButton, PeopleOnlyNote } from "./CommerceWriteParts";

// Currency (GRE-3972 slice 2, parity with the website's old FX editor): the website's display rate, which is US
// dollars for one pound. The shop shows and charges USD / rate, rounded to the whole pound. A person changes it,
// after a preview of real prices and a confirm; the last 50 changes are listed.

function when(value: unknown) {
  const at = text(value);
  return at && !Number.isNaN(Date.parse(at)) ? formatDateTime(at) : null;
}

// Whole pounds, as the website shows them.
const POUNDS = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const gbp = (minor: number | null) => (minor === null ? "Price on application" : POUNDS.format(minor / 100));
const STALE_TONE = {
  fresh: "border-border bg-muted text-muted-foreground",
  ageing: "border-status-warning/40 bg-status-warning/15 text-status-warning-foreground",
  stale: "border-status-danger/40 bg-status-danger-soft text-status-danger-foreground",
} as const;

export function CommerceCurrency({ companyId, siteId }: { companyId: string; siteId: string }) {
  const queryClient = useQueryClient();
  const isPerson = useCommercePerson();
  const key = queryKeys.website.commerce(companyId, siteId, "fx");
  const fx = useQuery({ queryKey: key, queryFn: () => websiteCommerceApi.fx(companyId, siteId) });
  const catalogue = useWholeCatalogue(companyId, siteId, true);
  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState("");
  const write = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => {
      if (item) queryClient.setQueryData(key, { item });
      setEditing(false);
    },
  });

  if (fx.isLoading) return <PageSkeleton variant="detail" />;
  if (fx.error || !fx.data) return <ErrorState error={fx.error ?? new Error("The website sent no rate.")} onRetry={() => void fx.refetch()} retrying={fx.isFetching} />;
  const item = fx.data.item;
  const current = showRate(item.usd_to_gbp_display_rate);
  const currentRate = Number(current);
  const history = Array.isArray(item.history) ? (item.history as CommerceRow[]) : [];
  const stale = rateStaleness(item.updated_at);

  const parsed = editing ? parseRate(rate) : null;
  const nextRate = parsed && "rate" in parsed ? parsed.rate : null;
  const changed = nextRate !== null && Math.abs(nextRate - currentRate) > 1e-9;
  const problem = editing && rate.trim() !== "" && parsed && "problem" in parsed ? parsed.problem
    : editing && nextRate !== null && !changed ? "That is the rate now." : null;
  const rows = previewRows(catalogue.data ?? [], currentRate, changed ? nextRate : null);
  const counts = priceCounts(catalogue.data ?? []);
  const otherCurrencies = Object.entries(counts.other);
  const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? "" : "s"}`;
  const repriced = catalogue.data
    ? `${plural(counts.usd, "dollar price")} on ${plural(counts.products, "product")} ${counts.usd === 1 ? "changes" : "change"}`
    : "Every dollar price changes";

  const startEditing = () => {
    setRate(current ?? "");
    write.reset();
    setEditing(true);
  };
  const save = () => {
    if (!changed || nextRate === null) return;
    write.mutate({ method: "PATCH", parts: ["fx"], body: { usdToGbpDisplayRate: rate.trim(), expectedRowVersion: rowVersionOf(item) } });
  };
  const loadCurrent = (row: CommerceRow) => {
    queryClient.setQueryData(key, { item: { ...item, ...row } });
    setRate(showRate(row.usd_to_gbp_display_rate) ?? "");
    write.reset();
    void fx.refetch();
  };

  return (
    <div className="space-y-6" data-testid="commerce-currency">
      <section className="space-y-4 rounded-xl border border-border bg-card p-4" aria-label="Display rate">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Display rate, US dollars to the pound</p>
            <p className="text-2xl font-semibold tabular-nums" data-testid="commerce-fx-rate">
              {current ? `£1 = $${current}` : "Not set"}
            </p>
            {currentRate > 0 ? (
              <p className="text-sm tabular-nums text-muted-foreground">So $1 = £{poundsPerDollar(currentRate)}.</p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Prices are kept in US dollars. The website shows and charges pounds: the dollar price divided by this rate,
              rounded to the whole pound. Nothing updates the rate on its own.
            </p>
          </div>
          {isPerson && !editing ? <Button size="sm" variant="outline" onClick={startEditing}>Change rate</Button> : null}
        </div>
        {stale ? (
          <p data-testid="commerce-fx-staleness" role={stale.level === "stale" ? "alert" : undefined}
            className={cn("rounded-lg border px-3 py-2 text-sm", STALE_TONE[stale.level])}>
            {stale.label}{when(item.updated_at) ? ` (${when(item.updated_at)})` : ""}.
            {stale.level === "fresh" ? null : " Check it still matches the market before it prices a live order."}
          </p>
        ) : null}
        {isPerson ? null : <PeopleOnlyNote>Only a person changes the rate, in GSAM.</PeopleOnlyNote>}
        {editing ? (
          <form className="space-y-3" onSubmit={(event: FormEvent) => event.preventDefault()} noValidate>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="commerce-fx-input" className="text-sm font-medium">New rate (US dollars for £1)</label>
                <Input id="commerce-fx-input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)}
                  aria-describedby="commerce-fx-example" aria-invalid={problem ? true : undefined}
                  className="w-40 tabular-nums" disabled={write.isPending} />
              </div>
              <ConfirmButton
                label={write.isPending ? "Saving" : "Save rate"}
                variant="default"
                disabled={write.isPending || !changed}
                testId="commerce-fx-save"
                title="Reprice the whole catalogue?"
                description={`£1 = $${current} becomes £1 = $${rate.trim()}. ${repriced} on the website at once. To undo, set the rate back.`}
                confirmLabel="Save rate"
                onConfirm={save}
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); write.reset(); }} disabled={write.isPending}>Cancel</Button>
            </div>
            <p id="commerce-fx-example" className="text-sm text-muted-foreground tabular-nums">
              {nextRate !== null
                ? `At this rate $1 = £${poundsPerDollar(nextRate)}, and a $1,000 product shows as ${gbp(usdToGbpMinor(100_000, nextRate))}.`
                : "For example, at 1.32 a $1,000 product shows as £758."}
              {" "}If the stored prices are really pounds, a rate of 1.00 shows them unchanged.
            </p>
          </form>
        ) : null}
        {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
        <CommerceWriteError error={write.error} onUseCurrent={loadCurrent} />
      </section>

      <section className="space-y-2" aria-label="Price preview" data-testid="commerce-fx-preview">
        <h2 className="text-sm font-semibold">What the website shows</h2>
        <p className="text-sm text-muted-foreground">
          {changed ? `Now, and at $${rate.trim()} to the pound, for` : "Now, for"} the {rows.length} highest priced published products.
          {catalogue.data ? ` The rate reprices ${plural(counts.usd, "dollar price")} on ${plural(counts.products, "product")}.` : ""}
        </p>
        {otherCurrencies.length ? (
          <p className="text-sm text-muted-foreground" data-testid="commerce-fx-other">
            Not affected: {otherCurrencies.map(([code, n]) => `${formatNumber(n)} ${code === "unknown" ? "with no currency" : `in ${code}`}`).join(", ")}.
          </p>
        ) : null}
        {catalogue.isLoading ? <PageSkeleton variant="list" /> : null}
        {catalogue.error ? <ErrorState error={catalogue.error} onRetry={() => void catalogue.refetch()} retrying={catalogue.isFetching} /> : null}
        {catalogue.data && rows.length === 0 ? <p className="text-sm text-muted-foreground">No published product has a dollar price.</p> : null}
        {rows.length ? (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-4 py-2 font-medium">Product</th>
                  <th scope="col" className="hidden px-4 py-2 text-right font-medium sm:table-cell">Stored</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Shown now</th>
                  {changed ? <th scope="col" className="px-4 py-2 text-right font-medium">At the new rate</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="max-w-36 truncate px-4 py-2 sm:max-w-64" title={row.name}>{row.name}</td>
                    <td className="hidden px-4 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">{formatMinor(row.usdMinor, "USD")}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{gbp(row.now)}</td>
                    {changed ? <td className="px-4 py-2 text-right font-medium tabular-nums">{gbp(row.next)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="space-y-2" aria-label="Rate history">
        <h2 className="text-sm font-semibold">History</h2>
        {history.length === 0 ? <p className="text-sm text-muted-foreground">No changes recorded yet.</p> : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card" data-testid="commerce-fx-history">
            {history.map((change, index) => (
              <li key={text(change.id) ?? index} className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                <span className="tabular-nums">
                  {showRate(change.old_rate) ? `$${showRate(change.old_rate)}` : "None"} <span aria-hidden="true">→</span><span className="sr-only">to</span>{" "}
                  <span className="font-medium">${showRate(change.new_rate)}</span> <span className="text-muted-foreground">to the pound</span>
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
