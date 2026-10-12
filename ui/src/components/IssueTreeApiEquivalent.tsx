import type { IssueCostSummary } from "@greatstone/shared";
import { formatCents, formatTokens } from "../lib/utils";

/**
 * What an issue tree's tokens would cost under API billing, with the split
 * per model. Labelled "API-equivalent" so nobody reads it as a bill.
 */
export function IssueTreeApiEquivalent({ summary }: { summary: IssueCostSummary }) {
  const models = (summary.byModel ?? []).filter(
    (row) => row.inputTokens + row.cachedInputTokens + row.outputTokens > 0,
  );
  if (models.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-3"
      title="What these tokens would cost at published API prices. Not a bill: real spend is shown above."
    >
      <span className="font-medium text-foreground">
        API-equivalent {formatCents(Math.round(summary.apiEquivalentCents ?? 0))}
      </span>
      {models.map((row) => (
        <span key={`${row.provider}/${row.model}`}>
          {row.model}{" "}
          {row.apiEquivalentCents === null ? "unpriced" : formatCents(Math.round(row.apiEquivalentCents))}
          {` (${formatTokens(row.inputTokens + row.cachedInputTokens + row.outputTokens)} tokens)`}
        </span>
      ))}
      {summary.unpricedTokens > 0 ? (
        <span>{formatTokens(summary.unpricedTokens)} tokens on unpriced models not included</span>
      ) : null}
    </div>
  );
}
