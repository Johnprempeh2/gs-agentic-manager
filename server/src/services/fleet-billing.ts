import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { fleetBillingCustomers, fleetBillingEvents, fleetBillingItems, fleetBillingPrices } from "@greatstone/db";
import { ENTITLEMENT_FEATURE_KEYS, type EntitlementFeatureKey } from "@greatstone/shared";
import type { FleetBillingItemInput, FleetBillingItemView } from "@greatstone/shared/fleet";
import { HttpError, badRequest, notFound } from "../errors.js";
import { fleetService } from "./fleet.js";
import type { HubSigningKey } from "./fleet-entitlements.js";

/**
 * GSAM for Mac (P3): payments and modules on the hub.
 *
 * - The catalogue (modules, packages, deals) lives in the hub DB and mirrors
 *   to Stripe: one Product per item, one Price per billing interval.
 * - Stripe events reach `POST /api/fleet/billing/events`, signed with
 *   GSAM_BILLING_EVENTS_SECRET in Stripe's own signature format. Each one
 *   re-signs the install's entitlement document (grace 0), which the install
 *   gets with its next check-in.
 */

export const STRIPE_SECRET_KEY_ENV = "GSAM_STRIPE_SECRET_KEY";
export const BILLING_EVENTS_SECRET_ENV = "GSAM_BILLING_EVENTS_SECRET";
/** A signature older (or newer) than this is refused, so a captured request cannot be replayed later. */
export const BILLING_SIGNATURE_TOLERANCE_SECONDS = 300;
const ISSUED_BY = "stripe";

// ─── Signature (Stripe's format: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`) ───

function hmacHex(secret: string, timestamp: number, body: Buffer | string) {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

/** The `Stripe-Signature` header value for a body. The website signs its forwarded events with this. */
export function signBillingEvent(body: Buffer | string, secret: string, now = new Date()) {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${hmacHex(secret, t, body)}`;
}

/** True when one `v1` matches and `t` is within the tolerance. Constant-time compare. */
export function verifyBillingSignature(body: Buffer | string, header: string | undefined, secret: string, now = new Date()) {
  if (!header || !secret) return false;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s.trim());
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v) v1.push(v);
  }
  if (t === null || v1.length === 0) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > BILLING_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(hmacHex(secret, t, body), "hex");
  return v1.some((sig) => {
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// ─── Stripe client: plain fetch, form-encoded, no SDK ───

export interface StripeClient {
  request<T = Record<string, unknown>>(method: "GET" | "POST", path: string, params?: Record<string, unknown>): Promise<T>;
}

function formPairs(params: Record<string, unknown>, prefix = ""): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object") pairs.push(...formPairs(value as Record<string, unknown>, name));
    else pairs.push([name, String(value)]);
  }
  return pairs;
}

export class StripeError extends Error {}

export function createStripeClient(secretKey: string, fetchImpl: typeof fetch = fetch): StripeClient {
  return {
    async request(method, path, params = {}) {
      const body = new URLSearchParams(formPairs(params)).toString();
      const res = await fetchImpl(`https://api.stripe.com${path}${method === "GET" && body ? `?${body}` : ""}`, {
        method,
        headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded" },
        ...(method === "POST" ? { body } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
      if (!res.ok) throw new StripeError(`Stripe ${res.status}: ${json.error?.message ?? "request failed"}`);
      return json as never;
    },
  };
}

export function stripeFromEnv(env: NodeJS.ProcessEnv = process.env): StripeClient | null {
  const key = env[STRIPE_SECRET_KEY_ENV]?.trim();
  return key ? createStripeClient(key) : null;
}

// ─── Subscription to entitlement ───

type ItemRow = typeof fleetBillingItems.$inferSelect;
type PriceRow = typeof fleetBillingPrices.$inferSelect;

export interface Grant {
  features: Record<EntitlementFeatureKey, boolean>;
  limits: Record<string, number>;
  /** Price ids that grant nothing: unknown to the hub, or a deal for another customer. */
  refused: string[];
}

function maxLimits(into: Record<string, number>, from: Record<string, number>) {
  for (const [key, value] of Object.entries(from)) into[key] = Math.max(into[key] ?? 0, value);
}

