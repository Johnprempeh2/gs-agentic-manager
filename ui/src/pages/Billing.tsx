import { useEffect, type CSSProperties, type ReactNode } from "react";
import { ExternalLink, PauseCircle, ReceiptText } from "lucide-react";
import {
  BILLING_MODULES,
  type BillingAccount,
  type BillingInvoice,
  type BillingInvoiceStatus,
  type BillingState,
  type BillingStatus,
} from "@greatstone/shared/billing-account";
import type { BillingUsage } from "@/api/billing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { InlineBanner } from "@/components/InlineBanner";
import { PageSkeleton } from "@/components/PageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useBillingAccount } from "@/hooks/useBillingAccount";
import { cn } from "@/lib/utils";

/**
 * Client Billing page (GRE-1370, B1 on GRE-1357). Read-only: the hosting
 * operator sets the record (B2) and the server computes usage (GRE-1389).
 * Every amount shown comes from the server; none is in this file.
 */

export function formatMoney(cents: number, currency: string) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(cents / 100);
}

/** Billing dates are UTC days ("YYYY-MM-DD"); show them without a timezone shift. */
export function formatBillingDay(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

type ChipTone = "done" | "blocked" | "todo" | "backlog" | "in_progress";

function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span
      className="status-chip inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ "--sc": `var(--status-task-${tone})` } as CSSProperties}
    >
      {children}
    </span>
  );
}

const STATE_CHIP: Record<BillingState, { tone: ChipTone; label: string }> = {
  scheduled: { tone: "backlog", label: "Starts soon" },
  active: { tone: "done", label: "Active" },
  not_renewing: { tone: "todo", label: "Not renewing" },
  cancel_pending: { tone: "todo", label: "Cancelled" },
  ended: { tone: "blocked", label: "Ended" },
};

const INVOICE_CHIP: Record<BillingInvoiceStatus, { tone: ChipTone; label: string }> = {
  issued: { tone: "in_progress", label: "Issued" },
  paid: { tone: "done", label: "Paid" },
  overdue: { tone: "blocked", label: "Overdue" },
  void: { tone: "backlog", label: "Void" },
};

function renewalLine(status: BillingStatus) {
  if (status.state === "scheduled" && status.renewsOn) return `Starts on ${formatBillingDay(status.renewsOn)}`;
  if (status.renewsOn) return `Renews on ${formatBillingDay(status.renewsOn)}`;
  if (status.state === "ended" && status.accessEndsOn) return `Ended on ${formatBillingDay(status.accessEndsOn)}`;
  if (status.accessEndsOn) return `Ends on ${formatBillingDay(status.accessEndsOn)}`;
  return null;
}

