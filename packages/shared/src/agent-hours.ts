const MS_PER_HOUR = 60 * 60 * 1000;

/** Agent run time in hours. Negative or non-finite input counts as no time. */
export function agentWorkHours(workMs: number): number {
  if (!Number.isFinite(workMs) || workMs <= 0) return 0;
  return workMs / MS_PER_HOUR;
}

/**
 * What the agents' hours would cost at the company's hourly wage, in cents.
 * Null when the company has not set a rate, so the UI can ask for one
 * instead of showing a made-up number.
 */
export function minimumWageEquivalentCents(workMs: number, hourlyRateCents: number | null | undefined): number | null {
  if (hourlyRateCents == null || !Number.isFinite(hourlyRateCents) || hourlyRateCents < 0) return null;
  return Math.round(agentWorkHours(workMs) * hourlyRateCents);
}
