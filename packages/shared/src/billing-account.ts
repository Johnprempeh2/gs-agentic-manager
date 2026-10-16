// Billing account record of one client instance (GRE-1369, B2 on GRE-1357).
//
// One record per instance: plan, selected modules, fees, AI allowance, term,
// renewal, cancel state and an invoice list. The hosting operator (instance
// admin) sets it; everyone else, the client board included, reads it and gets
// 403 `settings_operator_managed` on writes. The client may only cancel.
//
// No price, allowance or retention value lives in this file. Every amount is a
// value the operator puts on the record. This file holds the module catalogue
// (names and boundaries, not prices) and the date rules.

import { z } from "zod";
import type { InstanceFeatureKey } from "./feature-catalog.js";

/**
 * The module catalogue version. A record names the version of its contract;
 * an all-inclusive plan covers the modules named on the record, never "every
 * module in this file", so a module added later does not join it (D2 rule 3).
 */
export const BILLING_CATALOGUE_VERSION = "packaging-v2-d2-2026-10-11";

export type BillingModuleKind = "module" | "add_on";

export interface BillingModuleEntry {
  title: string;
  kind: BillingModuleKind;
  /** Selectable parts of one sold area share a group (Website). */
  group?: string;
  description: string;
  /** Modules this one needs on the same record. */
  requires: readonly BillingModuleKey[];
  /** A scoped add-on: the record must say what the scope is. */
  needsScope: boolean;
  /** Feature switches sold under this module. A switch is sold under one module only. */
  features: readonly InstanceFeatureKey[];
}

/**
 * Packaging v2 (GRE-1086, deliverable v9), with John's D2 choices of
 * 11 Oct 2026 (GRE-1354):
 * 1. Board is a separate add-on that needs Strategy.
 * 2. Basic goals stay in the Foundation; the KPI cascade and readings are Strategy.
 * 3. All-inclusive covers the named catalogue of the contract version.
 * 4. CRM is the GSAM CRM plus a read-only connection; write-back, two-way sync
 *    and migration are each a separately scoped add-on.
 * 5. Pipelines and cases are in CRM.
 * 6. Development environments are sold once, under Software development.
 * The Foundation is always included (the service fee) and is not listed here.
 * Financial planning is parked and is not sold.
 */
export const BILLING_MODULES = {
  crm: {
    title: "CRM",
    kind: "module",
    description: "GSAM CRM (pipelines, cases, contacts, access levels, typed fields) and a read-only connection to the client's CRM.",
    requires: [],
    needsScope: false,
    features: ["enablePipelines", "enableCases"],
  },
  crm_write_back: {
    title: "CRM write-back",
    kind: "add_on",
    description: "Writes from GSAM into the client's CRM, with field ownership and a conflict queue.",
    requires: ["crm"],
    needsScope: true,
    features: [],
  },
  crm_two_way_sync: {
    title: "CRM two-way sync",
    kind: "add_on",
    description: "Two-way sync between GSAM and the client's CRM.",
    requires: ["crm"],
    needsScope: true,
    features: [],
  },
  crm_migration: {
    title: "CRM migration",
    kind: "add_on",
    description: "One-off migration of records from the client's CRM.",
    requires: ["crm"],
    needsScope: true,
    features: [],
  },
  website_analytics: {
    title: "Website analytics",
    kind: "module",
    group: "website",
    description: "Google Analytics 4 and Search Console view.",
    requires: [],
    needsScope: false,
    features: ["enableWebsiteView"],
  },
  website_seo: {
    title: "Website SEO",
    kind: "module",
    group: "website",
    description: "SEO and site-health monitoring.",
    requires: [],
    needsScope: false,
    features: [],
  },
  website_publishing: {
    title: "Website editing and publishing",
    kind: "module",
    group: "website",
    description: "Website editing and publishing. Development environments are sold under Software development.",
    requires: [],
    needsScope: false,
    features: [],
  },
  marketing: {
    title: "Marketing",
    kind: "module",
    description: "Marketing agent team, content calendar, publishing and performance review.",
    requires: [],
    needsScope: false,
    features: [],
  },
  booking: {
    title: "Booking",
    kind: "module",
    description: "External appointments and internal scheduling of people and agents.",
    requires: [],
    needsScope: false,
    features: [],
  },
  strategy: {
    title: "Strategy",
    kind: "module",
    description: "KPI cascade (vision to KPI) and KPI readings. Basic goals are in the Foundation.",
    requires: [],
    needsScope: false,
    features: [],
  },
  board: {
    title: "Board",
    kind: "add_on",
    description: "Board control panel, board pack and board users. Needs Strategy.",
    requires: ["strategy"],
    needsScope: false,
    features: ["enableStrategyBoard"],
  },
  advanced_knowledge: {
    title: "Advanced knowledge",
    kind: "module",
    description: "Memory stewardship, reviews, provenance and conflict checks.",
    requires: [],
    needsScope: false,
    features: [],
  },
  software_development: {
    title: "Software development",
    kind: "module",
    description: "Development environments: pull request status, environments, runner and previews.",
    requires: [],
    needsScope: false,
    features: ["enableExternalObjects", "enableEnvironments", "enableNativeRunner", "enableWorktreeRunExecution"],
  },
} as const satisfies Record<string, Omit<BillingModuleEntry, "requires"> & { requires: readonly string[] }>;

