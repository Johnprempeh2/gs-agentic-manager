import type { CostByAgent, CostByProject, CostSummary } from "@greatstone/shared";
import { formatCents } from "./utils";
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

/**
 * "Copy as an update" on Costs: total spend against budget, then the top
 * agents and projects, ready to paste into a finance note.
 *
 *   Spend, month to date
 *   $123.45 of $500.00 budget (25%).
 *
 *   Top agents
 *   • Ridge: $80.00, 40 runs
 */
export function costsUpdateText(
  data: { summary: CostSummary; byAgent: readonly CostByAgent[]; byProject: readonly CostByProject[] },
  rangeLabel: string,
  top = 5,
): string {
  const { summary } = data;
  const lines = [
    `Spend, ${rangeLabel.toLowerCase()}`,
    summary.budgetCents > 0
      ? `${formatCents(summary.spendCents)} of ${formatCents(summary.budgetCents)} budget (${summary.utilizationPercent}%).`
      : `${formatCents(summary.spendCents)} spent.`,
  ];
  const agents = [...data.byAgent].filter((row) => row.costCents > 0).sort((a, b) => b.costCents - a.costCents).slice(0, top);
  if (agents.length > 0) {
    lines.push("", "Top agents");
    for (const row of agents) {
      const runs = row.apiRunCount + row.subscriptionRunCount;
      lines.push(`• ${row.agentName ?? "Unknown agent"}: ${formatCents(row.costCents)}, ${runs} ${runs === 1 ? "run" : "runs"}`);
    }
  }
  const projects = [...data.byProject].filter((row) => row.costCents > 0).sort((a, b) => b.costCents - a.costCents).slice(0, top);
  if (projects.length > 0) {
    lines.push("", "Top projects");
    for (const row of projects) lines.push(`• ${row.projectName ?? "No project"}: ${formatCents(row.costCents)}`);
  }
  return lines.join("\n");
}