/**
 * What a subscription's prices grant. Features add up; a limit takes the
 * highest value. A package or deal gets its modules' features and limits,
 * and its own limits replace the modules' ones. A deal grants only to its
 * own customer. Archived items still grant: the customer paid for them.
 */
export function grantFor(priceIds: string[], customerId: string, prices: Map<string, PriceRow>, items: Map<string, ItemRow>): Grant {
  const on = new Set<string>();
  const limits: Record<string, number> = {};
  const refused: string[] = [];
  for (const priceId of priceIds) {
    const item = items.get(prices.get(priceId)?.itemId ?? "");
    if (!item || (item.kind === "deal" && item.stripeCustomerId !== customerId)) {
      refused.push(priceId);
      continue;
    }
    if (item.kind === "module") {
      item.features.forEach((key) => on.add(key));
      maxLimits(limits, item.limits);
      continue;
    }
    const own: Record<string, number> = {};
    for (const id of item.moduleIds) {
      const module = items.get(id);
      if (!module) continue;
      module.features.forEach((key) => on.add(key));
      maxLimits(own, module.limits);
    }
    maxLimits(limits, { ...own, ...item.limits });
  }
  return {
    features: Object.fromEntries(ENTITLEMENT_FEATURE_KEYS.map((key) => [key, on.has(key)])) as Grant["features"],
    limits,
    refused,
  };
}

interface StripeSubscription {
  id: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  items?: { data?: Array<{ price?: { id?: string }; current_period_end?: number }> };
}

const idOf = (value: unknown): string | null =>
  typeof value === "string" ? value : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : null;

const isoFromSeconds = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Newer Stripe API versions keep the period on each item, older ones on the subscription. */
export function subscriptionPeriodEnd(sub: StripeSubscription): number | null {
  const ends = [sub.current_period_end, ...(sub.items?.data ?? []).map((item) => item.current_period_end)].filter((n): n is number => typeof n === "number");
  return ends.length ? Math.max(...ends) : null;
}

const priceIdsOf = (sub: StripeSubscription) => (sub.items?.data ?? []).map((item) => item.price?.id).filter((id): id is string => Boolean(id));

/** Newer Stripe API versions moved `invoice.subscription` under `parent.subscription_details`. */
function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  const parent = invoice.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  return idOf(invoice.subscription) ?? idOf(parent?.subscription_details?.subscription);
}

/** The end of what this invoice paid for: the latest line period end. */
function invoicePaidUntil(invoice: Record<string, unknown>): number | null {
  const lines = (invoice.lines as { data?: Array<{ period?: { end?: number } }> } | undefined)?.data ?? [];
  const ends = lines.map((line) => line.period?.end).filter((n): n is number => typeof n === "number");
  return ends.length ? Math.max(...ends) : null;
}

// ─── Events ───

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

export interface BillingEventResult {
  outcome: "processed" | "ignored" | "duplicate";
  detail?: string;
  instanceId?: string | null;
  /** Checkout only, the first time: the new install's licence key. Never stored; a repeat of the event does not return it. */
  licenceKey?: string;
  licenceKeyExpiresAt?: string;
  validUntil?: string;
}

export const HANDLED_BILLING_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

class Duplicate extends Error {}

const unavailable = (what: string) => new HttpError(503, `${what} is not set on the hub`);