export type BillingModuleKey = keyof typeof BILLING_MODULES;
export const BILLING_MODULE_KEYS = Object.keys(BILLING_MODULES) as BillingModuleKey[];

export const BILLING_PLAN_KINDS = ["modules", "all_inclusive"] as const;
export type BillingPlanKind = (typeof BILLING_PLAN_KINDS)[number];

export const BILLING_TERM_KINDS = ["monthly", "annual"] as const;
export type BillingTermKind = (typeof BILLING_TERM_KINDS)[number];

/** What the operator does to the instance the day after a cancelled term ends (B9; John's policy). */
export const BILLING_END_ACTIONS = ["pause", "archive"] as const;
export type BillingEndAction = (typeof BILLING_END_ACTIONS)[number];

export const BILLING_INVOICE_STATUSES = ["issued", "paid", "overdue", "void"] as const;
export type BillingInvoiceStatus = (typeof BILLING_INVOICE_STATUSES)[number];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date (YYYY-MM-DD)")
  .refine((value) => toDayNumber(value) !== null, "must be a real date");
const cents = z.number().int().min(0).max(1_000_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/, "must be a three-letter currency code, e.g. GBP");

export const billingModuleSelectionSchema = z
  .object({
    key: z.enum(BILLING_MODULE_KEYS as [BillingModuleKey, ...BillingModuleKey[]]),
    /** Null: included in the plan fee. */
    feeCents: cents.nullable(),
    /** Required for a scoped add-on: what it covers. */
    scope: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type BillingModuleSelection = z.infer<typeof billingModuleSelectionSchema>;

/** The whole record, as the operator sets it. Cancel state is not part of it. */
export const upsertBillingAccountSchema = z
  .object({
    planKind: z.enum(BILLING_PLAN_KINDS),
    planName: z.string().trim().min(1).max(200).nullable().optional(),
    catalogueVersion: z.string().trim().min(1).max(100),
    currency,
    /** The Foundation and service fee for one term period. */
    serviceFeeCents: cents,
    modules: z.array(billingModuleSelectionSchema).max(BILLING_MODULE_KEYS.length),
    /**
     * AI allowance included in the fee, per calendar month, in API-equivalent
     * US cents whatever the account currency (GRE-1395). The client sees only
     * a percent of it.
     */
    allowanceMonthlyCents: cents,
    /** Monthly AI usage estimated at sign-up. Null or absent: no estimate was given. */
    estimateMonthlyCents: cents.nullable().optional(),
    /**
     * Account-currency units per US dollar, used to price extra usage past the
     * allowance. Null or absent: no rate (a USD account needs none).
     */
    usageFxRate: z.number().positive().max(1_000_000).nullable().optional(),
    /** The day the rate is from. Absent: the day it was last changed. */
    usageFxRateSetOn: isoDate.nullable().optional(),
    termKind: z.enum(BILLING_TERM_KINDS),
    termStartsOn: isoDate,
    autoRenew: z.boolean(),
    endAction: z.enum(BILLING_END_ACTIONS).nullable().optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const message of billingModuleProblems(value.planKind, value.modules)) {
      ctx.addIssue({ code: "custom", path: ["modules"], message });
    }
  });
export type UpsertBillingAccount = z.infer<typeof upsertBillingAccountSchema>;

/** One invoice line. A reference and a link only: no card or bank data is ever stored. */
export const recordBillingInvoiceSchema = z
  .object({
    reference: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/, "letters, digits and . _ / - only"),
    periodStart: isoDate,
    periodEnd: isoDate,
    amountCents: cents,
    currency,
    status: z.enum(BILLING_INVOICE_STATUSES),
    url: z.string().url().max(2000).refine((value) => value.startsWith("https://"), "must be an https link").nullable().optional(),
    issuedOn: isoDate,
  })
  .strict()
  .refine((value) => value.periodEnd >= value.periodStart, { path: ["periodEnd"], message: "must not be before periodStart" });
