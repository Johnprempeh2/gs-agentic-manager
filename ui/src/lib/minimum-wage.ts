import { agentWorkHours } from "@greatstone/shared";

/** Agent run time as hours with one decimal, e.g. "12.5 h". */
export function formatAgentHours(workMs: number): string {
  const hours = agentWorkHours(workMs);
  return `${hours.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}

/** Cents as a plain amount for an input box, e.g. 1250 -> "12.50". Empty when unset. */
export function hourlyRateInputValue(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

/**
 * Reads the hourly rate typed in settings. Empty clears the rate (null);
 * anything that is not a non-negative amount is "invalid".
 */
export function parseHourlyRateInput(text: string): number | null | "invalid" {
  const trimmed = text.trim().replace(/,/g, "");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return "invalid";
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isSafeInteger(cents) && cents <= 100_000_000 ? cents : "invalid";
}
