import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShoppingBag } from "lucide-react";
import { websiteCommerceApi, type CommerceRow } from "@/api/website-commerce";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMinor, recordCode, recordTitle, statusLabel, statusTone, text } from "@/lib/commerce";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, formatDate } from "@/lib/utils";

// The Stripe payment report (GRE-3972 slice 6), read only. Built by the website from its own orders: GSAM makes no
// Stripe call and holds no Stripe key. Refunds are made by a person in Stripe; requests are decided on GSAM cards.

const MODE: Record<string, { label: string; tone: string; note: string }> = {
  test: { label: "Test mode", tone: "bg-status-info-soft text-status-info-foreground", note: "The website's Stripe key is a test key. No real money moves." },
  live: { label: "Live mode", tone: "bg-status-warning-soft text-status-warning-foreground", note: "The website's Stripe key is a live key." },
  unset: { label: "Stripe not set up", tone: "bg-status-neutral-soft text-status-neutral-foreground", note: "The website has no Stripe key." },
};

function Pill({ tone, children, testId }: { tone: string; children: string; testId?: string }) {
  return <span className={cn("inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", tone)} data-testid={testId}>{children}</span>;
}

const asRows = (value: unknown) => (Array.isArray(value) ? (value as CommerceRow[]) : []);

export function CommercePayments({ companyId, siteId }: { companyId: string; siteId: string }) {
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [draft, setDraft] = useState({ from: "", to: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const report = useQuery({
    queryKey: queryKeys.website.commerce(companyId, siteId, "payments", range.from ?? "", range.to ?? ""),
    queryFn: () => websiteCommerceApi.payments(companyId, siteId, range),
  });
  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) return setProblem("From must not be after To.");
    setProblem(null);
    setRange({ ...(draft.from ? { from: draft.from } : {}), ...(draft.to ? { to: draft.to } : {}) });
  };

  const data = report.data?.report;
  const mode = MODE[String(data?.stripeMode)] ?? MODE.unset!;
  const totals = asRows(data?.totals);
  const requests = asRows(data?.refundRequests);
  const orders = asRows(data?.items);

  return (
    <div className="space-y-6" data-testid="commerce-payments">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Stripe payments</h2>
            {data ? <Pill tone={mode.tone} testId="commerce-stripe-mode">{mode.label}</Pill> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Read only, from the website's orders. {data ? mode.note : ""} Refunds are made by a person in Stripe.
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={apply} noValidate aria-label="Date range">
          <div className="flex flex-col gap-1">
            <label htmlFor="commerce-payments-from" className="text-xs font-medium">From</label>
            <Input id="commerce-payments-from" type="date" value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} className="w-40" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="commerce-payments-to" className="text-xs font-medium">To</label>
            <Input id="commerce-payments-to" type="date" value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} className="w-40" />
          </div>
          <Button type="submit" size="sm" variant="outline">Show</Button>
        </form>
      </section>
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      {report.isLoading ? <PageSkeleton variant="list" /> : null}
      {report.error ? <ErrorState error={report.error} onRetry={() => void report.refetch()} retrying={report.isFetching} /> : null}

      {data ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Totals">
            {totals.length === 0 ? <p className="text-sm text-muted-foreground">No Stripe payments in this range.</p> : totals.map((row) => (
              <div key={text(row.currency) ?? "total"} className="rounded-xl border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">{text(row.currency) ?? "Total"} · {text(row.orders) ?? "0"} orders</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{formatMinor(row.total_minor, row.currency) ?? "None"}</p>
                <p className="text-xs text-muted-foreground tabular-nums">Refunded {formatMinor(row.refunded_minor, row.currency) ?? "none"}</p>
              </div>
            ))}
          </section>

          {requests.length ? (
            <section className="space-y-2" aria-label="Refund requests">
              <h3 className="text-sm font-semibold">Refund requests</h3>
              <ul className="flex flex-wrap gap-2 text-sm">
                {requests.map((row) => (
                  <li key={text(row.status) ?? ""} className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5">
                    <Pill tone={statusTone(text(row.status) ?? "")}>{statusLabel(text(row.status) ?? "")}</Pill>
                    <span className="tabular-nums">{text(row.requests) ?? "0"}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="space-y-2" aria-label="Orders paid by Stripe">
            <h3 className="text-sm font-semibold">Orders paid by Stripe</h3>
            {orders.length === 0 ? <EmptyState icon={ShoppingBag} message="No orders paid by Stripe in this range." /> : (
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {orders.map((order) => {
                  const id = text(order.id) ?? "";
                  const refunds = asRows(order.refund_requests);
                  const unallocated = Number(order.unallocated_refund_minor ?? 0);
                  const waiting = refunds.some((r) => r.waiting_on_stripe === true);
                  return (
                    <li key={id} className="space-y-1 px-4 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <Link to={`/commerce/orders/${encodeURIComponent(id)}`} className="min-w-0 flex-1 truncate text-sm font-medium text-primary underline-offset-4 hover:underline">
                          {recordTitle("orders", order)}
                        </Link>
                        <span className="shrink-0 text-sm font-medium tabular-nums">{formatMinor(order.total_minor, order.currency)}</span>
                        <Pill tone={statusTone(text(order.status) ?? "")}>{statusLabel(text(order.status) ?? "")}</Pill>
                      </div>
                      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {recordCode("orders", order) ? <span className="font-mono">{recordCode("orders", order)}</span> : null}
                        <span>{text(order.placed_at ?? order.created_at) ? formatDate(text(order.placed_at ?? order.created_at)!) : ""}</span>
                        {Number(order.refunded_minor ?? 0) > 0 ? <span>Refunded {formatMinor(order.refunded_minor, order.currency)}</span> : null}
                        {refunds.length ? <span>{refunds.length} refund {refunds.length === 1 ? "request" : "requests"}</span> : null}
                        {waiting ? <span className="font-medium text-status-warning-foreground">Waiting on Stripe</span> : null}
                        {unallocated > 0 ? <span className="font-medium text-status-warning-foreground">Refund with no request: {formatMinor(unallocated, order.currency)}</span> : null}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