export type RecordBillingInvoice = z.infer<typeof recordBillingInvoiceSchema>;

export const cancelBillingAccountSchema = z
  .object({ reason: z.string().trim().min(1).max(1000).optional() })
  .strict();
export type CancelBillingAccount = z.infer<typeof cancelBillingAccountSchema>;

export const resumeBillingRenewalSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export type ResumeBillingRenewal = z.infer<typeof resumeBillingRenewalSchema>;

/**
 * Module boundary problems on a record, empty when it is fine: duplicates, a
 * module whose needed module is missing (Board without Strategy, a CRM add-on
 * without CRM), a scoped add-on with no scope, a scope on anything else, and
 * an all-inclusive plan that names no modules.
 */
export function billingModuleProblems(planKind: BillingPlanKind, modules: readonly BillingModuleSelection[]): string[] {
  const problems: string[] = [];
  const keys = new Set<BillingModuleKey>();
  for (const selection of modules) {
    if (keys.has(selection.key)) problems.push(`${selection.key} is listed more than once`);
    keys.add(selection.key);
  }
  for (const selection of modules) {
    const entry: BillingModuleEntry = BILLING_MODULES[selection.key];
    for (const needed of entry.requires) {
      if (!keys.has(needed)) problems.push(`${selection.key} needs ${needed}`);
    }
    if (entry.needsScope && !selection.scope) problems.push(`${selection.key} is a scoped add-on and needs a scope`);
    if (!entry.needsScope && selection.scope !== undefined) problems.push(`${selection.key} takes no scope`);
  }
  if (planKind === "all_inclusive" && modules.length === 0) {
    problems.push("an all-inclusive plan must name the modules of its contract catalogue");
  }
  return problems;
}

