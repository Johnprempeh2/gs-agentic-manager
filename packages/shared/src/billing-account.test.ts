import { describe, expect, it } from "vitest";
import {
  BILLING_MODULES,
  BILLING_MODULE_KEYS,
  accessEndWhenRenewalStops,
  addMonthsClamped,
  billingModuleProblems,
  billingPeriodOn,
  billingStatusOn,
  recordBillingInvoiceSchema,
  upsertBillingAccountSchema,
  type BillingModuleSelection,
} from "./billing-account.js";
import { INSTANCE_FEATURE_KEYS } from "./feature-catalog.js";

const pick = (...keys: BillingModuleSelection["key"][]): BillingModuleSelection[] =>
  keys.map((key) => (BILLING_MODULES[key].needsScope ? { key, feeCents: null, scope: "agreed scope" } : { key, feeCents: null }));

describe("billing module catalogue: John's D2 rules (GRE-1354, 11 Oct)", () => {
  it("rule 1: Board is a separate add-on that needs Strategy", () => {
    expect(BILLING_MODULES.board.kind).toBe("add_on");
    expect(billingModuleProblems("modules", pick("board"))).toEqual(["board needs strategy"]);
    expect(billingModuleProblems("modules", pick("strategy", "board"))).toEqual([]);
    expect(billingModuleProblems("modules", pick("strategy"))).toEqual([]);
  });

  it("rule 2: Strategy holds the KPI cascade and readings; basic goals are not a module", () => {
    expect(BILLING_MODULES.strategy.description).toMatch(/KPI cascade/);
    expect(BILLING_MODULE_KEYS).not.toContain("goals");
  });

  it("rule 3: all-inclusive names its catalogue on the record; an empty one is refused", () => {
    expect(billingModuleProblems("all_inclusive", [])).toEqual([
      "an all-inclusive plan must name the modules of its contract catalogue",
    ]);
    expect(billingModuleProblems("all_inclusive", pick("crm", "strategy"))).toEqual([]);
  });

  it("rule 4: CRM write-back, two-way sync and migration are scoped add-ons that need CRM", () => {
    for (const key of ["crm_write_back", "crm_two_way_sync", "crm_migration"] as const) {
      expect(BILLING_MODULES[key]).toMatchObject({ kind: "add_on", needsScope: true, requires: ["crm"] });
      expect(billingModuleProblems("modules", pick(key))).toEqual([`${key} needs crm`]);
      expect(billingModuleProblems("modules", [{ key: "crm", feeCents: null }, { key, feeCents: 100 }])).toEqual([
        `${key} is a scoped add-on and needs a scope`,
      ]);
      expect(billingModuleProblems("modules", pick("crm", key))).toEqual([]);
    }
    expect(BILLING_MODULES.crm.needsScope).toBe(false);
    expect(billingModuleProblems("modules", [{ key: "crm", feeCents: null, scope: "x" }])).toEqual(["crm takes no scope"]);
  });

  it("rule 5: pipelines and cases are sold under CRM", () => {
    expect(BILLING_MODULES.crm.features).toEqual(expect.arrayContaining(["enablePipelines", "enableCases"]));
  });

  it("rule 6: development environments are sold once, under Software development", () => {
    expect(BILLING_MODULES.software_development.features).toContain("enableEnvironments");
    for (const key of ["website_analytics", "website_seo", "website_publishing"] as const) {
      expect(BILLING_MODULES[key].features).not.toContain("enableEnvironments");
    }
  });

  it("sells each feature switch under one module at most, and only real switches", () => {
    const seen = new Map<string, string>();
    for (const key of BILLING_MODULE_KEYS) {
      for (const feature of BILLING_MODULES[key].features) {
        expect(INSTANCE_FEATURE_KEYS).toContain(feature);
        expect(seen.get(feature), `${feature} under ${seen.get(feature)} and ${key}`).toBeUndefined();
        seen.set(feature, key);
      }
    }
  });

  it("refuses a module listed twice and parked financial planning", () => {
    expect(billingModuleProblems("modules", pick("crm", "crm"))).toEqual(["crm is listed more than once"]);
    expect(BILLING_MODULE_KEYS).not.toContain("financial_planning");
  });
});

