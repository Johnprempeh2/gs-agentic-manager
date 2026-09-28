import type { ApiEquivalentModelRow, ApiEquivalentProviderRow, ApiEquivalentSummary } from "@greatstone/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatCents, formatTokens, providerDisplayName } from "../lib/utils";

/** "Saving $X", "Extra $X" or "Even" for what we pay versus API billing. */
export function apiEquivalentDifferenceLabel(savingCents: number) {
  const saving = Math.round(savingCents);
  if (saving > 0) return `Saving ${formatCents(saving)}`;
  if (saving < 0) return `Extra ${formatCents(-saving)}`;
  return "Even";
}

/** The saving (or extra) of what we pay versus API billing, in one line. */
export function apiEquivalentDifferenceLine(summary: Pick<ApiEquivalentSummary, "savingCents" | "paidCents" | "apiEquivalentCents">) {
  return `${apiEquivalentDifferenceLabel(summary.savingCents)}: we paid ${formatCents(summary.paidCents)}, API billing would have cost ${formatCents(summary.apiEquivalentCents)}.`;
}

function Amount({ label, cents, note }: { label: string; cents: number; note: string }) {
  return (
    <div className="min-w-0">
      <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{formatCents(Math.round(cents))}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{note}</div>
    </div>
  );
}

export function ApiEquivalentCard({ summary }: { summary: ApiEquivalentSummary }) {
  const saving = Math.round(summary.savingCents);
  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">What we pay vs API billing</CardTitle>
        <CardDescription>
          Every token priced at the published per-model API rate, whether it ran on a subscription or the API.
          Subscriptions are prorated by day over the period.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-2">
        <div className="grid gap-4 sm:grid-cols-3">
          <Amount label="Actual API spend" cents={summary.actualApiSpendCents} note="Billed per token" />
          <Amount label="Subscription cost" cents={summary.subscriptionCostCents} note="Monthly plans, prorated" />
          <Amount
            label="Would cost under API billing"
            cents={summary.apiEquivalentCents}
            note={`${formatTokens(summary.totalTokens)} tokens`}
          />
        </div>

        <p
          className={cn(
            "text-sm font-medium",
            saving > 0 ? "text-emerald-700 dark:text-emerald-400" : saving < 0 ? "text-amber-700 dark:text-amber-400" : "",
          )}
          data-testid="api-equivalent-difference"
        >
          {apiEquivalentDifferenceLine(summary)}
        </p>

        {summary.unpricedTokens > 0 ? (
          <p className="text-xs text-muted-foreground">
            {formatTokens(summary.unpricedTokens)} tokens are on models with no published price in our table
            ({summary.unpricedModels.join(", ")}); their price is shown as unknown and is not in the total.
          </p>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Provider / model</th>
                <th className="py-2 pr-3 text-right font-medium">Tokens (in / cached / out)</th>
                <th className="py-2 pr-3 text-right font-medium">API spend</th>
                <th className="py-2 pr-3 text-right font-medium">Subscription</th>
                <th className="py-2 text-right font-medium">Under API billing</th>
              </tr>
            </thead>
            <tbody>
              {summary.byProvider.map((provider) => (
                <ProviderRows key={provider.provider} row={provider} models={summary.byModel} />
              ))}
              {summary.byProvider.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-muted-foreground">No token usage or subscriptions in this period.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">Prices checked {summary.priceTableCheckedAt}.</p>
      </CardContent>
    </Card>
  );
}

function tokenTriple(row: { inputTokens: number; cachedInputTokens: number; outputTokens: number }) {
  return `${formatTokens(row.inputTokens)} / ${formatTokens(row.cachedInputTokens)} / ${formatTokens(row.outputTokens)}`;
}

function ProviderRows({ row, models: allModels }: { row: ApiEquivalentProviderRow; models: ApiEquivalentModelRow[] }) {
  const models = allModels.filter((entry) => entry.provider.trim().toLowerCase() === row.provider);
  return (
    <>
      <tr className="border-b border-border font-medium">
        <td className="py-2 pr-3">{providerDisplayName(row.provider)}</td>
        <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{tokenTriple(row)}</td>
        <td className="py-2 pr-3 text-right tabular-nums">{formatCents(Math.round(row.actualApiSpendCents))}</td>
        <td className="py-2 pr-3 text-right tabular-nums">{formatCents(Math.round(row.subscriptionCostCents))}</td>
        <td className="py-2 text-right tabular-nums">
          {formatCents(Math.round(row.apiEquivalentCents))}
          {row.unpricedTokens > 0 ? <span className="text-xs text-muted-foreground"> + unknown</span> : null}
        </td>
      </tr>
      {models.map((model) => (
        <tr key={`${model.provider}/${model.model}`} className="border-b border-border/60 text-muted-foreground">
          <td className="py-1.5 pr-3 pl-4 font-mono text-xs">{model.model}</td>
          <td className="py-1.5 pr-3 text-right font-mono text-xs tabular-nums">{tokenTriple(model)}</td>
          <td className="py-1.5 pr-3 text-right tabular-nums">{formatCents(Math.round(model.actualApiSpendCents))}</td>
          <td className="py-1.5 pr-3 text-right" />
          <td className="py-1.5 text-right tabular-nums">
            {model.apiEquivalentCents === null ? "unknown" : formatCents(Math.round(model.apiEquivalentCents))}
          </td>
        </tr>
      ))}
    </>
  );
}