export function fleetBillingService(
  db: Db,
  deps: { stripe?: () => StripeClient | null; signingKey: () => HubSigningKey | null; now?: () => Date },
) {
  const stripeOrNull = deps.stripe ?? (() => stripeFromEnv());
  const now = deps.now ?? (() => new Date());

  const requireStripe = () => {
    const stripe = stripeOrNull();
    if (!stripe) throw unavailable(STRIPE_SECRET_KEY_ENV);
    return stripe;
  };

  async function loadCatalogue(tx: Pick<Db, "select">) {
    const [items, prices] = await Promise.all([tx.select().from(fleetBillingItems), tx.select().from(fleetBillingPrices)]);
    return { items: new Map(items.map((item) => [item.id, item])), prices: new Map(prices.map((price) => [price.stripePriceId, price])) };
  }

  async function fetchSubscription(id: string) {
    return requireStripe().request<StripeSubscription>("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
  }

  /** The event row first, so a second copy racing this one waits on the key and then finds it. */
  async function inEventTransaction(event: StripeEvent, work: (tx: Db) => Promise<BillingEventResult>) {
    return db.transaction(async (tx) => {
      const [claimed] = await tx
        .insert(fleetBillingEvents)
        .values({ stripeEventId: event.id, type: event.type, outcome: "processing" })
        .onConflictDoNothing()
        .returning();
      if (!claimed) throw new Duplicate();
      const result = await work(tx as unknown as Db);
      await tx
        .update(fleetBillingEvents)
        .set({ outcome: `${result.outcome}${result.detail ? `: ${result.detail}` : ""}`, fleetInstanceId: result.instanceId ?? null })
        .where(eq(fleetBillingEvents.stripeEventId, event.id));
      return result;
    });
  }

  async function customerRow(tx: Db, customerId: string | null) {
    if (!customerId) return null;
    return tx.select().from(fleetBillingCustomers).where(eq(fleetBillingCustomers.stripeCustomerId, customerId)).then((rows) => rows[0] ?? null);
  }

  function key() {
    const signing = deps.signingKey();
    if (!signing) throw unavailable("GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY");
    return signing;
  }

  async function reissue(
    tx: Db,
    instanceId: string,
    next: { features: Record<string, boolean>; limits: Record<string, number>; validUntil: string },
    reason: string,
  ) {
    const updated = await fleetService(tx).issueEntitlement(instanceId, { ...next, grace: 0, reason }, ISSUED_BY, key(), now());
    if (!updated) throw notFound("Fleet instance not found");
    return updated;
  }

  async function current(tx: Db, instanceId: string) {
    return (await fleetService(tx).get(instanceId))?.entitlement ?? null;
  }

  // A fresh read of the subscription stands for every change made before it. Stripe's `created` is whole seconds.
  const fetchedAt = () => new Date(Math.floor(now().getTime() / 1000) * 1000);

  const later = (a: string | null | undefined, b: string) => (a && Date.parse(a) > Date.parse(b) ? a : b);

  async function checkout(event: StripeEvent): Promise<BillingEventResult> {
    const session = event.data.object;
    const subId = idOf(session.subscription);
    if (session.mode !== "subscription" || !subId) return ignore(event, "not a subscription checkout");
    if (event.type === "checkout.session.completed" && session.payment_status === "unpaid") return ignore(event, "payment not taken yet");
    const sub = await fetchSubscription(subId);
    const customerId = idOf(session.customer) ?? idOf(sub.customer);
    const periodEnd = subscriptionPeriodEnd(sub);
    if (!customerId || !periodEnd) return ignore(event, "subscription has no customer or period");
    return inEventTransaction(event, async (tx) => {
      const catalogue = await loadCatalogue(tx);
      const grant = grantFor(priceIdsOf(sub), customerId, catalogue.prices, catalogue.items);
      const linked = await customerRow(tx, customerId);
      const fields = { stripeSubscriptionId: sub.id, subscriptionStatus: sub.status, cancelAtPeriodEnd: sub.cancel_at_period_end === true, lastEventAt: fetchedAt(), updatedAt: now() };
      const reason = `Stripe checkout ${refusedNote(grant)}`.trim();
      if (linked) {
        const validUntil = later((await current(tx, linked.fleetInstanceId))?.validUntil, isoFromSeconds(periodEnd));
        await reissue(tx, linked.fleetInstanceId, { features: grant.features, limits: grant.limits, validUntil }, reason);
        await tx.update(fleetBillingCustomers).set(fields).where(eq(fleetBillingCustomers.stripeCustomerId, customerId));
        return { outcome: "processed", instanceId: linked.fleetInstanceId, validUntil };
      }
      const validUntil = isoFromSeconds(periodEnd);
      const created = await fleetService(tx).createLicence(
        { features: grant.features, limits: grant.limits, validUntil, grace: 0, reason },
        { userId: null, label: ISSUED_BY },
        key(),
        now(),
      );
      if (!created) throw new HttpError(409, "The install code made for this licence is taken; send the event again");
      await tx.insert(fleetBillingCustomers).values({ stripeCustomerId: customerId, fleetInstanceId: created.instance.id, ...fields });
      return { outcome: "processed", instanceId: created.instance.id, validUntil, licenceKey: created.licenceKey, licenceKeyExpiresAt: created.licenceKeyExpiresAt };
    });
  }

  /** The install's row, when this subscription drives it. A row with no subscription yet (linked by hand) adopts this one. */
  function drives(row: typeof fleetBillingCustomers.$inferSelect | null, subId: string) {
    return row && (row.stripeSubscriptionId === null || row.stripeSubscriptionId === subId) ? row : null;
  }

  async function invoicePaid(event: StripeEvent): Promise<BillingEventResult> {
    const invoice = event.data.object;
    const subId = invoiceSubscriptionId(invoice);
    if (!subId) return ignore(event, "not a subscription invoice");
    const sub = await fetchSubscription(subId);
    return inEventTransaction(event, async (tx) => {
      const row = drives(await customerRow(tx, idOf(invoice.customer) ?? idOf(sub.customer)), subId);
      if (!row) return { outcome: "ignored", detail: "no install driven by this subscription (checkout makes it)" };
      const paidEnd = invoicePaidUntil(invoice) ?? subscriptionPeriodEnd(sub);
      if (!paidEnd) return { outcome: "ignored", detail: "invoice has no period", instanceId: row.fleetInstanceId };
      const catalogue = await loadCatalogue(tx);
      const grant = grantFor(priceIdsOf(sub), row.stripeCustomerId, catalogue.prices, catalogue.items);
      // Paid-until only ever moves forward: a late copy of an older invoice never shortens it.
      const validUntil = later((await current(tx, row.fleetInstanceId))?.validUntil, isoFromSeconds(paidEnd));
      await reissue(tx, row.fleetInstanceId, { features: grant.features, limits: grant.limits, validUntil }, `Stripe invoice paid ${refusedNote(grant)}`.trim());
      await tx
        .update(fleetBillingCustomers)
        .set({ stripeSubscriptionId: subId, subscriptionStatus: sub.status, cancelAtPeriodEnd: sub.cancel_at_period_end === true, lastEventAt: fetchedAt(), updatedAt: now() })
        .where(eq(fleetBillingCustomers.stripeCustomerId, row.stripeCustomerId));
      return { outcome: "processed", instanceId: row.fleetInstanceId, validUntil };
    });
  }

  async function paymentFailed(event: StripeEvent): Promise<BillingEventResult> {
    const invoice = event.data.object;
    const subId = invoiceSubscriptionId(invoice);
    if (!subId) return ignore(event, "not a subscription invoice");
    return inEventTransaction(event, async (tx) => {
      const row = drives(await customerRow(tx, idOf(invoice.customer)), subId);
      const doc = row ? await current(tx, row.fleetInstanceId) : null;
      if (!row || !doc) return { outcome: "ignored", detail: "no install driven by this subscription" };
      // No extension: the same grant and paid-until, re-signed so the install's log says why.
      await reissue(tx, row.fleetInstanceId, { features: doc.features, limits: doc.limits, validUntil: doc.validUntil }, "Stripe payment failed: not extended, the service stops at the end of the paid period");
      await tx
        .update(fleetBillingCustomers)
        .set({ subscriptionStatus: "past_due", updatedAt: now() })
        .where(eq(fleetBillingCustomers.stripeCustomerId, row.stripeCustomerId));
      return { outcome: "processed", instanceId: row.fleetInstanceId, validUntil: doc.validUntil };
    });
  }

  /** Module changes and cancellations. Paid-until never moves here: only a paid invoice extends it. */
  async function subscriptionChanged(event: StripeEvent): Promise<BillingEventResult> {
    const sub = event.data.object as unknown as StripeSubscription;
    const eventAt = new Date(event.created * 1000);
    return inEventTransaction(event, async (tx) => {
      const row = drives(await customerRow(tx, idOf(sub.customer)), sub.id);
      const doc = row ? await current(tx, row.fleetInstanceId) : null;
      if (!row || !doc) return { outcome: "ignored", detail: "no install driven by this subscription" };
      if (row.lastEventAt && eventAt < row.lastEventAt) {
        return { outcome: "ignored", detail: "older than the last change applied", instanceId: row.fleetInstanceId };
      }
      const catalogue = await loadCatalogue(tx);
      const grant = grantFor(priceIdsOf(sub), row.stripeCustomerId, catalogue.prices, catalogue.items);
      const deleted = event.type === "customer.subscription.deleted";
      const reason = deleted
        ? "Stripe subscription cancelled: no renewal, the service stops at the end of the paid period"
        : `Stripe subscription changed${sub.cancel_at_period_end ? " (cancels at period end)" : ""} ${refusedNote(grant)}`.trim();
      await reissue(tx, row.fleetInstanceId, { features: grant.features, limits: grant.limits, validUntil: doc.validUntil }, reason);
      await tx
        .update(fleetBillingCustomers)
        .set({
          stripeSubscriptionId: sub.id,
          subscriptionStatus: deleted ? "canceled" : sub.status,
          cancelAtPeriodEnd: sub.cancel_at_period_end === true,
          lastEventAt: eventAt,
          updatedAt: now(),
        })
        .where(eq(fleetBillingCustomers.stripeCustomerId, row.stripeCustomerId));
      return { outcome: "processed", instanceId: row.fleetInstanceId, validUntil: doc.validUntil };
    });
  }

  async function ignore(event: StripeEvent, detail: string): Promise<BillingEventResult> {
    return inEventTransaction(event, async () => ({ outcome: "ignored", detail }));
  }

  return {
    /** Idempotent on the Stripe event id. Throws an HttpError (503, 502) when the sender should retry. */
    async handleEvent(event: StripeEvent): Promise<BillingEventResult> {
      const seen = await db.select().from(fleetBillingEvents).where(eq(fleetBillingEvents.stripeEventId, event.id)).then((rows) => rows[0]);
      if (seen) return { outcome: "duplicate", instanceId: seen.fleetInstanceId };
      try {
        switch (event.type) {
          case "checkout.session.completed":
          case "checkout.session.async_payment_succeeded":
            return await checkout(event);
          case "invoice.paid":
            return await invoicePaid(event);
          case "invoice.payment_failed":
            return await paymentFailed(event);
          case "customer.subscription.updated":
          case "customer.subscription.deleted":
            return await subscriptionChanged(event);
          default:
            return await ignore(event, "event type not handled");
        }
      } catch (error) {
        if (error instanceof Duplicate) return { outcome: "duplicate" };
        if (error instanceof StripeError) throw new HttpError(502, error.message);
        throw error;
      }
    },
  };
}

function refusedNote(grant: Grant) {
  return grant.refused.length ? `(${grant.refused.length} price not granted: unknown, or a deal for another customer)` : "";
}

// ─── Catalogue ───

function itemView(item: ItemRow, prices: PriceRow[]): FleetBillingItemView {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    description: item.description,
    features: item.features,
    limits: item.limits,
    moduleIds: item.moduleIds,
    monthlyAmount: item.monthlyAmount,
    annualAmount: item.annualAmount,
    currency: item.currency,
    stripeCustomerId: item.stripeCustomerId,
    stripeProductId: item.stripeProductId,
    prices: prices
      .filter((price) => price.itemId === item.id && price.active)
      .map((price) => ({ stripePriceId: price.stripePriceId, interval: price.interval, amount: price.amount, currency: price.currency, active: price.active })),
    archivedAt: item.archivedAt?.toISOString() ?? null,
    updatedAt: item.updatedAt.toISOString(),
  };
}