describe("billing record schema", () => {
  const record = {
    planKind: "modules",
    catalogueVersion: "packaging-v2-d2-2026-10-11",
    currency: "GBP",
    serviceFeeCents: 1,
    modules: pick("crm"),
    allowanceMonthlyCents: 2,
    termKind: "monthly",
    termStartsOn: "2026-10-01",
    autoRenew: true,
  };

  it("takes a full record and refuses module boundary problems", () => {
    expect(upsertBillingAccountSchema.safeParse(record).success).toBe(true);
    const bad = upsertBillingAccountSchema.safeParse({ ...record, modules: pick("board") });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("board needs strategy");
  });

  it("refuses cancel fields and impossible dates on the operator record", () => {
    expect(upsertBillingAccountSchema.safeParse({ ...record, cancelRequestedAt: "2026-10-10T00:00:00Z" }).success).toBe(false);
    expect(upsertBillingAccountSchema.safeParse({ ...record, termStartsOn: "2026-02-30" }).success).toBe(false);
  });

  it("invoices keep a reference and a link only: card data and plain http links are refused", () => {
    const invoice = {
      reference: "INV-001",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      amountCents: 5,
      currency: "GBP",
      status: "issued",
      url: "https://billing.example/inv-001",
      issuedOn: "2026-10-01",
    };
    expect(recordBillingInvoiceSchema.safeParse(invoice).success).toBe(true);
    expect(recordBillingInvoiceSchema.safeParse({ ...invoice, cardNumber: "4242424242424242" }).success).toBe(false);
    expect(recordBillingInvoiceSchema.safeParse({ ...invoice, url: "http://billing.example/x" }).success).toBe(false);
    expect(recordBillingInvoiceSchema.safeParse({ ...invoice, periodEnd: "2026-09-30" }).success).toBe(false);
  });
});

describe("term dates (UTC days)", () => {
  it("adds months and clamps to the month's last day", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsClamped("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonthsClamped("2026-11-15", 2)).toBe("2027-01-15");
    expect(addMonthsClamped("2026-10-11", 12)).toBe("2027-10-11");
  });

  it("finds the period that holds a day, anchored on the term start", () => {
    expect(billingPeriodOn("monthly", "2026-01-31", "2026-03-30")).toEqual({
      start: "2026-02-28",
      end: "2026-03-30",
      nextStart: "2026-03-31",
    });
    expect(billingPeriodOn("monthly", "2026-01-31", "2026-03-31")).toMatchObject({ start: "2026-03-31", end: "2026-04-29" });
    expect(billingPeriodOn("annual", "2026-10-11", "2027-10-10")).toMatchObject({ start: "2026-10-11", end: "2027-10-10" });
    expect(billingPeriodOn("annual", "2026-10-11", "2027-10-11")).toMatchObject({ start: "2027-10-11", nextStart: "2028-10-11" });
    expect(billingPeriodOn("monthly", "2026-10-11", "2026-10-10")).toBeNull();
  });

  it("stops renewal at the end of the paid period that holds today", () => {
    expect(accessEndWhenRenewalStops("monthly", "2026-10-01", "2026-10-10")).toBe("2026-10-31");
    expect(accessEndWhenRenewalStops("annual", "2026-10-01", "2027-03-01")).toBe("2027-09-30");
    expect(accessEndWhenRenewalStops("monthly", "2026-11-01", "2026-10-10")).toBe("2026-10-31");
  });

  it("is a date check: renewing, then cancel pending with access, then ended without", () => {
    const base = { termKind: "monthly" as const, termStartsOn: "2026-10-01", endAction: "pause" as const };
    expect(billingStatusOn({ ...base, accessEndsOn: null, cancelRequestedAt: null }, "2026-10-10")).toMatchObject({
      state: "active",
      hasAccess: true,
      renewsOn: "2026-11-01",
    });
    const cancelled = { ...base, accessEndsOn: "2026-10-31", cancelRequestedAt: "2026-10-10T09:00:00.000Z" };
    expect(billingStatusOn(cancelled, "2026-10-31")).toMatchObject({ state: "cancel_pending", hasAccess: true, renewsOn: null });
    expect(billingStatusOn(cancelled, "2026-11-01")).toMatchObject({ state: "ended", hasAccess: false, endAction: "pause" });
    expect(billingStatusOn({ ...base, accessEndsOn: "2026-10-31", cancelRequestedAt: null }, "2026-10-20")).toMatchObject({
      state: "not_renewing",
      hasAccess: true,
    });
    expect(billingStatusOn({ ...base, accessEndsOn: null, cancelRequestedAt: null }, "2026-09-30")).toMatchObject({
      state: "scheduled",
      hasAccess: false,
      renewsOn: "2026-10-01",
    });
  });
});
