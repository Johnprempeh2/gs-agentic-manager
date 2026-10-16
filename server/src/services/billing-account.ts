import { and, asc, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { billingAccounts, billingInvoices, budgetPolicies, companies, costEvents } from "@greatstone/db";
import { computeApiEquivalentCents, DEFAULT_BUDGET_WARN_PERCENT } from "@greatstone/shared";
import { logActivity } from "./activity-log.js";
import { appliedTopUpCents } from "./budgets.js";
import {
  accessEndWhenRenewalStops,
  billingStatusOn,
  billingUsageOn,
  billingUsageWindowOn,
  utcDay,
  type BillingAccount,
  type BillingEndAction,
  type BillingInvoice,
  type BillingInvoiceStatus,
  type BillingModuleSelection,
  type BillingPlanKind,
  type BillingTermKind,
  type OperatorBillingAccountView,
  type OperatorBillingUsage,
  type RecordBillingInvoice,
  type UpsertBillingAccount,
} from "@greatstone/shared/billing-account";

/**
 * Billing account of this instance (GRE-1369). One row, set by the hosting
 * operator. The record holds the values; the status is a date check on it,
 * so "cancel keeps paid-period access" needs no timer: access is true while
 * today is on or before `accessEndsOn`.
 */
const SINGLETON_KEY = "default";

type AccountRow = typeof billingAccounts.$inferSelect;
type InvoiceRow = typeof billingInvoices.$inferSelect;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toAccount(row: AccountRow): BillingAccount {
  return {
    id: row.id,
    planKind: row.planKind as BillingPlanKind,
    planName: row.planName ?? null,
    catalogueVersion: row.catalogueVersion,
    currency: row.currency,
    serviceFeeCents: row.serviceFeeCents,
    modules: (row.modules ?? []) as BillingModuleSelection[],
    allowanceMonthlyCents: row.allowanceMonthlyCents,
    estimateMonthlyCents: row.estimateMonthlyCents ?? null,
    usageFxRate: row.usageFxRate ?? null,
    usageFxRateSetOn: row.usageFxRateSetOn ?? null,
    termKind: row.termKind as BillingTermKind,
    termStartsOn: row.termStartsOn,
    autoRenew: row.autoRenew,
    endAction: (row.endAction ?? null) as BillingEndAction | null,
    accessEndsOn: row.accessEndsOn ?? null,
    cancelRequestedAt: iso(row.cancelRequestedAt),
    cancelRequestedByUserId: row.cancelRequestedByUserId ?? null,
    cancelReason: row.cancelReason ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toInvoice(row: InvoiceRow): BillingInvoice {
  return {
    id: row.id,
    reference: row.reference,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status as BillingInvoiceStatus,
    url: row.url ?? null,
    issuedOn: row.issuedOn,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type BillingCancelResult =
  | { outcome: "cancelled"; before: BillingAccount; account: BillingAccount }
  | { outcome: "already_cancelled"; account: BillingAccount }
  | { outcome: "no_account" };

/** An allowance warning that is live now: the window crossed the warn level and usage is still over it. */
export interface BillingUsageWarningCard {
  account: BillingAccount;
  usage: OperatorBillingUsage;
  warnedAt: Date;
}

export function billingAccountService(db: Db) {
  /**
   * The company the account bills. A client instance has one company; on an
   * instance with more, the first one made is the client's.
   */
  async function instanceCompany() {
    return db
      .select({ id: companies.id, status: companies.status, pausedAt: companies.pausedAt })
      .from(companies)
      .orderBy(asc(companies.createdAt), asc(companies.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  /** The warn level setting: the company budget policy's, else the budget default. */
  async function warnPercentFor(companyId: string): Promise<number> {
    const policy = await db
      .select({ warnPercent: budgetPolicies.warnPercent })
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, "company"),
          eq(budgetPolicies.scopeId, companyId),
          eq(budgetPolicies.metric, "billed_cents"),
          eq(budgetPolicies.windowKind, "calendar_month_utc"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return policy?.warnPercent ?? DEFAULT_BUDGET_WARN_PERCENT;
  }

  /**
   * Used (charged) cents and the API-price equivalent of subscription-included
   * usage, in [start, end). Subscription-included events record no charge, so
   * they add to the equivalent only.
   */
  async function usageSums(companyId: string, start: Date, end: Date) {
    const inWindow = and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end));
    const [used] = await db
      .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision` })
      .from(costEvents)
      .where(inWindow);
    // Pricing is linear in tokens, so pricing each model's total equals the sum per event.
    const included = await db
      .select({
        provider: costEvents.provider,
        model: costEvents.model,
        inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`,
        cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`,
        outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
      })
      .from(costEvents)
      .where(and(inWindow, eq(costEvents.billingType, "subscription_included")))
      .groupBy(costEvents.provider, costEvents.model);
    const apiEquivalent = included.reduce(
      (sum, row) =>
        sum +
        (computeApiEquivalentCents({
          provider: row.provider,
          model: row.model,
          inputTokens: Number(row.inputTokens),
          cachedInputTokens: Number(row.cachedInputTokens),
          outputTokens: Number(row.outputTokens),
        }) ?? 0),
      0,
    );
    return { usedCents: Number(used?.total ?? 0), apiEquivalentCents: Math.round(apiEquivalent) };
  }

  /**
   * The usage block for the window that holds `now`. Null with no account or
   * no company. The month's applied top-ups add to its allowance (GRE-1371).
   */
  async function usageFor(account: BillingAccount, now: Date) {
    const company = await instanceCompany();
    if (!company) return null;
    const window = billingUsageWindowOn(now);
    const [sums, warnPercent, topUpCents] = await Promise.all([
      usageSums(company.id, window.start, window.end),
      warnPercentFor(company.id),
      appliedTopUpCents(db, company.id, now),
    ]);
    const usage = billingUsageOn(now, {
      ...sums,
      warnPercent,
      account: { ...account, allowanceMonthlyCents: account.allowanceMonthlyCents + topUpCents },
      pausedSince: company.status === "paused" && company.pausedAt ? company.pausedAt.toISOString() : null,
    });
    return { companyId: company.id, usage };
  }

  async function getRow(): Promise<AccountRow | null> {
    return db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.singletonKey, SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
  }

  async function get(): Promise<BillingAccount | null> {
    const row = await getRow();
    return row ? toAccount(row) : null;
  }

  async function listInvoices(): Promise<BillingInvoice[]> {
    const rows = await db
      .select()
      .from(billingInvoices)
      .orderBy(desc(billingInvoices.issuedOn), desc(billingInvoices.periodStart), desc(billingInvoices.createdAt));
    return rows.map(toInvoice);
  }

  return {
    get,
    listInvoices,

    /** The operator's view. Clients get `clientBillingAccountView` of it (GRE-1395). */
    async view(now: Date): Promise<OperatorBillingAccountView> {
      const [account, invoices] = await Promise.all([get(), listInvoices()]);
      const usage = account ? ((await usageFor(account, now))?.usage ?? null) : null;
      return { audience: "operator", account, status: account ? billingStatusOn(account, utcDay(now)) : null, usage, invoices };
    },

    /**
     * AT-1.4: record that usage in the window holding `at` crossed the warn
     * level. One guarded update moves the mark forward only, so a repeat, a
     * race, a second crossing in the same window or a late event for an older
     * window makes no second mark. Returns the usage when this call made the mark.
     */
    async noteUsageWarning(at: Date): Promise<{ companyId: string; usage: OperatorBillingUsage } | null> {
      const account = await get();
      if (!account) return null;
      const found = await usageFor(account, at);
      if (!found?.usage.warning) return null;
      const windowStart = found.usage.windowStart;
      const [marked] = await db
        .update(billingAccounts)
        .set({ usageWarnedWindowStart: windowStart, usageWarnedAt: at })
        .where(
          and(
            eq(billingAccounts.id, account.id),
            or(isNull(billingAccounts.usageWarnedWindowStart), lt(billingAccounts.usageWarnedWindowStart, windowStart)),
          ),
        )
        .returning({ id: billingAccounts.id });
      return marked ? found : null;
    },

    /**
     * The Inbox card for `companyId`: the current window was marked and usage
     * is still at or over the warn level. Its time is the mark's, so a
     * dismissed card stays dismissed for the rest of the window.
     */
    async usageWarningCard(companyId: string, now: Date): Promise<BillingUsageWarningCard | null> {
      const row = await getRow();
      if (!row?.usageWarnedAt) return null;
      const account = toAccount(row);
      const found = await usageFor(account, now);
      if (!found || found.companyId !== companyId || !found.usage.warning) return null;
      if (row.usageWarnedWindowStart !== found.usage.windowStart) return null;
      return { account, usage: found.usage, warnedAt: row.usageWarnedAt };
    },

    /**
     * The operator sets the whole record. Turning auto-renew off stops renewal
     * at the end of the paid period that holds today; turning it on again
     * clears that, unless the client has cancelled (only `resumeRenewal` lifts
     * a cancel). Cancel fields are never written here.
     */
    async upsert(input: UpsertBillingAccount, actorUserId: string | null, now: Date) {
      const before = await getRow();
      const today = utcDay(now);
      const cancelled = before?.cancelRequestedAt != null;
      const autoRenew = cancelled ? false : input.autoRenew;
      let accessEndsOn: string | null = null;
      if (!autoRenew) {
        accessEndsOn = before?.accessEndsOn ?? accessEndWhenRenewalStops(input.termKind, input.termStartsOn, today);
      }
      // The rate's day: as sent, else kept while the rate is unchanged, else today.
      const usageFxRate = input.usageFxRate ?? null;
      const usageFxRateSetOn =
        usageFxRate === null
          ? null
          : (input.usageFxRateSetOn ?? (before?.usageFxRate === usageFxRate ? before.usageFxRateSetOn : null) ?? today);
      const values = {
        planKind: input.planKind,
        planName: input.planName ?? null,
        catalogueVersion: input.catalogueVersion,
        currency: input.currency,
        serviceFeeCents: input.serviceFeeCents,
        modules: input.modules,
        allowanceMonthlyCents: input.allowanceMonthlyCents,
        estimateMonthlyCents: input.estimateMonthlyCents ?? null,
        usageFxRate,
        usageFxRateSetOn,
        termKind: input.termKind,
        termStartsOn: input.termStartsOn,
        autoRenew,
        endAction: input.endAction ?? null,
        accessEndsOn,
        updatedByUserId: actorUserId,
        updatedAt: now,
      };
      const [row] = await db
        .insert(billingAccounts)
        .values({ singletonKey: SINGLETON_KEY, ...values })
        .onConflictDoUpdate({ target: billingAccounts.singletonKey, set: values })
        .returning();
      return { before: before ? toAccount(before) : null, account: toAccount(row!) };
    },

    /** Add or correct one invoice line, keyed by its reference; sending it again changes nothing else. */
    async recordInvoice(input: RecordBillingInvoice, now: Date) {
      const before = await db
        .select()
        .from(billingInvoices)
        .where(eq(billingInvoices.reference, input.reference))
        .then((rows) => rows[0] ?? null);
      const values = {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        amountCents: input.amountCents,
        currency: input.currency,
        status: input.status,
        url: input.url ?? null,
        issuedOn: input.issuedOn,
        updatedAt: now,
      };
      const [row] = await db
        .insert(billingInvoices)
        .values({ reference: input.reference, ...values })
        .onConflictDoUpdate({ target: billingInvoices.reference, set: values })
        .returning();
      return { before: before ? toInvoice(before) : null, invoice: toInvoice(row!) };
    },

    /**
     * Cancel: stop the next renewal and keep access to the end of the paid
     * period that holds today. One guarded update, so a repeat or a race keeps
     * the first cancel and its date. Creates no refund or finance row.
     */
    async cancel(actorUserId: string | null, reason: string | null, now: Date): Promise<BillingCancelResult> {
      const row = await getRow();
      if (!row) return { outcome: "no_account" };
      if (row.cancelRequestedAt) return { outcome: "already_cancelled", account: toAccount(row) };
      const accessEndsOn =
        row.accessEndsOn ?? accessEndWhenRenewalStops(row.termKind as BillingTermKind, row.termStartsOn, utcDay(now));
      const [updated] = await db
        .update(billingAccounts)
        .set({
          autoRenew: false,
          accessEndsOn,
          cancelRequestedAt: now,
          cancelRequestedByUserId: actorUserId,
          cancelReason: reason,
          updatedAt: now,
        })
        .where(and(eq(billingAccounts.id, row.id), isNull(billingAccounts.cancelRequestedAt)))
        .returning();
      if (!updated) {
        const current = await getRow();
        return { outcome: "already_cancelled", account: toAccount(current!) };
      }
      return { outcome: "cancelled", before: toAccount(row), account: toAccount(updated) };
    },

    /** Operator only: lift a cancel or a stopped renewal; the record renews again. */
    async resumeRenewal(actorUserId: string | null, now: Date) {
      const row = await getRow();
      if (!row) return null;
      const [updated] = await db
        .update(billingAccounts)
        .set({
          autoRenew: true,
          accessEndsOn: null,
          cancelRequestedAt: null,
          cancelRequestedByUserId: null,
          cancelReason: null,
          updatedByUserId: actorUserId,
          updatedAt: now,
        })
        .where(eq(billingAccounts.id, row.id))
        .returning();
      return { before: toAccount(row), account: toAccount(updated!) };
    },
  };
}

/**
 * After usage can have grown (a cost event) or the allowance changed (the
 * operator's record): mark the first warn crossing of the window and log it
 * once. The Inbox card and the fleet check-in read the same rule.
 */
export async function noteBillingUsageWarning(db: Db, at: Date) {
  const crossed = await billingAccountService(db).noteUsageWarning(at);
  if (!crossed) return null;
  const { usage } = crossed;
  await logActivity(db, {
    companyId: crossed.companyId,
    actorType: "system",
    actorId: "billing_usage",
    action: "billing.usage_warning",
    entityType: "billing_account",
    entityId: usage.windowStart,
    // Company members can read the activity log: a percent only, no money (GRE-1395).
    details: {
      windowStart: usage.windowStart,
      usedPercent: usage.usedPercent,
      warnPercent: usage.warnPercent,
    },
  });
  return crossed;
}
