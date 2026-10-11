import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { billingAccounts, billingInvoices } from "@greatstone/db";
import {
  accessEndWhenRenewalStops,
  billingStatusOn,
  utcDay,
  type BillingAccount,
  type BillingAccountView,
  type BillingEndAction,
  type BillingInvoice,
  type BillingInvoiceStatus,
  type BillingModuleSelection,
  type BillingPlanKind,
  type BillingTermKind,
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

export function billingAccountService(db: Db) {
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

    async view(now: Date): Promise<BillingAccountView> {
      const [account, invoices] = await Promise.all([get(), listInvoices()]);
      return { account, status: account ? billingStatusOn(account, utcDay(now)) : null, invoices };
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
      const values = {
        planKind: input.planKind,
        planName: input.planName ?? null,
        catalogueVersion: input.catalogueVersion,
        currency: input.currency,
        serviceFeeCents: input.serviceFeeCents,
        modules: input.modules,
        allowanceMonthlyCents: input.allowanceMonthlyCents,
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
