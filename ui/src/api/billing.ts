import type { BillingAccountView } from "@greatstone/shared/billing-account";
import { api } from "./client";

/**
 * This month's AI usage against the allowance (GRE-1370, B1). The server
 * computes every number (GRE-1389); the page only shows them. Window is the
 * current UTC calendar month.
 */
export interface BillingUsage {
  windowStart: string;
  windowEnd: string;
  daysElapsed: number;
  daysInWindow: number;
  /** Sum of `cost_events.costCents` in the window: the charged usage. */
  usedCents: number;
  /** Subscription-included usage at API prices: shown, not charged. */
  apiEquivalentCents: number;
  allowanceCents: number;
  remainingCents: number;
  usedPercent: number;
  /** The warn level setting. */
  warnPercent: number;
  warning: boolean;
  /** Straight-line forecast to the end of the window. */
  forecastCents: number;
  /** Estimated at sign-up; null when the operator set none. */
  estimateCents: number | null;
  /** ISO time the company was paused, else null. */
  pausedSince: string | null;
}

/** `usage` is absent on a server that does not send it yet. */
export type ClientBillingView = BillingAccountView & { usage?: BillingUsage | null };

export const billingApi = {
  /** Every board user may read; writes are operator-only (403 `settings_operator_managed`). */
  get: () => api.get<ClientBillingView>("/instance/billing-account"),
};
