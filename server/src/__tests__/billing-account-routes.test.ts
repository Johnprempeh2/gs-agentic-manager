import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  billingAccounts,
  billingInvoices,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  financeEvents,
} from "@greatstone/db";
import { computeApiEquivalentCents, SETTINGS_OPERATOR_MANAGED_ERROR_CODE } from "@greatstone/shared";
import { BILLING_CATALOGUE_VERSION } from "@greatstone/shared/billing-account";
import { buildCheckIn, usageTotals } from "../../../scripts/client-instance/fleet.js";
import { billingUsageSignal } from "../../../scripts/client-instance/watch.js";
import { attentionService } from "../services/attention.js";
import { budgetService } from "../services/budgets.js";
import { costService } from "../services/costs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * GRE-1369 (B2 on GRE-1357): the billing account record of an instance.
 * Acceptance tests AT-1.1, AT-1.7, AT-1.8 and AT-1.9 against the real routes
 * and a real database. The operator is an instance admin; the client is the
 * company's board owner, not an instance admin (as `client-instance.sh create`
 * makes them). Every amount below is test data, not a price.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Who = "operator" | "client" | "viewer" | "agent";

describeEmbeddedPostgres("billing account record (GRE-1369)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let companyId!: string;
  let clock = new Date("2026-10-10T09:00:00.000Z");

  function actorFor(who: Who): Express.Request["actor"] {
    if (who === "agent") {
      return { type: "agent", agentId: randomUUID(), companyId, source: "agent_key" } as Express.Request["actor"];
    }
    const role = who === "viewer" ? "viewer" : "owner";
    const memberships = [{ companyId, membershipRole: role, status: "active" }];
    return {
      type: "board",
      userId: `${who}-1`,
      source: "session",
      isInstanceAdmin: who === "operator",
      companyIds: [companyId],
      memberships,
    } as Express.Request["actor"];
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-billing-account-");
    db = createDb(tempDb.connectionString);
    const [{ billingAccountRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/billing-account.js"),
      import("../middleware/index.js"),
    ]);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actorFor(req.header("x-test-actor") as Who);
      next();
    });
    app.use("/api", billingAccountRoutes(db, { now: () => clock }));
    app.use(errorHandler);
  });

  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(billingInvoices);
    await db.delete(billingAccounts);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Client Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    clock = new Date("2026-10-10T09:00:00.000Z");
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const as = (who: Who) => ({
    get: (url: string) => request(app).get(url).set("x-test-actor", who),
    put: (url: string) => request(app).put(url).set("x-test-actor", who),
    post: (url: string) => request(app).post(url).set("x-test-actor", who),
  });

  const record = {
    planKind: "modules",
    planName: "Foundation with CRM and Strategy",
    catalogueVersion: BILLING_CATALOGUE_VERSION,
    currency: "GBP",
    serviceFeeCents: 123_400,
    modules: [
      { key: "crm", feeCents: 45_600 },
      { key: "strategy", feeCents: 78_900 },
    ],
    allowanceMonthlyCents: 25_000,
    termKind: "monthly",
    termStartsOn: "2026-10-01",
    autoRenew: true,
    endAction: "pause",
    reason: "Signed order form",
  };

  async function setRecord(body: Record<string, unknown> = record) {
    const res = await as("operator").put("/api/instance/billing-account").send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  it("AT-1.1: the client sees each fee exactly as the operator set them, and cannot change them; the allowance amount is the operator's", async () => {
    await setRecord();

    const view = await as("client").get("/api/instance/billing-account");
    expect(view.status).toBe(200);
    expect(view.body.audience).toBe("client");
    expect(view.body.account).toMatchObject({
      planKind: "modules",
      currency: "GBP",
      serviceFeeCents: 123_400,
      modules: [
        { key: "crm", feeCents: 45_600 },
        { key: "strategy", feeCents: 78_900 },
      ],
      termStartsOn: "2026-10-01",
    });
    // GRE-1395: the included allowance is a percent for the client, never an amount.
    expect(view.body.account).not.toHaveProperty("allowanceMonthlyCents");
    const operator = await as("operator").get("/api/instance/billing-account");
    expect(operator.body.audience).toBe("operator");
    expect(operator.body.account.allowanceMonthlyCents).toBe(25_000);

    const writes = [
      () => as("client").put("/api/instance/billing-account").send({ ...record, serviceFeeCents: 1 }),
      // A bad body is still refused as operator-managed, not as a validation error.
      () => as("client").put("/api/instance/billing-account").send({ allowanceMonthlyCents: 99_999_999 }),
      () =>
        as("client").post("/api/instance/billing-account/invoices").send({
          reference: "FAKE-1",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-31",
          amountCents: 0,
          currency: "GBP",
          status: "paid",
          issuedOn: "2026-10-01",
        }),
      () => as("client").post("/api/instance/billing-account/resume-renewal").send({ reason: "mine" }),
    ];
    for (const write of writes) {
      const res = await write();
      expect(res.status).toBe(403);
      expect(res.body.details?.code ?? res.body.code).toBe(SETTINGS_OPERATOR_MANAGED_ERROR_CODE);
    }
    const after = await as("client").get("/api/instance/billing-account");
    expect(after.body.account.serviceFeeCents).toBe(123_400);
    expect((await as("operator").get("/api/instance/billing-account")).body.account.allowanceMonthlyCents).toBe(25_000);
    expect(after.body.invoices).toEqual([]);

    // The operator's change is audited with the old and new values.
    const rows = await db.select().from(activityLog).where(eq(activityLog.action, "billing.account_updated"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.companyId).toBe(companyId);
    expect(rows[0]!.details).toMatchObject({ oldValue: null, reason: "Signed order form" });
    // Company members can read the activity log: no allowance or rate in it, only the names of what changed (GRE-1395).
    const details = rows[0]!.details as Record<string, Record<string, unknown> | unknown>;
    expect(details.newValue).not.toHaveProperty("allowanceMonthlyCents");
    expect(details.newValue).not.toHaveProperty("usageFxRate");
    expect(details.newValue).not.toHaveProperty("usageFxRateSetOn");
    expect(details.operatorFieldsChanged).toEqual(expect.arrayContaining(["allowanceMonthlyCents"]));
  });

  it("refuses the record to agents and a module boundary the D2 rules forbid", async () => {
    await setRecord();
    expect((await as("agent").get("/api/instance/billing-account")).status).toBe(403);
    const board = await as("operator")
      .put("/api/instance/billing-account")
      .send({ ...record, modules: [{ key: "board", feeCents: 1 }] });
    expect(board.status).toBe(400);
    expect(JSON.stringify(board.body)).toContain("board needs strategy");
  });

  it("an all-inclusive record covers the modules it names, not every module in the catalogue", async () => {
    await setRecord({ ...record, planKind: "all_inclusive", modules: [{ key: "crm", feeCents: null }, { key: "strategy", feeCents: null }] });
    const view = await as("client").get("/api/instance/billing-account");
    expect(view.body.account.modules.map((m: { key: string }) => m.key)).toEqual(["crm", "strategy"]);
    expect(view.body.account.catalogueVersion).toBe(BILLING_CATALOGUE_VERSION);
  });

  it("AT-1.7: invoices are listed newest first, by reference and link only; card data is refused", async () => {
    await setRecord();
    const invoice = {
      reference: "GS-2026-0009",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      amountCents: 100,
      currency: "GBP",
      status: "paid",
      url: "https://billing.example/GS-2026-0009",
      issuedOn: "2026-09-01",
    };
    expect((await as("operator").post("/api/instance/billing-account/invoices").send(invoice)).status).toBe(200);
    const october = { ...invoice, reference: "GS-2026-0010", periodStart: "2026-10-01", periodEnd: "2026-10-31", issuedOn: "2026-10-01", status: "issued" };
    expect((await as("operator").post("/api/instance/billing-account/invoices").send(october)).status).toBe(200);
    // Sent again (at-least-once): still one row per reference, status updated.
    expect((await as("operator").post("/api/instance/billing-account/invoices").send({ ...october, status: "paid" })).status).toBe(200);

    const card = await as("operator")
      .post("/api/instance/billing-account/invoices")
      .send({ ...invoice, reference: "GS-2026-0011", cardNumber: "4242424242424242", cvc: "123" });
    expect(card.status).toBe(400);

    const view = await as("client").get("/api/instance/billing-account");
    expect(view.body.invoices.map((i: { reference: string; status: string }) => [i.reference, i.status])).toEqual([
      ["GS-2026-0010", "paid"],
      ["GS-2026-0009", "paid"],
    ]);
    expect(view.body.invoices[1]).toMatchObject({ periodStart: "2026-09-01", periodEnd: "2026-09-30", amountCents: 100, url: invoice.url });
    expect(await db.select().from(billingInvoices)).toHaveLength(2);
  });

  it("AT-1.8: a monthly term shows the next renewal date; an annual term shows its annual date and auto-renew state", async () => {
    await setRecord();
    let view = await as("client").get("/api/instance/billing-account");
    expect(view.body.status).toMatchObject({ state: "active", renewsOn: "2026-11-01", currentPeriodEnd: "2026-10-31" });
    expect(view.body.account.autoRenew).toBe(true);

    await setRecord({ ...record, termKind: "annual", termStartsOn: "2026-03-15" });
    view = await as("client").get("/api/instance/billing-account");
    expect(view.body.status).toMatchObject({ state: "active", renewsOn: "2027-03-15", hasAccess: true });
    expect(view.body.account.autoRenew).toBe(true);

    // Auto-renew off: no renewal date; access to the end of the paid year.
    await setRecord({ ...record, termKind: "annual", termStartsOn: "2026-03-15", autoRenew: false });
    view = await as("client").get("/api/instance/billing-account");
    expect(view.body.account.autoRenew).toBe(false);
    expect(view.body.status).toMatchObject({ state: "not_renewing", renewsOn: null, accessEndsOn: "2027-03-14", hasAccess: true });

    // And on again: it renews.
    await setRecord({ ...record, termKind: "annual", termStartsOn: "2026-03-15", autoRenew: true });
    view = await as("client").get("/api/instance/billing-account");
    expect(view.body.status).toMatchObject({ state: "active", renewsOn: "2027-03-15", accessEndsOn: null });
  });

  it("AT-1.9: cancel on day 10 stops the renewal, keeps access to the period end, and ends the day after; no refund row", async () => {
    await setRecord();
    const financeRowsBefore = (await db.select().from(financeEvents)).length;

    clock = new Date("2026-10-10T15:30:00.000Z"); // day 10 of the paid period 1-31 October
    const cancel = await as("client").post("/api/instance/billing-account/cancel").send({ reason: "Moving on" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toMatchObject({
      state: "cancel_pending",
      renewsOn: null,
      accessEndsOn: "2026-10-31",
      hasAccess: true,
    });
    expect(cancel.body.account).toMatchObject({ autoRenew: false, cancelRequestedByUserId: "client-1", cancelReason: "Moving on" });

    // A second cancel (a retry, or the operator later) keeps the first one and its date.
    clock = new Date("2026-10-20T09:00:00.000Z");
    const again = await as("operator").post("/api/instance/billing-account/cancel").send({});
    expect(again.status).toBe(200);
    expect(again.body.account.cancelRequestedAt).toBe("2026-10-10T15:30:00.000Z");
    expect(again.body.account.cancelRequestedByUserId).toBe("client-1");

    // The operator cannot renew it by setting the record again; only resume lifts a cancel.
    await setRecord({ ...record, autoRenew: true });
    let view = await as("client").get("/api/instance/billing-account");
    expect(view.body.status).toMatchObject({ state: "cancel_pending", accessEndsOn: "2026-10-31" });

    clock = new Date("2026-10-31T23:59:59.000Z"); // last day: still paid
    view = await as("client").get("/api/instance/billing-account");
    expect(view.body.status).toMatchObject({ state: "cancel_pending", hasAccess: true });

    clock = new Date("2026-11-01T00:00:00.000Z"); // day after the period end
    view = await as("client").get("/api/instance/billing-account");
    expect(view.body.status).toMatchObject({ state: "ended", hasAccess: false, renewsOn: null, endAction: "pause" });

    expect((await db.select().from(financeEvents)).length).toBe(financeRowsBefore);
    const cancelRows = await db.select().from(activityLog).where(eq(activityLog.action, "billing.cancel_requested"));
    expect(cancelRows).toHaveLength(1);
    expect(cancelRows[0]!.details).toMatchObject({
      oldValue: { autoRenew: true, accessEndsOn: null },
      newValue: { autoRenew: false, accessEndsOn: "2026-10-31" },
      reason: "Moving on",
    });
  });

  it("only an owner or admin may cancel, and only the operator may resume the renewal", async () => {
    await setRecord();
    const viewer = await as("viewer").post("/api/instance/billing-account/cancel").send({});
    expect(viewer.status).toBe(403);
    expect((await as("agent").post("/api/instance/billing-account/cancel").send({})).status).toBe(403);

    await as("client").post("/api/instance/billing-account/cancel").send({});
    const resumed = await as("operator").post("/api/instance/billing-account/resume-renewal").send({ reason: "Client stayed" });
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toMatchObject({ state: "active", renewsOn: "2026-11-01", accessEndsOn: null });
    expect(resumed.body.account.cancelRequestedAt).toBeNull();
  });

  it("cancel with no record is 404", async () => {
    expect((await as("client").post("/api/instance/billing-account/cancel").send({})).status).toBe(404);
    const view = await as("client").get("/api/instance/billing-account");
    expect(view.body).toEqual({ audience: "client", account: null, status: null, usage: null, invoices: [] });
  });

  // ------------------------------------------------------------ GRE-1389: the usage block (B1)

  async function addAgent(forCompanyId = companyId) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: forCompanyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
    });
    return agentId;
  }

  async function addCost(
    agentId: string,
    costCents: number,
    occurredAt: string,
    extra: Partial<typeof costEvents.$inferInsert> = {},
  ) {
    const [agent] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId));
    await db.insert(costEvents).values({
      companyId: agent!.companyId,
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-opus-5-5",
      costCents,
      occurredAt: new Date(occurredAt),
      ...extra,
    });
  }

  /** The real cost path: insert, budget check, then the billing warn check. */
  async function reportCost(agentId: string, costCents: number, occurredAt: string) {
    await costService(db).createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-opus-5-5",
      costCents,
      occurredAt: new Date(occurredAt),
    });
  }

  async function usageCards() {
    const feed = await attentionService(db, { now: () => clock.getTime() }).list(companyId, { userId: "client-1" });
    return feed.items.filter((item) => item.dedupKey.startsWith("billing_usage:"));
  }

  it("AT-1.2: actual usage is exactly the sum of cost_events.costCents for the company in this UTC month", async () => {
    await setRecord();
    const agentId = await addAgent();
    await addCost(agentId, 1_234, "2026-10-01T00:00:00.000Z"); // first instant of the window
    await addCost(agentId, 5_678, "2026-10-09T23:59:59.000Z");
    await addCost(agentId, 91, "2026-10-10T08:00:00.000Z");
    await addCost(agentId, 7_000, "2026-09-30T23:59:59.999Z"); // last month
    await addCost(agentId, 8_000, "2026-11-01T00:00:00.000Z"); // next month
    // A second company made later is not the instance's company.
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 6).toUpperCase()}` });
    await addCost(await addAgent(otherCompanyId), 99_999, "2026-10-05T00:00:00.000Z");

    const view = await as("operator").get("/api/instance/billing-account");
    expect(view.status).toBe(200);
    const [sum] = await db
      .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
      .from(costEvents)
      .where(and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, new Date("2026-10-01T00:00:00.000Z")),
        lt(costEvents.occurredAt, new Date("2026-11-01T00:00:00.000Z")),
      ));
    expect(view.body.usage.usedCents).toBe(sum!.total);
    expect(view.body.usage).toMatchObject({
      windowStart: "2026-10-01",
      windowEnd: "2026-10-31",
      daysElapsed: 10,
      daysInWindow: 31,
      usedCents: 1_234 + 5_678 + 91,
      allowanceCents: 25_000,
      remainingCents: 25_000 - 7_003,
      usedPercent: 28.01,
      warnPercent: 80,
      warning: false,
      pausedSince: null,
    });
    // The client gets the same percent and nothing else about the amounts.
    const client = await as("client").get("/api/instance/billing-account");
    expect(client.body.usage).toMatchObject({ usedPercent: 28.01, warning: false, extraUsage: { state: "none", amountCents: 0, currency: "GBP" } });
  });

  it("AT-1.3: estimate and straight-line forecast after 10 days; subscription-included usage is API-equivalent, not charged", async () => {
    await setRecord({ ...record, estimateMonthlyCents: 30_000 });
    const agentId = await addAgent();
    await addCost(agentId, 4_000, "2026-10-02T10:00:00.000Z");
    await addCost(agentId, 6_000, "2026-10-08T10:00:00.000Z");
    const tokens = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000 };
    await addCost(agentId, 0, "2026-10-09T10:00:00.000Z", { billingType: "subscription_included", ...tokens });

    clock = new Date("2026-10-10T18:00:00.000Z"); // day 10 of 31
    const view = await as("operator").get("/api/instance/billing-account");
    expect(view.body.account.estimateMonthlyCents).toBe(30_000);
    const expectedEquivalent = Math.round(computeApiEquivalentCents({ provider: "anthropic", model: "claude-opus-5-5", ...tokens })!);
    expect(expectedEquivalent).toBeGreaterThan(0);
    // GRE-1395: the allowance is API-equivalent, so subscription-included usage counts against it.
    const consumed = 10_000 + expectedEquivalent;
    expect(view.body.usage).toMatchObject({
      daysElapsed: 10,
      usedCents: 10_000, // the subscription run adds nothing charged
      apiEquivalentCents: expectedEquivalent,
      consumedCents: consumed,
      forecastCents: Math.round((consumed / 10) * 31), // straight line over 31 days
      estimateCents: 30_000,
    });
    const client = await as("client").get("/api/instance/billing-account");
    expect(client.body.usage.forecastPercent).toBe(Number(((Math.round((consumed / 10) * 31) / 25_000) * 100).toFixed(2)));
    expect(client.body.usage.estimateCents).toBe(30_000);

    // The estimate is the operator's and optional: a record without one shows none.
    await setRecord();
    const without = await as("client").get("/api/instance/billing-account");
    expect(without.body.account.estimateMonthlyCents).toBeNull();
    expect(without.body.usage.estimateCents).toBeNull();
    // ...and the client cannot set it.
    const write = await as("client").put("/api/instance/billing-account").send({ ...record, estimateMonthlyCents: 1 });
    expect(write.status).toBe(403);
  });

  it("AT-1.4: crossing the warn level makes one Inbox card for the month and a failing budget-warn check-in alert; no second card", async () => {
    await setRecord(); // allowance 25 000; no budget policy, so the warn level is the default
    const agentId = await addAgent();
    await reportCost(agentId, 19_999, "2026-10-05T10:00:00.000Z");
    expect(await usageCards()).toHaveLength(0);

    await reportCost(agentId, 1, "2026-10-06T10:00:00.000Z"); // 20 000 = 80% exactly
    expect((await as("operator").get("/api/instance/billing-account")).body.usage).toMatchObject({ usedCents: 20_000, consumedCents: 20_000 });
    let view = await as("client").get("/api/instance/billing-account");
    expect(view.body.usage).toMatchObject({ usedPercent: 80, warnPercent: 80, warning: true });
    let cards = await usageCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ sourceKind: "budget_alert", dedupKey: "billing_usage:2026-10-01", subject: { kind: "billing_account" } });
    // The client reads the card: a percent, no money for the included allowance (GRE-1395).
    expect(cards[0]!.subject.metadata).toEqual({ windowStart: "2026-10-01", usedPercent: 80, warnPercent: 80 });
    expect(cards[0]!.detail).toMatchObject({ kind: "generic" });
    const firstCardAt = cards[0]!.createdAt;

    // The next fleet check-in carries the alert as a fail, with no amount or company in it.
    const signal = billingUsageSignal(view.body.usage);
    const checkIn = buildCheckIn(
      {
        edition: "managed",
        appUp: true,
        newestBackupAt: null,
        releaseTag: null,
        appVersion: null,
        usage: usageTotals([], 0),
        connections: null,
        signals: [{ key: "health", ok: true, detail: "ok" }, signal],
      },
      clock.getTime(),
    );
    expect(checkIn.alerts).toContainEqual({ key: "budget-warn", ok: false });

    // More usage in the same window: still one card, one crossing logged.
    await reportCost(agentId, 2_000, "2026-10-07T10:00:00.000Z");
    expect(await usageCards()).toHaveLength(1);

    // The operator raises the allowance: under the warn level, the card goes and the alert passes.
    await setRecord({ ...record, allowanceMonthlyCents: 100_000 });
    expect(await usageCards()).toHaveLength(0);
    view = await as("client").get("/api/instance/billing-account");
    expect(billingUsageSignal(view.body.usage)).toMatchObject({ key: "budget-warn", ok: true });

    // A second crossing in the same window makes no second card: the same card, from the first crossing.
    await reportCost(agentId, 60_000, "2026-10-08T10:00:00.000Z");
    cards = await usageCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.createdAt).toBe(firstCardAt);
    const crossings = await db.select().from(activityLog).where(eq(activityLog.action, "billing.usage_warning"));
    expect(crossings).toHaveLength(1);
    // Company members can read the activity log, so the row holds a percent and no money (GRE-1395).
    expect(crossings[0]!.details).toEqual({ windowStart: "2026-10-01", usedPercent: 80, warnPercent: 80 });

    // A new month is a new window: the next crossing makes its card.
    clock = new Date("2026-11-03T09:00:00.000Z");
    expect(await usageCards()).toHaveLength(0);
    await reportCost(agentId, 85_000, "2026-11-02T10:00:00.000Z");
    cards = await usageCards();
    expect(cards.map((card) => card.dedupKey)).toEqual(["billing_usage:2026-11-01"]);
  });

  it("the warn level is the company budget policy's setting, not a value in code", async () => {
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 0,
      warnPercent: 50,
      isActive: false,
    });
    await setRecord();
    const agentId = await addAgent();
    await reportCost(agentId, 12_500, "2026-10-05T10:00:00.000Z"); // 50%
    const view = await as("client").get("/api/instance/billing-account");
    expect(view.body.usage).toMatchObject({ warnPercent: 50, warning: true });
    expect(await usageCards()).toHaveLength(1);
  });

  it("lowering the allowance under this month's usage is a crossing too", async () => {
    await setRecord({ ...record, allowanceMonthlyCents: 100_000 });
    const agentId = await addAgent();
    await reportCost(agentId, 20_000, "2026-10-05T10:00:00.000Z");
    expect(await usageCards()).toHaveLength(0);
    await setRecord(); // 25 000: usage is now at 80%
    expect(await usageCards()).toHaveLength(1);
  });

  it("AT-1.10: a paused company shows paused since, starts no run and adds no usage", async () => {
    await setRecord();
    const agentId = await addAgent();
    await addCost(agentId, 3_000, "2026-10-04T10:00:00.000Z");
    const pausedAt = new Date("2026-10-05T12:00:00.000Z");
    await db.update(companies).set({ status: "paused", pauseReason: "manual", pausedAt }).where(eq(companies.id, companyId));

    clock = new Date("2026-10-10T09:00:00.000Z");
    let view = await as("operator").get("/api/instance/billing-account");
    expect(view.body.usage).toMatchObject({ pausedSince: pausedAt.toISOString(), usedCents: 3_000 });

    // The run gate refuses new work while paused, so no cost event is made.
    const block = await budgetService(db).getInvocationBlock(companyId, agentId);
    expect(block).toMatchObject({ scopeType: "company", scopeId: companyId });

    clock = new Date("2026-10-20T09:00:00.000Z");
    view = await as("operator").get("/api/instance/billing-account");
    expect(view.body.usage).toMatchObject({ pausedSince: pausedAt.toISOString(), usedCents: 3_000 });

    // Resumed: no paused-since.
    await db.update(companies).set({ status: "active", pauseReason: null, pausedAt: null }).where(eq(companies.id, companyId));
    view = await as("client").get("/api/instance/billing-account");
    expect(view.body.usage.pausedSince).toBeNull();
  });

  // ------------------------------------------------------------ GRE-1395: percent for the client, extra usage in the account currency

  const INCLUDED_MONEY_KEYS = ["usedCents", "apiEquivalentCents", "consumedCents", "allowanceCents", "remainingCents", "forecastCents"];

  it("GRE-1395: the client response has no included-usage money; the operator's keeps it", async () => {
    await setRecord({ ...record, usageFxRate: 0.75, usageFxRateSetOn: "2026-10-01" });
    const agentId = await addAgent();
    await addCost(agentId, 10_000, "2026-10-04T10:00:00.000Z");
    await addCost(agentId, 0, "2026-10-05T10:00:00.000Z", {
      billingType: "subscription_included",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 100_000,
    });

    for (const who of ["client", "viewer"] as const) {
      const view = await as(who).get("/api/instance/billing-account");
      expect(view.status).toBe(200);
      expect(view.body.audience).toBe("client");
      for (const key of INCLUDED_MONEY_KEYS) expect(view.body.usage).not.toHaveProperty(key);
      for (const key of ["allowanceMonthlyCents", "usageFxRate", "usageFxRateSetOn"]) expect(view.body.account).not.toHaveProperty(key);
      expect(Object.keys(view.body.usage.extraUsage).sort()).toEqual(["amountCents", "currency", "state"]);
      expect(view.body.usage).toMatchObject({ warnPercent: 80, warning: expect.any(Boolean) });
      expect(typeof view.body.usage.usedPercent).toBe("number");
      expect(typeof view.body.usage.forecastPercent).toBe("number");
    }

    // A client cancel returns the client view too.
    const cancel = await as("client").post("/api/instance/billing-account/cancel").send({});
    expect(cancel.body.audience).toBe("client");
    for (const key of INCLUDED_MONEY_KEYS) expect(cancel.body.usage).not.toHaveProperty(key);

    const operator = await as("operator").get("/api/instance/billing-account");
    expect(operator.body.audience).toBe("operator");
    expect(operator.body.account).toMatchObject({ allowanceMonthlyCents: 25_000, usageFxRate: 0.75, usageFxRateSetOn: "2026-10-01" });
    for (const key of INCLUDED_MONEY_KEYS) expect(operator.body.usage).toHaveProperty(key);
  });

  it("GRE-1395: a GBP account with a USD allowance shows the right percent and warning, whatever the rate", async () => {
    await setRecord({ ...record, usageFxRate: 0.5 });
    const agentId = await addAgent();
    await reportCost(agentId, 19_000, "2026-10-05T10:00:00.000Z"); // US$190 of US$250
    let view = await as("client").get("/api/instance/billing-account");
    expect(view.body.usage).toMatchObject({ usedPercent: 76, warning: false });
    expect(await usageCards()).toHaveLength(0);

    await reportCost(agentId, 1_000, "2026-10-06T10:00:00.000Z"); // US$200 = 80%
    view = await as("client").get("/api/instance/billing-account");
    expect(view.body.usage).toMatchObject({ usedPercent: 80, warning: true, extraUsage: { state: "none", amountCents: 0, currency: "GBP" } });
    expect(await usageCards()).toHaveLength(1);
  });

  it("GRE-1395: extra usage past 100% converts with the account's rate; no rate gives rate missing and no amount", async () => {
    await setRecord({ ...record, usageFxRate: 0.75, usageFxRateSetOn: "2026-10-01" });
    const agentId = await addAgent();
    await addCost(agentId, 29_000, "2026-10-05T10:00:00.000Z"); // US$40 past the US$250 allowance

    let client = await as("client").get("/api/instance/billing-account");
    expect(client.body.usage).toMatchObject({ usedPercent: 116, warning: true });
    expect(client.body.usage.extraUsage).toEqual({ state: "priced", amountCents: 3_000, currency: "GBP" });
    let operator = await as("operator").get("/api/instance/billing-account");
    expect(operator.body.usage.extraUsage).toEqual({
      state: "priced",
      amountCents: 3_000,
      currency: "GBP",
      usdCents: 4_000,
      rate: 0.75,
      rateSetOn: "2026-10-01",
    });

    // The operator clears the rate: no amount, a clear rate-missing state.
    await setRecord({ ...record, usageFxRate: null });
    client = await as("client").get("/api/instance/billing-account");
    expect(client.body.usage.extraUsage).toEqual({ state: "rate_missing", amountCents: null, currency: "GBP" });
    operator = await as("operator").get("/api/instance/billing-account");
    expect(operator.body.usage.extraUsage).toMatchObject({ state: "rate_missing", amountCents: null, usdCents: 4_000, rate: null });

    // A USD account needs no rate: it converts at 1.
    await setRecord({ ...record, currency: "USD" });
    client = await as("client").get("/api/instance/billing-account");
    expect(client.body.usage.extraUsage).toEqual({ state: "priced", amountCents: 4_000, currency: "USD" });
  });

  it("GRE-1395: the rate's day is the operator's, else kept while the rate is unchanged, else today", async () => {
    clock = new Date("2026-10-02T09:00:00.000Z");
    let body = await setRecord({ ...record, usageFxRate: 0.75 });
    expect(body.account).toMatchObject({ usageFxRate: 0.75, usageFxRateSetOn: "2026-10-02" });

    clock = new Date("2026-10-09T09:00:00.000Z");
    body = await setRecord({ ...record, usageFxRate: 0.75, planName: "Renamed" });
    expect(body.account.usageFxRateSetOn).toBe("2026-10-02");

    body = await setRecord({ ...record, usageFxRate: 0.8 });
    expect(body.account.usageFxRateSetOn).toBe("2026-10-09");

    body = await setRecord({ ...record, usageFxRate: 0.81, usageFxRateSetOn: "2026-10-07" });
    expect(body.account.usageFxRateSetOn).toBe("2026-10-07");

    // The client cannot set a rate, and a bad one is refused.
    expect((await as("client").put("/api/instance/billing-account").send({ ...record, usageFxRate: 1 })).status).toBe(403);
    expect((await as("operator").put("/api/instance/billing-account").send({ ...record, usageFxRate: 0 })).status).toBe(400);
  });
});
