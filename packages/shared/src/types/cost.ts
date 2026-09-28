import type { AgentAppearance } from "../agent-appearance.js";
import type { BillingType, CostStatus } from "../constants.js";

export interface CostEvent {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  heartbeatRunId: string | null;
  billingCode: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  costStatus: CostStatus;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: Date;
  createdAt: Date;
}

export interface CostSummary {
  companyId: string;
  spendCents: number;
  budgetCents: number;
  utilizationPercent: number;
}

export interface IssueCostSummary {
  issueId: string;
  issueCount: number;
  includeDescendants: boolean;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** number of distinct heartbeat runs aggregated across the issue tree */
  runCount: number;
  /** sum of wall-clock duration of each run in the tree (ms);
   * still-running runs contribute (now - startedAt) so this ticks up live */
  runtimeMs: number;
}

export interface CostByAgent {
  agentId: string;
  agentName: string | null;
  agentAppearance?: AgentAppearance | null;
  avatarUrl?: string;
  agentStatus: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByProviderModel {
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByBiller {
  biller: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
  providerCount: number;
  modelCount: number;
}

/** per-agent breakdown by provider + model, for identifying token-hungry agents */
export interface CostByAgentModel {
  agentId: string;
  agentName: string | null;
  agentAppearance?: AgentAppearance | null;
  avatarUrl?: string;
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** spend per provider for a fixed rolling time window */
export interface CostWindowSpendRow {
  provider: string;
  biller: string;
  /** duration label, e.g. "5h", "24h", "7d" */
  window: string;
  /** rolling window duration in hours */
  windowHours: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** cost attributed to a project via heartbeat run → activity log → issue → project chain */
export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** a model subscription the company pays a flat monthly price for */
export interface CompanySubscription {
  id: string;
  companyId: string;
  provider: string;
  plan: string;
  monthlyPriceCents: number;
  createdAt: Date;
  updatedAt: Date;
}

/** a provider seen on subscription-billed runs that has no saved subscription yet */
export interface DetectedSubscriptionProvider {
  provider: string;
  biller: string;
  lastSeenAt: Date;
}

export interface CompanySubscriptionsResult {
  subscriptions: CompanySubscription[];
  detected: DetectedSubscriptionProvider[];
}

/** token usage and cost for one provider + model, priced as if billed by the API */
export interface ApiEquivalentModelRow {
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  subscriptionTokens: number;
  /** what the ledger says was actually billed per token (metered API, overage) */
  actualApiSpendCents: number;
  /** null when the model has no published price in the price table */
  apiEquivalentCents: number | null;
}

export interface ApiEquivalentProviderRow {
  provider: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  actualApiSpendCents: number;
  subscriptionCostCents: number;
  /** priced models only; unpricedTokens counts the rest */
  apiEquivalentCents: number;
  unpricedTokens: number;
}

export interface ApiEquivalentSummary {
  companyId: string;
  from: string;
  to: string;
  priceTableCheckedAt: string;
  actualApiSpendCents: number;
  /** subscription monthly prices prorated by day over the period */
  subscriptionCostCents: number;
  /** actual API spend + subscription cost */
  paidCents: number;
  /** what all token usage would cost under API billing (priced models only) */
  apiEquivalentCents: number;
  /** apiEquivalentCents - paidCents; positive means subscriptions saved money */
  savingCents: number;
  totalTokens: number;
  unpricedTokens: number;
  unpricedModels: string[];
  byProvider: ApiEquivalentProviderRow[];
  byModel: ApiEquivalentModelRow[];
}

/**
 * How a ledger amount was produced: `billed` is the cost the run recorded;
 * `api_equivalent` is a seat-plan run priced at published API rates.
 */
export type CostLedgerBasis = "billed" | "api_equivalent";

/** one agent + provider + tool + model + billing type, for one month */
export interface CostLedgerLine {
  agentId: string;
  agentName: string | null;
  provider: string;
  biller: string;
  /** the agent's adapter type (claude_local, codex_local, ...) */
  tool: string;
  model: string;
  billingType: string;
  /** true for subscription (seat-plan) runs */
  seatPlan: boolean;
  basis: CostLedgerBasis;
  runCount: number;
  eventCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** sum of cost_events.cost_cents as recorded */
  billedCents: number;
  /** null when the model has no published price in the price table */
  apiEquivalentCents: number | null;
  /** billedCents for billed lines, apiEquivalentCents for seat-plan lines (0 when unpriced) */
  ledgerCents: number;
  /** tokens on seat-plan lines whose model has no published price */
  unpricedTokens: number;
}

export interface CostLedgerTotal {
  key: string;
  label: string | null;
  runCount: number;
  eventCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  billedCents: number;
  /** priced lines only */
  apiEquivalentCents: number;
  /** ledger amount from billed lines */
  billedLedgerCents: number;
  /** ledger amount from seat-plan lines priced at API rates */
  apiEquivalentLedgerCents: number;
  ledgerCents: number;
  unpricedTokens: number;
}

export interface CostLedger {
  companyId: string;
  /** YYYY-MM, UTC */
  month: string;
  from: string;
  /** exclusive */
  to: string;
  priceTableCheckedAt: string;
  lines: CostLedgerLine[];
  byAgent: CostLedgerTotal[];
  byProvider: CostLedgerTotal[];
  byTool: CostLedgerTotal[];
  totals: CostLedgerTotal;
}