export interface BillingAccount {
  id: string;
  planKind: BillingPlanKind;
  planName: string | null;
  catalogueVersion: string;
  currency: string;
  serviceFeeCents: number;
  modules: BillingModuleSelection[];
  /** API-equivalent US cents per month. Operator only. */
  allowanceMonthlyCents: number;
  /** Monthly AI usage estimated at sign-up; null when none was given. */
  estimateMonthlyCents: number | null;
  /** Account-currency units per US dollar for extra usage; null when none is set. Operator only. */
  usageFxRate: number | null;
  usageFxRateSetOn: string | null;
  termKind: BillingTermKind;
  termStartsOn: string;
  autoRenew: boolean;
  endAction: BillingEndAction | null;
  /** Last day of access once renewal is stopped (cancel, or auto-renew off). Null while it renews. */
  accessEndsOn: string | null;
  cancelRequestedAt: string | null;
  cancelRequestedByUserId: string | null;
  cancelReason: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillingInvoice {
  id: string;
  reference: string;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  currency: string;
  status: BillingInvoiceStatus;
  url: string | null;
  issuedOn: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * - `scheduled`: the term has not started.
 * - `active`: renews on `renewsOn`.
 * - `not_renewing`: auto-renew is off; access until `accessEndsOn`.
 * - `cancel_pending`: cancelled; access until `accessEndsOn`, no renewal.
 * - `ended`: past `accessEndsOn`; the operator applies `endAction` (B9).
 */
export const BILLING_STATES = ["scheduled", "active", "not_renewing", "cancel_pending", "ended"] as const;
export type BillingState = (typeof BILLING_STATES)[number];

export interface BillingStatus {
  /** The UTC day the status is for. */
  today: string;
  state: BillingState;
  hasAccess: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  /** The next renewal date; null when renewal is stopped. */
  renewsOn: string | null;
  /** The last day of access when renewal is stopped. */
  accessEndsOn: string | null;
  endAction: BillingEndAction | null;
}

/** The record as the client sees it: no allowance amount and no exchange rate (GRE-1395). */
export type ClientBillingAccount = Omit<BillingAccount, "allowanceMonthlyCents" | "usageFxRate" | "usageFxRateSetOn">;

/**
 * Extra usage past the allowance, in the account currency.
 * - `none`: usage is within the allowance; `amountCents` is 0.
 * - `priced`: `amountCents` is the extra usage converted with the account's rate.
 * - `rate_missing`: there is extra usage, but the account is not in USD and
 *   has no rate, so no amount is shown (`amountCents` is null).
 */
export type BillingExtraUsageState = "none" | "priced" | "rate_missing";

export interface BillingExtraUsage {
  state: BillingExtraUsageState;
  amountCents: number | null;
  /** The account currency. */
  currency: string;
}

/** Operator view of extra usage: the US amount and the rate used. */
export interface OperatorBillingExtraUsage extends BillingExtraUsage {
  /** max(0, consumed - allowance), API-equivalent US cents. */
  usdCents: number;
  /** The rate applied: 1 for a USD account, else the account's rate; null when missing. */
  rate: number | null;
  rateSetOn: string | null;
}

/**
 * AI usage of the instance's company in the current UTC calendar month, as
 * the client sees it (GRE-1389, GRE-1395): a percent of the included
 * allowance, never money for it. Money shows only for extra usage, in the
 * account currency.
 */
export interface BillingUsage {
  /** First day of the month, YYYY-MM-DD. */
  windowStart: string;
  /** Last day of the month, YYYY-MM-DD. */
  windowEnd: string;
  /** Days in the window up to and including today. */
  daysElapsed: number;
  daysInWindow: number;
  /** consumed / allowance * 100, two decimals; 0 when the allowance is 0. May pass 100. */
  usedPercent: number;
  /** Straight-line month-end forecast as a percent of the allowance, two decimals. */
  forecastPercent: number;
  /** The warn level: the company budget policy's, else the budget default. */
  warnPercent: number;
  /** usedPercent >= warnPercent. The page, the Inbox card and the fleet check-in share this rule. */
  warning: boolean;
  extraUsage: BillingExtraUsage;
  /** The account's estimate at sign-up, in the account currency; null when none was given. */
  estimateCents: number | null;
  /** When the company was paused (ISO time); null while it runs. */
  pausedSince: string | null;
}

/** The operator's usage block: the client block plus the US-dollar amounts behind it. */
export interface OperatorBillingUsage extends BillingUsage {
  /** Sum of `cost_events.costCents` in the window: metered usage, US cents. */
  usedCents: number;
  /** Subscription-included usage priced at API rates, US cents. */
  apiEquivalentCents: number;
  /** usedCents + apiEquivalentCents: the API-equivalent usage measured against the allowance. */
  consumedCents: number;
  /** The monthly allowance, API-equivalent US cents. */
  allowanceCents: number;
  /** max(0, allowance - consumed). */
  remainingCents: number;
  /** Straight line: consumedCents / daysElapsed * daysInWindow, rounded. */
  forecastCents: number;
  extraUsage: OperatorBillingExtraUsage;
}

/** GET /api/instance/billing-account for a client board user. */
export interface BillingAccountView {
  audience: "client";
  account: ClientBillingAccount | null;
  status: BillingStatus | null;
  /** Null when there is no account. */
  usage: BillingUsage | null;
  /** Newest first. */
  invoices: BillingInvoice[];
}

/** GET /api/instance/billing-account for the hosting operator. */
export interface OperatorBillingAccountView {
  audience: "operator";
  account: BillingAccount | null;
  status: BillingStatus | null;
  usage: OperatorBillingUsage | null;
  invoices: BillingInvoice[];
}

// ---------------------------------------------------------------- date rules (UTC days)

const DAY_MS = 86_400_000;

function toDayNumber(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return ms / DAY_MS;
}

function fromDayNumber(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The UTC day of an instant, "YYYY-MM-DD". */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const day = toDayNumber(date);
  if (day === null) throw new Error(`not a date: ${date}`);
  return fromDayNumber(day + days);
}

/** Add whole months to the term anchor; a day past the month's end becomes its last day (31 Jan + 1 month = 28 or 29 Feb). */
export function addMonthsClamped(date: string, months: number): string {
  if (toDayNumber(date) === null) throw new Error(`not a date: ${date}`);
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = index - targetYear * 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return fromDayNumber(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)) / DAY_MS);
}