function Figure({ label, value, note, testId }: { label: string; value: ReactNode; note?: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
      {note ? <dd className="mt-0.5 text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

function PlanCard({ account, status }: { account: BillingAccount; status: BillingStatus | null }) {
  const period = account.termKind === "annual" ? "year" : "month";
  const moduleTotal = account.modules.reduce((sum, module) => sum + (module.feeCents ?? 0), 0);
  const total = account.serviceFeeCents + moduleTotal;
  const chip = status ? STATE_CHIP[status.state] : null;
  const renewal = status ? renewalLine(status) : null;
  const planTitle = account.planName ?? (account.planKind === "all_inclusive" ? "All-inclusive" : "Modules");

  return (
    <Card data-testid="billing-plan">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>{planTitle}</span>
          {chip ? <Chip tone={chip.tone}>{chip.label}</Chip> : null}
        </CardTitle>
        <CardDescription>
          {account.termKind === "annual" ? "Annual term" : "Monthly term"} from {formatBillingDay(account.termStartsOn)}
          {renewal ? ` · ${renewal}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <table className="w-full text-sm">
          <caption className="sr-only">Fees per {period}</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">Item</th>
              <th scope="col" className="py-2 text-right font-medium">Per {period}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border/60" data-testid="billing-fee-row">
              <td className="py-2 pr-3">
                <div className="font-medium">Service fee</div>
                <div className="text-xs text-muted-foreground">Foundation, always included</div>
              </td>
              <td className="py-2 text-right font-mono tabular-nums">{formatMoney(account.serviceFeeCents, account.currency)}</td>
            </tr>
            {account.modules.map((module) => {
              const entry = BILLING_MODULES[module.key];
              return (
                <tr key={module.key} className="border-b border-border/60" data-testid="billing-fee-row">
                  <td className="py-2 pr-3">
                    <div className="font-medium">
                      {entry?.title ?? module.key}
                      {entry?.kind === "add_on" ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">add-on</span> : null}
                    </div>
                    {module.scope ? <div className="text-xs text-muted-foreground">Scope: {module.scope}</div> : null}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {module.feeCents === null ? (
                      <span className="font-sans text-muted-foreground">Included</span>
                    ) : (
                      formatMoney(module.feeCents, account.currency)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="pt-2 pr-3 text-left font-semibold">Total</th>
              <td className="pt-2 text-right font-mono font-semibold tabular-nums" data-testid="billing-fee-total">
                {formatMoney(total, account.currency)}
              </td>
            </tr>
          </tfoot>
        </table>
        <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <Figure
            label="AI allowance"
            value={formatMoney(account.allowanceMonthlyCents, account.currency)}
            note="Included in the fee, each calendar month"
            testId="billing-allowance"
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function UsageBar({ usage }: { usage: BillingUsage }) {
  const width = Math.min(100, Math.max(0, usage.usedPercent));
  const over = usage.usedPercent >= 100;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{formatPercent(usage.usedPercent)} used</span>
        <span>{formatPercent(Math.max(0, 100 - usage.usedPercent))} left</span>
      </div>
      <div className="relative h-2 rounded-full bg-muted">
        <div
          role="progressbar"
          aria-label="AI allowance used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(width)}
          className={cn(
            "h-full rounded-full",
            over ? "bg-(--status-task-blocked)" : usage.warning ? "bg-(--status-task-todo)" : "bg-(--status-task-done)",
          )}
          style={{ width: `${width}%` }}
        />
        <div
          aria-hidden
          title={`Warning at ${formatPercent(usage.warnPercent)}`}
          className="absolute -top-0.5 h-3 w-px bg-foreground/60"
          style={{ left: `${Math.min(100, usage.warnPercent)}%` }}
        />
      </div>
    </div>
  );
}

function UsageCard({ usage, currency }: { usage: BillingUsage | null | undefined; currency: string }) {
  if (!usage) {
    return (
      <Card data-testid="billing-usage">
        <CardHeader>
          <CardTitle>AI usage this month</CardTitle>
          <CardDescription>Usage figures are not available yet.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card data-testid="billing-usage">
      <CardHeader>
        <CardTitle>AI usage this month</CardTitle>
        <CardDescription>
          {formatBillingDay(usage.windowStart)} to {formatBillingDay(usage.windowEnd)} · day {usage.daysElapsed} of{" "}
          {usage.daysInWindow}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <UsageBar usage={usage} />
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Figure
            label="Actual"
            value={formatMoney(usage.usedCents, currency)}
            note={`of ${formatMoney(usage.allowanceCents, currency)} allowance`}
            testId="billing-actual"
          />
          <Figure
            label="Remaining"
            value={formatMoney(usage.remainingCents, currency)}
            note="Until the month ends"
            testId="billing-remaining"
          />
          <Figure
            label="Forecast to month end"
            value={formatMoney(usage.forecastCents, currency)}
            note="Straight line from usage so far"
            testId="billing-forecast"
          />
          <Figure
            label="Estimate"
            value={usage.estimateCents === null ? <span className="text-muted-foreground">Not set</span> : formatMoney(usage.estimateCents, currency)}
            note="Estimated at sign-up"
            testId="billing-estimate"
          />
        </dl>
        {usage.apiEquivalentCents > 0 ? (
          <p className="border-t border-border pt-4 text-sm text-muted-foreground" data-testid="billing-api-equivalent">
            Subscription-included usage: <span className="font-medium text-foreground">{formatMoney(usage.apiEquivalentCents, currency)}</span>{" "}
            API-equivalent. This is not charged.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InvoicesCard({ invoices }: { invoices: BillingInvoice[] }) {
  if (invoices.length === 0) return null;
  return (
    <Card data-testid="billing-invoices">
      <CardHeader>
        <CardTitle>Invoices</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {invoices.map((invoice) => {
            const chip = INVOICE_CHIP[invoice.status];
            return (
              <li key={invoice.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{invoice.reference}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatBillingDay(invoice.periodStart)} to {formatBillingDay(invoice.periodEnd)}
                  </span>
                </span>
                <span className="font-mono tabular-nums">{formatMoney(invoice.amountCents, invoice.currency)}</span>
                <Chip tone={chip.tone}>{chip.label}</Chip>
                {invoice.url ? (
                  <a
                    href={invoice.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Open <ExternalLink className="h-3 w-3" aria-hidden />
                    <span className="sr-only"> invoice {invoice.reference}</span>
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

export function Billing() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const query = useBillingAccount();

  useEffect(() => {
    setBreadcrumbs([{ label: "Billing" }]);
  }, [setBreadcrumbs]);

  if (query.isLoading) return <PageSkeleton variant="list" />;

  if (query.error || !query.data) {
    return (
      <p role="alert" className="mx-auto max-w-3xl text-sm text-destructive">
        Billing could not be loaded. Try again in a moment.
      </p>
    );
  }

  const { account, status, invoices, usage } = query.data;

  if (!account) {
    return (
      <EmptyState
        icon={ReceiptText}
        title="No billing account"
        message="This instance has no billing account. Greatstone sets it up when your service starts."
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="billing-page">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="text-sm text-muted-foreground">Your plan, fees and AI usage. Greatstone manages these values.</p>
      </div>

      {usage?.pausedSince ? (
        <InlineBanner tone="info" icon={PauseCircle} title={`Paused since ${formatBillingDay(usage.pausedSince.slice(0, 10))}`}>
          No AI usage is added while the company is paused.
        </InlineBanner>
      ) : null}

      {usage?.warning ? (
        <InlineBanner tone="warning" title={`You have used ${formatPercent(usage.usedPercent)} of this month's AI allowance`}>
          The warning level is {formatPercent(usage.warnPercent)}. Contact Greatstone if you expect to need more this month.
        </InlineBanner>
      ) : null}

      <UsageCard usage={usage} currency={account.currency} />
      <PlanCard account={account} status={status} />
      <InvoicesCard invoices={invoices} />
    </div>
  );
}
