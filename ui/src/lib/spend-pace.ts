import { formatCents, formatShortDate } from "./utils";

export interface MonthPace {
  /** Spend by the end of the month if the rest of the month goes like the days so far. */
  projectedCents: number;
  /** The day the budget runs out at this pace, when that is before month end. */
  overBudgetOn: Date | null;
}

/**
 * Month-end pace from spend so far: today counts as a full day. Nothing is
 * projected in the first two days, when one busy morning would mislead.
 */
export function monthPace(spentCents: number, budgetCents: number, now: Date = new Date()): MonthPace | null {
  const day = now.getDate();
  if (day < 3 || spentCents <= 0) return null;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const perDay = spentCents / day;
  const projectedCents = Math.round(perDay * daysInMonth);
  let overBudgetOn: Date | null = null;
  if (budgetCents > 0 && projectedCents > budgetCents && spentCents < budgetCents) {
    const dayReached = Math.ceil(budgetCents / perDay);
    if (dayReached <= daysInMonth) overBudgetOn = new Date(now.getFullYear(), now.getMonth(), dayReached);
  }
  return { projectedCents, overBudgetOn };
}

/** "On pace for $280.00 by month end" or "On pace to pass the budget around 24 Oct". */
export function monthPaceLine(pace: MonthPace | null): string | null {
  if (!pace) return null;
  if (pace.overBudgetOn) return `On pace to pass the budget around ${formatShortDate(pace.overBudgetOn)}`;
  return `On pace for ${formatCents(pace.projectedCents)} by month end`;
}

/**
 * The agent page's "This month" row: "$42.00 spent. On pace for $130.00 by
 * month end". Null before the agent has spent anything this month.
 */
export function agentMonthLine(
  agent: { spentMonthlyCents?: number | null; budgetMonthlyCents?: number | null },
  now: Date = new Date(),
): string | null {
  const spent = agent.spentMonthlyCents ?? 0;
  if (spent <= 0) return null;
  const paceLine = monthPaceLine(monthPace(spent, agent.budgetMonthlyCents ?? 0, now));
  return paceLine ? `${formatCents(spent)} spent. ${paceLine}` : `${formatCents(spent)} spent`;
}
