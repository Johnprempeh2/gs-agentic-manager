import { describe, expect, it } from "vitest";
import {
  BILLING_MODULES,
  BILLING_MODULE_KEYS,
  accessEndWhenRenewalStops,
  addMonthsClamped,
  billingModuleProblems,
  billingPeriodOn,
  billingStatusOn,
  billingExtraUsage,
  billingUsageOn,
  billingUsageWarning,
  clientBillingAccountView,
  recordBillingInvoiceSchema,
  upsertBillingAccountSchema,
  type BillingAccount,
  type BillingModuleSelection,
} from "./billing-account.js";
import { INSTANCE_FEATURE_KEYS } from "./feature-catalog.js";
import { API_PRICE_TABLE } from "./api-pricing.js";

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

describe("billing usage (GRE-1389, GRE-1395)", () => {
  // The allowance is API-equivalent US cents on every account; the currency is the account's.
  const usd = { allowanceMonthlyCents: 25_000, estimateMonthlyCents: null, currency: "USD", usageFxRate: null, usageFxRateSetOn: null };
  const gbp = { ...usd, currency: "GBP", usageFxRate: 0.75, usageFxRateSetOn: "2026-10-01" };
  const base = { usedCents: 0, apiEquivalentCents: 0, warnPercent: 80, pausedSince: null, account: usd };

  it("the window is the UTC calendar month, today included", () => {
    expect(billingUsageOn(new Date("2028-02-29T23:59:59Z"), base)).toMatchObject({
      windowStart: "2028-02-01",
      windowEnd: "2028-02-29",
      daysElapsed: 29,
      daysInWindow: 29,
    });
    expect(billingUsageOn(new Date("2026-10-01T00:00:00Z"), base)).toMatchObject({ daysElapsed: 1, daysInWindow: 31 });
  });

  it("warns at the warn level exactly, never with no allowance", () => {
    expect(billingUsageWarning(19_999, 25_000, 80)).toBe(false);
    expect(billingUsageWarning(20_000, 25_000, 80)).toBe(true);
    expect(billingUsageWarning(1, 0, 80)).toBe(false);
    expect(
      billingUsageOn(new Date("2026-10-10T00:00:00Z"), { ...base, usedCents: 5, account: { ...usd, allowanceMonthlyCents: 0 } }),
    ).toMatchObject({ usedPercent: 0, remainingCents: 0, warning: false });
  });

  it("forecasts on a straight line, as cents and as a percent, and floors remaining at zero", () => {
    const usage = billingUsageOn(new Date("2026-10-10T12:00:00Z"), { ...base, usedCents: 30_000 });
    expect(usage).toMatchObject({ forecastCents: 93_000, forecastPercent: 372, remainingCents: 0, usedPercent: 120, warning: true });
  });

  it("uses each future day's model price and reports missing successor days", () => {
    API_PRICE_TABLE.google.models["forecast-test"] = [
      { inputPerMTok: 1, cachedInputPerMTok: 0, outputPerMTok: 1, effectiveFrom: "2026-10-01", effectiveUntil: "2026-10-20", sourceUrl: "https://example.com/intro" },
      { inputPerMTok: 2, cachedInputPerMTok: 0, outputPerMTok: 2, effectiveFrom: "2026-10-20", effectiveUntil: "2026-10-22", sourceUrl: "https://example.com/list" },
    ];
    try {
      const forecastModels = [{ provider: "google", model: "forecast-test", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }];
      const usage = billingUsageOn(new Date("2026-10-18T12:00:00Z"), { ...base, usedCents: 0, apiEquivalentCents: 1_800, forecastModels });
      // October 19: $1; October 20 and 21: $2 each; later days unpriced.
      expect(usage.forecastCents).toBe(2_300);
      expect(usage.forecastUnpriced).toHaveLength(10);
      expect(usage.forecastUnpriced?.[0]).toMatchObject({ day: "2026-10-22" });
    } finally {
      delete API_PRICE_TABLE.google.models["forecast-test"];
    }
  });

  it("measures metered and subscription-included usage together against the allowance", () => {
    const usage = billingUsageOn(new Date("2026-10-10T12:00:00Z"), { ...base, usedCents: 5_000, apiEquivalentCents: 15_000 });
    expect(usage).toMatchObject({ consumedCents: 20_000, usedPercent: 80, warning: true, remainingCents: 5_000 });
  });

  it("a GBP account with a USD allowance: the percent and the warning are USD against USD, not off by the rate", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    // US$190 used of a US$250 allowance is 76%: under the warn level. Converting
    // usage to GBP first (x 0.75) or the allowance to USD would give a wrong percent.
    const under = billingUsageOn(now, { ...base, usedCents: 19_000, account: gbp });
    expect(under).toMatchObject({ usedPercent: 76, warning: false, allowanceCents: 25_000 });
    expect(under.extraUsage).toMatchObject({ state: "none", amountCents: 0, currency: "GBP" });
    // US$200 of US$250 is 80%: at the warn level, the same as for a USD account.
    const at = billingUsageOn(now, { ...base, usedCents: 20_000, account: gbp });
    expect(at).toMatchObject({ usedPercent: 80, warning: true });
    expect(billingUsageOn(now, { ...base, usedCents: 20_000, account: usd })).toMatchObject({ usedPercent: 80, warning: true });
  });

  it("extra usage past 100% converts to the account currency with the account's rate", () => {
    const usage = billingUsageOn(new Date("2026-10-10T12:00:00Z"), { ...base, usedCents: 29_000, account: gbp });
    expect(usage.usedPercent).toBe(116);
    // US$40 over the allowance at 0.75 GBP per USD is GBP 30.
    expect(usage.extraUsage).toEqual({ state: "priced", amountCents: 3_000, currency: "GBP", usdCents: 4_000, rate: 0.75, rateSetOn: "2026-10-01" });
  });

  it("a USD account converts at 1 and needs no rate", () => {
    expect(billingExtraUsage(4_000, usd)).toEqual({ state: "priced", amountCents: 4_000, currency: "USD", usdCents: 4_000, rate: 1, rateSetOn: null });
    // A rate left on a USD record is not used.
    expect(billingExtraUsage(4_000, { ...usd, usageFxRate: 0.5, usageFxRateSetOn: "2026-10-01" })).toMatchObject({ amountCents: 4_000, rate: 1 });
  });

  it("extra usage with no rate on a non-USD account shows no amount: rate missing", () => {
    expect(billingExtraUsage(4_000, { ...gbp, usageFxRate: null, usageFxRateSetOn: null })).toEqual({
      state: "rate_missing",
      amountCents: null,
      currency: "GBP",
      usdCents: 4_000,
      rate: null,
      rateSetOn: null,
    });
    // Within the allowance there is nothing to price, so a missing rate does not matter.
    expect(billingExtraUsage(0, { ...gbp, usageFxRate: null })).toMatchObject({ state: "none", amountCents: 0 });
  });

  it("the client view has no money for the included allowance and no rate", () => {
    const account: BillingAccount = {
      id: "acc-1",
      planKind: "modules",
      planName: null,
      catalogueVersion: "v",
      currency: "GBP",
      serviceFeeCents: 100_000,
      modules: [],
      allowanceMonthlyCents: 25_000,
      estimateMonthlyCents: 15_000,
      usageFxRate: 0.75,
      usageFxRateSetOn: "2026-10-01",
      termKind: "monthly",
      termStartsOn: "2026-10-01",
      autoRenew: true,
      endAction: null,
      accessEndsOn: null,
      cancelRequestedAt: null,
      cancelRequestedByUserId: null,
      cancelReason: null,
      updatedByUserId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const usage = billingUsageOn(new Date("2026-10-10T12:00:00Z"), { ...base, usedCents: 29_000, account });
    const view = clientBillingAccountView({ audience: "operator", account, status: null, usage, invoices: [] });
    expect(view.audience).toBe("client");
    for (const key of ["allowanceMonthlyCents", "usageFxRate", "usageFxRateSetOn"]) expect(view.account).not.toHaveProperty(key);
    for (const key of ["usedCents", "apiEquivalentCents", "consumedCents", "allowanceCents", "remainingCents", "forecastCents"]) {
      expect(view.usage).not.toHaveProperty(key);
    }
    expect(view.usage!.extraUsage).toEqual({ state: "priced", amountCents: 3_000, currency: "GBP" });
    expect(view.usage).toMatchObject({ usedPercent: 116, forecastPercent: 359.6, warnPercent: 80, warning: true, estimateCents: 15_000 });
  });
});