function periodMonths(termKind: BillingTermKind): number {
  return termKind === "annual" ? 12 : 1;
}

/**
 * The term period that holds `today`: periods start on the term anchor and
 * every 1 or 12 months after it. Null before the term starts.
 */
export function billingPeriodOn(
  termKind: BillingTermKind,
  termStartsOn: string,
  today: string,
): { start: string; end: string; nextStart: string } | null {
  if (today < termStartsOn) return null;
  const months = periodMonths(termKind);
  const [startYear, startMonth] = termStartsOn.split("-").map(Number) as [number, number];
  const [todayYear, todayMonth] = today.split("-").map(Number) as [number, number];
  let index = Math.max(0, Math.floor(((todayYear - startYear) * 12 + (todayMonth - startMonth)) / months));
  // The estimate can be one period late (the anchor day not reached yet this month).
  while (index > 0 && addMonthsClamped(termStartsOn, index * months) > today) index -= 1;
  while (addMonthsClamped(termStartsOn, (index + 1) * months) <= today) index += 1;
  const start = addMonthsClamped(termStartsOn, index * months);
  const nextStart = addMonthsClamped(termStartsOn, (index + 1) * months);
  return { start, end: addDays(nextStart, -1), nextStart };
}

/** The date check: what the record means on `today`. */
export function billingStatusOn(
  account: Pick<BillingAccount, "termKind" | "termStartsOn" | "accessEndsOn" | "cancelRequestedAt" | "endAction">,
  today: string,
): BillingStatus {
  const period = billingPeriodOn(account.termKind, account.termStartsOn, today);
  const base = {
    today,
    currentPeriodStart: period?.start ?? null,
    currentPeriodEnd: period?.end ?? null,
    endAction: account.endAction,
  };
  if (account.accessEndsOn !== null) {
    if (today > account.accessEndsOn) {
      return { ...base, state: "ended", hasAccess: false, renewsOn: null, accessEndsOn: account.accessEndsOn };
    }
    return {
      ...base,
      state: account.cancelRequestedAt ? "cancel_pending" : "not_renewing",
      hasAccess: period !== null,
      renewsOn: null,
      accessEndsOn: account.accessEndsOn,
    };
  }
  if (!period) {
    return { ...base, state: "scheduled", hasAccess: false, renewsOn: account.termStartsOn, accessEndsOn: null };
  }
  return { ...base, state: "active", hasAccess: true, renewsOn: period.nextStart, accessEndsOn: null };
}

/**
 * The last day of access when renewal stops on `today`: the end of the paid
 * period that holds today. Before the term starts nothing is paid, so access
 * ends the day before it starts.
 */
export function accessEndWhenRenewalStops(termKind: BillingTermKind, termStartsOn: string, today: string): string {
  const period = billingPeriodOn(termKind, termStartsOn, today);
  return period ? period.end : addDays(termStartsOn, -1);
}

// ---------------------------------------------------------------- usage (UTC calendar month)

/** The UTC calendar month that holds `now`, as dates and as the instants [start, end). */
export function billingUsageWindowOn(now: Date) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const daysInWindow = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return {
    windowStart: utcDay(start),
    windowEnd: addDays(utcDay(end), -1),
    start,
    end,
    daysElapsed: now.getUTCDate(),
    daysInWindow,
  };
}

/**
 * The one warn rule (AT-1.4): usage is at or over the warn level of the
 * allowance. Both are API-equivalent US cents, so the rule holds for every
 * account currency (GRE-1395). Whole-number arithmetic, so 80% of 25 000 is
 * exactly 20 000. No allowance means nothing to warn about.
 */
export function billingUsageWarning(consumedCents: number, allowanceCents: number, warnPercent: number): boolean {
  return allowanceCents > 0 && consumedCents * 100 >= allowanceCents * warnPercent;
}

function percentOf(valueCents: number, allowanceCents: number): number {
  return allowanceCents > 0 ? Number(((valueCents / allowanceCents) * 100).toFixed(2)) : 0;
}

