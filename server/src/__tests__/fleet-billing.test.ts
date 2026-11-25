import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  fleetBillingCustomers,
  fleetBillingEvents,
  fleetBillingItems,
  fleetBillingPrices,
  fleetCheckIns,
  fleetInstances,
} from "@greatstone/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { fleetHubRoutes } from "../routes/fleet.js";
import { fleetBillingEventRoutes, fleetBillingHubRoutes } from "../routes/fleet-billing.js";
import { grantFor, signBillingEvent, subscriptionPeriodEnd, verifyBillingSignature, type StripeClient } from "../services/fleet-billing.js";

// GSAM for Mac P3: catalogue mirrored to Stripe, Stripe events driving the
// install's signed document. Stripe is a fake here; nothing calls Stripe.

const DAY = 24 * 60 * 60;

describe("billing event signature", () => {
  const secret = randomBytes(32).toString("hex");
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });

  it("accepts its own signature and refuses a changed body, another secret, or a bad header", () => {
    const header = signBillingEvent(body, secret);
    expect(verifyBillingSignature(body, header, secret)).toBe(true);
    expect(verifyBillingSignature(Buffer.from(body), header, secret)).toBe(true);
    expect(verifyBillingSignature(body.replace("evt_1", "evt_2"), header, secret)).toBe(false);
    expect(verifyBillingSignature(body, header, randomBytes(32).toString("hex"))).toBe(false);
    expect(verifyBillingSignature(body, undefined, secret)).toBe(false);
    expect(verifyBillingSignature(body, "v1=abc", secret)).toBe(false);
    expect(verifyBillingSignature(body, header.replace(/v1=[0-9a-f]+/, "v1=zz"), secret)).toBe(false);
  });

  it("refuses a signature older or newer than five minutes", () => {
    const now = new Date();
    const old = signBillingEvent(body, secret, new Date(now.getTime() - 301_000));
    const future = signBillingEvent(body, secret, new Date(now.getTime() + 301_000));
    expect(verifyBillingSignature(body, old, secret, now)).toBe(false);
    expect(verifyBillingSignature(body, future, secret, now)).toBe(false);
    expect(verifyBillingSignature(body, signBillingEvent(body, secret, new Date(now.getTime() - 200_000)), secret, now)).toBe(true);
  });
});

