import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, billingAccounts, billingInvoices, companies, createDb, financeEvents } from "@greatstone/db";
import { SETTINGS_OPERATOR_MANAGED_ERROR_CODE } from "@greatstone/shared";
import { BILLING_CATALOGUE_VERSION } from "@greatstone/shared/billing-account";
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
  }, 30_000);

  beforeEach(async () => {
    await db.delete(activityLog);
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

  it("AT-1.1: the client sees each fee and the allowance exactly as the operator set them, and cannot change them", async () => {
    await setRecord();

    const view = await as("client").get("/api/instance/billing-account");
    expect(view.status).toBe(200);
    expect(view.body.account).toMatchObject({
      planKind: "modules",
      currency: "GBP",
      serviceFeeCents: 123_400,
      modules: [
        { key: "crm", feeCents: 45_600 },
        { key: "strategy", feeCents: 78_900 },
      ],
      allowanceMonthlyCents: 25_000,
      termStartsOn: "2026-10-01",
    });

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
    expect(after.body.account.allowanceMonthlyCents).toBe(25_000);
    expect(after.body.invoices).toEqual([]);

    // The operator's change is audited with the old and new values.
    const rows = await db.select().from(activityLog).where(eq(activityLog.action, "billing.account_updated"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.companyId).toBe(companyId);
    expect(rows[0]!.details).toMatchObject({ oldValue: null, reason: "Signed order form" });
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
    expect(view.body).toEqual({ account: null, status: null, invoices: [] });
  });
});
