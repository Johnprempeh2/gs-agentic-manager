import type { CostByAgent, CostByProject } from "@greatstone/shared";
import type { Sheet } from "./spreadsheet-export";

/**
 * "Download as spreadsheet" on Costs: spend by agent and by project for the
 * range on screen, as a two-tab Excel workbook. Amounts are in dollars, as on
 * the page.
 */

const dollars = (cents: number) => Math.round(cents) / 100;

export function costsByAgentSheet(rows: readonly CostByAgent[]): Sheet {
  return {
    name: "By agent",
    headers: ["Agent", "Spend ($)", "Runs", "Input tokens", "Cached input tokens", "Output tokens"],
    rows: [...rows]
      .sort((a, b) => b.costCents - a.costCents)
      .map((row) => [
        row.agentName ?? "Unknown agent",
        dollars(row.costCents),
        row.apiRunCount + row.subscriptionRunCount,
        row.inputTokens + row.subscriptionInputTokens,
        row.cachedInputTokens + row.subscriptionCachedInputTokens,
        row.outputTokens + row.subscriptionOutputTokens,
      ]),
  };
}

export function costsByProjectSheet(rows: readonly CostByProject[]): Sheet {
  return {
    name: "By project",
    headers: ["Project", "Spend ($)", "Input tokens", "Cached input tokens", "Output tokens"],
    rows: [...rows]
      .sort((a, b) => b.costCents - a.costCents)
      .map((row) => [
        row.projectId ? (row.projectName ?? "Unknown project") : "No project",
        dollars(row.costCents),
        row.inputTokens,
        row.cachedInputTokens,
        row.outputTokens,
      ]),
  };
}

/** "gre-costs-2026-10-01-to-2026-10-16.xlsx", or "gre-costs-all-time-2026-10-16.xlsx" with no range. */
export function costsFileName(prefix: string | null | undefined, from: string | undefined, to: string | undefined, today: string) {
  const slug = (prefix ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const day = (value: string | undefined) => (value ? value.slice(0, 10) : null);
  const range = day(from) ? `${day(from)}-to-${day(to) ?? today}` : `all-time-${today}`;
  return `${slug ? `${slug}-` : ""}costs-${range}.xlsx`;
}