/**
 * Extra usage past the allowance in the account currency. A USD account
 * converts at 1; any other needs the operator's rate, else no amount is shown.
 */
export function billingExtraUsage(
  extraUsdCents: number,
  account: Pick<BillingAccount, "currency" | "usageFxRate" | "usageFxRateSetOn">,
): OperatorBillingExtraUsage {
  const isUsd = account.currency === "USD";
  const rate = isUsd ? 1 : account.usageFxRate;
  const rateSetOn = isUsd ? null : account.usageFxRateSetOn;
  const base = { currency: account.currency, usdCents: extraUsdCents, rate, rateSetOn };
  if (extraUsdCents <= 0) return { ...base, state: "none", amountCents: 0 };
  if (rate === null) return { ...base, state: "rate_missing", amountCents: null };
  return { ...base, state: "priced", amountCents: Math.round(extraUsdCents * rate) };
}

/** The operator's usage block from the window, the sums and the record. */
export function billingUsageOn(
  now: Date,
  input: {
    usedCents: number;
    apiEquivalentCents: number;
    warnPercent: number;
    pausedSince: string | null;
    account: Pick<BillingAccount, "allowanceMonthlyCents" | "estimateMonthlyCents" | "currency" | "usageFxRate" | "usageFxRateSetOn">;
  },
): OperatorBillingUsage {
  const window = billingUsageWindowOn(now);
  const { usedCents, apiEquivalentCents, warnPercent, account } = input;
  const allowanceCents = account.allowanceMonthlyCents;
  const consumedCents = usedCents + apiEquivalentCents;
  const forecastCents = Math.round((consumedCents / window.daysElapsed) * window.daysInWindow);
  return {
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    daysElapsed: window.daysElapsed,
    daysInWindow: window.daysInWindow,
    usedPercent: percentOf(consumedCents, allowanceCents),
    forecastPercent: percentOf(forecastCents, allowanceCents),
    warnPercent,
    warning: billingUsageWarning(consumedCents, allowanceCents, warnPercent),
    extraUsage: billingExtraUsage(Math.max(0, consumedCents - allowanceCents), account),
    estimateCents: account.estimateMonthlyCents,
    pausedSince: input.pausedSince,
    usedCents,
    apiEquivalentCents,
    consumedCents,
    allowanceCents,
    remainingCents: Math.max(0, allowanceCents - consumedCents),
    forecastCents,
  };
}

// ---------------------------------------------------------------- client view (GRE-1395)
// Built field by field, never by spreading the operator object, so a field
// added to the operator view stays out of the client's until named here.

export function clientBillingUsage(usage: OperatorBillingUsage): BillingUsage {
  return {
    windowStart: usage.windowStart,
    windowEnd: usage.windowEnd,
    daysElapsed: usage.daysElapsed,
    daysInWindow: usage.daysInWindow,
    usedPercent: usage.usedPercent,
    forecastPercent: usage.forecastPercent,
    warnPercent: usage.warnPercent,
    warning: usage.warning,
    extraUsage: {
      state: usage.extraUsage.state,
      amountCents: usage.extraUsage.amountCents,
      currency: usage.extraUsage.currency,
    },
    estimateCents: usage.estimateCents,
    pausedSince: usage.pausedSince,
  };
}

export function clientBillingAccount(account: BillingAccount): ClientBillingAccount {
  return {
    id: account.id,
    planKind: account.planKind,
    planName: account.planName,
    catalogueVersion: account.catalogueVersion,
    currency: account.currency,
    serviceFeeCents: account.serviceFeeCents,
    modules: account.modules,
    estimateMonthlyCents: account.estimateMonthlyCents,
    termKind: account.termKind,
    termStartsOn: account.termStartsOn,
    autoRenew: account.autoRenew,
    endAction: account.endAction,
    accessEndsOn: account.accessEndsOn,
    cancelRequestedAt: account.cancelRequestedAt,
    cancelRequestedByUserId: account.cancelRequestedByUserId,
    cancelReason: account.cancelReason,
    updatedByUserId: account.updatedByUserId,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export function clientBillingAccountView(view: OperatorBillingAccountView): BillingAccountView {
  return {
    audience: "client",
    account: view.account ? clientBillingAccount(view.account) : null,
    status: view.status,
    usage: view.usage ? clientBillingUsage(view.usage) : null,
    invoices: view.invoices,
  };
}