/**
 * Bring Stripe in line with the item: one Product, and one active Price per
 * interval that has an amount. Stripe prices cannot change, so a new amount
 * archives the old price and makes a new one. Archived items archive all.
 */
export async function mirrorItem(db: Db, stripe: StripeClient, item: ItemRow) {
  const archived = item.archivedAt !== null;
  const product = {
    name: item.name,
    description: item.description || undefined,
    active: !archived,
    metadata: { gsam_item_id: item.id, gsam_kind: item.kind, gsam_customer: item.stripeCustomerId ?? "" },
  };
  let productId = item.stripeProductId;
  if (!productId) {
    productId = (await stripe.request<{ id: string }>("POST", "/v1/products", product)).id;
    await db.update(fleetBillingItems).set({ stripeProductId: productId }).where(eq(fleetBillingItems.id, item.id));
  }
  const existing = await db.select().from(fleetBillingPrices).where(and(eq(fleetBillingPrices.itemId, item.id), eq(fleetBillingPrices.active, true)));
  for (const [interval, amount] of [["month", item.monthlyAmount], ["year", item.annualAmount]] as const) {
    const wanted = !archived && amount !== null ? amount : null;
    const live = existing.find((price) => price.interval === interval);
    if (live && live.amount === wanted && live.currency === item.currency) continue;
    if (live) {
      await stripe.request("POST", `/v1/prices/${encodeURIComponent(live.stripePriceId)}`, { active: false });
      await db.update(fleetBillingPrices).set({ active: false }).where(eq(fleetBillingPrices.stripePriceId, live.stripePriceId));
    }
    if (wanted === null) continue;
    const price = await stripe.request<{ id: string }>("POST", "/v1/prices", {
      product: productId,
      unit_amount: wanted,
      currency: item.currency,
      recurring: { interval },
      metadata: { gsam_item_id: item.id, gsam_kind: item.kind, gsam_customer: item.stripeCustomerId ?? "" },
    });
    await db.insert(fleetBillingPrices).values({ stripePriceId: price.id, itemId: item.id, interval, amount: wanted, currency: item.currency });
  }
  if (item.stripeProductId) await stripe.request("POST", `/v1/products/${encodeURIComponent(productId)}`, product);
}