describe("subscription to entitlement", () => {
  const item = (id: string, fields: Partial<typeof fleetBillingItems.$inferSelect>) =>
    [id, { id, kind: "module", name: id, features: [], limits: {}, moduleIds: [], stripeCustomerId: null, ...fields }] as const;
  const items = new Map<string, typeof fleetBillingItems.$inferSelect>(
    [
      item("crm", { features: ["enablePipelines", "enableCases"], limits: { maxUsers: 5 } }),
      item("strategy", { features: ["enableStrategy"], limits: { maxUsers: 10, maxAgents: 4 } }),
      item("bundle", { kind: "package", moduleIds: ["crm", "strategy"], limits: { maxUsers: 25 } }),
      item("deal", { kind: "deal", moduleIds: ["strategy"], limits: { maxAgents: 50 }, stripeCustomerId: "cus_A" }),
    ] as never,
  );
  const prices = new Map(
    ["crm", "strategy", "bundle", "deal"].map((id) => [`price_${id}`, { stripePriceId: `price_${id}`, itemId: id }] as const),
  ) as never;

  it("adds features and takes the highest limit across modules", () => {
    const grant = grantFor(["price_crm", "price_strategy"], "cus_A", prices, items);
    expect(grant.features).toMatchObject({ enablePipelines: true, enableCases: true, enableStrategy: true, enableDeepDive: false });
    expect(grant.limits).toEqual({ maxUsers: 10, maxAgents: 4 });
    expect(grant.refused).toEqual([]);
  });

  it("gives a package its modules' features, with its own limits in place of theirs", () => {
    const grant = grantFor(["price_bundle"], "cus_B", prices, items);
    expect(grant.features).toMatchObject({ enablePipelines: true, enableStrategy: true });
    expect(grant.limits).toEqual({ maxUsers: 25, maxAgents: 4 });
  });

  it("grants a deal only to its own customer", () => {
    expect(grantFor(["price_deal"], "cus_A", prices, items)).toMatchObject({ features: { enableStrategy: true }, limits: { maxAgents: 50 }, refused: [] });
    const other = grantFor(["price_deal"], "cus_B", prices, items);
    expect(other.features.enableStrategy).toBe(false);
    expect(other.refused).toEqual(["price_deal"]);
  });

  it("grants nothing for a price the hub does not know", () => {
    expect(grantFor(["price_unknown"], "cus_A", prices, items).refused).toEqual(["price_unknown"]);
  });

  it("reads the period end from the subscription or from its items (newer Stripe API)", () => {
    expect(subscriptionPeriodEnd({ id: "s", customer: "c", status: "active", current_period_end: 100 })).toBe(100);
    expect(subscriptionPeriodEnd({ id: "s", customer: "c", status: "active", items: { data: [{ current_period_end: 200 }, { current_period_end: 300 }] } })).toBe(300);
    expect(subscriptionPeriodEnd({ id: "s", customer: "c", status: "active" })).toBeNull();
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

type Sub = { id: string; customer: string; status: string; cancel_at_period_end?: boolean; items: { data: Array<{ price: { id: string }; current_period_end: number }> } };

function fakeStripe() {
  const calls: Array<{ method: string; path: string; params?: Record<string, unknown> }> = [];
  const subscriptions = new Map<string, Sub>();
  let n = 0;
  const client: StripeClient = {
    async request(method, path, params) {
      calls.push({ method, path, params });
      const sub = path.match(/^\/v1\/subscriptions\/(.+)$/);
      if (sub) return structuredClone(subscriptions.get(decodeURIComponent(sub[1]!))) as never;
      if (method === "POST" && path === "/v1/products") return { id: `prod_${++n}` } as never;
      if (method === "POST" && path === "/v1/prices") return { id: `price_${++n}` } as never;
      return {} as never;
    },
  };
  return { client, calls, subscriptions };
}

describeEmbeddedPostgres("payments and modules on the hub", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let stripe: ReturnType<typeof fakeStripe>;
  let secret: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fleet-billing-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(() => {
    secret = randomBytes(32).toString("hex");
    process.env.GSAM_FLEET_HUB = "true";
    process.env.GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY = randomBytes(32).toString("base64url");
    process.env.GSAM_BILLING_EVENTS_SECRET = secret;
    stripe = fakeStripe();
  });

  afterEach(async () => {
    delete process.env.GSAM_FLEET_HUB;
    delete process.env.GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY;
    delete process.env.GSAM_BILLING_EVENTS_SECRET;
    await db.delete(fleetBillingEvents);
    await db.delete(fleetBillingCustomers);
    await db.delete(fleetBillingPrices);
    await db.delete(fleetBillingItems);
    await db.delete(fleetCheckIns);
    await db.delete(fleetInstances);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app() {
    const server = express();
    server.use(express.json({ verify: (req, _res, buf) => ((req as unknown as { rawBody: Buffer }).rawBody = buf) }));
    server.use(fleetBillingEventRoutes(db, { stripe: () => stripe.client }));
    server.use((req, _res, next) => {
      req.actor = { type: "board", userId: "hub-admin", userEmail: "admin@hub.test", source: "session", isInstanceAdmin: true, companyIds: [] } as never;
      next();
    });
    server.use("/api", fleetHubRoutes(db));
    server.use("/api", fleetBillingHubRoutes(db, { stripe: () => stripe.client }));
    server.use(errorHandler);
    return server;
  }

  async function addItem(body: Record<string, unknown>) {
    const res = await request(app()).post("/api/fleet/catalogue").send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; prices: Array<{ stripePriceId: string; interval: string; amount: number }>; stripeProductId: string };
  }

  let eventSeq = 0;
  function send(type: string, object: Record<string, unknown>, opts: { id?: string; created?: number; signWith?: string; at?: Date } = {}) {
    const event = { id: opts.id ?? `evt_${++eventSeq}`, type, created: opts.created ?? Math.floor(Date.now() / 1000), data: { object } };
    const body = JSON.stringify(event);
    return request(app())
      .post("/api/fleet/billing/events")
      .set("content-type", "application/json")
      .set("stripe-signature", signBillingEvent(body, opts.signWith ?? secret, opts.at))
      .send(body);
  }

  async function documentOf(instanceId: string) {
    const [row] = await db.select().from(fleetInstances).where(eq(fleetInstances.id, instanceId));
    return { version: row!.entitlementVersion, doc: JSON.parse(Buffer.from(row!.entitlementDocument!.document, "base64url").toString("utf8")) };
  }

  const periodEnd = (days: number) => Math.floor(Date.now() / 1000) + days * DAY;

  function subscription(id: string, customer: string, priceIds: string[], end: number, fields: Partial<Sub> = {}) {
    const sub: Sub = { id, customer, status: "active", items: { data: priceIds.map((priceId) => ({ price: { id: priceId }, current_period_end: end })) }, ...fields };
    stripe.subscriptions.set(id, sub);
    return sub;
  }

  const checkoutSession = (customer: string) => ({ mode: "subscription", payment_status: "paid", subscription: "sub_1", customer });

  async function paidCheckout(customer = "cus_new1", priceId?: string) {
    const crm = await addItem({ kind: "module", name: "CRM", features: ["enablePipelines"], limits: { maxUsers: 5 }, monthlyAmount: 4900, annualAmount: 49000 });
    const monthly = priceId ?? crm.prices.find((price) => price.interval === "month")!.stripePriceId;
    subscription("sub_1", customer, [monthly], periodEnd(30));
    const res = await send("checkout.session.completed", checkoutSession(customer), { id: `evt_checkout_${customer}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { crm, res };
  }

  it("mirrors a module to one Stripe product and a price per interval; a new amount archives the old price", async () => {
    const module = await addItem({ kind: "module", name: "CRM", features: ["enablePipelines"], monthlyAmount: 4900, annualAmount: 49000 });
    expect(module.stripeProductId).toMatch(/^prod_/);
    expect(module.prices.map((price) => [price.interval, price.amount]).sort()).toEqual([["month", 4900], ["year", 49000]]);
    const oldMonthly = module.prices.find((price) => price.interval === "month")!.stripePriceId;

    const changed = await request(app())
      .put(`/api/fleet/catalogue/${module.id}`)
      .send({ kind: "module", name: "CRM", features: ["enablePipelines"], monthlyAmount: 5900, annualAmount: 49000 });
    expect(changed.status).toBe(200);
    expect(changed.body.prices.find((price: { interval: string }) => price.interval === "month").amount).toBe(5900);
    expect(stripe.calls).toContainEqual({ method: "POST", path: `/v1/prices/${oldMonthly}`, params: { active: false } });
    // The old price stays on the hub (inactive) so subscriptions on it still map.
    const rows = await db.select().from(fleetBillingPrices).where(eq(fleetBillingPrices.itemId, module.id));
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.active)).toHaveLength(2);

    const archived = await request(app()).delete(`/api/fleet/catalogue/${module.id}`);
    expect(archived.body.archivedAt).not.toBeNull();
    expect(archived.body.prices).toEqual([]);
    expect(stripe.calls.at(-1)).toMatchObject({ method: "POST", path: `/v1/products/${module.stripeProductId}`, params: { active: false } });
  });

  it("refuses a package with an unknown module and a deal with no customer", async () => {
    const unknown = await request(app()).post("/api/fleet/catalogue").send({ kind: "package", name: "Bundle", moduleIds: ["00000000-0000-4000-8000-000000000000"] });
    expect(unknown.status).toBe(400);
    const module = await addItem({ kind: "module", name: "CRM", features: ["enablePipelines"] });
    const noCustomer = await request(app()).post("/api/fleet/catalogue").send({ kind: "deal", name: "Deal", moduleIds: [module.id] });
    expect(noCustomer.status).toBe(400);
    const deal = await addItem({ kind: "deal", name: "Deal", moduleIds: [module.id], monthlyAmount: 1000, stripeCustomerId: "cus_A" });
    expect(stripe.calls.find((call) => call.path === "/v1/products" && call.params?.name === "Deal")?.params).toMatchObject({ metadata: { gsam_customer: "cus_A", gsam_kind: "deal" } });
    expect(deal.prices).toHaveLength(1);
  });

  it("refuses bad, old or missing signatures and answers 503 with no secret", async () => {
    expect((await send("invoice.paid", {}, { signWith: randomBytes(32).toString("hex") })).status).toBe(401);
    expect((await send("invoice.paid", {}, { at: new Date(Date.now() - 10 * 60_000) })).status).toBe(401);
    expect((await request(app()).post("/api/fleet/billing/events").send({ id: "evt_x", type: "invoice.paid", created: 1, data: { object: {} } })).status).toBe(401);
    delete process.env.GSAM_BILLING_EVENTS_SECRET;
    expect((await send("invoice.paid", {})).status).toBe(503);
    expect(await db.select().from(fleetBillingEvents)).toEqual([]);
  });

  it("checkout makes a licence once, with grace 0 and paid until the period end; a repeat is a duplicate with no key", async () => {
    const { res } = await paidCheckout();
    expect(res.body).toMatchObject({ outcome: "processed", licenceKey: expect.stringMatching(/^gsamlk_/) });
    const { version, doc } = await documentOf(res.body.instanceId);
    expect(version).toBe(1);
    expect(doc).toMatchObject({ grace: 0, issuedBy: "stripe", features: { enablePipelines: true, enableStrategy: false }, limits: { maxUsers: 5 } });
    expect(Math.abs(Date.parse(doc.validUntil) / 1000 - periodEnd(30))).toBeLessThan(5);
    const [link] = await db.select().from(fleetBillingCustomers);
    expect(link).toMatchObject({ stripeCustomerId: "cus_new1", fleetInstanceId: res.body.instanceId, stripeSubscriptionId: "sub_1", subscriptionStatus: "active" });

    const again = await send("checkout.session.completed", checkoutSession("cus_new1"), { id: "evt_checkout_cus_new1" });
    expect(again.body).toMatchObject({ outcome: "duplicate", instanceId: res.body.instanceId });
    expect(again.body.licenceKey).toBeUndefined();
    expect(await db.select().from(fleetInstances)).toHaveLength(1);
    expect((await documentOf(res.body.instanceId)).version).toBe(1);
  });

  it("an unpaid checkout waits for its async payment", async () => {
    const crm = await addItem({ kind: "module", name: "CRM", features: ["enablePipelines"], monthlyAmount: 4900 });
    subscription("sub_1", "cus_new1", [crm.prices[0]!.stripePriceId], periodEnd(30));
    const unpaid = await send("checkout.session.completed", { mode: "subscription", payment_status: "unpaid", subscription: "sub_1", customer: "cus_new1" });
    expect(unpaid.body).toMatchObject({ outcome: "ignored" });
    const paid = await send("checkout.session.async_payment_succeeded", { mode: "subscription", payment_status: "paid", subscription: "sub_1", customer: "cus_new1" });
    expect(paid.body.licenceKey).toMatch(/^gsamlk_/);
  });

  it("renewal extends paid-until; module change keeps it; failed payment and cancel never extend it", async () => {
    const { crm, res } = await paidCheckout();
    const id = res.body.instanceId as string;
    const first = (await documentOf(id)).doc.validUntil;

    // Renewal: the invoice paid for the next period.
    const monthly = crm.prices.find((price) => price.interval === "month")!.stripePriceId;
    subscription("sub_1", "cus_new1", [monthly], periodEnd(60));
    const renewed = await send("invoice.paid", { customer: "cus_new1", parent: { subscription_details: { subscription: "sub_1" } }, lines: { data: [{ period: { end: periodEnd(60) } }] } });
    expect(renewed.body.outcome).toBe("processed");
    const second = await documentOf(id);
    expect(second.version).toBe(2);
    expect(Date.parse(second.doc.validUntil)).toBeGreaterThan(Date.parse(first));
    // A late copy of an older invoice never shortens it.
    await send("invoice.paid", { customer: "cus_new1", subscription: "sub_1", lines: { data: [{ period: { end: periodEnd(30) } }] } });
    expect((await documentOf(id)).doc.validUntil).toBe(second.doc.validUntil);

    // Upgrade: a module added; paid-until unchanged.
    const strategy = await addItem({ kind: "module", name: "Strategy", features: ["enableStrategy"], limits: { maxUsers: 20 }, monthlyAmount: 2900 });
    const updatedSub = subscription("sub_1", "cus_new1", [monthly, strategy.prices[0]!.stripePriceId], periodEnd(60));
    const upgraded = await send("customer.subscription.updated", updatedSub as never);
    expect(upgraded.body.outcome).toBe("processed");
    const third = await documentOf(id);
    expect(third.doc).toMatchObject({ features: { enablePipelines: true, enableStrategy: true }, limits: { maxUsers: 20 }, grace: 0 });
    expect(third.doc.validUntil).toBe(second.doc.validUntil);

    // A stale snapshot (made before the last change) changes nothing.
    const stale = await send("customer.subscription.updated", { ...updatedSub, items: { data: [{ price: { id: monthly } }] } }, { created: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.body).toMatchObject({ outcome: "ignored", detail: expect.stringContaining("older") });

    // Payment failed: no extension, re-signed with the same paid-until.
    const failed = await send("invoice.payment_failed", { customer: "cus_new1", subscription: "sub_1" });
    expect(failed.body.outcome).toBe("processed");
    const fourth = await documentOf(id);
    expect(fourth.version).toBe(third.version! + 1);
    expect(fourth.doc.validUntil).toBe(third.doc.validUntil);
    expect((await db.select().from(fleetBillingCustomers))[0]!.subscriptionStatus).toBe("past_due");

    // Cancelled: no renewal, paid-until stays at the period end.
    const cancelled = await send("customer.subscription.deleted", { ...updatedSub, status: "canceled" }, { created: Math.floor(Date.now() / 1000) + 5 });
    expect(cancelled.body.outcome).toBe("processed");
    const fifth = await documentOf(id);
    expect(fifth.doc.validUntil).toBe(third.doc.validUntil);
    expect(fifth.doc.reason).toMatch(/cancelled/);
    expect((await db.select().from(fleetBillingCustomers))[0]!.subscriptionStatus).toBe("canceled");
  });

  it("events for a subscription that does not drive the install change nothing", async () => {
    const { res } = await paidCheckout();
    const before = await documentOf(res.body.instanceId);
    stripe.subscriptions.set("sub_other", { id: "sub_other", customer: "cus_new1", status: "active", items: { data: [] } });
    const other = await send("invoice.paid", { customer: "cus_new1", subscription: "sub_other", lines: { data: [{ period: { end: periodEnd(400) } }] } });
    expect(other.body.outcome).toBe("ignored");
    expect(other.status).toBe(200);
    expect((await documentOf(res.body.instanceId)).version).toBe(before.version);
  });

  it("a deal for another customer grants nothing at checkout", async () => {
    const module = await addItem({ kind: "module", name: "Strategy", features: ["enableStrategy"] });
    const deal = await addItem({ kind: "deal", name: "Deal", moduleIds: [module.id], monthlyAmount: 100, stripeCustomerId: "cus_A" });
    subscription("sub_1", "cus_B", [deal.prices[0]!.stripePriceId], periodEnd(30));
    const res = await send("checkout.session.completed", { mode: "subscription", payment_status: "paid", subscription: "sub_1", customer: "cus_B" });
    const { doc } = await documentOf(res.body.instanceId);
    expect(doc.features.enableStrategy).toBe(false);
    expect(doc.reason).toMatch(/not granted/);
  });

  it("a licence linked to its Stripe customer by hand is driven by that customer's checkout, with no new key", async () => {
    const licence = await request(app())
      .post("/api/fleet/licences")
      .send({ features: {}, limits: {}, validUntil: new Date(Date.now() + 5 * DAY * 1000).toISOString() });
    expect(licence.status).toBe(201);
    const id = licence.body.instance.id as string;
    expect((await request(app()).put(`/api/fleet/instances/${id}/billing`).send({ stripeCustomerId: "cus_old1" })).status).toBe(200);
    expect((await request(app()).put(`/api/fleet/instances/${id}/billing`).send({ stripeCustomerId: "cus_old2" })).status).toBe(409);

    const { res } = await paidCheckout("cus_old1");
    expect(res.body).toMatchObject({ outcome: "processed", instanceId: id });
    expect(res.body.licenceKey).toBeUndefined();
    expect((await documentOf(id)).doc.features.enablePipelines).toBe(true);
    const list = await request(app()).get("/api/fleet/instances");
    expect(list.body[0].billing).toMatchObject({ stripeCustomerId: "cus_old1", stripeSubscriptionId: "sub_1", subscriptionStatus: "active", cancelAtPeriodEnd: false });
  });

  it("answers 502 when Stripe cannot be read, and the event can be sent again", async () => {
    stripe.client.request = async () => {
      throw new (await import("../services/fleet-billing.js")).StripeError("Stripe 500: down");
    };
    const res = await send("checkout.session.completed", { mode: "subscription", payment_status: "paid", subscription: "sub_1", customer: "cus_new1" }, { id: "evt_retry" });
    expect(res.status).toBe(502);
    expect(await db.select().from(fleetBillingEvents)).toEqual([]);
  });
});