export function fleetCatalogueService(db: Db, deps: { stripe?: () => StripeClient | null } = {}) {
  const stripeOrNull = deps.stripe ?? (() => stripeFromEnv());

  async function assertModules(input: FleetBillingItemInput) {
    if (input.moduleIds.length === 0) return;
    const found = await db
      .select({ id: fleetBillingItems.id })
      .from(fleetBillingItems)
      .where(and(inArray(fleetBillingItems.id, input.moduleIds), eq(fleetBillingItems.kind, "module")));
    if (found.length !== new Set(input.moduleIds).size) throw badRequest("Every module in a package or deal must be an existing module");
  }

  async function get(id: string) {
    const item = await db.select().from(fleetBillingItems).where(eq(fleetBillingItems.id, id)).then((rows) => rows[0]);
    if (!item) return null;
    return itemView(item, await db.select().from(fleetBillingPrices).where(eq(fleetBillingPrices.itemId, id)));
  }

  async function mirrorAndView(item: ItemRow) {
    const stripe = stripeOrNull();
    if (stripe) {
      try {
        await mirrorItem(db, stripe, item);
      } catch (error) {
        // Saved on the hub either way; saving again retries the mirror.
        if (error instanceof StripeError) throw new HttpError(502, `Saved on the hub, but Stripe refused it: ${error.message}`);
        throw error;
      }
    }
    return (await get(item.id))!;
  }

  return {
    async list(): Promise<FleetBillingItemView[]> {
      const [items, prices] = await Promise.all([db.select().from(fleetBillingItems).orderBy(fleetBillingItems.kind, fleetBillingItems.name), db.select().from(fleetBillingPrices)]);
      return items.map((item) => itemView(item, prices));
    },

    async create(input: FleetBillingItemInput) {
      await assertModules(input);
      const [item] = await db.insert(fleetBillingItems).values(input).returning();
      return mirrorAndView(item!);
    },

    async update(id: string, input: FleetBillingItemInput) {
      const before = await db.select().from(fleetBillingItems).where(eq(fleetBillingItems.id, id)).then((rows) => rows[0]);
      if (!before) throw notFound("Catalogue item not found");
      if (before.kind !== input.kind) throw badRequest("An item keeps its kind; make a new one instead");
      await assertModules(input);
      const [item] = await db.update(fleetBillingItems).set({ ...input, updatedAt: new Date() }).where(eq(fleetBillingItems.id, id)).returning();
      return mirrorAndView(item!);
    },

    /** Archived, never deleted: subscriptions on its prices keep their features. */
    async archive(id: string) {
      const [item] = await db.update(fleetBillingItems).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(fleetBillingItems.id, id)).returning();
      if (!item) throw notFound("Catalogue item not found");
      return mirrorAndView(item);
    },

    /** Link an install to a Stripe customer by hand (a licence made before payments, or a customer who paid elsewhere). */
    async link(instanceId: string, stripeCustomerId: string) {
      const [row] = await db
        .insert(fleetBillingCustomers)
        .values({ stripeCustomerId, fleetInstanceId: instanceId })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new HttpError(409, "This Stripe customer or this install is already linked");
      return row;
    },
  };
}
